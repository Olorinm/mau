export type FlowStatus = "pending" | "running" | "waiting_user" | "done" | "failed";
export type FlowStepStatus = "pending" | "running" | "waiting" | "done" | "failed";

export interface FlowStep {
  id: string;
  title: string;
  owner: string;
  status: FlowStepStatus;
  output?: string;
  blocking?: boolean;
  note?: string;
  [key: string]: unknown;
}

export interface FlowData {
  flow: "v1";
  title: string;
  status: FlowStatus;
  initiator?: string;
  started?: string;
  updated?: string;
  steps: FlowStep[];
  [key: string]: unknown;
}


export type FlowLiveTodoStatus='pending'|'in_progress'|'completed';
export interface FlowLiveTodo {content:string;status:FlowLiveTodoStatus}
export interface FlowActivity {todos?:FlowLiveTodo[];loading?:boolean;failed?:boolean}
