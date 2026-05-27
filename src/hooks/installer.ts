// Writes hook scripts into <project>/.claude/hooks/ and registers them in
// <project>/.claude/settings.local.json. Idempotent.
// TODO: M3

import type { SynthraPaths } from "../shared/paths.js";

export interface InstallResult {
  scriptsWritten: string[];
  settingsUpdated: boolean;
  mcpRegistered: boolean;
}

export async function installHooks(_paths: SynthraPaths, _mcpPort: number): Promise<InstallResult> {
  throw new Error("Synthra: installHooks not yet implemented (M3)");
}
