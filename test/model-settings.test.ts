import { afterEach, expect, it } from "vitest";
import type { WorkSessions } from "@agent-router/server";
import { ModelSettings, readModelOptions } from "../src/model-settings.js";
import { DurableStore } from "../src/store.js";

const stores: DurableStore[] = [];
afterEach(() => stores.splice(0).forEach(store => store.close()));

const codex = {
  id: "personal", kernel: "codex", model: "large",
  allowedSettings: { model: { values: ["large", "small", "unlisted"] }, effort: { values: ["low", "medium", "high"] } },
  native: { models: { data: [
    { id: "large", model: "large", displayName: "Large", description: "Careful work.", defaultReasoningEffort: "medium",
      supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "medium" }, { reasoningEffort: "high" }, { reasoningEffort: "xhigh" }] },
    { id: "small", model: "small", displayName: "Small", supportedReasoningEfforts: [{ reasoningEffort: "low" }] },
    { id: "hidden", model: "hidden", displayName: "Not allowed by the owner" },
  ], nextCursor: null } },
};

function setup(discovered: unknown = codex) {
  const store = new DurableStore(":memory:", "models"); stores.push(store);
  const state = { discovered, running: true, saved: {} as Record<string, unknown>, owners: [] as string[] };
  const work = {
    discover: async () => { if (!state.running) throw new Error("environment_not_ready"); return state.discovered; },
    defaultSettings: () => state.saved,
    setDefaultSettings: (value: Record<string, unknown>) => { state.saved = value; return value; },
  } as unknown as WorkSessions;
  const settings = new ModelSettings(store, async (owner) => { state.owners.push(owner); if (owner !== "alice") throw new Error("not_owned"); return work; });
  return { settings, state };
}

it("lists only models the owner allows, with the efforts each model supports and the owner allows", () => {
  expect(readModelOptions(codex)).toEqual({ kernel: "codex", defaultModel: "large", efforts: ["low", "medium", "high"], models: [
    { id: "large", label: "Large", description: "Careful work.", efforts: ["low", "medium", "high"], defaultEffort: "medium" },
    { id: "small", label: "Small", efforts: ["low"] },
    // Allowed by the owner but not reported by the kernel: shown by its id, with every allowed effort.
    { id: "unlisted", label: "unlisted", efforts: ["low", "medium", "high"] },
  ] });
  // The Claude SDK reports a flat list with its own field names.
  expect(readModelOptions({ kernel: "claude", allowedSettings: { model: { values: ["opus"] }, effort: { values: ["high", "max"] } },
    native: { models: [{ value: "opus", displayName: "Opus", supportedEffortLevels: ["low", "high", "max"] }] } }).models)
    .toEqual([{ id: "opus", label: "Opus", efforts: ["high", "max"] }]);
  // No list from the owner means nothing is selectable, whatever the kernel reports.
  expect(readModelOptions({ kernel: "codex", native: codex.native })).toEqual({ kernel: "codex", models: [], efforts: [] });
  expect(readModelOptions("unexpected")).toEqual({ models: [], efforts: [] });
});

it("saves a valid choice through Router, refuses values outside the options and keeps the last reading while the environment sleeps", async () => {
  const { settings, state } = setup();
  await expect(settings.view("bob", "agent")).rejects.toThrow("not_owned");
  expect(await settings.view("alice", "agent")).toMatchObject({ source: "live", selection: {}, defaultModel: "large" });
  await expect(settings.select("alice", "agent", { model: "hidden" })).rejects.toThrow("model_not_available");
  await expect(settings.select("alice", "agent", { effort: "xhigh" })).rejects.toThrow("effort_not_available");
  await expect(settings.select("alice", "agent", { model: "small", effort: "high" })).rejects.toThrow("effort_not_available");
  await expect(settings.select("alice", "agent", { provider: "other" })).rejects.toThrow();
  expect(state.saved).toEqual({});
  state.saved = { serviceTier: "fast" };
  expect((await settings.select("alice", "agent", { model: "small", effort: "low" })).selection).toEqual({ model: "small", effort: "low" });
  expect(state.saved).toEqual({ serviceTier: "fast", model: "small", effort: "low" });
  // Sleeping: the saved reading still answers, and a choice can still be changed against it.
  state.running = false;
  expect(await settings.view("alice", "agent")).toMatchObject({ source: "saved", selection: { model: "small", effort: "low" }, models: [{ id: "large" }, { id: "small" }, { id: "unlisted" }] });
  expect((await settings.select("alice", "agent", { model: null, effort: "high" })).selection).toEqual({ effort: "high" });
  expect(state.saved).toEqual({ serviceTier: "fast", effort: "high" });
  settings.forget("agent");
  expect(await settings.view("alice", "agent")).toMatchObject({ source: "none", models: [], efforts: [] });
  await expect(settings.select("alice", "agent", { effort: null })).rejects.toThrow("model_settings_unavailable");
});
