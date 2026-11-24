// Guard for the local server's mutating (POST) routes.
//
// WHY THIS EXISTS (don't delete it as ceremony): the server binds
// 127.0.0.1 with no auth, so any page the user happens to be browsing can aim a
// cross-origin POST at it. Such a request skips the CORS preflight entirely if
// it uses a "simple" content type (text/plain, form-encoded, multipart) or an
// HTML <form> — the attacker can't read the opaque response, but the write has
// already happened.
//
// Requiring application/json closes that path: it is NOT a CORS-safelisted
// content type, so a cross-origin fetch must first pass an OPTIONS preflight
// that this app never answers, and an HTML form cannot set it at all. Note that
// Hono's c.req.json() does NOT enforce the header — it will parse a text/plain
// body — so the check has to be explicit.
//
// Rejecting a foreign Origin is the belt to that braces. A MISSING Origin is
// allowed: curl and other non-browser clients omit it, and any local process
// could write Synthra's files directly anyway.

export type PostGuardResult = { ok: true } | { ok: false; status: 415 | 403; error: string };

/**
 * Who answered, for every refusal (v0.51). A refused request is often not an
 * attack but another app's own traffic: its backend listens on the same port
 * number and Synthra answers in its place (on Windows two programs can hold
 * one port, see server/port.ts). The bare "cross-origin request refused" then
 * showed up on that app's login page with no hint of where it came from.
 */
export function whoAnswered(port: number): string {
  return `This is Synthra's local server on port ${port}, not your app. If your own app should answer on this port, both are listening on it: restart Synthra (it now picks another port), or set SYN_MCP_PORT.`;
}

/** Same-origin JSON check for a mutating dashboard request. */
export function checkLocalJsonPost(
  contentType: string | undefined,
  origin: string | undefined,
  port: number,
): PostGuardResult {
  const type = (contentType ?? "").split(";")[0]?.trim().toLowerCase();
  if (type !== "application/json") {
    return {
      ok: false,
      status: 415,
      error: `expected content-type: application/json. ${whoAnswered(port)}`,
    };
  }
  if (origin && !isLocalOrigin(origin, port)) {
    return {
      ok: false,
      status: 403,
      error: `cross-origin request refused. ${whoAnswered(port)}`,
    };
  }
  return { ok: true };
}

function isLocalOrigin(origin: string, port: number): boolean {
  try {
    const u = new URL(origin);
    const localHost =
      u.hostname === "127.0.0.1" || u.hostname === "localhost" || u.hostname === "[::1]";
    return localHost && u.port === String(port);
  } catch {
    return false; // unparseable Origin — treat as foreign
  }
}
