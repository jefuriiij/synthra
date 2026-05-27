// Free-form CONTEXT.md narrative. Updated by Stop hook at session end with:
//   - Current Task (1 sentence)
//   - Key Decisions (max 3 bullets)
//   - Next Steps (max 3 bullets)
// Capped at ~20 lines total.
// TODO: M4

export interface ContextMd {
  currentTask: string;
  keyDecisions: string[];
  nextSteps: string[];
  date: string;
}

export async function readContextMd(_path: string): Promise<ContextMd | null> {
  throw new Error("Synthra: readContextMd not yet implemented (M4)");
}

export async function writeContextMd(_path: string, _ctx: ContextMd): Promise<void> {
  throw new Error("Synthra: writeContextMd not yet implemented (M4)");
}
