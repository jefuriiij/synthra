// POST /context-update — Stop hook calls this to update CONTEXT.md
// based on the session's transcript (current task / decisions / next steps).
// TODO: M4

export interface ContextUpdateRequest {
  transcript_path: string;
  branch?: string;
}

export interface ContextUpdateResponse {
  updated: boolean;
  path: string;
}

export async function handleContextUpdate(
  _req: ContextUpdateRequest,
): Promise<ContextUpdateResponse> {
  throw new Error("Synthra: handleContextUpdate not yet implemented (M4)");
}
