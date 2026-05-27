// Project bootstrap: creates .synthra-graph/, .synthra/, updates .gitignore,
// patches CLAUDE.md with the versioned policy block.
// TODO: M1

import type { SynthraPaths } from "../shared/paths.js";

export interface BootstrapResult {
  graphCreated: boolean;
  contextCreated: boolean;
  gitignoreUpdated: boolean;
  claudeMdUpdated: boolean;
}

export async function bootstrap(_paths: SynthraPaths): Promise<BootstrapResult> {
  throw new Error("Synthra: bootstrap not yet implemented (M1)");
}
