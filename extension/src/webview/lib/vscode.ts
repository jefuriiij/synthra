// The page's only door to the extension host.
//
// acquireVsCodeApi() may be called ONCE per webview document — a second call
// throws. This module is therefore the only caller.

import type { HostToWebview, Tab, WebviewToHost } from "../../shared/tabs";

/** UI-only state VS Code keeps across hide/show and window reloads. The data
 *  is not here: the host re-sends it on `ready`. */
export interface PersistedState {
  tab?: Tab;
}

declare function acquireVsCodeApi(): {
  postMessage(msg: unknown): void;
  getState(): unknown;
  setState(s: unknown): void;
};

const api = acquireVsCodeApi();

export function post(msg: WebviewToHost): void {
  api.postMessage(msg);
}

const TABS: readonly string[] = ["memory", "capabilities", "agents"];

export function getState(): PersistedState {
  // Whatever an older build stored comes back verbatim; never trust its shape.
  const s: unknown = api.getState();
  if (typeof s !== "object" || s === null) return {};
  const { tab } = s as { tab?: unknown };
  return typeof tab === "string" && TABS.includes(tab) ? { tab: tab as Tab } : {};
}

export function setState(s: PersistedState): void {
  api.setState(s);
}

/** Subscribe to host messages. Call before mounting so an early `view` is not
 *  missed. */
export function onHostMessage(handler: (msg: HostToWebview) => void): void {
  window.addEventListener("message", (e: MessageEvent<unknown>) => {
    const d = e.data;
    if (typeof d === "object" && d !== null && typeof (d as { type?: unknown }).type === "string") {
      handler(d as HostToWebview);
    }
  });
}
