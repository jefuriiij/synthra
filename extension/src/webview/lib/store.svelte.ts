// The page's state: the last view the host sent, the tab on screen, and
// whether a refresh the user asked for is running.

import type { HostToWebview, Tab, TabsView } from "../../shared/tabs";
import { getState, post, setState } from "./vscode";

class Store {
  view = $state<TabsView | undefined>(undefined);
  tab = $state<Tab>(getState().tab ?? "memory");
  refreshing = $state(false);

  apply(msg: HostToWebview): void {
    if (msg.type === "view") this.view = msg.view;
    else if (msg.type === "refreshing") this.refreshing = msg.on;
  }

  setTab(tab: Tab): void {
    this.tab = tab;
    setState({ tab });
  }

  /** A click on something the host offered (see shared/tabs.ts). */
  open(key: string | undefined): void {
    if (key) post({ type: "open", key });
  }

  refresh(): void {
    this.refreshing = true;
    post({ type: "refresh" });
  }
}

export const store = new Store();
