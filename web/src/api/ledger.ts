import { ApiError, request } from "./http";

/*
 * Router owner-ledger web channel (agent-router ADR 0005, section 8).
 * HTTP carries every command and history read; one WebSocket per tab carries events.
 * Durable events are ordered per chat by (generation, seq); gaps are repaired from history.
 * This module has no React or Matrix dependency so the state machine is testable on its own.
 */

export const ledgerBase = "/_agent-router/v1/web";

// ---- Shared types (ADR 0005 §8.2) ----
export type Actor = { type: "person" | "agent" | "system" | "external"; id: string; name: string };
export type ChannelTag = { kind: "web" | "room" | "matrix" | "feishu" | "grove-mail" | "agentmail" | "telegram" | "weixin" | "schedule"; label?: string };
export type AttachmentRef = { attachmentId: string; name: string; contentType: string; size: number | null; sha256: string | null; url: string };
export type DeliveryState = { deliveryId: string; channel: ChannelTag; status: "queued" | "sending" | "sent" | "suppressed" | "rejected" | "unknown" | "replied"; error?: string };
export type CardStatus = "pending" | "answered" | "approved" | "rejected" | "expired" | "canceled";
export interface Card {
  cardId: string; agentId: string; turnId: string; claimId: string; callId: string;
  kind: "question" | "approval" | "connector_approval" | "sensitive";
  /** Phase 4: from the callId prefix; `router` marks Router's own cards (the unknown-turn "重新执行 / 不用了"). */
  source?: "host" | "mau-approval" | "mau-handoff" | "router";
  text: string;
  choices: Array<{ choiceId: string; label: string; style?: "primary" | "danger" }>;
  freeText: boolean;
  native?: { method: string; params: unknown };
  deadlineAt: string | null; status: CardStatus;
}
export type TurnState = "queued" | "running" | "waiting" | "completed" | "failed" | "canceled" | "unknown";
export type ChatEventBody =
  | { kind: "message"; role: "user" | "assistant"; text: string; html?: string; attachments?: AttachmentRef[];
      mentions?: { agentIds: string[]; all: boolean }; replyTo?: string; final?: boolean; possibleDuplicate?: boolean;
      deliveries?: DeliveryState[];
      /** Router phase 3: the stored target of a redaction (empty text), also when the `redaction` event is not loaded. */
      redacted?: boolean;
      /** Phase 4: steered into a running turn (rendered inside its run surface). */
      steer?: boolean }
  | { kind: "notice"; text: string; level: "info" | "warning" }
  | { kind: "action"; targetCardId: string; label: string }
  | { kind: "card"; card: Card }
  | { kind: "card.update"; cardId: string; status: CardStatus; answeredBy?: Actor; summary?: string }
  | { kind: "turn"; agentId: string; state: TurnState; inputEventIds: string[]; error?: string }
  | { kind: "delivery"; targetEventId: string; delivery: DeliveryState }
  | { kind: "edit"; targetEventId: string; text: string }
  | { kind: "redaction"; targetEventId: string }
  | { kind: "reaction"; targetEventId: string; key: string; removed: boolean }
  | { kind: "window"; window: number; reason: "reset" | "migration" }
  | { kind: "member"; action: "add" | "remove" | "rename"; member?: Actor; title?: string };
export type ChatEvent = {
  chatId: string; seq: number; generation: number; eventId: string; at: string;
  sender: Actor; channel?: ChannelTag; turnId?: string; idempotencyKey?: string;
} & ChatEventBody;
export interface ChatSummary {
  chatId: string; kind: "dm" | "group" | "observed"; title: string; agentIds: string[];
  readOnly: boolean; lastSeq: number; generation: number; readSeq: number; unread: number;
  lastEvent: { eventId: string; at: string; preview: string; sender: Actor } | null;
  activeTurns: number; pendingCards: number; updatedAt: string;
}
export interface Inflight { turnId: string; agentId: string; text: string; updatedAt: string; afterSeq: number }
export interface EventPage {
  chatId: string; generation: number; lastSeq: number;
  mode: "page" | "delta" | "reset";
  reset?: { reason: "generation_changed" | "gap_too_large" | "not_found" };
  events: ChatEvent[];
  olderCursor: number | null;
  newerCursor: number | null;
  inflight: Inflight[];
}
export interface SendRequest {
  idempotencyKey: string; text: string; attachments?: string[];
  mentions?: { agentIds: string[]; all?: boolean }; replyTo?: string;
}
export interface SendResponse {
  status: "accepted" | "duplicate"; event: ChatEvent;
  addressed: Array<{ agentId: string; state: "queued" | "control" | "not_addressed" }>;
}
/**
 * Owner redaction (撤回) of an own web message, ADR 0005 §16.4 (decision 4e; Router serves it from phase 3 with `send`):
 * `POST /chats/:chatId/events/:eventId/redact` with an idempotency key, answered with the stored `redaction` event,
 * the same way a send is answered with its stored message. `dropped`: the input had not started yet.
 */
export interface RedactResponse { status: "accepted" | "duplicate"; event: ChatEvent; dropped?: boolean }
export interface TurnDetail {
  turnId: string; chatId: string; agentId: string; state: string; admission: string;
  inputEventIds: string[]; finalEventId: string | null; cardIds: string[];
  runs: Array<{ claimId: string; runId: string | null; phase: "submitting" | "running" | "finished" | "unknown"; error: string | null }>;
}
export type AnswerBody = { choiceId: string } | { text: string } | { result: unknown };
export type AnswerRequest = { idempotencyKey: string } & AnswerBody;
export interface AnswerResponse { status: "accepted" | "duplicate" | "stale"; card: Card }
export interface ResetResponse { window: number; event: ChatEvent }
export interface PurgeResponse { generation: number; purgedEvents: number; window: number }
export type CancelResponse = { status: "accepted" } | { status: "already_finished"; state: string };
export type SteerResponse = { status: "accepted"; event: ChatEvent } | { status: "unsupported" };
export interface LedgerMe {
  person: { id: string; name: string }; ownerId: string; identities: unknown[];
  /** `features` is a name → boolean map (ADR 0005 "Client contract" 1); a missing name is off. */
  limits?: { features?: Partial<Record<LedgerFeature, boolean>> } & Record<string, unknown>;
}
/** A verified `(provider, namespace, subject)` of the owner (ADR 0005 phase 6 implementation notes). */
export interface PersonIdentity {
  identityId: string; personId: string; provider: string; namespace: string; subject: string;
  verifiedBy: "login" | "config" | "pairing" | "admin" | string; createdAt: string; lastSeenAt: string | null;
  removable: boolean; fixed?: "identity_from_config" | "identity_in_use";
}
export interface PairingCode { id: string; code: string; expiresAt: string; instructions: string }
export interface PendingPairingCode { id: string; createdAt: string; expiresAt: string }
export interface HistoryQuery { before?: number; after?: number; generation?: number; limit?: number; strict?: boolean }

// ---- Flags ----
/** Console features Router advertises per migration phase (ADR 0005 §11). */
export type LedgerFeature = "history" | "send" | "cards" | "attachments" | "reset" | "groups" | "identity" | "matrix";
const featureNames: readonly LedgerFeature[] = ["history", "send", "cards", "attachments", "reset", "groups", "identity", "matrix"];
export const chatSourceKey = "mau.chatSource";

/** The console reads chats from Router only when the browser opted in; Matrix stays the default. */
export function chatSourcePreference(storage: Pick<Storage, "getItem"> | undefined = globalThis.localStorage): "matrix" | "ledger" {
  try { return storage?.getItem(chatSourceKey) === "ledger" ? "ledger" : "matrix"; } catch { return "matrix"; }
}

/** `limits.features` is a name → boolean map; only names set to `true` are on, unknown names are ignored. */
export function ledgerFeatures(me: LedgerMe | null | undefined): Set<LedgerFeature> {
  const raw = me?.limits?.features;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return new Set();
  return new Set(featureNames.filter((name) => (raw as Record<string, unknown>)[name] === true));
}

/**
 * Matrix is available unless Router says otherwise (ADR 0005 "Client contract" 1): every Router from phase 7 reports
 * `features.matrix` explicitly, so a missing entry (or no ledger API at all) is an older Router with Matrix.
 */
export function matrixEnabled(me: LedgerMe | null | undefined): boolean {
  const raw = me?.limits?.features as Record<string, unknown> | undefined;
  return !raw || typeof raw !== "object" || !("matrix" in raw) || raw.matrix === true;
}

// ---- HTTP ----
const keyPattern = /^[A-Za-z0-9_-]{16,128}$/;
export function newIdempotencyKey(): string {
  return crypto.randomUUID();
}

async function failure(response: Response): Promise<ApiError> {
  const data = await response.json().catch(() => undefined) as { error?: unknown } | undefined;
  return new ApiError(typeof data?.error === "string" && /^[A-Za-z0-9_]+$/.test(data.error) ? data.error
    : response.status === 429 ? "rate_limited" : "request_failed", response.status);
}

export function ledgerApi(token: string, base = ledgerBase) {
  const chat = (id: string) => base + "/chats/" + encodeURIComponent(id);
  const signalOf = (signal?: AbortSignal) => signal ? { signal } : {};
  return {
    me: (signal?: AbortSignal) => request<LedgerMe>(base + "/me", { token, ...signalOf(signal) }),
    socketTicket: () => request<{ ticket: string; expiresAt: string }>(base + "/socket-tickets", { token, body: {} }),
    chats: (cursor?: string | null, signal?: AbortSignal) => request<{ data: ChatSummary[]; next: string | null }>(
      base + "/chats?" + new URLSearchParams({ archived: "false", ...(cursor ? { cursor } : {}) }), { token, ...signalOf(signal) }),
    openDm: (agentId: string) => request<ChatSummary>(base + "/chats/dm", { token, body: { agentId } }),
    chat: (chatId: string, signal?: AbortSignal) => request<ChatSummary & { members: Actor[] }>(chat(chatId), { token, ...signalOf(signal) }),
    events: (chatId: string, query: HistoryQuery = {}, signal?: AbortSignal) => {
      const params = new URLSearchParams();
      if (query.before !== undefined) params.set("before", String(query.before));
      if (query.after !== undefined) params.set("after", String(query.after));
      if (query.generation !== undefined) params.set("generation", String(query.generation));
      if (query.limit !== undefined) params.set("limit", String(query.limit));
      if (query.strict) params.set("strict", "true");
      const search = params.toString();
      return request<EventPage>(chat(chatId) + "/events" + (search ? "?" + search : ""), { token, ...signalOf(signal) });
    },
    send: (chatId: string, body: SendRequest) => {
      if (!keyPattern.test(body.idempotencyKey)) throw new ApiError("invalid_idempotency_key", 0);
      return request<SendResponse>(chat(chatId) + "/messages", { token, body });
    },
    redact: (chatId: string, eventId: string, idempotencyKey: string) => {
      if (!keyPattern.test(idempotencyKey)) throw new ApiError("invalid_idempotency_key", 0);
      return request<RedactResponse>(chat(chatId) + "/events/" + encodeURIComponent(eventId) + "/redact", { token, body: { idempotencyKey } });
    },
    /** "新对话": 409 `session_busy` while a turn runs, unless `cancelActive` (ADR 0005 16.3). */
    reset: (chatId: string, idempotencyKey: string, cancelActive = false) =>
      request<ResetResponse>(chat(chatId) + "/reset", { token, body: { idempotencyKey, ...(cancelActive ? { cancelActive: true } : {}) } }),
    /** Permanent; `confirm` must equal the chat id (typed confirmation, ADR 0005 16.4). */
    purge: (chatId: string, confirm: string, idempotencyKey: string, cancelActive = false) =>
      request<PurgeResponse>(chat(chatId) + "/purge", { token, body: { idempotencyKey, confirm, ...(cancelActive ? { cancelActive: true } : {}) } }),
    /** The live card: while a handoff card is pending its text carries the private link, which history never stores. */
    card: (chatId: string, cardId: string, signal?: AbortSignal) => request<Card>(chat(chatId) + "/cards/" + encodeURIComponent(cardId), { token, ...signalOf(signal) }),
    read: (chatId: string, seq: number) => request<{ readSeq: number; unread: number }>(chat(chatId) + "/read", { token, body: { seq } }),
    turn: (chatId: string, turnId: string, signal?: AbortSignal) => request<TurnDetail>(chat(chatId) + "/turns/" + encodeURIComponent(turnId), { token, ...signalOf(signal) }),
    cancelTurn: (chatId: string, turnId: string) => request<CancelResponse>(chat(chatId) + "/turns/" + encodeURIComponent(turnId) + "/cancel", { token, body: {} }),
    steer: (chatId: string, turnId: string, text: string, idempotencyKey = newIdempotencyKey()) =>
      request<SteerResponse>(chat(chatId) + "/turns/" + encodeURIComponent(turnId) + "/steer", { token, body: { idempotencyKey, text } }),
    answerCard: (chatId: string, cardId: string, answer: AnswerRequest) => {
      if (!keyPattern.test(answer.idempotencyKey)) throw new ApiError("invalid_idempotency_key", 0);
      return request<AnswerResponse>(chat(chatId) + "/cards/" + encodeURIComponent(cardId) + "/answer", { token, body: answer });
    },
    createGroup: (title: string, agentIds: string[], idempotencyKey = newIdempotencyKey()) =>
      request<ChatSummary>(base + "/groups", { token, body: { idempotencyKey, title, agentIds } }),
    updateGroup: (roomId: string, patch: { title?: string; archived?: boolean }) =>
      request<ChatSummary>(base + "/groups/" + encodeURIComponent(roomId), { token, method: "PATCH", body: patch }),
    addMember: (roomId: string, agentId: string) =>
      request<{ members: Actor[] }>(base + "/groups/" + encodeURIComponent(roomId) + "/members", { token, body: { agentId } }),
    removeMember: (roomId: string, agentId: string) =>
      request<{ members: Actor[] }>(base + "/groups/" + encodeURIComponent(roomId) + "/members/" + encodeURIComponent(agentId), { token, method: "DELETE" }),
    identities: (signal?: AbortSignal) => request<{ data: PersonIdentity[] }>(base + "/identities", { token, ...signalOf(signal) }),
    revokeIdentity: (identityId: string) => request<null>(base + "/identities/" + encodeURIComponent(identityId), { token, method: "DELETE" }),
    pairingCodes: (signal?: AbortSignal) => request<{ data: PendingPairingCode[] }>(base + "/identities/pairing-codes", { token, ...signalOf(signal) }),
    createPairingCode: () => request<PairingCode>(base + "/identities/pairing-codes", { token, body: {} }),
    cancelPairingCode: (id: string) => request<null>(base + "/identities/pairing-codes/" + encodeURIComponent(id), { token, method: "DELETE" }),
    /**
     * Raw-body upload (ADR 0005 16.5, client contract 8): the body is the `Blob` itself, never a `ReadableStream`, so the
     * browser sets `Content-Length`. In a browser it goes through XMLHttpRequest for upload progress; elsewhere through fetch.
     */
    async uploadAttachment(file: Blob, name: string, options: AbortSignal | UploadOptions = {}): Promise<AttachmentRef> {
      const { signal, onProgress, maxBytes } = options instanceof AbortSignal ? { signal: options } as UploadOptions : options;
      if (maxBytes !== undefined && file.size > maxBytes) throw new ApiError("attachment_too_large", 413);
      const headers = {
        // An edge login (Cloudflare Access) has no token: no bearer, the edge adds its JWT.
        Accept: "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}),
        "Content-Type": file.type || "application/octet-stream",
        "X-File-Name": "UTF-8''" + encodeURIComponent(name),
        "X-Sha256": await sha256Hex(file),
      };
      if (typeof XMLHttpRequest === "function") return xhrUpload(base + "/attachments", file, headers, onProgress, signal);
      const response = await fetch(base + "/attachments", {
        // Same-origin cookies let an edge access gate (Cloudflare Access) pass the request.
        method: "POST", credentials: "same-origin", redirect: "error", body: await file.arrayBuffer(), headers,
        ...signalOf(signal),
      }).catch(() => { throw new ApiError(signal?.aborted ? "upload_aborted" : "network_error", 0); });
      if (!response.ok) throw await failure(response);
      const ref = await response.json() as AttachmentRef;
      onProgress?.(file.size, file.size);
      return ref;
    },
    /**
     * Bytes of an attachment from its same-origin URL. Before the edge identity (phase 6) the URL needs the bearer
     * header, so the console fetches it and shows it through `URL.createObjectURL`.
     */
    async downloadAttachment(attachment: string | Pick<AttachmentRef, "attachmentId">, signal?: AbortSignal): Promise<Blob> {
      const response = await fetch(attachmentUrl(attachment, base), {
        credentials: "same-origin", redirect: "error", headers: token ? { Authorization: `Bearer ${token}` } : {}, ...signalOf(signal),
      }).catch(() => { throw new ApiError("network_error", 0); });
      if (!response.ok) throw await failure(response);
      return response.blob();
    },
  };
}
export type LedgerApi = ReturnType<typeof ledgerApi>;

// ---- Attachments (ADR 0005 16.5) ----
export interface UploadOptions {
  signal?: AbortSignal;
  /** Bytes sent so far and the total, as the browser reports them. */
  onProgress?(loaded: number, total: number): void;
  /** `limits.attachmentBytes`: larger files are refused before any bytes are sent (413 `attachment_too_large`). */
  maxBytes?: number;
}
async function sha256Hex(file: Blob): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", await file.arrayBuffer()))].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function xhrUpload(url: string, file: Blob, headers: Record<string, string>, onProgress: UploadOptions["onProgress"], signal: AbortSignal | undefined): Promise<AttachmentRef> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new ApiError("upload_aborted", 0)); return; }
    const xhr = new XMLHttpRequest();
    const abort = () => xhr.abort();
    xhr.open("POST", url);
    // Same-origin requests carry the edge access cookie by default (`withCredentials` only affects cross-origin).
    for (const [name, value] of Object.entries(headers)) xhr.setRequestHeader(name, value);
    xhr.upload.onprogress = (event) => { if (event.lengthComputable) onProgress?.(event.loaded, event.total); };
    xhr.onload = () => {
      signal?.removeEventListener("abort", abort);
      let data: { error?: unknown } | undefined;
      try { data = JSON.parse(xhr.responseText); } catch { data = undefined; }
      if (xhr.status === 201 || xhr.status === 200) { onProgress?.(file.size, file.size); resolve(data as unknown as AttachmentRef); return; }
      reject(new ApiError(typeof data?.error === "string" && /^[A-Za-z0-9_]+$/.test(data.error) ? data.error
        : xhr.status === 429 ? "rate_limited" : xhr.status === 413 ? "attachment_too_large" : "request_failed", xhr.status));
    };
    xhr.onerror = () => { signal?.removeEventListener("abort", abort); reject(new ApiError("network_error", 0)); };
    xhr.onabort = () => { signal?.removeEventListener("abort", abort); reject(new ApiError("upload_aborted", 0)); };
    signal?.addEventListener("abort", abort, { once: true });
    xhr.send(file);
  });
}
/**
 * The same-origin download URL (`/_agent-router/v1/web/attachments/<id>`, the `url` the server returns). It is built
 * from the id, so a stored or forged `url` can never point the console at another origin or path.
 */
export function attachmentUrl(attachment: string | Pick<AttachmentRef, "attachmentId">, base = ledgerBase): string {
  return base + "/attachments/" + encodeURIComponent(typeof attachment === "string" ? attachment : attachment.attachmentId);
}
export type AttachmentKind = "image" | "text" | "file";
/** Inline images: raster types only (SVG downloads like any other file). */
export function attachmentKind(contentType: string): AttachmentKind {
  return /^image\/(png|jpeg|gif|webp|avif|bmp)$/.test(contentType) ? "image" : contentType.startsWith("text/") ? "text" : "file";
}
export function formatBytes(size: number | null | undefined): string {
  if (size === null || size === undefined) return "";
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(size < 10 * 1024 ? 1 : 0)} KB`;
  return `${(size / 1024 / 1024).toFixed(size < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}
/** Attachment limits from `GET /me` (`limits.attachmentBytes`, `attachmentsPerMessage`), with the ADR defaults. */
export function attachmentLimits(me: LedgerMe | null | undefined): { bytes: number; perMessage: number; quotaBytes: number | null } {
  const limits = me?.limits ?? {}, number = (value: unknown, fallback: number) => typeof value === "number" && value > 0 ? value : fallback;
  return { bytes: number(limits.attachmentBytes, 25 * 1024 * 1024), perMessage: number(limits.attachmentsPerMessage, 10),
    quotaBytes: typeof limits.attachmentQuotaBytes === "number" ? limits.attachmentQuotaBytes : null };
}

export interface DraftAttachment {
  id: string; chatId: string; name: string; contentType: string; size: number; kind: AttachmentKind;
  state: "uploading" | "ready" | "failed";
  /** Bytes sent so far while uploading. */
  loaded: number;
  error?: string; ref?: AttachmentRef;
  /** A local object URL for image previews in the composer. */
  previewUrl?: string;
}
interface DraftEntry { item: DraftAttachment; file: File; abort?: AbortController }
export interface AttachmentDraftOptions {
  limits?(): { bytes: number; perMessage: number };
  preview?(file: File): string | undefined;
  revoke?(url: string): void;
  id?(): string;
}
/**
 * Composer attachments per chat: each picked, pasted or dropped file is uploaded at once (one at a time per chat),
 * with progress; too many or too large files fail before upload. A send takes the uploaded references.
 */
export class AttachmentDrafts {
  private readonly chats = new Map<string, DraftEntry[]>();
  private readonly queues = new Map<string, Promise<void>>();
  private readonly listeners = new Set<() => void>();
  private version = 0;
  private next = 0;
  constructor(private readonly upload: (file: File, name: string, options: UploadOptions) => Promise<AttachmentRef>, private readonly options: AttachmentDraftOptions = {}) {}
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  getVersion = () => this.version;
  private notify() { this.version++; for (const listener of this.listeners) listener(); }
  private entries(chatId: string) { let list = this.chats.get(chatId); if (!list) this.chats.set(chatId, list = []); return list; }
  list(chatId: string): DraftAttachment[] { return (this.chats.get(chatId) ?? []).map((entry) => entry.item); }
  busy(chatId: string): boolean { return this.list(chatId).some((item) => item.state === "uploading"); }
  ready(chatId: string): AttachmentRef[] { return this.list(chatId).flatMap((item) => item.state === "ready" && item.ref ? [item.ref] : []); }
  add(chatId: string, files: readonly File[]): void {
    const limits = this.options.limits?.() ?? { bytes: 25 * 1024 * 1024, perMessage: 10 };
    const list = this.entries(chatId);
    for (const file of files) {
      const kind = attachmentKind(file.type), name = file.name || "attachment";
      const preview = kind === "image" ? this.options.preview?.(file) : undefined;
      const item: DraftAttachment = { id: this.options.id?.() ?? `draft-${++this.next}`, chatId, name, contentType: file.type || "application/octet-stream",
        size: file.size, kind, state: "uploading", loaded: 0, ...(preview ? { previewUrl: preview } : {}) };
      const entry: DraftEntry = { item, file };
      const counted = list.filter((other) => other.item.state !== "failed").length;
      list.push(entry);
      if (counted >= limits.perMessage) { this.fail(entry, "too_many_attachments"); continue; }
      if (file.size > limits.bytes) { this.fail(entry, "attachment_too_large"); continue; }
      this.enqueue(entry);
    }
    this.notify();
  }
  private fail(entry: DraftEntry, error: string) { entry.item = { ...entry.item, state: "failed", error }; }
  private enqueue(entry: DraftEntry) {
    const chatId = entry.item.chatId, prior = this.queues.get(chatId) ?? Promise.resolve();
    entry.abort = new AbortController();
    const run = prior.then(() => this.send(entry));
    this.queues.set(chatId, run);
    void run.finally(() => { if (this.queues.get(chatId) === run) this.queues.delete(chatId); });
  }
  private async send(entry: DraftEntry) {
    if (!this.has(entry) || entry.abort?.signal.aborted) return;
    try {
      const limits = this.options.limits?.();
      const ref = await this.upload(entry.file, entry.item.name, { signal: entry.abort!.signal, ...(limits ? { maxBytes: limits.bytes } : {}),
        onProgress: (loaded) => { if (!this.has(entry)) return; entry.item = { ...entry.item, loaded }; this.notify(); } });
      if (!this.has(entry)) return;
      entry.item = { ...entry.item, state: "ready", loaded: entry.item.size, ref };
      delete entry.item.error;
    } catch (error) {
      if (!this.has(entry)) return;
      this.fail(entry, error instanceof ApiError ? error.code : "request_failed");
    }
    this.notify();
  }
  private has(entry: DraftEntry) { return this.chats.get(entry.item.chatId)?.includes(entry) ?? false; }
  /** Upload a failed file again (not for files refused by the limits). */
  retry(chatId: string, id: string) {
    const entry = this.chats.get(chatId)?.find((other) => other.item.id === id);
    if (!entry || entry.item.state !== "failed" || ["too_many_attachments", "attachment_too_large"].includes(entry.item.error ?? "")) return;
    entry.item = { ...entry.item, state: "uploading", loaded: 0 }; delete entry.item.error;
    this.enqueue(entry);
    this.notify();
  }
  remove(chatId: string, id: string) {
    const list = this.chats.get(chatId), index = list?.findIndex((entry) => entry.item.id === id) ?? -1;
    if (!list || index < 0) return;
    const [entry] = list.splice(index, 1);
    entry!.abort?.abort();
    if (entry!.item.previewUrl) this.options.revoke?.(entry!.item.previewUrl);
    this.notify();
  }
  /** The uploaded references for a send; the chat's drafts are cleared (failed ones too). */
  take(chatId: string): AttachmentRef[] {
    const refs = this.ready(chatId);
    for (const entry of this.chats.get(chatId) ?? []) { entry.abort?.abort(); if (entry.item.previewUrl) this.options.revoke?.(entry.item.previewUrl); }
    this.chats.delete(chatId);
    this.notify();
    return refs;
  }
}
/** What the state machine needs from HTTP; tests supply a fake server. */
export type LedgerTransport = Pick<LedgerApi, "socketTicket" | "events" | "send" | "read" | "chats" | "redact">;
/** Phase 4 commands (cards and control); a transport without them cannot answer, reset or purge. */
export type LedgerCommands = Pick<LedgerApi, "answerCard" | "reset" | "purge" | "steer" | "cancelTurn">;

// ---- Socket ----
export interface LedgerSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code: number; reason?: string }) => void) | null;
  onerror: ((event: unknown) => void) | null;
}
export type SocketFactory = (url: string) => LedgerSocket;
export interface LedgerClock {
  now(): number;
  random(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}
const systemClock: LedgerClock = {
  now: () => Date.now(), random: () => Math.random(),
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
};
export function browserSocketUrl(ticket: string, location: Pick<Location, "protocol" | "host"> = globalThis.location): string {
  return `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}${ledgerBase}/socket?` + new URLSearchParams({ ticket });
}

// ---- State machine ----
export type ConnectionState = "idle" | "connecting" | "open" | "reconnecting" | "closed";
export interface PendingSend {
  idempotencyKey: string; chatId: string; text: string; attachments: AttachmentRef[];
  mentions?: { agentIds: string[]; all?: boolean }; replyTo?: string;
  state: "sending" | "accepted" | "failed" | "rejected"; error?: string; createdAt: number;
  /** Transmissions so far; network failures are retried automatically with the same key. */
  attempts: number;
  /** Set while an automatic retry is scheduled (epoch ms). */
  retryAt?: number;
}
export interface PendingRedaction { chatId: string; eventId: string; idempotencyKey: string; state: "sending" | "failed" | "rejected"; error?: string }
/**
 * A card answer in flight. `stale`: another surface (chat, run view, another tab) answered first; the card's own
 * `card.update` closes it. A network failure keeps the key, so a retry cannot answer twice.
 */
export interface PendingAnswer { chatId: string; cardId: string; idempotencyKey: string; body: AnswerBody; state: "sending" | "failed" | "rejected" | "stale"; error?: string }
export interface LedgerChatView {
  chatId: string; loaded: boolean; generation: number; lastSeq: number; readSeq: number;
  events: readonly ChatEvent[]; hasOlder: boolean; inflight: readonly Inflight[];
  pending: readonly PendingSend[]; redactions: readonly PendingRedaction[]; answers: readonly PendingAnswer[]; error?: string;
}
interface ChatState {
  chatId: string; loaded: boolean; generation: number; lastSeq: number; readSeq: number;
  events: ChatEvent[]; olderCursor: number | null;
  inflight: Map<string, Inflight>;
  /** Live frames past a gap, kept until history fills it. */
  buffered: Map<number, ChatEvent>;
  repair?: Promise<void>; retry?: unknown;
  error?: string; view?: LedgerChatView;
}
interface Request { method: string; chatIds: string[] }

const terminalTurn = new Set<TurnState>(["completed", "failed", "canceled", "unknown"]);
const retryable = (error: unknown) => !(error instanceof ApiError) || error.status === 0 || error.status === 429 || error.status >= 500;

export interface LedgerClientOptions {
  socket: SocketFactory;
  socketUrl?: (ticket: string) => string;
  clock?: LedgerClock;
  idempotencyKey?: () => string;
  /** Maximum reconnect delay; the base doubles from 1 s. */
  maxBackoffMs?: number;
  /** Automatic resends after a network failure (1 s, 2 s, 4 s …); then the bubble waits for a manual retry. */
  sendRetries?: number;
}

/**
 * Owner-scoped chat state over the ledger web API: history pages, a live socket with per-chat seq,
 * gap catch-up, reset/snapshot reloads, reconnect with backoff, and optimistic sends deduped by idempotencyKey.
 */
export class LedgerClient {
  readonly chats = new Map<string, ChatSummary>();
  connection: { state: ConnectionState; epoch?: string; attempt: number; error?: string } = { state: "idle", attempt: 0 };
  private readonly states = new Map<string, ChatState>();
  /** Chats the UI has open; they are (re)subscribed on every socket. */
  private readonly open = new Set<string>();
  private readonly pending = new Map<string, PendingSend>();
  private readonly resend = new Map<string, unknown>();
  private readonly redactions = new Map<string, PendingRedaction>();
  private readonly answers = new Map<string, PendingAnswer>();
  private readonly listeners = new Set<() => void>();
  private readonly requests = new Map<string, Request>();
  private readonly clock: LedgerClock;
  private socket: LedgerSocket | undefined;
  private reconnectTimer: unknown;
  private reauthorizedAt = -Infinity;
  private heartbeat: unknown;
  private heartbeatMs = 30_000;
  private lastFrameAt = 0;
  private nextRequest = 1;
  private version = 0;
  private stopped = true;

  constructor(private readonly api: LedgerTransport & Partial<LedgerCommands>, private readonly options: LedgerClientOptions) {
    this.clock = options.clock ?? systemClock;
  }

  // -- observation (useSyncExternalStore) --
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  getVersion = () => this.version;
  private notify() {
    this.version++;
    for (const state of this.states.values()) delete state.view;
    for (const listener of this.listeners) listener();
  }

  view(chatId: string): LedgerChatView {
    const state = this.state(chatId);
    if (state.view) return state.view;
    const shown = new Set(state.events.flatMap((event) => event.idempotencyKey ? [event.idempotencyKey] : []));
    return state.view = {
      chatId, loaded: state.loaded, generation: state.generation, lastSeq: state.lastSeq, readSeq: state.readSeq,
      events: state.events, hasOlder: state.olderCursor !== null, inflight: [...state.inflight.values()],
      pending: [...this.pending.values()].filter((item) => item.chatId === chatId && (item.state === "rejected" || !shown.has(item.idempotencyKey))),
      redactions: [...this.redactions.values()].filter((item) => item.chatId === chatId),
      answers: [...this.answers.values()].filter((item) => item.chatId === chatId),
      ...(state.error ? { error: state.error } : {}),
    };
  }
  private state(chatId: string): ChatState {
    let state = this.states.get(chatId);
    if (!state) {
      state = { chatId, loaded: false, generation: 0, lastSeq: 0, readSeq: this.chats.get(chatId)?.readSeq ?? 0,
        events: [], olderCursor: null, inflight: new Map(), buffered: new Map() };
      this.states.set(chatId, state);
    }
    return state;
  }

  // -- chat index --
  async loadChats(signal?: AbortSignal) {
    let cursor: string | null = null;
    const seen = new Set<string>();
    do {
      const page: { data: ChatSummary[]; next: string | null } = await this.api.chats(cursor, signal);
      for (const summary of page.data) { seen.add(summary.chatId); this.updateSummary(summary); }
      cursor = page.next;
    } while (cursor);
    for (const chatId of [...this.chats.keys()]) if (!seen.has(chatId)) this.chats.delete(chatId);
    this.notify();
    return [...this.chats.values()];
  }
  updateSummary(summary: ChatSummary) {
    this.chats.set(summary.chatId, summary);
    const state = this.states.get(summary.chatId);
    if (!state) return;
    if (summary.readSeq > state.readSeq) state.readSeq = summary.readSeq;
    if (state.loaded && summary.generation !== state.generation) void this.snapshot(summary.chatId);
  }
  /** Newest activity first, as the server orders `GET /chats`. */
  chatList(): ChatSummary[] {
    return [...this.chats.values()].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  }

  // -- history --
  /** Load the latest page once and keep the chat subscribed while open. */
  async openChat(chatId: string) {
    this.open.add(chatId);
    const state = this.state(chatId);
    if (!state.loaded) await this.snapshot(chatId);
    else if (this.connection.state === "open") this.request("subscribe", [chatId]);
  }
  closeChat(chatId: string) {
    if (!this.open.delete(chatId)) return;
    if (this.connection.state === "open") this.request("unsubscribe", [chatId]);
  }
  async loadOlder(chatId: string) {
    const state = this.state(chatId);
    if (!state.loaded || state.olderCursor === null) return;
    const page = await this.api.events(chatId, { before: state.olderCursor });
    if (page.mode === "reset" || page.generation !== state.generation) return this.snapshot(chatId);
    const first = state.events[0]?.seq ?? Infinity;
    state.events = [...page.events.filter((event) => event.seq < first), ...state.events];
    state.olderCursor = page.olderCursor;
    this.notify();
  }

  /** Discard local events and load the latest page (reset, snapshot_required, generation change). */
  private snapshot(chatId: string): Promise<void> {
    const state = this.state(chatId);
    return this.serial(state, () => this.load(state));
  }
  /** Gap repair; concurrent callers share the running repair. */
  private repair(state: ChatState): Promise<void> {
    return state.repair ?? this.serial(state, () => this.catchUp(state));
  }
  /** One history operation per chat at a time; live frames are buffered meanwhile. */
  private serial(state: ChatState, task: () => Promise<void>): Promise<void> {
    const run = (state.repair ?? Promise.resolve()).catch(() => undefined).then(task);
    const tracked: Promise<void> = run.catch((error: unknown) => {
      state.error = error instanceof ApiError ? error.code : "request_failed";
      // A failed repair with frames still waiting retries on a timer, never in a tight loop.
      if (state.buffered.size && state.retry === undefined)
        state.retry = this.clock.setTimeout(() => { delete state.retry; void this.repair(state); }, 2000);
    }).finally(() => {
      if (state.repair !== tracked) return;
      delete state.repair;
      this.drain(state);
      this.notify();
      // Frames past a gap arrived while the repair ran: repair again unless a retry is already timed.
      if (state.buffered.size && state.retry === undefined) void this.repair(state);
    });
    state.repair = tracked;
    return run;
  }
  private async load(state: ChatState): Promise<void> {
    const page = await this.api.events(state.chatId, {});
    state.loaded = true;
    state.generation = page.generation;
    state.events = [...page.events];
    state.olderCursor = page.olderCursor;
    state.lastSeq = page.events.at(-1)?.seq ?? page.lastSeq;
    state.inflight = new Map(page.inflight.map((item) => [item.turnId, item]));
    state.buffered = new Map([...state.buffered].filter(([seq, event]) => seq > state.lastSeq && event.generation === page.generation));
    delete state.error;
    for (const event of page.events) this.settle(event);
    this.notify();
    if (this.open.has(state.chatId) && this.connection.state === "open") this.request("subscribe", [state.chatId]);
    if (page.newerCursor !== null || page.lastSeq > state.lastSeq) await this.catchUp(state);
  }

  /** Fill `lastSeq+1 …` from history (`after=`); then drain buffered live frames. */
  private async catchUp(state: ChatState): Promise<void> {
    let guard = 0;
    for (;;) {
      const page = await this.api.events(state.chatId, { after: state.lastSeq, generation: state.generation });
      if (page.mode === "reset" || page.generation !== state.generation) return this.load(state);
      for (const event of page.events) this.accept(state, event);
      if (page.newerCursor === null) {
        for (const item of page.inflight) state.inflight.set(item.turnId, item);
        break;
      }
      if (!page.events.length || ++guard > 1000) throw new ApiError("invalid_response", 200);
    }
    this.drain(state);
    delete state.error;
    // History has not reached a buffered frame yet (publication race): try again shortly.
    if (state.buffered.size && state.retry === undefined)
      state.retry = this.clock.setTimeout(() => { delete state.retry; void this.repair(state); }, 1000);
  }

  /** Apply one event from any source. Returns true when it was shown now. */
  private ingest(event: ChatEvent): boolean {
    const state = this.state(event.chatId);
    if (!state.loaded) return false;            // the first page load will include it
    if (state.repair) { state.buffered.set(event.seq, event); return false; }
    if (event.generation !== state.generation) {
      state.buffered.set(event.seq, event);
      void this.snapshot(event.chatId).catch(() => undefined);
      return false;
    }
    if (event.seq <= state.lastSeq) { this.settle(event); return false; }
    if (event.seq > state.lastSeq + 1) {
      state.buffered.set(event.seq, event);
      void this.repair(state);
      return false;
    }
    this.accept(state, event);
    this.drain(state);
    return true;
  }
  private accept(state: ChatState, event: ChatEvent) {
    if (event.seq <= state.lastSeq) return;   // duplicate
    if (event.seq !== state.lastSeq + 1 || event.generation !== state.generation) throw new ApiError("invalid_response", 200);
    state.events.push(event);
    state.lastSeq = event.seq;
    state.buffered.delete(event.seq);
    if (event.turnId && ((event.kind === "message" && event.final) || (event.kind === "turn" && terminalTurn.has(event.state))))
      state.inflight.delete(event.turnId);
    this.settle(event);
  }
  private drain(state: ChatState) {
    for (const [seq, event] of [...state.buffered]) if (seq <= state.lastSeq || event.generation !== state.generation) state.buffered.delete(seq);
    for (let next = state.buffered.get(state.lastSeq + 1); next; next = state.buffered.get(state.lastSeq + 1))
      this.accept(state, next);
  }
  /** A stored event with the sender's key replaces the optimistic bubble. */
  private settle(event: ChatEvent) {
    if (event.idempotencyKey && this.pending.get(event.idempotencyKey)?.chatId === event.chatId) {
      this.pending.delete(event.idempotencyKey);
      this.cancelResend(event.idempotencyKey);
    }
    if (event.kind === "redaction") this.redactions.delete(event.chatId + "\n" + event.targetEventId);
    // The card's own update is the final word, whichever surface answered.
    if (event.kind === "card.update" && event.status !== "pending") {
      const answer = this.answers.get(event.chatId + "\n" + event.cardId);
      if (answer && answer.state !== "sending") this.answers.delete(event.chatId + "\n" + event.cardId);
    }
  }

  // -- commands --
  async send(chatId: string, input: { text: string; attachments?: AttachmentRef[]; mentions?: { agentIds: string[]; all?: boolean }; replyTo?: string }) {
    const key = (this.options.idempotencyKey ?? newIdempotencyKey)();
    const item: PendingSend = { idempotencyKey: key, chatId, text: input.text, attachments: input.attachments ?? [], state: "sending", createdAt: this.clock.now(), attempts: 0,
      ...(input.mentions ? { mentions: input.mentions } : {}), ...(input.replyTo ? { replyTo: input.replyTo } : {}) };
    this.pending.set(key, item);
    this.notify();
    return this.transmit(item);
  }
  /** Retry with the same key: the server answers `duplicate` if the first attempt was stored. */
  retry(idempotencyKey: string) {
    const item = this.pending.get(idempotencyKey);
    if (!item || item.state === "sending" || item.state === "accepted") return Promise.resolve(undefined);
    this.cancelResend(idempotencyKey);
    return this.transmit(item);
  }
  discard(idempotencyKey: string) {
    this.cancelResend(idempotencyKey);
    if (this.pending.delete(idempotencyKey)) this.notify();
  }
  private cancelResend(idempotencyKey: string) {
    if (!this.resend.has(idempotencyKey)) return;
    this.clock.clearTimeout(this.resend.get(idempotencyKey));
    this.resend.delete(idempotencyKey);
    const item = this.pending.get(idempotencyKey);
    if (item) delete item.retryAt;
  }
  private async transmit(item: PendingSend): Promise<SendResponse | undefined> {
    item.state = "sending"; item.attempts++; delete item.error; delete item.retryAt; this.notify();
    try {
      const response = await this.api.send(item.chatId, {
        idempotencyKey: item.idempotencyKey, text: item.text,
        ...(item.attachments.length ? { attachments: item.attachments.map((ref) => ref.attachmentId) } : {}),
        ...(item.mentions ? { mentions: item.mentions } : {}), ...(item.replyTo ? { replyTo: item.replyTo } : {}),
      });
      // Shown as sent until the event is in order (socket or catch-up), whichever comes first.
      if (this.pending.has(item.idempotencyKey)) item.state = "accepted";
      this.ingest(response.event);
      this.notify();
      return response;
    } catch (error) {
      if (!this.pending.has(item.idempotencyKey)) return undefined;
      item.state = retryable(error) ? "failed" : "rejected";
      item.error = error instanceof ApiError ? error.code : "request_failed";
      // Network failures resend with the same key: the server answers `duplicate` if the first attempt was stored.
      if (item.state === "failed" && item.attempts <= (this.options.sendRetries ?? 3)) {
        const delay = 1000 * 2 ** (item.attempts - 1);
        item.retryAt = this.clock.now() + delay;
        this.resend.set(item.idempotencyKey, this.clock.setTimeout(() => {
          this.resend.delete(item.idempotencyKey);
          if (this.pending.get(item.idempotencyKey) === item && item.state === "failed") void this.transmit(item).catch(() => undefined);
        }, delay));
      }
      this.notify();
      throw error;
    }
  }
  /**
   * Redact (撤回) an own message. One key per target, so a retry after a network failure reuses it.
   * The target disappears when the stored `redaction` event is in order (response or socket).
   */
  async redact(chatId: string, eventId: string) {
    const id = chatId + "\n" + eventId;
    const item = this.redactions.get(id) ?? { chatId, eventId, idempotencyKey: (this.options.idempotencyKey ?? newIdempotencyKey)(), state: "sending" as const };
    if (this.redactions.get(id)?.state === "sending") return undefined;
    item.state = "sending"; delete item.error;
    this.redactions.set(id, item);
    this.notify();
    try {
      const response = await this.api.redact(chatId, eventId, item.idempotencyKey);
      this.redactions.delete(id);
      this.ingest(response.event);
      this.notify();
      return response;
    } catch (error) {
      if (this.redactions.get(id) !== item) return undefined;
      item.state = retryable(error) ? "failed" : "rejected";
      item.error = error instanceof ApiError ? error.code : "request_failed";
      this.notify();
      throw error;
    }
  }
  private command<K extends keyof LedgerCommands>(name: K): LedgerCommands[K] {
    const command = this.api[name];
    if (!command) throw new ApiError("feature_unavailable", 0);
    return command.bind(this.api) as LedgerCommands[K];
  }
  /**
   * Answer a card (ADR 0005 16.1). One key per card answer; a retry after a network failure reuses it, so the server
   * returns `duplicate` instead of answering twice. A later answer than another surface's is `stale`.
   */
  async answerCard(chatId: string, cardId: string, body: AnswerBody) {
    const id = chatId + "\n" + cardId, prior = this.answers.get(id);
    if (prior?.state === "sending") return undefined;
    const reuse = prior?.state === "failed" && JSON.stringify(prior.body) === JSON.stringify(body);
    const item: PendingAnswer = { chatId, cardId, body, state: "sending",
      idempotencyKey: reuse ? prior.idempotencyKey : (this.options.idempotencyKey ?? newIdempotencyKey)() };
    this.answers.set(id, item);
    this.notify();
    try {
      const response = await this.command("answerCard")(chatId, cardId, { idempotencyKey: item.idempotencyKey, ...body } as AnswerRequest);
      // A stale answer stays visible ("已在其他地方回答") only while the card's own update has not arrived.
      if (this.answers.get(id) === item) {
        if (response.status === "stale" && !this.cardClosed(chatId, cardId)) item.state = "stale";
        else this.answers.delete(id);
      }
      this.notify();
      return response;
    } catch (error) {
      if (this.answers.get(id) !== item) return undefined;
      item.state = retryable(error) ? "failed" : "rejected";
      item.error = error instanceof ApiError ? error.code : "request_failed";
      this.notify();
      throw error;
    }
  }
  private cardClosed(chatId: string, cardId: string) {
    return this.state(chatId).events.some((event) => event.kind === "card.update" && event.cardId === cardId && event.status !== "pending");
  }
  dismissAnswer(chatId: string, cardId: string) {
    if (this.answers.delete(chatId + "\n" + cardId)) this.notify();
  }
  /** "新对话". Rejects with `session_busy` (409) while a turn runs unless `cancelActive`; the window event is shown at once. */
  async reset(chatId: string, cancelActive = false) {
    const response = await this.command("reset")(chatId, (this.options.idempotencyKey ?? newIdempotencyKey)(), cancelActive);
    if (this.ingest(response.event)) this.notify();
    return response;
  }
  /** Permanent purge; the chat reloads in its new generation (the socket also sends `snapshot_required`). */
  async purge(chatId: string, confirm: string, cancelActive = false) {
    const response = await this.command("purge")(chatId, confirm, (this.options.idempotencyKey ?? newIdempotencyKey)(), cancelActive);
    const state = this.state(chatId);
    state.buffered.clear();
    await this.snapshot(chatId);
    return response;
  }
  async cancelTurn(chatId: string, turnId: string) {
    return this.command("cancelTurn")(chatId, turnId);
  }
  /** Add text to a running turn. `unsupported` when the kernel cannot take it; the steered message arrives as an event. */
  async steer(chatId: string, turnId: string, text: string) {
    const response = await this.command("steer")(chatId, turnId, text, (this.options.idempotencyKey ?? newIdempotencyKey)());
    if (response.status === "accepted" && this.ingest(response.event)) this.notify();
    return response;
  }
  dismissRedaction(chatId: string, eventId: string) {
    if (this.redactions.delete(chatId + "\n" + eventId)) this.notify();
  }

  /** Read markers are monotonic on the server; lower values are not sent. */
  async markRead(chatId: string, seq: number) {
    const state = this.state(chatId);
    if (seq <= state.readSeq) return;
    state.readSeq = seq;
    const summary = this.chats.get(chatId);
    if (summary) this.chats.set(chatId, { ...summary, readSeq: seq, unread: 0 });
    this.notify();
    const result = await this.api.read(chatId, seq);
    if (result.readSeq > state.readSeq) state.readSeq = result.readSeq;
    const latest = this.chats.get(chatId);
    if (latest) this.chats.set(chatId, { ...latest, readSeq: Math.max(latest.readSeq, result.readSeq), unread: result.unread });
    this.notify();
  }

  // -- socket --
  connect() {
    if (!this.stopped) return;
    this.stopped = false;
    void this.dial();
  }
  disconnect() {
    this.stopped = true;
    for (const key of [...this.resend.keys()]) this.cancelResend(key);
    this.clock.clearTimeout(this.reconnectTimer);
    this.clock.clearTimeout(this.heartbeat);
    const socket = this.socket;
    this.socket = undefined;
    socket?.close(1000, "client_closed");
    this.connection = { ...this.connection, state: "closed" };
    this.notify();
  }
  private async dial() {
    if (this.stopped) return;
    this.connection = { ...this.connection, state: this.connection.attempt ? "reconnecting" : "connecting" };
    this.notify();
    let ticket: string;
    try {
      // Tickets are single-use and short-lived, so every dial asks for a new one.
      ticket = (await this.api.socketTicket()).ticket;
    } catch (error) {
      if (error instanceof ApiError && (error.status === 401 || error.status === 403 || error.code === "access_session_expired")) return this.stop(error.code);
      return this.schedule();
    }
    if (this.stopped) return;
    const socket = this.options.socket((this.options.socketUrl ?? browserSocketUrl)(ticket));
    this.socket = socket;
    this.lastFrameAt = this.clock.now();
    socket.onmessage = (message) => { if (this.socket === socket) this.frame(message.data); };
    socket.onclose = (event) => { if (this.socket === socket) this.closed(event.code); };
    socket.onerror = () => undefined;
  }
  private stop(error: string) {
    this.stopped = true;
    this.connection = { ...this.connection, state: "closed", error };
    this.notify();
  }
  private schedule(minimum = 0) {
    if (this.stopped) return;
    const attempt = this.connection.attempt++;
    const ceiling = Math.min(this.options.maxBackoffMs ?? 30_000, 1000 * 2 ** attempt);
    // Full jitter in [ceiling/2, ceiling] so many tabs do not reconnect together after a restart.
    const delay = Math.max(minimum, Math.round(ceiling / 2 + this.clock.random() * ceiling / 2));
    this.connection = { ...this.connection, state: "reconnecting" };
    this.notify();
    this.clock.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = this.clock.setTimeout(() => void this.dial(), delay);
  }
  private closed(code: number) {
    this.socket = undefined;
    this.clock.clearTimeout(this.heartbeat);
    this.requests.clear();
    for (const state of this.states.values()) state.inflight.clear();
    if (this.stopped) return;
    // 4401 (revoked session, or an edge JWT at its `exp`): ask for a new ticket once a minute at most. The ticket request
    // then decides: a renewed Access session continues, an expired one stops with access_session_expired.
    if (code === 4401) {
      const now = this.clock.now();
      if (now - this.reauthorizedAt < 60_000) return this.stop("unauthorized");
      this.reauthorizedAt = now;
      return void this.dial();
    }
    if (code === 4403) return this.stop("forbidden");
    // 4408 backpressure and 1012 restart reconnect and catch up through subscribe replay.
    this.schedule(code === 4429 ? 30_000 : 0);
  }
  private beat() {
    this.clock.clearTimeout(this.heartbeat);
    this.heartbeat = this.clock.setTimeout(() => {
      const socket = this.socket;
      if (!socket) return;
      // No frame (not even pong) for two intervals: the connection is dead.
      if (this.clock.now() - this.lastFrameAt > this.heartbeatMs * 2) {
        this.socket = undefined;
        socket.close(4000, "heartbeat_timeout");
        return this.closed(4000);
      }
      socket.send("ping");
      this.beat();
    }, this.heartbeatMs);
  }
  private request(method: "subscribe" | "unsubscribe", chatIds: string[]) {
    const socket = this.socket;
    if (!socket || !chatIds.length) return;
    const id = String(this.nextRequest++);
    this.requests.set(id, { method, chatIds });
    const params = method === "subscribe"
      ? { chats: chatIds.flatMap((chatId) => {
          const state = this.states.get(chatId);
          return state?.loaded ? [{ chatId, afterSeq: state.lastSeq, generation: state.generation }] : [];
        }), index: true }
      : { chatIds };
    socket.send(JSON.stringify({ type: "req", id, method, params }));
  }
  private frame(raw: unknown) {
    this.lastFrameAt = this.clock.now();
    if (typeof raw !== "string" || raw === "pong") return;
    let message: { type?: string; id?: string; ok?: boolean; result?: unknown; error?: { code?: string }; event?: string; data?: unknown };
    try { message = JSON.parse(raw); } catch { return; }
    if (message.type === "res" && typeof message.id === "string") return this.response(message);
    if (message.type !== "event") return;
    const data = message.data as Record<string, unknown> | undefined;
    switch (message.event) {
      case "hello": {
        const hello = data as { epoch?: string; heartbeatMs?: number };
        if (hello.epoch !== this.connection.epoch) for (const state of this.states.values()) state.inflight.clear();
        if (typeof hello.heartbeatMs === "number" && hello.heartbeatMs > 0) this.heartbeatMs = hello.heartbeatMs;
        this.connection = { state: "open", attempt: 0, ...(hello.epoch ? { epoch: hello.epoch } : {}) };
        this.beat();
        this.request("subscribe", [...this.open]);
        this.notify();
        return;
      }
      case "chat.event":
        if (this.ingest(data as unknown as ChatEvent)) this.notify();
        return;
      case "chat.stream": {
        const stream = data as { chatId: string; turnId: string; agentId: string; text: string; afterSeq: number };
        const state = this.states.get(stream.chatId);
        if (!state?.loaded) return;
        state.inflight.set(stream.turnId, { turnId: stream.turnId, agentId: stream.agentId, text: stream.text,
          afterSeq: stream.afterSeq, updatedAt: new Date(this.clock.now()).toISOString() });
        this.notify();
        return;
      }
      case "chats.updated":
        this.updateSummary(data as unknown as ChatSummary);
        this.notify();
        return;
      case "chat.read": {
        const read = data as { chatId: string; readSeq: number };
        const state = this.states.get(read.chatId);
        if (state && read.readSeq > state.readSeq) state.readSeq = read.readSeq;
        const summary = this.chats.get(read.chatId);
        if (summary && read.readSeq > summary.readSeq) this.chats.set(read.chatId, { ...summary, readSeq: read.readSeq });
        this.notify();
        return;
      }
      case "snapshot_required": {
        const chatId = (data as { chatId: string }).chatId;
        const state = this.states.get(chatId);
        if (state) { state.buffered.clear(); void this.snapshot(chatId).catch(() => undefined); }
        return;
      }
    }
  }
  /**
   * Subscribe results (ADR 0005 8.4): chats that failed are listed in `result.errors` and only they get an error;
   * `ok:false` is a request-level failure for every chat in it. `mode` is informational: a `reset` is always
   * followed by a `snapshot_required` frame, which is what reloads the chat.
   */
  private response(message: { id?: string; ok?: boolean; result?: unknown; error?: { code?: string } }) {
    const request = this.requests.get(message.id!);
    this.requests.delete(message.id!);
    if (!request || request.method !== "subscribe") return;
    const failed = message.ok
      ? ((message.result as { errors?: Array<{ chatId: string; code?: string }> } | undefined)?.errors ?? [])
      : request.chatIds.map((chatId) => ({ chatId, code: message.error?.code }));
    for (const item of failed) {
      const state = this.states.get(item.chatId);
      if (state) state.error = item.code ?? "subscribe_failed";
    }
    if (failed.length) this.notify();
  }
}

// ---- Folding (ADR 0005 §8.2 "Folding rules for clients") ----
export interface LedgerBubble {
  eventId: string; seq: number; at: string; sender: Actor; channel?: ChannelTag; turnId?: string;
  kind: "message" | "notice" | "action" | "card" | "window" | "member";
  role: "user" | "assistant" | "system"; text: string; html?: string;
  attachments: AttachmentRef[]; replyTo?: string; final?: boolean; possibleDuplicate?: boolean; edited?: boolean;
  /** Redacted (撤回): the bubble stays as a placeholder; text, html and attachments are cleared. */
  redacted?: boolean;
  reactions: Array<{ key: string; senders: string[] }>; deliveries: DeliveryState[];
  level?: "info" | "warning"; card?: Card; idempotencyKey?: string;
  /** Steered into a running turn (phase 4); shown with that turn's run surface. */
  steer?: boolean;
}
export interface LedgerTurn { turnId: string; agentId: string; state: TurnState; inputEventIds: string[]; error?: string; seq: number }
export interface LedgerFold { items: LedgerBubble[]; turns: Map<string, LedgerTurn>; cards: Map<string, Card> }

/** edit, redaction, reaction, card.update and delivery modify their target and are not bubbles. */
export function foldEvents(events: readonly ChatEvent[]): LedgerFold {
  const items: LedgerBubble[] = [], byId = new Map<string, LedgerBubble>();
  const turns = new Map<string, LedgerTurn>(), cards = new Map<string, Card>();
  const reactions = new Map<string, Map<string, Set<string>>>();
  for (const event of events) {
    const base = { eventId: event.eventId, seq: event.seq, at: event.at, sender: event.sender,
      ...(event.channel ? { channel: event.channel } : {}), ...(event.turnId ? { turnId: event.turnId } : {}),
      ...(event.idempotencyKey ? { idempotencyKey: event.idempotencyKey } : {}),
      attachments: [] as AttachmentRef[], reactions: [] as LedgerBubble["reactions"], deliveries: [] as DeliveryState[] };
    let bubble: LedgerBubble | undefined;
    switch (event.kind) {
      case "message":
        bubble = { ...base, kind: "message", role: event.role, text: event.text, attachments: event.attachments ?? [], deliveries: [...(event.deliveries ?? [])],
          ...(event.html ? { html: event.html } : {}), ...(event.replyTo ? { replyTo: event.replyTo } : {}),
          ...(event.final ? { final: true } : {}), ...(event.possibleDuplicate ? { possibleDuplicate: true } : {}),
          ...(event.steer ? { steer: true } : {}),
          ...(event.redacted ? { redacted: true, text: "", attachments: [] } : {}) };
        break;
      case "notice": bubble = { ...base, kind: "notice", role: "system", text: event.text, level: event.level }; break;
      case "action": bubble = { ...base, kind: "action", role: "user", text: event.label }; break;
      case "card": cards.set(event.card.cardId, { ...event.card }); bubble = { ...base, kind: "card", role: "assistant", text: event.card.text, card: cards.get(event.card.cardId)! }; break;
      case "window": bubble = { ...base, kind: "window", role: "system", text: String(event.window) }; break;
      case "member": bubble = { ...base, kind: "member", role: "system", text: event.title ?? event.member?.name ?? "" }; break;
      case "turn": {
        const previous = turns.get(event.turnId ?? "");
        const turnId = event.turnId;
        if (turnId) turns.set(turnId, { turnId, agentId: event.agentId, state: event.state, seq: previous?.seq ?? event.seq,
          inputEventIds: event.inputEventIds.length ? event.inputEventIds : previous?.inputEventIds ?? [], ...(event.error ? { error: event.error } : {}) });
        break;
      }
      case "card.update": {
        const card = cards.get(event.cardId);
        if (card) card.status = event.status;
        break;
      }
      case "edit": {
        const target = byId.get(event.targetEventId);
        if (target && !target.redacted && target.sender.id === event.sender.id) { target.text = event.text; target.edited = true; delete target.html; }
        break;
      }
      case "redaction": {
        const target = byId.get(event.targetEventId);
        // Kept in place so the chat shows that a message was withdrawn; turns placed after it stay put.
        if (target) { target.redacted = true; target.text = ""; target.attachments = []; target.reactions = []; delete target.html; delete target.edited; }
        break;
      }
      case "reaction": {
        if (!byId.has(event.targetEventId) || byId.get(event.targetEventId)!.redacted) break;
        const keys = reactions.get(event.targetEventId) ?? new Map<string, Set<string>>();
        const senders = keys.get(event.key) ?? new Set<string>();
        if (event.removed) senders.delete(event.sender.id); else senders.add(event.sender.id);
        keys.set(event.key, senders);
        reactions.set(event.targetEventId, keys);
        break;
      }
      case "delivery": {
        const target = byId.get(event.targetEventId);
        if (!target) break;
        const index = target.deliveries.findIndex((item) => item.deliveryId === event.delivery.deliveryId);
        if (index >= 0) target.deliveries[index] = event.delivery; else target.deliveries.push(event.delivery);
        break;
      }
    }
    if (bubble) { items.push(bubble); byId.set(bubble.eventId, bubble); }
  }
  for (const [eventId, keys] of reactions) {
    const target = byId.get(eventId);
    if (target && !target.redacted) target.reactions = [...keys].filter(([, senders]) => senders.size).map(([key, senders]) => ({ key, senders: [...senders] }));
  }
  return { items, turns, cards };
}

// ---- Card answers from the run surface (ADR 0005 16.7) ----
/**
 * Map an answer given in the run surface (built with `@olorinm/agent-host/interactions`) to the card answer Router
 * accepts. Approvals answer by choice (Router's choice 0 allows, 1 denies; `session/request_permission` follows its
 * options), Mau's synthetic handoff and Router's own cards by text, Host questions by their native result.
 */
export function cardAnswerBody(card: Pick<Card, "kind" | "source" | "native" | "choices">, native: unknown, allows: boolean | undefined): AnswerBody {
  if (card.kind === "sensitive") throw new ApiError("sensitive_input_requires_native_entry", 422);
  const value = native && typeof native === "object" ? native as Record<string, unknown> : {};
  if (card.kind === "connector_approval") return { choiceId: value.choice === "once" ? "0" : "1" };
  if (card.kind === "approval") {
    if (card.native?.method === "session/request_permission") {
      const options = (card.native.params as { options?: Array<{ optionId?: unknown }> } | null)?.options ?? [];
      const index = options.findIndex((option) => option.optionId === (value.outcome as { optionId?: unknown } | undefined)?.optionId);
      if (index >= 0) return { choiceId: String(index) };
    }
    if (allows === undefined) throw new ApiError("choice_not_found", 422);
    return { choiceId: allows ? "0" : "1" };
  }
  if (card.source === "mau-handoff" || card.source === "router") {
    const answers = value.answers && typeof value.answers === "object" ? Object.values(value.answers as Record<string, unknown>) : [];
    const first = answers.map((item) => Array.isArray((item as { answers?: unknown })?.answers) ? (item as { answers: unknown[] }).answers[0] : item)
      .find((item): item is string => typeof item === "string" && !!item.trim());
    const text = first ?? (typeof value.answer === "string" ? value.answer : undefined);
    if (!text) throw new ApiError("choice_or_text_required", 422);
    const choice = card.choices.find((item) => item.label === text);
    return choice ? { choiceId: choice.choiceId } : { text };
  }
  return { result: native };
}
