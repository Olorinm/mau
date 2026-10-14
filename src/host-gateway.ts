import express from "express";
import { RouterError } from "@agent-router/server";
import type { EnvironmentManager } from "./environments.js";

// Product-owned gateway to the selected Agent's public Host HTTP v1 API.
// Ownership and the current Environment binding are checked on every request.
const id = "[A-Za-z0-9._:-]+";
const reads = new RegExp(`^/v1/(?:health|runtimes|sessions|runs|runs/${id}(?:/events|/calls)?|sessions/${id}/files)$`);
const writes = new RegExp(`^/v1/(?:runs|runtimes/(?:inspect|discover)|native-sessions|runs/${id}/(?:cancel|steer|compact)|runs/${id}/calls/${id}/result|sessions/${id}/files)$`);

export function hostGateway(environments: EnvironmentManager): express.RequestHandler {
  const body = express.json({ limit: "44mb" });
  return (req, res, next) => {
    try {
      const agentId = String(req.params.id);
      const state = environments.summary(String(res.locals.owner), agentId);
      if (!(req.method === "GET" ? reads : req.method === "POST" ? writes : /a^/).test(req.path))
        throw new RouterError("host_operation_not_exposed", 404);
      if (!state || state.state !== "ready" || state.busy)
        throw new RouterError("environment_not_ready", 409);
      const signal = new AbortController();
      res.once("close", () => { if (!res.writableEnded) signal.abort(); });
      body(req, res, (error?: unknown) => {
        if (error) return next(error);
        const path = req.url;
        void environments.http(agentId, state.operationId).request(path, {
          signal: signal.signal,
          ...(req.method === "POST" ? { body: req.body } : {}),
        }).then(value => {
          res.status(req.method === "POST" && req.path === "/v1/runs" ? 202 : 200).json(value);
        }).catch((error: unknown) => {
          // ServiceHttp deliberately exposes stable error codes, never response bodies or credentials.
          if (error instanceof Error && "status" in error && typeof error.status === "number" &&
              error.status >= 400 && error.status <= 599 && "code" in error &&
              typeof error.code === "string" && /^[a-zA-Z0-9_.:-]{1,120}$/.test(error.code)) {
            next(new RouterError(error.code, error.status));
          } else next(error);
        });
      });
    } catch (error) { next(error); }
  };
}
