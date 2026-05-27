// This-session rolling log of what the AI read and edited.
// Persisted to .synthra-graph/session.json for resume support.
// TODO: M1 (write); M3 (read on resume)

export type SessionEventKind = "read" | "edit" | "query";

export interface SessionEvent {
  kind: SessionEventKind;
  target: string;
  ts: string;
  meta?: Record<string, unknown>;
}

export interface SessionState {
  startedAt: string;
  events: SessionEvent[];
  filesIdentified: string[];
  symbolsChanged: string[];
}

export async function readSession(_path: string): Promise<SessionState | null> {
  throw new Error("Synthra: readSession not yet implemented (M1)");
}

export async function writeSession(_path: string, _state: SessionState): Promise<void> {
  throw new Error("Synthra: writeSession not yet implemented (M1)");
}

export async function appendEvent(_path: string, _event: SessionEvent): Promise<void> {
  throw new Error("Synthra: appendEvent not yet implemented (M1)");
}
