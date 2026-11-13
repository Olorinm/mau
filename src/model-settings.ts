import { z } from "zod";
import { RouterError, type WorkSessions } from "@agent-router/server";
import type { DurableStore } from "./store.js";

/** One model the employee's kernel offers and its runtime owner allows. */
export interface ModelOption { id: string; label: string; description?: string; efforts: string[]; defaultEffort?: string }
export interface ModelSettingsView {
  kernel?: string;
  /** The runtime's configured model, used when the owner selects none. */
  defaultModel?: string;
  models: ModelOption[];
  /** Effort values the runtime owner allows; a model lists the ones it supports. */
  efforts: string[];
  selection: { model?: string; effort?: string };
  /** `live`: read from the running kernel now. `saved`: the last reading, because the environment is not running. */
  source: "live" | "saved" | "none";
}
interface Reading { kernel?: string; defaultModel?: string; models: ModelOption[]; efforts: string[] }

const collection = "model_settings_readings";
const text = z.string().min(1).max(200);
const allowed = z.object({ values: z.array(z.unknown()) }).passthrough();
const description = z.object({
  kernel: z.string().optional(), model: z.string().optional(),
  allowedSettings: z.object({ model: allowed.optional(), effort: allowed.optional() }).passthrough().optional(),
  native: z.object({ models: z.unknown() }).passthrough().optional(),
}).passthrough();
/** Codex lists `{ model, displayName, supportedReasoningEfforts }`; the Claude SDK lists `{ value, displayName, supportedEffortLevels }`. */
const catalogEntry = z.object({
  id: z.string().optional(), model: z.string().optional(), value: z.string().optional(),
  displayName: z.string().optional(), description: z.string().optional(),
  supportedReasoningEfforts: z.array(z.object({ reasoningEffort: z.string() }).passthrough()).optional(),
  supportedEffortLevels: z.array(z.string()).optional(), defaultReasoningEffort: z.string().optional(),
}).passthrough();
export const modelSelectionInput = z.object({ model: text.nullable().optional(), effort: text.nullable().optional() }).strict();
const strings = (values: unknown[] | undefined) => (values ?? []).filter((value): value is string => typeof value === "string" && value.length > 0 && value.length <= 200);

/** Only what the kernel reported and the owner's list allows; nothing is inferred from a model's name. */
export function readModelOptions(discovered: unknown): Reading {
  const parsed = description.safeParse(discovered);
  if (!parsed.success) return { models: [], efforts: [] };
  const { kernel, model, allowedSettings, native } = parsed.data;
  const listed = native?.models && typeof native.models === "object" && !Array.isArray(native.models) ? (native.models as { data?: unknown }).data : native?.models;
  const catalog = new Map<string, z.infer<typeof catalogEntry>>();
  for (const item of Array.isArray(listed) ? listed : []) {
    const entry = catalogEntry.safeParse(item);
    const id = entry.success ? entry.data.model ?? entry.data.value ?? entry.data.id : undefined;
    if (entry.success && id && !catalog.has(id)) catalog.set(id, entry.data);
  }
  const efforts = strings(allowedSettings?.effort?.values);
  const models = strings(allowedSettings?.model?.values).map((id): ModelOption => {
    const entry = catalog.get(id);
    const supported = entry?.supportedReasoningEfforts?.map(item => item.reasoningEffort) ?? entry?.supportedEffortLevels;
    const usable = supported ? supported.filter(value => efforts.includes(value)) : efforts;
    return { id, label: entry?.displayName ?? id, ...(entry?.description ? { description: entry.description.slice(0, 500) } : {}), efforts: usable,
      ...(entry?.defaultReasoningEffort && usable.includes(entry.defaultReasoningEffort) ? { defaultEffort: entry.defaultReasoningEffort } : {}) };
  });
  return { ...(kernel ? { kernel } : {}), ...(model ? { defaultModel: model } : {}), models, efforts };
}

/** The owner's model and effort choice for one employee. Router stores it and sends it with every turn; Host enforces the allowed list. */
export class ModelSettings {
  constructor(private readonly store: DurableStore, private readonly sessions: (owner: string, agentId: string) => Promise<WorkSessions>) {}

  async view(owner: string, agentId: string): Promise<ModelSettingsView> {
    const work = await this.sessions(owner, agentId);
    let reading: Reading | undefined, source: ModelSettingsView["source"] = "live";
    try { reading = readModelOptions(await work.discover()); this.store.set(collection, agentId, reading); }
    catch { reading = this.store.get<Reading>(collection, agentId); source = reading ? "saved" : "none"; }
    const saved = work.defaultSettings(), selection: ModelSettingsView["selection"] = {};
    if (typeof saved.model === "string") selection.model = saved.model;
    if (typeof saved.effort === "string") selection.effort = saved.effort;
    return { ...(reading ?? { models: [], efforts: [] }), selection, source };
  }

  /** `null` clears a choice. Other default settings the Router holds for the agent are kept. */
  async select(owner: string, agentId: string, input: unknown): Promise<ModelSettingsView> {
    const change = modelSelectionInput.parse(input), current = await this.view(owner, agentId);
    if (current.source === "none") throw new RouterError("model_settings_unavailable", 409);
    const model = change.model === undefined ? current.selection.model : change.model ?? undefined;
    const effort = change.effort === undefined ? current.selection.effort : change.effort ?? undefined;
    if (model !== undefined && !current.models.some(option => option.id === model)) throw new RouterError("model_not_available", 400);
    const efforts = current.models.find(option => option.id === (model ?? current.defaultModel))?.efforts ?? current.efforts;
    if (effort !== undefined && !efforts.includes(effort)) throw new RouterError("effort_not_available", 400);
    const work = await this.sessions(owner, agentId), { model: _model, effort: _effort, ...rest } = work.defaultSettings();
    work.setDefaultSettings({ ...rest, ...(model ? { model } : {}), ...(effort ? { effort } : {}) });
    return { ...current, selection: { ...(model ? { model } : {}), ...(effort ? { effort } : {}) } };
  }

  forget(agentId: string) { this.store.delete(collection, agentId); }
}
