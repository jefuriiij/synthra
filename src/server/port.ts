// Finds a free port in the 47080–47099 range. The chosen port is written to
// .synthra-graph/mcp_port so PowerShell/Bash hook scripts can read it.
//
// `reserveFreePort` binds and HOLDS the socket, then hands it back. The older
// close-then-return shape left a TOCTOU gap: the port was free again for the
// microseconds between the probe and the real listen, so two `syn` starting
// together could both pick it and one would die on EADDRINUSE.
//
// Why not 8080–8099 (the range until v0.51): Synthra listens on 127.0.0.1
// only, and on Windows that bind works while another program holds the same
// port on 0.0.0.0, "::" or "::1" (unless it asked for exclusive use, and most
// dev servers don't). Both then listen, and every request to localhost goes to
// the more specific address: Synthra. A user's backend on 0.0.0.0:8080 had its
// sign-in requests answered by Synthra's "cross-origin request refused".
// Two guards:
//   1. `answers`: before taking a port, try to connect to it on 127.0.0.1 and
//      ::1. Whatever answers owns it, whatever flags it bound with.
//   2. The range. A check at start can't see an app that starts LATER (the
//      editor opens, then the backend): Windows lets it bind next to Synthra
//      with no error. So the default range keeps away from the ports dev
//      servers use; it is below the range the OS hands out by itself (49152+).

import { type Server, connect, createServer } from "node:net";

export const PORT_RANGE_START = 47080;
export const PORT_RANGE_END = 47099;

/** How long a connect may take before the port counts as silent. A refused
 *  connect on loopback answers in 1 to 2 ms. */
const ANSWER_TIMEOUT_MS = 250;

export interface PortReservation {
  port: number;
  /** Release the probe socket right before the real server binds. */
  release: () => Promise<void>;
}

export async function reserveFreePort(
  start = PORT_RANGE_START,
  end = PORT_RANGE_END,
  preferred?: number,
): Promise<PortReservation> {
  // The port this project had last time first: a restart then keeps the
  // address that open Claude chats and .mcp.json already use (v0.48).
  const order =
    preferred !== undefined && preferred >= start && preferred <= end ? [preferred] : [];
  for (let p = start; p <= end; p++) if (p !== preferred) order.push(p);
  for (const port of order) {
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

/** Whether something accepts a connection on this loopback address. */
function answersOn(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ port, host });
    const done = (yes: boolean) => {
      socket.destroy();
      resolve(yes);
    };
    socket.setTimeout(ANSWER_TIMEOUT_MS, () => done(false));
    socket.once("connect", () => done(true));
    // Refused, or no IPv6 on this machine: nothing is there.
    socket.once("error", () => done(false));
  });
}

/** Whether another program already serves this port on localhost, over IPv4
 *  or IPv6. A bind alone can't tell on Windows (see the top of the file). */
export async function answers(port: number): Promise<boolean> {
  const [v4, v6] = await Promise.all([answersOn(port, "127.0.0.1"), answersOn(port, "::1")]);
  return v4 || v6;
}

async function hold(port: number): Promise<Server | null> {
  if (await answers(port)) return null;
  return new Promise((resolve) => {
    const s = createServer();
    s.once("error", () => resolve(null));
    s.once("listening", () => resolve(s));
    s.listen(port, "127.0.0.1");
  });
}
