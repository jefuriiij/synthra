// The page's state: the last view the host sent, the tab on screen, and
// whether a refresh the user asked for is running.

import type { HostToWebview, Tab, TabsView } from "../../shared/tabs";
import { getState, post, setState } from "./vscode";

class Store {
  view = $state<TabsView | undefined>(undefined);
  tab = $state<Tab>(getState().tab ?? "learning");
  refreshing = $state(false);
  /** Settings being saved, and the last refusal per setting. */
  saving = $state<Record<string, boolean>>({});
  settingErrors = $state<Record<string, string>>({});
  /** Proposals being answered, and the last failure per proposal. */
  answering = $state<Record<string, boolean>>({});
  answerErrors = $state<Record<string, string>>({});
  /** Curator actions in flight and their last failure, by target (a path,
   *  an archive path, or "run"). */
  curatorBusy = $state<Record<string, boolean>>({});
  curatorErrors = $state<Record<string, string>>({});

  apply(msg: HostToWebview): void {
    if (msg.type === "view") this.view = msg.view;
    else if (msg.type === "refreshing") this.refreshing = msg.on;
    else if (msg.type === "showTab") this.setTab(msg.tab);
    else if (msg.type === "answerResult") {
      this.answering = { ...this.answering, [msg.id]: false };
      this.answerErrors = { ...this.answerErrors, [msg.id]: msg.error };
    } else if (msg.type === "curatorResult") {
      this.curatorBusy = { ...this.curatorBusy, [msg.target]: false };
      this.curatorErrors = { ...this.curatorErrors, [msg.target]: msg.error };
    } else if (msg.type === "settingResult") {
      this.saving = { ...this.saving, [msg.key]: false };
      this.settingErrors = { ...this.settingErrors, [msg.key]: msg.error };
    }
  }

  /** Approve or reject a skill proposal. */
  answer(id: string, verdict: "approve" | "reject"): void {
    this.answering = { ...this.answering, [id]: true };
    this.answerErrors = { ...this.answerErrors, [id]: "" };
    post({ type: "answer", id, verdict });
  }

  /** Pin or unpin a skill, restore an archived one, or run the Curator now. */
  curator(
    a:
      | { type: "pin"; path: string; on: boolean }
      | { type: "restore"; archivePath: string }
      | { type: "runCurator" },
  ): void {
    const target = a.type === "pin" ? a.path : a.type === "restore" ? a.archivePath : "run";
    this.curatorBusy = { ...this.curatorBusy, [target]: true };
    this.curatorErrors = { ...this.curatorErrors, [target]: "" };
    post(a);
  }

  /** Change a setting; null = back to its default. */
  setSetting(key: string, value: number | boolean | null): void {
    this.saving = { ...this.saving, [key]: true };
    this.settingErrors = { ...this.settingErrors, [key]: "" };
    post({ type: "setSetting", key, value });
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
