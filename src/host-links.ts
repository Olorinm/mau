/**
 * How a computer's Host reaches the service: it enrolls with a pairing code, then keeps one socket open. Agent Kit
 * serves both paths and checks the code or the link's own credential on them; they are the only routes besides the
 * liveness probe that a deployment lets through without an owner sign-in.
 */
export const HOST_LINK_PATHS = {
  enroll: "/_agent-router/v1/host-links/enroll",
  socket: "/_agent-router/v1/host-links/socket",
} as const;

/** The command the owner runs on the computer whose agent becomes a partner. */
export const pairCommand = (service: string, code: string) => `npx @olorinm/agent-host link ${service} --code ${code}`;
