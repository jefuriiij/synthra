// Rejects requests whose Host header isn't one we serve.
//
// WHY THIS EXISTS (don't delete it as ceremony): both Hono apps bind 127.0.0.1
// with no auth, and that is NOT the boundary it feels like. A page in the
// user's browser can make requests to localhost on an attacker's behalf — DNS
// rebinding is the standard technique: attacker.example resolves to their
// server, serves JS, then re-points its own DNS at 127.0.0.1 with a 1s TTL. The
// script fetches its own origin, the browser calls that same-origin (same
// hostname on both sides), so no CORS applies and the response body is readable
// by the attacker. Without this check the MCP server answers, and `graph_read`
// is by design a read-any-file-in-the-project primitive.
//
// Host is the right header to key on because it is on the browser's forbidden
// list: page script cannot set, override or strip it, so it always names the
// host that was actually dialled. The rebound request arrives saying
// `attacker.example:8901` while every legitimate one says 127.0.0.1 or
// localhost. Origin can't do this job — a rebound request is same-origin, so
// the browser sends no Origin at all (see dashboard/origin-guard.ts, which
// allows a missing one on purpose: curl omits it too).

const LOCAL_HOSTNAMES = new Set(["127.0.0.1", "localhost", "::1", "[::1]", "0.0.0.0"]);

/** Split "host:port" without tripping over IPv6's own colons. */
function splitHostPort(raw: string): { hostname: string; port: string | null } {
  const value = raw.trim();
  if (value.startsWith("[")) {
    // [::1]:8901 — bracketed IPv6, port (if any) follows the closing bracket.
    const close = value.indexOf("]");
    if (close === -1) return { hostname: value.toLowerCase(), port: null };
    const hostname = value.slice(0, close + 1).toLowerCase();
    const rest = value.slice(close + 1);
    return { hostname, port: rest.startsWith(":") ? rest.slice(1) : null };
  }
  const colon = value.lastIndexOf(":");
  // A bare IPv6 literal has several colons and no port.
  if (colon === -1 || value.indexOf(":") !== colon) {
    return { hostname: value.toLowerCase(), port: null };
  }
  return { hostname: value.slice(0, colon).toLowerCase(), port: value.slice(colon + 1) };
}

/**
 * Is this Host header one we're willing to answer on?
 *
 * `allowed` entries come from SYN_ALLOWED_HOSTS and may name a bare hostname
 * ("dev.box") or pin a port ("dev.box:8901"). A bare entry matches any port, so
 * someone tunnelling doesn't have to enumerate the range.
 */
export function isAllowedHost(
  hostHeader: string | undefined,
  port: number,
  allowed: readonly string[] = [],
): boolean {
  // HTTP/1.1 requires Host and node maps HTTP/2's :authority onto it, so a
  // missing one means a hand-rolled client. Fail closed — the legitimate
  // callers here are hook scripts and a browser, and both always send it.
  if (!hostHeader) return false;

  const { hostname, port: hostPort } = splitHostPort(hostHeader);
  if (!hostname) return false;

  // Loopback names are ours, but only on the port this server actually holds:
  // ports are machine-global, and answering for a port we don't own would be
  // the same category of mistake v0.26 fixed for mcp_port.
  if (LOCAL_HOSTNAMES.has(hostname) && hostPort === String(port)) return true;

  for (const entry of allowed) {
    const want = splitHostPort(entry);
    if (!want.hostname || want.hostname !== hostname) continue;
    // A pinned port must match; an unpinned entry matches any.
    if (want.port === null || want.port === hostPort) return true;
  }

  return false;
}

/** Message for a refused request — names the escape hatch so a LAN or tunnel
 *  user can fix it without reading the source. */
export function forbiddenHostMessage(hostHeader: string | undefined): string {
  const seen = hostHeader ? `"${hostHeader}"` : "(no Host header)";
  return (
    `refused: ${seen} is not a host this server answers on. Synthra only serves ` +
    `localhost. If you are reaching it over a LAN, tunnel or container, list the ` +
    `hostname in SYN_ALLOWED_HOSTS (comma-separated, optionally host:port).`
  );
}
