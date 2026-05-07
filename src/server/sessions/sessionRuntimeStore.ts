import type { AgentSessionRuntime } from "@mariozechner/pi-coding-agent";

export interface ActiveSession {
  runtime: AgentSessionRuntime;
  unsubscribe: () => void;
}

export type GetActiveSession = (sessionId: string) => Promise<ActiveSession>;
