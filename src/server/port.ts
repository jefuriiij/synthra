// Finds a free port in the 8080–8099 range. Writes the chosen port to
// .synthra-graph/mcp_port so PowerShell/Bash hook scripts can read it.
// TODO: M2

import { createServer } from "node:net";

export const PORT_RANGE_START = 8080;
export const PORT_RANGE_END = 8099;

export async function findFreePort(
  start = PORT_RANGE_START,
  end = PORT_RANGE_END,
): Promise<number> {
  for (let port = start; port <= end; port++) {
    if (await isFree(port)) return port;
  }
  throw new Error(`Synthra: no free port in ${start}-${end}`);
}

function isFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = createServer();
    s.once("error", () => resolve(false));
    s.once("listening", () => s.close(() => resolve(true)));
    s.listen(port, "127.0.0.1");
  });
}
