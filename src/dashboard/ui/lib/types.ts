// Single source of truth: re-export the frozen server data contracts as
// type-only (erased at build — the server modules are never bundled into the UI).
export type {
  DashboardData,
  ProjectStats,
  RecentTurn,
  RecentGate,
  HotFile,
} from "../../delta.js";
export type { ArsenalData, ArsenalItem, ArsenalScope } from "../../arsenal.js";

export type View = "overview" | "arsenal";
