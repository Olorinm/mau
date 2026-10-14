import { createHash, randomUUID } from "node:crypto";
import { RouterError } from "@agent-router/server";
import type { WorkspaceBackend } from "@olorinm/agent-environment/workspace";
import { DurableStore } from "./store.js";

interface Workspace { id: string; owner: string; storageOwner: string; name: string; createdAt: string }
/** Product identities and ownership live here; Environment owns cloud storage. */
export class Workspaces {
  private loaded: Promise<WorkspaceBackend> | undefined;
  constructor(private readonly journal: DurableStore, private readonly configFile: string | undefined,
    private readonly assertWritable: () => void, private readonly load?: () => Promise<WorkspaceBackend>) {}
  get enabled() { return !!(this.configFile || this.load); }
  backend(): Promise<WorkspaceBackend> {
    if (!this.enabled) throw new RouterError("workspaces_not_configured", 409);
    this.loaded ??= (this.load ? this.load() : import("@olorinm/agent-environment/workspace").then(m => m.loadWorkspaceConfiguration(this.configFile!)))
      .catch(() => { this.loaded = undefined; throw new RouterError("workspace_storage_unavailable", 503); });
    return this.loaded;
  }
  list(owner: string) { return this.journal.entries<Workspace>("workspaces").map(e => e.value).filter(w => w.owner === owner).map(w => this.view(w)); }
  create(owner: string, name: string) {
    this.assertWritable();
    if (!this.enabled) throw new RouterError("workspaces_not_configured", 409);
    if (!name.trim() || name.length > 100) throw new RouterError("invalid_workspace_name", 400);
    const w: Workspace = { id: randomUUID(), owner, name: name.trim(), createdAt: new Date().toISOString(),
      storageOwner: createHash("sha256").update(owner).digest("hex") };
    this.journal.insert("workspaces", w.id, w); return this.view(w);
  }
  owned(owner: string, id: string) {
    const w = this.journal.get<Workspace>("workspaces", id);
    if (!w || w.owner !== owner) throw new RouterError("workspace_not_found", 404);
    return w;
  }
  view(w: Workspace) { return { id: w.id, name: w.name, createdAt: w.createdAt }; }
  async files(owner: string, id: string, prefix = "") {
    const w = this.owned(owner, id); return (await this.backend()).store.list(w.storageOwner, w.id, prefix);
  }
  async put(owner: string, id: string, path: string, body: Uint8Array) {
    this.assertWritable(); const w = this.owned(owner, id);
    return (await this.backend()).store.put({ tenantId: w.storageOwner, workspaceId: w.id, path, body });
  }
  async remove(owner: string, id: string, path: string) {
    this.assertWritable(); const w = this.owned(owner, id);
    return (await this.backend()).store.delete(w.storageOwner, w.id, path);
  }
  async download(owner: string, id: string, path: string) {
    const w = this.owned(owner, id), store = (await this.backend()).store;
    const metadata = await store.stat(w.storageOwner, w.id, path);
    if (!metadata) throw new RouterError("workspace_file_not_found", 404);
    if (!store.createSignedReadUrl) throw new RouterError("workspace_download_unavailable", 503);
    return { ...metadata, url: await store.createSignedReadUrl(w.storageOwner, w.id, path, 60, { download: true }), expiresInSeconds: 60 };
  }
}
