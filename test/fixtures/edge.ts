// The console's only login is the edge identity (Cloudflare Access): the Mau fixture with alice mapped to an Access
// email, and the header Cloudflare adds to every request behind Access.
import { alice, mauFixture } from "./mau.js";
import { accessIssuer } from "./access.js";

export const aliceEmail = "alice@example.test";

/** `mauFixture` with edge login. `edgeHeaders()` goes into a browser context's `extraHTTPHeaders` or a direct request. */
export async function edgeMauFixture(cleanup: Array<() => unknown>, serving: Parameters<typeof mauFixture>[1] = {},
  /** Extra Router service settings, for example the ledger flags. */
  routerConfig: Record<string, unknown> = {}) {
  const access = await accessIssuer(cleanup);
  const f = await mauFixture(cleanup, serving, undefined, { edgeIdentity: access.config({ [aliceEmail]: alice }) }, routerConfig,
    { edgeIdentityCerts: access.certsUrl });
  return Object.assign(f, { access,
    edgeHeaders: (claims: Record<string, unknown> = {}) => ({ "cf-access-jwt-assertion": access.jwt(claims) }) });
}
