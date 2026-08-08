// Finds a free port in the 8080–8099 range. The chosen port is written to
// .synthra-graph/mcp_port so PowerShell/Bash hook scripts can read it.
//
// `reserveFreePort` binds and HOLDS the socket, then hands it back. The older
// close-then-return shape left a TOCTOU gap: the port was free again for the
// microseconds between the probe and the real listen, so two `syn` starting
// together could both pick it and one would die on EADDRINUSE.

import { createServer, type Server } from "node:net";

export const PORT_RANGE_START = 8080;
export const PORT_RANGE_END = 8099;

export interface PortReservation {
  port: number;
  /** Release the probe socket right before the real server binds. */
  release: () => Promise<void>;
}

export async function reserveFreePort(
  start = PORT_RANGE_START,
  end = PORT_RANGE_END,
): Promise<PortReservation> {
  for (let port = start; port <= end; port++) {
    const held = await hold(port);
    if (held) {
      return {
        port,
        release: () =>
          new Promise<void>((resolve) => {
            held.close(() => resolve());
          }),
      };
    }
  }
  throw new Error(`Synthra: no free port in ${start}-${end}`);
}

/** Kept for callers that only need a number and tolerate the race (the
 *  dashboard, which writes no port file and downgrades EADDRINUSE to a warning). */
export async function findFreePort(
  start = PORT_RANGE_START,
  end = PORT_RANGE_END,
): Promise<number> {
  const r = await reserveFreePort(start, end);
  await r.release();
  return r.port;
}

function hold(port: number): Promise<Server | null> {
  return new Promise((resolve) => {
    const s = createServer();
    s.once("error", () => resolve(null));
    s.once("listening", () => resolve(s));
    s.listen(port, "127.0.0.1");
  });
}
