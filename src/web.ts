import express from "express";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

/** Same-origin web console. API, Router and Matrix paths never fall back to the page. */
/** `homeserver` is the public Matrix origin the console may call; none when Matrix is off (agent-router ADR 0005 19.3). */
export function webConsole(root: string, homeserver?: string): express.RequestHandler {
  const directory = resolve(root);
  if (!existsSync(join(directory, "index.html"))) throw new Error("web_console_index_missing");
  const policy = [
    "default-src 'self'",
    homeserver ? `connect-src 'self' ${homeserver}` : "connect-src 'self'",
    // blob: shows ledger attachment images, which are fetched with the bearer header (agent-router ADR 0005 16.5).
    "img-src 'self' data: blob:",
    // React and the shared UI set dynamic sizes through style attributes.
    "style-src 'self' 'unsafe-inline'",
    "script-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    // The only framed page is Cloudflare Browser Run's live view, shown when an Agent hands its browser to the owner.
    "frame-src https://live.browser.run",
    "frame-ancestors 'none'",
  ].join("; ");
  const headers = (res: express.Response) => res.set({
    "Content-Security-Policy": policy,
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
  });
  const assets = express.static(directory, {
    index: false,
    setHeaders: (res, path) => {
      headers(res);
      res.set("Cache-Control", path.endsWith("/version.json") ? "no-store" : path.includes(`${join(directory, "assets")}`) ? "public, max-age=31536000, immutable" : "no-cache");
    },
  });
  return (req, res, next) => {
    if (req.path.startsWith("/_") || /^\/health(?:\/|$)/i.test(req.path)) return next();
    assets(req, res, () => {
      if (req.method !== "GET" && req.method !== "HEAD") return next();
      headers(res);
      res.set("Cache-Control", "no-cache");
      // Relative to root: dotfile rules apply inside the console, not to its install path.
      res.sendFile("index.html", { root: directory });
    });
  };
}
