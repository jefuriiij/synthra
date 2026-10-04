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
  /** Favorite and delete from Capabilities, by the skill's path. */
  skillBusy = $state<Record<string, boolean>>({});
  skillErrors = $state<Record<string, string>>({});
  /** Why the last merge request couldn't be made ("" = it is on the clipboard). */
  mergeError = $state("");
  merging = $state(false);
  /** Backup and restore, in the Settings tab. */
  backingUp = $state(false);
  backupText = $state("");
  backupError = $state("");
  restoring = $state(false);
  restoreLines = $state<string[]>([]);
  restoreError = $state("");
  reinstall = $state(0);
  /** The update check of installed skills, in the Capabilities tab. */
  checkingUpdates = $state(false);
  updatesText = $state("");
  updatesError = $state("");

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
    } else if (msg.type === "skillResult") {
      this.skillBusy = { ...this.skillBusy, [msg.target]: false };
      this.skillErrors = { ...this.skillErrors, [msg.target]: msg.error };
    } else if (msg.type === "backupResult") {
      this.backingUp = false;
      this.backupText = msg.text;
      this.backupError = msg.error;
    } else if (msg.type === "restoreResult") {
      this.restoring = false;
      this.restoreLines = msg.lines;
      this.reinstall = msg.reinstall;
      this.restoreError = msg.error;
    } else if (msg.type === "updatesResult") {
      this.checkingUpdates = false;
      this.updatesText = msg.text;
      this.updatesError = msg.error;
    } else if (msg.type === "mergeResult") {
      this.merging = false;
      this.mergeError = msg.error;
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

  /** Approve or reject every change of one merge. */
  answerGroup(group: string, verdict: "approve" | "reject"): void {
    this.answering = { ...this.answering, [group]: true };
    this.answerErrors = { ...this.answerErrors, [group]: "" };
    post({ type: "answerGroup", group, verdict });
  }

  /** Capabilities: star or unstar, or delete (the host asks first). */
  skill(
    a: { type: "favorite"; path: string; on: boolean } | { type: "deleteSkill"; path: string },
  ): void {
    this.skillBusy = { ...this.skillBusy, [a.path]: true };
    this.skillErrors = { ...this.skillErrors, [a.path]: "" };
    post(a);
  }

  /** Ask GitHub which installed skills have updates. */
  checkUpdates(): void {
    this.checkingUpdates = true;
    this.updatesText = "";
    this.updatesError = "";
    post({ type: "checkUpdates" });
  }

  /** Update installed skills (the host asks first). Busy under "update:<names>". */
  updateSkills(names: string[]): void {
    const target = `update:${names.join(" ")}`;
    this.skillBusy = { ...this.skillBusy, [target]: true };
    this.skillErrors = { ...this.skillErrors, [target]: "" };
    post({ type: "updateSkills", names });
  }

  /** "Don't update" on or off, or the update's changes as a diff; busy and
   *  errors under the skill's path. */
  installed(
    a: { type: "holdSkill"; name: string; on: boolean } | { type: "skillChanges"; name: string },
    path: string,
  ): void {
    this.skillBusy = { ...this.skillBusy, [path]: true };
    this.skillErrors = { ...this.skillErrors, [path]: "" };
    post(a);
  }

  /** Open an installed skill's repo on GitHub. */
  openRepo(repo: string): void {
    post({ type: "openRepo", repo });
  }

  /** Put a merge request for these skills on the clipboard. */
  merge(paths: string[]): void {
    this.merging = true;
    this.mergeError = "";
    post({ type: "mergeSkills", paths });
  }

  backup(): void {
    this.backingUp = true;
    this.backupText = "";
    this.backupError = "";
    post({ type: "backup" });
  }

  restore(): void {
    this.restoring = true;
    this.restoreLines = [];
    this.restoreError = "";
    this.reinstall = 0;
    post({ type: "restoreBackup" });
  }

  runReinstall(): void {
    post({ type: "reinstall" });
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
