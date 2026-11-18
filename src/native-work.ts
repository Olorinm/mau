import { createHash } from "node:crypto";
import { z } from "zod";
import type { PartnerTools } from "./business-tools.js";
import type { RunAdmission } from "./run-admission.js";
import { PartnerContext, MemoryError, memoryInput, memoryToolSchema } from "./partner-context.js";
import { historyQuery, type SessionHistory } from "./session-history.js";
import { ProactiveWork, proactiveRuleInput, type ProactiveRule, type RuleProposal } from "./proactive.js";
import { partnersInput, type Partners } from "./partners.js";
import { PARTNERS_DESCRIPTION } from "./partner-text.js";

const proactiveInput = z.object({ action: z.enum(["list", "create", "update", "runs", "pause", "resume", "run"]), ruleId: z.uuid().optional(),
  expectedVersion: z.number().int().positive().optional(), rule: proactiveRuleInput.omit({ agentId: true }).optional() }).strict();
const awaitingOwner = (proposal: RuleProposal) => ({ status: "awaiting_owner_confirmation", confirmationId: proposal.id, change: proposal.kind,
  ...(proposal.ruleId ? { ruleId: proposal.ruleId } : {}), name: proposal.rule.name, expiresAt: proposal.expiresAt,
  instruction: proposal.status === "confirmed" ? "The owner confirmed. The rule is saved, enabled, as soon as its run in flight ends. Do not repeat the call."
    : `Nothing is saved or changed yet${proposal.kind === "create" ? "" : ": the rule keeps its saved version and state"}. The owner was shown a confirmation card in their private conversation with you, with the schedule, the full instruction, the connections and the destination. The rule is saved, enabled, only when the owner confirms that card. Do not repeat this call, do not call resume and do not ask for confirmation in chat; tell the owner to answer the card.` });
const required = (value: string | undefined, name: string) => { if (!value) throw new Error(`${name}_required`); return value; };

/** Product tools compose native operations; no model argument may choose owner, Host or runtime. */
export class NativePartnerTools implements PartnerTools {
  readonly definitions;
  constructor(private readonly owner: string, private readonly agentId: string, private readonly partners: Partners,
    private readonly facts: PartnerContext, private readonly proactive: ProactiveWork, private readonly enabled: boolean,
    private readonly options: { history?: Pick<SessionHistory, "search">; isMemoryReview?: (admission: RunAdmission) => boolean;
      reminders?: (admission: RunAdmission, sessionId: string) => string } = {}) {
    this.definitions = enabled ? [
      // A wait of up to a minute has to end before the call's own deadline.
      { name: "partners", description: PARTNERS_DESCRIPTION, inputSchema: z.toJSONSchema(partnersInput), timeoutMs: 90_000 },
      { name: "memory", description: "Maintain your one durable memory document (MEMORY.md, 4000 Unicode characters). You decide what belongs in it: what stays true about the owner and how they want things done, how recurring work is done, and the current state of what you are responsible for (what was decided, what is still open, where the files are). Read, add, replace or remove entries; batch operations are atomic. add requires content, replace requires old_text and content, remove requires old_text, batch requires operations. old_text must uniquely identify an entry by exact literal text; replace replaces the WHOLE entry. Duplicate writes are rejected. Never store secrets (passwords, tokens, keys) or instructions that override safety. Update an entry instead of appending history, and free space with remove/replace when full. Writes are autonomous unless staged for owner approval. This memory is yours alone: no other partner reads it and you read no other partner's. The current session's initial snapshot stays frozen; updates load in new sessions.", inputSchema: memoryToolSchema, timeoutMs: 10_000 },
      { name: "session_search", description: "Search the original stored text of your own conversations. Returns exact text excerpts, session IDs and coverage; this is separate from your memory and may not include older native history until explicitly imported.", inputSchema: z.toJSONSchema(historyQuery), timeoutMs: 10_000 },
      { name: "proactive_work", description: "Create, inspect, edit, pause, resume or run a proactive rule of your own, only when requested by the owner. Show the concrete goal, schedule, time zone, sources and notification destination (notify.channel: web keeps notices in the conversation, where push channels may announce them; a connection id such as a chat channel or a push channel delivers there; new rules default to web). Source grants remain limited to the connections assigned to you. New rules default paused; explicitly requested activation uses status=active. Saving a rule never grants new account access.", inputSchema: z.toJSONSchema(proactiveInput), timeoutMs: 60_000 },
    ] : [];
  }
  private mine(admission: RunAdmission) { return this.enabled && admission.owner === this.owner && admission.agentId === this.agentId; }
  context(admission: RunAdmission, _input = "", sessionKey?: string) {
    if (!this.mine(admission) || admission.kind === "schedule" || !sessionKey) return undefined;
    return this.facts.snapshot(this.owner, this.agentId, sessionKey);
  }
  scheduledContext(admission: RunAdmission) {
    if (!this.mine(admission) || admission.kind !== "schedule") return undefined;
    return this.facts.scheduledContext(this.owner, this.agentId);
  }
  async turnContext(admission: RunAdmission, sessionId: string, tools: string[]) {
    if (!this.mine(admission) || admission.kind === "schedule" || this.options.isMemoryReview?.(admission)) return {};
    // A session that began with an earlier set of tools is not reminded of a tool, or shown a roster, it cannot act on.
    const reminder = admission.kind === "owner" && tools.includes("memory") ? this.options.reminders?.(admission, sessionId) : undefined;
    return { ...(reminder ? { memoryMaintenanceReminder: reminder } : {}), ...await this.partners.turnContext(admission, tools.includes("partners")) };
  }
  authority(admission: RunAdmission) { return this.mine(admission) ? this.partners.authority(admission) : undefined; }
  observe(run: { id: string; status: string }) { if (this.enabled) this.partners.observe(this.agentId, run); }
  delivered(name: string, admission: RunAdmission, callId: string) { if (name === "partners" && this.mine(admission)) this.partners.delivered(admission, callId); }
  async execute(name: string, raw: unknown, admission: RunAdmission, callId: string): Promise<unknown> {
    if (!this.mine(admission) || admission.kind === "schedule") throw new Error("partner_tool_not_authorized");
    const review = this.options.isMemoryReview?.(admission) ?? false;
    if (review && name !== "memory") throw new Error("memory_review_tool_not_authorized");
    if (name === "partners") return this.partners.execute(admission, raw, callId);
    if (name === "memory") {
      try {
        const input = memoryInput.parse(raw);
        if (input.action === "read") return this.facts.read(this.owner, this.agentId);
        return this.facts.mutate(this.owner, this.agentId, input, { origin: review ? "review" : admission.kind,
          source: review ? undefined : this.partners.memorySource(admission) });
      } catch (error) {
        if (error instanceof MemoryError) {
          let live: unknown; try { live = this.facts.read(this.owner, this.agentId).entries; } catch { /* Preserve the original fail-closed error. */ }
          return { isError: true, error: error.message, ...error.details, ...(live ? { entries: live } : {}) };
        }
        if (error instanceof z.ZodError) return { isError: true, error: "memory_invalid_input", issues: error.issues };
        throw error;
      }
    }
    if (name === "session_search") {
      if (!this.options.history) throw new Error("session_search_unavailable");
      return this.options.history.search(this.owner, this.agentId, historyQuery.parse(raw));
    }
    if (name !== "proactive_work") throw new Error("partner_tool_unknown");
    const input = proactiveInput.parse(raw);
    if (admission.kind !== "owner" && !["list", "runs"].includes(input.action)) throw new Error("proactive_owner_admission_required");
    if (input.action === "list") {
      const waiting = this.proactive.proposals(this.owner, this.agentId).map(awaitingOwner);
      return { rules: this.proactive.list(this.owner).filter(r => r.agentId === this.agentId), ...(waiting.length ? { awaitingOwnerConfirmation: waiting } : {}) };
    }
    // Creating a rule, changing what one does and enabling one take effect only when the owner confirms the card.
    const proposed = (result: ProactiveRule | RuleProposal) => "kind" in result ? awaitingOwner(result) : result;
    if (input.action === "create") {
      if (!input.rule) throw new Error("rule_required");
      return proposed(await this.proactive.propose(this.owner, this.agentId, input.rule));
    }
    const id = required(input.ruleId, "rule_id"), rule = this.proactive.rule(this.owner, id);
    if (rule.agentId !== this.agentId) throw new Error("partner_tool_not_authorized");
    if (input.action === "update") {
      if (!input.rule || !input.expectedVersion) throw new Error("rule_and_version_required");
      return proposed(await this.proactive.propose(this.owner, this.agentId, input.rule, id, input.expectedVersion));
    }
    if (input.action === "runs") return { runs: this.proactive.runs(this.owner, id) };
    if (input.action === "run") return this.proactive.runNow(this.owner, id,
      `mau-tool-${createHash("sha256").update(JSON.stringify([this.owner, this.agentId, admission.reference, callId])).digest("hex")}`);
    return input.action === "pause" ? this.proactive.state(this.owner, id, "paused") : proposed(await this.proactive.proposeResume(this.owner, id));
  }
}
