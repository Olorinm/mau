import { z } from "zod";

/** Trusted composition metadata. Never accepted from model arguments or forwarded as Host HTTP policy. */
export const runAdmissionSchema = z.object({
  kind: z.enum(["owner", "delegation", "schedule"]),
  owner: z.string().min(1), agentId: z.string().min(1), reference: z.string().min(1),
  expiresAt: z.iso.datetime().optional(),
  maxToolCalls: z.number().int().min(1).max(1000).optional(),
  toolGrants: z.object({
    business: z.boolean().optional(), feishu: z.boolean().optional(),
    connectedApps: z.object({ connections: z.array(z.string()).max(64),
      operations: z.array(z.string()).max(200).optional() }).strict().optional(),
  }).strict().optional(),
}).strict();
export type RunAdmission = z.infer<typeof runAdmissionSchema>;
export type AdmissionValidator = (admission: RunAdmission) => boolean;

export function validAdmission(value: unknown, agentId: string, owner: string, validate?: AdmissionValidator): RunAdmission | undefined {
  const parsed = runAdmissionSchema.safeParse(value);
  if (!parsed.success || parsed.data.agentId !== agentId || parsed.data.owner !== owner) return;
  const admission = parsed.data;
  if (admission.expiresAt && Date.parse(admission.expiresAt) <= Date.now()) return;
  if (admission.kind !== "owner" && !admission.toolGrants) return;
  if (validate && !validate(admission)) return;
  return admission;
}
