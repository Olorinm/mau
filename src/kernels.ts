/**
 * What Mau knows about the kernels a partner can run on. An environment has one main kernel, which may be any kernel
 * its Host runs; the kernels it offers beside that one are of this list.
 */
const kernels = {
  /** Codex reports the shell commands it runs to its Host, which is what a connector CLI in the shell relays through. */
  codex: { modelService: "openai", shellRelay: true },
  claude: { modelService: "anthropic", shellRelay: false },
} as const;
export type PartnerKernel = keyof typeof kernels;
export const PARTNER_KERNELS = Object.keys(kernels) as [PartnerKernel, ...PartnerKernel[]];
const known = (kernel: string | undefined): kernel is PartnerKernel => kernel !== undefined && Object.hasOwn(kernels, kernel);

/** Whether the connector CLIs installed in the environment's shell work for partners on this kernel. */
export const shellRelay = (kernel: string | undefined) => known(kernel) && kernels[kernel].shellRelay;

/**
 * The model endpoints the kernels of an environment need, as its provider names them. Nothing when one of the
 * kernels is not known here: the provider's own default then stays in place.
 */
export function modelServices(names: string[]): string[] | undefined {
  return names.every(known) ? [...new Set(names.map(name => kernels[name].modelService))] : undefined;
}
