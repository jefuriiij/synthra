// Version check on every run. Out of scope for v0.1 — users update via
// `npm i -g synthra@latest` for now. Stub kept for future use.

export interface UpdateCheckResult {
  current: string;
  latest: string | null;
  hasUpdate: boolean;
}

export async function checkForUpdate(): Promise<UpdateCheckResult> {
  // TODO: post-v0.1 — query npm registry
  const { version } = await import("../../package.json", { with: { type: "json" } });
  return { current: version, latest: null, hasUpdate: false };
}
