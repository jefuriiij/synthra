// GET /settings and POST /settings — the IDE's Settings tab. Reads and writes
// ~/.synthra/settings.json (src/shared/settings.ts); every setting comes back
// with where its value came from, so the tab can say "set by SYN_… in your
// environment" instead of offering a control that would do nothing.
//
// The file is global, so a change applies to every project's server at once:
// loadConfig() re-reads it whenever it changes.

import { patchAgentsMd } from "../../hooks/agents-md.js";
import { log } from "../../shared/logger.js";
import {
  type SettingSource,
  resolveSettings,
  settingsPath,
  writeSetting,
} from "../../shared/settings.js";
import type { ServerContext } from "../context.js";

export interface SettingView {
  key: string;
  group: string;
  label: string;
  help: string;
  type: "number" | "boolean";
  value: number | boolean;
  default: number | boolean;
  source: SettingSource;
  /** The environment variable that overrides the file. */
  env: string;
  min?: number;
  max?: number;
  unit?: string;
}

export interface SettingsView {
  path: string;
  settings: SettingView[];
}

export function settingsView(): SettingsView {
  return {
    path: settingsPath(),
    settings: resolveSettings().map(({ def, value, source }) => ({
      key: def.key,
      group: def.group,
      label: def.label,
      help: def.help,
      type: def.type,
      value,
      default: def.default,
      source,
      env: def.env,
      ...(def.type === "number"
        ? { min: def.min, max: def.max, ...(def.unit ? { unit: def.unit } : {}) }
        : {}),
    })),
  };
}

export interface SettingsPost {
  key?: unknown;
  /** The new value, or null to go back to the default. */
  value?: unknown;
}

export async function handleSettingsPost(
  body: SettingsPost,
  ctx: ServerContext,
): Promise<SettingsView & { ok: boolean; error?: string }> {
  if (typeof body?.key !== "string") {
    return { ok: false, error: "settings: `key` is required.", ...settingsView() };
  }
  const r = writeSetting(body.key, body.value === undefined ? null : body.value);
  if (!r.ok) return { ok: false, error: r.error, ...settingsView() };

  // AGENTS.md tells other AI tools the limits in words: keep it true now,
  // not at the next `syn .`.
  if (body.key === "memoryChars" || body.key === "userChars") {
    try {
      await patchAgentsMd(ctx.paths.agentsMd);
    } catch (err) {
      log.warn(`AGENTS.md not updated: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { ok: true, ...settingsView() };
}
