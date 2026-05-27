// chokidar-based file watcher. Emits events when the HUMAN saves a file
// outside Claude. Respects .gitignore + .synthraignore.
// TODO: M5 — improvement #3 (the wedge)

import type { FileEvent } from "./activity-log.js";

export interface FileWatcher {
  start(): Promise<void>;
  stop(): Promise<void>;
}

export type FileEventHandler = (e: FileEvent) => void | Promise<void>;

export function createFileWatcher(_root: string, _onEvent: FileEventHandler): FileWatcher {
  throw new Error("Synthra: createFileWatcher not yet implemented (M5)");
}
