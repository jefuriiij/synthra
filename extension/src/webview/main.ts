// Page entry. Order matters:
//   1. listen — the host answers `ready` with `view`, and a message posted
//      before a listener exists is simply lost;
//   2. mount the app;
//   3. announce `ready`.

import { mount } from "svelte";

import App from "./App.svelte";
import { store } from "./lib/store.svelte";
import { onHostMessage, post } from "./lib/vscode";
import "./app.css";

onHostMessage((msg) => store.apply(msg));

const target = document.getElementById("app");
if (!target) throw new Error("Synthra: #app element missing from the webview HTML");
mount(App, { target });

post({ type: "ready" });
