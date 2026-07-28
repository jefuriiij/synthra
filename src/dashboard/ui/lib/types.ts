// Single source of truth: re-export the frozen server data contracts as
// type-only (erased at build — the server modules are never bundled into the UI).
export type {
  DashboardData,
  ProjectStats,
  RecentTurn,
  RecentGate,
  RecentBash,
  RecentRoute,
  HotFile,
} from "../../delta.js";
export type {
  ArsenalData,
  ArsenalDetail,
  ArsenalItem,
  ArsenalKind,
  ArsenalScope,
} from "../../arsenal.js";
export type { DoctorCheck } from "../../../cli/doctor-command.js";
export type { FavoriteEntry } from "../../../shared/favorites.js";

import type { FavoriteEntry as Fav } from "../../../shared/favorites.js";
/** Payload of GET /favorites, and of a successful POST /favorites. */
export interface FavoritesResponse {
  ok?: boolean;
  favorite?: boolean;
  favorites: Fav[];
  error?: string;
}

import type { DoctorCheck as Check } from "../../../cli/doctor-command.js";
/** Payload of GET /report — doctor checks + system info + prebuilt markdown. */
export interface ReportData {
  version: string;
  platform: string;
  arch: string;
  node: string;
  checks: Check[];
  markdown: string;
}

export type View = "overview" | "arsenal" | "commands";
