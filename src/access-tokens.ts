import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { RouterError } from "@agent-router/server";
import { apiInput, requestScope, tokenScopes } from "./api-reference.js";
import type { DurableStore } from "./store.js";

type TokenScope = typeof tokenScopes[number];
/** What the store keeps of a token, under its id: never the secret, only its SHA-256. */
interface StoredToken { owner: string; name: string; scopes: TokenScope[]; hash: string; createdAt: string; expiresAt: string; revokedAt?: string; lastUsedAt?: string }
export interface TokenView { id: string; name: string; scopes: TokenScope[]; createdAt: string; expiresAt: string; lastUsedAt?: string; revokedAt?: string }
interface TokenRequest { headers: Record<string, unknown>; method?: string | undefined; originalUrl?: string | undefined }

const collection = "access-tokens", day = 86_400_000, liveLimit = 20, keptDays = 30;
/** `mau_<id>_<secret>`: the id is public and names the token; the secret is 32 random bytes. */
const format = /^mau_([0-9a-f]{16})_([A-Za-z0-9_-]{43})$/;
const digest = (secret: string) => createHash("sha256").update(secret).digest();
const absent = digest("");

/**
 * Access tokens: what the owner hands to an agent so that an Access service token of the same owner can do more than
 * read. A token is scoped (`chat`, `approve`, `manage`), expires, and can be revoked. It is no sign-in: it counts
 * only in `authorize`, which Router asks about a request of a verified service token that it would refuse.
 */
export class AccessTokens {
  constructor(private readonly store: DurableStore, private readonly now: () => number = Date.now) {}

  /** When a token stopped working, or undefined while it works. */
  private stopped(token: StoredToken, now: number): number | undefined {
    const expires = Date.parse(token.expiresAt), revoked = token.revokedAt === undefined ? Infinity : Date.parse(token.revokedAt);
    // A date that cannot be read counts as past.
    const at = Math.min(Number.isNaN(expires) ? 0 : expires, Number.isNaN(revoked) ? 0 : revoked);
    return at <= now ? at : undefined;
  }
  /** The owner's tokens, newest first; those that stopped working more than 30 days ago are dropped. */
  private owned(owner: string, now: number) {
    return this.store.entries<StoredToken>(collection).filter(({ id, value }) => {
      if (value.owner !== owner) return false;
      const stopped = this.stopped(value, now);
      if (stopped === undefined || now - stopped <= keptDays * day) return true;
      this.store.delete(collection, id);
      return false;
    }).reverse();
  }
  private view(id: string, { name, scopes, createdAt, expiresAt, lastUsedAt, revokedAt }: StoredToken): TokenView {
    return { id, name, scopes, createdAt, expiresAt, ...(lastUsedAt ? { lastUsedAt } : {}), ...(revokedAt ? { revokedAt } : {}) };
  }

  list(owner: string): TokenView[] {
    return this.store.transaction(() => this.owned(owner, this.now())).map(({ id, value }) => this.view(id, value));
  }
  /** The only place the token itself exists outside its holder's hands: the answer to its creation. */
  create(owner: string, input: unknown): TokenView & { token: string } {
    const { name, scopes, expiresInDays = 7 } = apiInput.newToken.parse(input), now = this.now();
    const id = randomBytes(8).toString("hex"), secret = randomBytes(32).toString("base64url");
    const value: StoredToken = { owner, name, scopes: tokenScopes.filter(scope => scopes.includes(scope)), hash: digest(secret).toString("hex"),
      createdAt: new Date(now).toISOString(), expiresAt: new Date(now + expiresInDays * day).toISOString() };
    this.store.transaction(() => {
      const live = this.owned(owner, now).filter(token => this.stopped(token.value, now) === undefined);
      if (live.length >= liveLimit) throw new RouterError("token_limit_reached", 409).with({ limit: liveLimit });
      if (live.some(token => token.value.name === name)) throw new RouterError("token_name_in_use", 409);
      if (!this.store.insert(collection, id, value)) throw new Error("token_id_in_use");
    });
    return { ...this.view(id, value), token: `mau_${id}_${secret}` };
  }
  revoke(owner: string, id: string): void {
    this.store.transaction(() => {
      const value = this.store.get<StoredToken>(collection, id);
      if (!value || value.owner !== owner) throw new RouterError("token_not_found", 404);
      if (!value.revokedAt) this.store.set(collection, id, { ...value, revokedAt: new Date(this.now()).toISOString() });
    });
  }

  /** The working token of this owner that a `Mau-Token` header holds. Anything else is no token. */
  private presented(owner: string, header: unknown, now: number): { id: string; value: StoredToken } | undefined {
    const match = typeof header === "string" && header.length <= 64 ? format.exec(header) : null;
    if (!match) return undefined;
    const value = this.store.get<StoredToken>(collection, match[1]!);
    // Digests have one length, and an unknown id is compared too, so the time taken says nothing about the secret.
    const matches = timingSafeEqual(digest(match[2]!), value ? Buffer.from(value.hash, "hex") : absent);
    return value && matches && value.owner === owner && this.stopped(value, now) === undefined ? { id: match[1]!, value } : undefined;
  }
  /** What the token of a service token's request allows, for display. A token means nothing for any other caller. */
  describe(principal: { ownerId: string; operator?: true }, request: TokenRequest): Pick<TokenView, "id" | "name" | "scopes" | "expiresAt"> | undefined {
    const token = principal.operator ? this.presented(principal.ownerId, request.headers["mau-token"], this.now()) : undefined;
    return token && { id: token.id, name: token.value.name, scopes: token.value.scopes, expiresAt: token.value.expiresAt };
  }
  /**
   * Router's `authorizeOperator`: whether a request of a service token that Router would refuse is allowed. True only
   * for a working token of the same owner on a request that is exactly a listed route whose scope the token carries;
   * `owner` routes are never allowed and whatever cannot be classified is refused. It only decides: the request is
   * still held to Router's CSRF guard afterwards.
   */
  authorize(principal: { ownerId: string }, request: TokenRequest): boolean {
    try {
      const now = this.now(), token = this.presented(principal.ownerId, request.headers["mau-token"], now);
      if (!token) return false;
      const scope = requestScope(request);
      if (scope === undefined || scope === "owner") return false;
      if (scope !== "read" && !token.value.scopes.includes(scope)) return false;
      this.used(token.id, token.value, now);
      return true;
    } catch { return false; }
  }
  /** Recorded at most once a minute; a write that fails does not fail the request. */
  private used(id: string, value: StoredToken, now: number): void {
    if (value.lastUsedAt && now - Date.parse(value.lastUsedAt) < 60_000) return;
    try { this.store.set(collection, id, { ...value, lastUsedAt: new Date(now).toISOString() }); } catch { /* the request was allowed all the same */ }
  }
}
