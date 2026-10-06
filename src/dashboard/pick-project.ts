// Which project a dashboard request is about. Any window's dashboard shows any
// project Synthra knows, but only those: a path from the page is checked
// against the registry, never opened as given.

import { type SynthraPaths, resolvePaths, sameRoot } from "../shared/paths.js";
import { listProjects } from "../shared/project-registry.js";

/** The project `?project=` asks for: this window's own when absent or the
 *  same, else one from the registry; null for a path Synthra doesn't know. */
export async function pickProject(
  own: SynthraPaths,
  want: string | undefined,
): Promise<SynthraPaths | null> {
  if (!want || sameRoot(want, own.projectRoot)) return own;
  const known = (await listProjects()).find((p) => sameRoot(p.path, want));
  return known ? resolvePaths(known.path, own.userMemory) : null;
}
