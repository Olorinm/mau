import { createServer } from "node:http";
import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { once } from "node:events";

export const accessTeam = "https://example-team.cloudflareaccess.com", accessAudience = "a".repeat(64);

/** A stand-in for Cloudflare Access: a local JWKS endpoint and RS256 application JWTs signed by it. */
export async function accessIssuer(cleanup: Array<() => unknown>) {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: "jwk" }), kid: "k1", alg: "RS256", use: "sig" };
  const certs = createServer((_req, res) => res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ keys: [jwk] })));
  certs.listen(0, "127.0.0.1"); await once(certs, "listening");
  cleanup.push(() => new Promise<void>((resolve) => certs.close(() => resolve())));
  const jwt = (claims: Record<string, unknown> = {}) => {
    const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const now = Math.floor(Date.now() / 1000);
    const input = `${part({ alg: "RS256", kid: "k1", typ: "JWT" })}.${part({ iss: accessTeam, aud: [accessAudience], email: "alice@example.test",
      sub: randomUUID(), type: "app", iat: now, exp: now + 600, ...claims })}`;
    return `${input}.${sign("RSA-SHA256", Buffer.from(input), privateKey).toString("base64url")}`;
  };
  return { jwt, certsUrl: new URL(`http://127.0.0.1:${(certs.address() as { port: number }).port}/cdn-cgi/access/certs`),
    config: (owners: Record<string, string>) => ({ provider: "cloudflare-access", teamDomain: accessTeam, audiences: [accessAudience], owners }) };
}
