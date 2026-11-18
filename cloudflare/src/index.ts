import { DurableObject } from "cloudflare:workers";
import { accessBatchDue, accessBatchKey, accessRecord, backupDueFor } from "./policy.mjs";

interface Env {
  MAU: DurableObjectNamespace<Mau>;
  ACCESS_LOGS: R2Bucket;
  /** "true" runs Mau. Any other value stops it and keeps it stopped, for a migration or a restore. */
  RUN: string;
  /** Any text. The container reads its configuration at start; changing this restarts it. */
  CONFIG_REVISION?: string;
  /** Where the object, and with it the container, is first placed. */
  LOCATION_HINT?: DurableObjectLocationHint;
  /** UTC hour (0-23) from which the daily encrypted backup is made. Without it there is none. */
  BACKUP_HOUR_UTC?: string;
  R2_ENDPOINT: string;
  CONFIG_BUCKET: string;
  STATE_BUCKET: string;
  R2_ACCESS_KEY_ID: string;
  R2_SECRET_ACCESS_KEY: string;
}

const PORT = 8790;
const MINUTE = 60_000;
// The longest the platform accepts. The alarm keeps this object active, so the container is never idle that long.
const INACTIVITY_MS = 6 * 60 * MINUTE;
// Memory and disk are billed as set here, CPU only while used: a whole core costs nothing idle and shortens every start.
const INSTANCE = { vcpu: 1, memoryMib: 768, diskMb: 4000 };
const BACKUP = ["python3", "node_modules/@olorinm/agent-environment/cloudflare/backup/scripts/server-backup.py", "/config/backup.json"];

const log = (event: string, fields: Record<string, unknown> = {}, failed = false) =>
  (failed ? console.error : console.log)(JSON.stringify({ event, ...fields }));
const unavailable = () => Response.json({ error: "unavailable" }, { status: 503, headers: { "Retry-After": "5", "Cache-Control": "no-store" } });

export default {
  fetch(request, env) {
    return env.MAU.getByName("mau", env.LOCATION_HINT ? { locationHint: env.LOCATION_HINT } : {}).fetch(request);
  },
} satisfies ExportedHandler<Env>;

/**
 * The one instance of Mau: its container, every request to it, and the upkeep around it. The container's disk is
 * empty at each start; `container/start.sh` restores Mau's state from the state bucket and keeps copying it back.
 */
export class Mau extends DurableObject<Env> {
  private reconciling?: Promise<void>;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS access (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, record TEXT NOT NULL)");
    // A new instance of this object (first use, a deploy, an eviction) reconciles at once; the alarm then repeats every minute.
    ctx.blockConcurrencyWhile(async () => {
      if (ctx.container?.running) await ctx.container.setInactivityTimeout(INACTIVITY_MS);
      await ctx.storage.setAlarm(Date.now());
    });
  }

  private get container() {
    if (!this.ctx.container) throw new Error("container_not_configured");
    return this.ctx.container;
  }

  async fetch(request: Request): Promise<Response> {
    const startedAt = Date.now();
    const response = await this.forward(request);
    this.ctx.storage.sql.exec("INSERT INTO access (at, record) VALUES (?, ?)", startedAt, JSON.stringify(accessRecord(request, response.status, startedAt)));
    return response;
  }

  private async forward(request: Request): Promise<Response> {
    if (!this.container.running) {
      this.ctx.waitUntil(this.reconcile().catch((error) => log("mau_reconcile_failed", { error: String(error) }, true)));
      return unavailable();
    }
    const url = new URL(request.url);
    url.protocol = "http:";
    const forwarded = new Request(url, request);
    // Mau reads the client address from this header only; a value the client sent is replaced.
    forwarded.headers.set("X-Forwarded-For", request.headers.get("CF-Connecting-IP") ?? "");
    let response: Response;
    // The port refuses connections while the container restores its state.
    try { response = await this.container.getTcpPort(PORT).fetch(forwarded); } catch { return unavailable(); }
    if (response.webSocket) return response;
    const secured = new Response(response.body, response);
    secured.headers.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    secured.headers.set("X-Content-Type-Options", "nosniff");
    secured.headers.set("Referrer-Policy", "no-referrer");
    return secured;
  }

  async alarm() {
    const steps: Array<[string, () => Promise<void>]> = [
      ["reconcile", () => this.reconcile()],
      ["served", () => this.noteServed()],
      ["access", () => this.writeAccessBatch()],
      ["backup", () => this.backup()],
    ];
    for (const [step, run] of steps) {
      try { await run(); } catch (error) { log("mau_upkeep_failed", { step, error: String(error) }, true); }
    }
    await this.ctx.storage.setAlarm(Date.now() + MINUTE);
  }

  /** Brings the container to what this deployment asks for: stopped, or running the deployed image. One run at a time. */
  private reconcile(): Promise<void> {
    return this.reconciling ??= this.converge().finally(() => { this.reconciling = undefined; });
  }

  private async converge() {
    const container = this.container;
    const image = this.env.RUN === "true" ? container.images.mau : undefined;
    if (this.env.RUN === "true" && !image) throw new Error("image_not_configured");
    // What the running container was started from: its image, its size and the configuration revision.
    const wanted = image && JSON.stringify([image, INSTANCE, this.env.CONFIG_REVISION ?? ""]);
    if (container.running && await this.ctx.storage.get<string>("started") !== wanted) await this.stop();
    if (!image || container.running) return;
    container.start({
      image,
      enableInternet: true,
      instance: INSTANCE,
      env: {
        R2_ENDPOINT: this.env.R2_ENDPOINT,
        R2_ACCESS_KEY_ID: this.env.R2_ACCESS_KEY_ID,
        R2_SECRET_ACCESS_KEY: this.env.R2_SECRET_ACCESS_KEY,
        CONFIG_BUCKET: this.env.CONFIG_BUCKET,
        STATE_BUCKET: this.env.STATE_BUCKET,
        STATE_EXPECTED: await this.ctx.storage.get<boolean>("served") ? "1" : "0",
      },
    });
    await container.setInactivityTimeout(INACTIVITY_MS);
    await this.ctx.storage.put("started", wanted);
    log("mau_container_started", { image });
    // A container that exits is looked at again within seconds, not at the next minute.
    const exited = (error?: unknown) => { log("mau_container_exited", error === undefined ? {} : { error: String(error) }, error !== undefined); return this.ctx.storage.setAlarm(Date.now() + 5000); };
    this.ctx.waitUntil(container.monitor().then(() => exited(), exited));
  }

  /**
   * Asks the container to stop and waits for it: Mau has 30 seconds to finish, then its state is copied a last time.
   * A container still running after three minutes is destroyed.
   */
  private async stop() {
    const container = this.container;
    container.signal(15);
    const exited = container.monitor().then(() => true, () => true);
    const overdue = new Promise<false>((resolve) => setTimeout(() => resolve(false), 3 * MINUTE));
    if (!await Promise.race([exited, overdue])) {
      log("mau_container_stop_overdue", {}, true);
      await container.destroy();
    }
    log("mau_container_stopped");
  }

  /** Once Mau has answered here, a start that finds no state to restore is refused instead of running empty. */
  private async noteServed() {
    if (!this.container.running || await this.ctx.storage.get<boolean>("served")) return;
    const response = await this.container.getTcpPort(PORT).fetch("http://mau/health/live").catch(() => undefined);
    if (response?.ok) await this.ctx.storage.put("served", true);
  }

  private async writeAccessBatch() {
    const sql = this.ctx.storage.sql;
    const { waiting, oldest } = sql.exec<{ waiting: number; oldest: number | null }>("SELECT count(*) AS waiting, min(at) AS oldest FROM access").one();
    if (!accessBatchDue(waiting, oldest ?? 0)) return;
    const rows = sql.exec<{ id: number; record: string }>("SELECT id, record FROM access ORDER BY id LIMIT 5000").toArray();
    await this.env.ACCESS_LOGS.put(accessBatchKey(rows[0]!.id), rows.map((row) => row.record).join("\n") + "\n");
    sql.exec("DELETE FROM access WHERE id <= ?", rows.at(-1)!.id);
  }

  /** The daily encrypted archive of /state and /config, made inside the container. A failed one is tried again an hour later. */
  private async backup() {
    const day = backupDueFor(this.env.BACKUP_HOUR_UTC, await this.ctx.storage.get<string>("backupDay"));
    if (!day || !this.container.running || Date.now() < (await this.ctx.storage.get<number>("backupRetryAt") ?? 0)) return;
    const { exitCode, stderr } = await (await this.container.exec(BACKUP, { cwd: "/app" })).output();
    if (exitCode !== 0) {
      await this.ctx.storage.put("backupRetryAt", Date.now() + 60 * MINUTE);
      throw new Error("backup_failed: " + new TextDecoder().decode(stderr).trim().slice(-200));
    }
    await this.ctx.storage.put("backupDay", day);
    log("mau_backup_complete", { day });
  }
}
