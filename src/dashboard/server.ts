// Standalone dashboard server on 8901. Reads .synthra-graph/token_log.jsonl
// across all projects the user has used Synthra with.
// TODO: M6

export interface DashboardServerHandle {
  port: number;
  url: string;
  stop(): Promise<void>;
}

export async function startDashboard(_port = 8901): Promise<DashboardServerHandle> {
  throw new Error("Synthra: startDashboard not yet implemented (M6)");
}
