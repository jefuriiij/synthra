// Single source of truth: re-export the frozen server data contracts as
// type-only (erased at build — the server modules are never bundled into the UI).
export type {
  DashboardData,
  ProjectStats,
  RecentTurn,
} from "../../delta.js";
export type {
  CostCard,
  Finding,
  KnowledgeCard,
  LearningCard,
  MemoryCard,
  OverviewData,
  ProjectHealth,
} from "../../overview.js";
export type { DoctorCheck } from "../../../cli/doctor-command.js";

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
