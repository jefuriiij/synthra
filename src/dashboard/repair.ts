// POST /repair, the dashboard's "Fix hooks": rewrite one project's hook
// scripts and their registration, the part of `syn .` that repairs a hook that
// stopped quietly.
//
// Only for a project this machine already runs Synthra in: the path must be
// the dashboard's own project or one in the registry, never any folder a page
// names. Same-origin JSON only (origin-guard.ts), like every write.

import { installHooks } from "../hooks/installer.js";
import { resolvePaths, sameRoot, type SynthraPaths } from "../shared/paths.js";
import { listProjects } from "../shared/project-registry.js";
import { checkLocalJsonPost } from "./origin-guard.js";

export interface RepairRequest {
  contentType: string | undefined;
  origin: string | undefined;
  body: unknown;
}

export interface RepairResult {
  status: 200 | 403 | 404 | 409 | 415;
  body: { ok: true; scripts: number } | { ok?: false; error: string };
}

export async function handleRepair(
  req: RepairRequest,
  active: SynthraPaths,
  port: number,
): Promise<RepairResult> {
  const guard = checkLocalJsonPost(req.contentType, req.origin, port);
  if (!guard.ok) return { status: guard.status, body: { error: guard.error } };

  const path = (req.body as { path?: unknown } | null)?.path;
  const target = typeof path === "string" ? path : "";
  const known =
    target !== "" &&
    (sameRoot(target, active.projectRoot) ||
      (await listProjects()).some((p) => sameRoot(p.path, target)));
  if (!known) return { status: 404, body: { error: "not a Synthra project on this machine" } };

  const result = await installHooks(resolvePaths(target));
  if (result.settingsUnreadable) {
    return {
      status: 409,
      body: {
        ok: false,
        error: `settings.local.json could not be read: ${result.settingsUnreadable}`,
      },
    };
  }
  return { status: 200, body: { ok: true, scripts: result.scriptsWritten.length } };
}
