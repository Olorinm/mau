/*
 * What partners send each other arrives in a conversation as the text the receiving model reads: the message or the
 * results inside fixed lines written by Mau (`src/partner-text.ts`). Router's chat events carry that text and no
 * structured copy of it, so the console reads the fixed lines here and shows what the partners wrote. Text that
 * does not have the expected form is not read: the caller shows it whole.
 */

export type PartnerIntent = "relay" | "ask";
/** A message one partner sent another, as the receiving partner's conversation records it. */
export interface PartnerMessageText { from?: string; intent?: PartnerIntent; text: string }
export type PartnerResultStatus = "completed" | "failed" | "cancelled" | "rejected" | "unknown";
/** One partner's result, as the sender's conversation records it. */
export interface PartnerResult {
  partner: string;
  status: PartnerResultStatus;
  /** Why it is not completed: a code (`no_answer_after_48_hours`) or the partner runtime's own words. */
  reason?: string;
  /** The partner's answer; empty when it gave none. */
  answer: string;
  /** Characters left out of a long answer; the whole answer is in that partner's conversation. */
  cut?: number;
}

const messageHeader = "[Partner message:", resultsHeader = "[Partner results:";
const messageStart = "\nEverything below this line is the message.\n\n";
/** Whether the text is one that Mau wrote around what a partner sent. */
export const isPartnerText = (text: string) => text.startsWith(messageHeader) || text.startsWith(resultsHeader);

/** The message inside the lines a receiving partner is given, or nothing when the text has another form. */
export function partnerMessage(text: string): PartnerMessageText | undefined {
  if (!text.startsWith(messageHeader)) return undefined;
  // The message is the last part; the first marker is the one Mau wrote, whatever the message contains.
  const start = text.indexOf(messageStart);
  if (start < 0) return undefined;
  const head = text.slice(0, start), from = /^From: partner "([^"\n]+)"/m.exec(head)?.[1], intent = /^Intent: (relay|ask):/m.exec(head)?.[1];
  return { ...(from ? { from } : {}), ...(intent ? { intent: intent as PartnerIntent } : {}), text: text.slice(start + messageStart.length) };
}

const statuses: readonly string[] = ["completed", "failed", "cancelled", "rejected", "unknown"];
const cutNote = /\n\[cut: (\d+) more characters; the full answer is in that partner's conversation\]$/;
function reasonOf(value: string | undefined): string | undefined {
  if (!value) return undefined;
  // A reason that is not a plain code is written as a JSON string.
  if (value.startsWith('"')) { try { const text: unknown = JSON.parse(value); return typeof text === "string" ? text : value; } catch { return value; } }
  return value;
}

/**
 * The results inside the lines a sender is given, in their order, or nothing when the text has another form. Each
 * answer stands between two lines that carry a value chosen after the answers were written, so an answer cannot
 * contain them.
 */
export function partnerResults(text: string): PartnerResult[] | undefined {
  if (!text.startsWith(resultsHeader)) return undefined;
  const boundary = /a line "answer ([0-9a-f]{6,64})" and a line "end of answer \1"/.exec(text)?.[1];
  if (!boundary) return undefined;
  const open = `\n----- answer ${boundary} -----\n`, close = `\n----- end of answer ${boundary} -----`;
  const results: PartnerResult[] = [];
  let position = 0;
  for (;;) {
    const start = text.indexOf(open, position);
    if (start < 0) break;
    const end = text.indexOf(close, start + open.length);
    if (end < 0) return undefined;
    // The lines about this result stand between the previous answer and this one.
    const head = text.slice(position, start);
    const partner = [...head.matchAll(/^From: partner "([^"\n]+)"$/gm)].at(-1)?.[1];
    const status = [...head.matchAll(/^Status: ([a-z]+)(?: \((.*)\))?$/gm)].at(-1);
    if (!partner || !status || !statuses.includes(status[1]!)) return undefined;
    let answer = text.slice(start + open.length, end);
    const cut = cutNote.exec(answer);
    if (cut) answer = answer.slice(0, cut.index);
    if (answer === "(no answer)") answer = "";
    const reason = reasonOf(status[2]);
    results.push({ partner, status: status[1] as PartnerResultStatus, ...(reason ? { reason } : {}), answer, ...(cut ? { cut: Number(cut[1]) } : {}) });
    position = end + close.length;
  }
  // Every result the text announces has to be read, and nothing may follow the last one.
  const announced = Number(/^Result \d+ of (\d+)$/m.exec(text)?.[1]);
  if (!results.length || results.length !== announced || text.slice(position).trim()) return undefined;
  return results;
}
