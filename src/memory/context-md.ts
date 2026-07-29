// Free-form CONTEXT.md narrative. Updated by Stop hook at session end with:
//   - Current Task (1 sentence)
//   - Key Decisions (max 3 bullets)
//   - Next Steps (max 3 bullets)
// Capped at ~20 visible content lines.

import { readFile } from "node:fs/promises";

import { writeTextAtomic } from "../shared/json-store.js";
import type { ContextEntry } from "./context-store.js";

export interface ContextMd {
  branch: string;
  currentTask: string;
  keyDecisions: string[];
  nextSteps: string[];
  date: string;
}

const MAX_BULLETS = 3;

export function deriveContextMd(entries: ContextEntry[], branch: string): ContextMd {
  // Latest pending task drives "current task".
  const tasks = entries.filter((e) => e.type === "task").reverse();
  const currentTask = tasks[0]?.content ?? "";

  const keyDecisions = entries
    .filter((e) => e.type === "decision")
    .slice(-MAX_BULLETS)
    .map((e) => e.content);

  const nextSteps = entries
    .filter((e) => e.type === "next")
    .slice(-MAX_BULLETS)
    .map((e) => e.content);

  return {
    branch,
    currentTask,
    keyDecisions,
    nextSteps,
    date: new Date().toISOString(),
  };
}

export function formatContextMd(ctx: ContextMd): string {
  const lines: string[] = [];
  lines.push(`# Context — ${ctx.branch}`);
  lines.push("");
  lines.push(`_Updated: ${ctx.date}_`);
  lines.push("");

  if (ctx.currentTask) {
    lines.push(`## Current task`);
    lines.push(ctx.currentTask);
    lines.push("");
  }

  if (ctx.keyDecisions.length) {
    lines.push(`## Key decisions`);
    for (const d of ctx.keyDecisions) lines.push(`- ${d}`);
    lines.push("");
  }

  if (ctx.nextSteps.length) {
    lines.push(`## Next steps`);
    for (const n of ctx.nextSteps) lines.push(`- ${n}`);
    lines.push("");
  }

  if (!ctx.currentTask && !ctx.keyDecisions.length && !ctx.nextSteps.length) {
    lines.push("_(no context entries yet — use `context_remember` to add one)_");
    lines.push("");
  }

  return lines.join("\n");
}

/** Atomic because this file is GIT-TRACKED — a torn write gets committed. */
export async function writeContextMd(path: string, ctx: ContextMd): Promise<void> {
  await writeTextAtomic(path, formatContextMd(ctx));
}

export async function readContextMd(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}
