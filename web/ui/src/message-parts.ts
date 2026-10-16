/** Display records only; adapters own event protocols and persistence. */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export type TextPart = {
  id: string;
  type: "text";
  text: string;
};

export type NotePart = {
  id: string;
  type: "note";
  text: string;
  tone: string;
  data?: JsonValue | undefined;
};

export type ReasoningPart = {
  id: string;
  type: "reasoning";
  reasoningId: string;
  kernelId: string;
  kind: "native" | "summary";
  text: string;
  status: string;
  redacted: boolean;
  elapsedMs?: number | undefined;
};

export type ToolPart = {
  /** Optional caller-supplied full detail; default OpenGrove presentation stays unchanged. */
  detail?: {label: string; text: string};
  interaction?: {
    disabledReason?: string;
    choices?: {id: string; label: string; description?: string; primary?: boolean}[];
    questions?: {id: string; title: string; description?: string; multiSelect?: boolean; secret?: boolean; options: {value: string; label: string; description?: string}[]}[];
    allowSkip?: boolean;
  };
  id: string;
  type: "tool";
  phase: string;
  toolId: string;
  callId?: string | undefined;
  title: string;
  input?: JsonValue | undefined;
  status: string;
  result?: JsonValue | undefined;
  error: string;
  approvalId: string;
  approvalStatus: string;
  approvalReason: string;
  approvalInput?: JsonValue | undefined;
  questionId: string;
  questionStatus: string;
  questionPrompt: string;
  questionInput?: JsonValue | undefined;
};

export type SkillPart = {
  id: string;
  type: "skill";
  skillId: string;
  skillName: string;
  title: string;
  status: string;
  contentPreview: string;
  allowedTools: string[];
  model: string;
  effort: string;
  forkSessionId: string;
  result: string;
  description: string;
  whenToUse: string;
  source: string;
  trust: string;
  context: string;
  packId: string;
};

export type MessagePart = TextPart | NotePart | ReasoningPart | ToolPart | SkillPart;

export interface AttachmentPayload {
  id: string;
  name: string;
  kind: "image" | "text" | "file";
  mimeType: string;
  size: number;
  text?: string;
  dataUrl?: string;
  thumbnailUrl?: string;
  error?: string;
}

