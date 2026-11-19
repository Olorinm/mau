/**
 * How a computer's Host reaches the service: it enrolls with a pairing code, then keeps one socket open. Agent Kit
 * serves both paths and checks the code or the link's own credential on them; they are the only routes besides the
 * liveness probe that a deployment lets through without an owner sign-in. They are Router's `HOST_LINK_ENROLL_PATH`
 * and `HOST_LINK_SOCKET_PATH`, written out because the CLI is packed without Router; a test compares them.
 */
export const HOST_LINK_PATHS = {
  enroll: "/_agent-router/v1/host-links/enroll",
  socket: "/_agent-router/v1/host-links/socket",
} as const;
