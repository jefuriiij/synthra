// Stable, short content hash for files. Used to detect changed files
// during incremental rescans (post-v0.1; M1 does full re-parse).
// TODO: M1 (minimal); post-v0.1 (incremental)

import { createHash } from "node:crypto";

export function fileHash(content: string): string {
  return createHash("sha1").update(content).digest("hex").slice(0, 8);
}
