// Minimal logger. Prefixes Synthra output with [syn].

type Level = "debug" | "info" | "warn" | "error";

const LEVEL_PRIORITY: Record<Level, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

let activeLevel: Level = (process.env.SYN_LOG_LEVEL as Level) ?? "info";

export function setLevel(level: Level): void {
  activeLevel = level;
}

function shouldLog(level: Level): boolean {
  return LEVEL_PRIORITY[level] >= LEVEL_PRIORITY[activeLevel];
}

function emit(level: Level, msg: string, ...args: unknown[]): void {
  if (!shouldLog(level)) return;
  const stream = level === "error" || level === "warn" ? process.stderr : process.stdout;
  stream.write(`[syn] ${msg}${args.length ? " " + args.map(String).join(" ") : ""}\n`);
}

export const log = {
  debug: (m: string, ...a: unknown[]) => emit("debug", m, ...a),
  info: (m: string, ...a: unknown[]) => emit("info", m, ...a),
  warn: (m: string, ...a: unknown[]) => emit("warn", m, ...a),
  error: (m: string, ...a: unknown[]) => emit("error", m, ...a),
};
