import type { Partners } from "../../src/partners.js";

/** The partners service for tests about the other product tools: nobody to work with, nothing to tell a turn. */
export const noPartners = { turnContext: async () => ({}), authority: () => undefined, observe: () => {}, delivered: () => {},
  execute: async () => ({ isError: true, error: "partner_tool_unavailable" }) } as unknown as Partners;
