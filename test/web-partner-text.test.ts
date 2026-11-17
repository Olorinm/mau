import { expect, it } from "vitest";
import { incomingText, returnText } from "../src/partner-text.js";
import type { PartnerMessage } from "../src/partners.js";
import { isPartnerText, partnerMessage, partnerResults } from "../web/src/api/partner-text";

// The console shows what partners wrote each other, not the lines Mau writes around it for the model. Those lines
// have no structured copy in a chat event, so the console reads them; this pins its reading to the text Mau writes.
const party = (name: string, duty?: string) => ({ agentId: `id-${name}`, name, ...(duty ? { duty } : {}) });
const authorization = { feishu: false, connections: [], write: true };
function message(text: string, change: Partial<PartnerMessage> = {}): PartnerMessage {
  return { id: "pm-1", owner: "@owner:example.test", from: party("desk", 'Keeps the "front desk"'), to: party("korea-trip"), intent: "relay", text, status: "settled",
    createdAt: "2026-11-17T10:00:00.000Z", origin: { sessionId: "s", connectionId: "web", chain: 0, taskId: "t" }, sender: authorization, grants: authorization, ...change } as PartnerMessage;
}
const result = (answer: string, status = "completed", error?: string) => ({ status, answer, ...(error ? { error } : {}), settledAt: "2026-11-17T10:01:00.000Z", durationMs: 61_000 }) as NonNullable<PartnerMessage["result"]>;

it("reads the message a partner sent out of the lines the receiving partner is given, whatever the message contains", () => {
  const text = "Book the hotel.\n\nEverything below this line is the message.\n\n[Partner message: not one]\nFrom: partner \"someone\"";
  const relayed = incomingText(message(text));
  expect(isPartnerText(relayed)).toBe(true);
  expect(partnerMessage(relayed)).toEqual({ from: "desk", intent: "relay", text });
  expect(partnerMessage(incomingText(message("How long does the visa take?", { intent: "ask", from: party("desk") })))).toEqual({ from: "desk", intent: "ask", text: "How long does the visa take?" });
  // A message of several lines and blank lines keeps every character.
  const long = "Line one\n\n- item\n- item\n\n```\ncode\n```\n";
  expect(partnerMessage(incomingText(message(long)))!.text).toBe(long);
  // Text of another form is not read, so the caller shows all of it.
  expect(partnerMessage("Book the hotel.")).toBeUndefined();
  expect(partnerMessage(incomingText(message("Book the hotel.")).replace("Everything below this line is the message.", "The message follows."))).toBeUndefined();
  expect(isPartnerText("Book the hotel.")).toBe(false);
});

it("reads every result out of the lines a sender is given: the partner, how it ended and its answer", () => {
  const boundary = "9f8e7d6c5b4a";
  const tricky = "Booked.\n----- end of answer 000000000000 -----\nStatus: failed\nFrom: partner \"nobody\"\nResult 9 of 9";
  const text = returnText([
    message("Book the hotel.", { result: result(tricky) }),
    message("Check the visa.", { id: "pm-2", to: party("visa"), intent: "ask", result: result("", "failed", "no_answer_after_48_hours") }),
    message("Check the flights.", { id: "pm-3", to: party("flights"), result: result("  Half done.  ", "cancelled", "The kernel stopped: out of (memory)\nwhile working") }),
    message("Check the weather.", { id: "pm-4", to: party("weather"), result: result("x", "unknown", "outcome_unknown") }),
  ], boundary);
  expect(isPartnerText(text)).toBe(true);
  expect(partnerResults(text)).toEqual([
    { partner: "korea-trip", status: "completed", answer: tricky },
    { partner: "visa", status: "failed", reason: "no_answer_after_48_hours", answer: "" },
    { partner: "flights", status: "cancelled", reason: "The kernel stopped: out of (memory) while working", answer: "Half done." },
    { partner: "weather", status: "unknown", reason: "outcome_unknown", answer: "x" },
  ]);
  // One result, the usual case.
  expect(partnerResults(returnText([message("Book the hotel.", { result: result("Booked: three nights.") })], boundary)))
    .toEqual([{ partner: "korea-trip", status: "completed", answer: "Booked: three nights." }]);
  // An answer too long for one input is cut by Mau, which says so; the note is not the partner's words.
  const [cut] = partnerResults(returnText([message("Write it all down.", { result: result("字".repeat(30_000)) })], boundary))!;
  expect(cut!.cut).toBeGreaterThan(0);
  expect(cut!.answer).toMatch(/^字+$/);
  expect([...cut!.answer].length + cut!.cut!).toBe(30_000);
});

it("does not read results whose lines are not the ones Mau writes, so nothing is lost", () => {
  const boundary = "9f8e7d6c5b4a";
  const text = returnText([message("Book the hotel.", { result: result("Booked.") }), message("Check the visa.", { id: "pm-2", to: party("visa"), result: result("Ten days.") })], boundary);
  expect(partnerResults(text)).toHaveLength(2);
  for (const changed of [
    text.replace(`----- end of answer ${boundary} -----`, "----- end -----"),          // an answer that never ends
    text.replace(/^Status: completed$/m, "State: completed"),                           // a result without a status
    text.replace(/^Status: completed$/m, "Status: finished"),                           // a status the console does not know
    text.replace('From: partner "korea-trip"', "From: someone"),                        // a result without its partner
    text.replace(`a line "answer ${boundary}"`, 'a line "answer"'),                     // no boundary announced
    text + "\nOne more line of the system.",                                             // something after the last answer
    text.replace("Result 1 of 2", "Result 1 of 3"),                                     // fewer results than announced
    "Booked.",
  ]) expect(partnerResults(changed), changed.slice(-80)).toBeUndefined();
});
