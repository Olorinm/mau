// Product lifecycle, adapted from OpenGrove main.tsx at 8b365ed.
// Shared frontend components intentionally have no reload/storage/network behavior.
const reloadBlockers = new Set<symbol>();
export function blockBuildReload(blocked: boolean) {
  const key = Symbol();
  if (blocked) reloadBlockers.add(key);
  return () => { reloadBlockers.delete(key); };
}
export function startBuildVersionWatcher(currentBuildId: string, canReload: () => boolean = () => true) {
  if (!currentBuildId || currentBuildId === "dev") return () => {};
  const key = "mau-build-reload-target", controller = new AbortController();
  let reloading = false, checking = false;
  const check = async () => {
    if (reloading || checking || document.hidden || controller.signal.aborted) return;
    checking = true;
    try {
      const response = await fetch("/version.json", {cache: "no-store", signal: controller.signal});
      if (!response.ok) return;
      const payload = await response.json() as {buildId?: unknown};
      const latest = typeof payload.buildId === "string" ? payload.buildId : "";
      if (!latest || controller.signal.aborted) return;
      if (latest === currentBuildId) { window.sessionStorage.removeItem(key); return; }
      if (reloadBlockers.size || !canReload()) return;
      if (window.sessionStorage.getItem(key) === latest) return;
      window.sessionStorage.setItem(key, latest);
      reloading = true;
      window.location.reload();
    } catch { /* Retry transient failures; unavailable storage must not cause a reload loop. */ }
    finally {checking = false;}
  };
  const visible = () => { if (!document.hidden) void check(); };
  const timer = window.setInterval(check, 20_000);
  document.addEventListener("visibilitychange", visible);
  return () => {controller.abort(); window.clearInterval(timer); document.removeEventListener("visibilitychange", visible);};
}
