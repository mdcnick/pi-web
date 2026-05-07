import type { AgentSessionRuntime } from "@earendil-works/pi-coding-agent";

export interface ActiveSession {
  runtime: AgentSessionRuntime;
  unsubscribe: () => void;
}

export type GetActiveSession = (sessionId: string) => Promise<ActiveSession>;
