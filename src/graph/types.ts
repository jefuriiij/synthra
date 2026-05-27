// Shared graph schema. Other modules read/write these shapes.

export type NodeKind = "file" | "symbol";

export type SymbolKind =
  | "function"
  | "method"
  | "class"
  | "interface"
  | "type"
  | "const"
  | "enum"
  | "component";

export interface FileNode {
  id: string;
  kind: "file";
  path: string;
  ext: string;
  size: number;
  keywords: string[];
  content: string;
  summary: string;
  file_hash: string;
}

export interface SymbolNode {
  id: string;
  kind: "symbol";
  symbol_kind: SymbolKind;
  name: string;
  file: string;
  start_line: number;
  end_line: number;
  signature: string;
}

export type GraphNode = FileNode | SymbolNode;

export type EdgeKind = "imports" | "calls" | "defines" | "tests";

export interface Edge {
  from: string;
  to: string;
  kind: EdgeKind;
}

export interface GraphSchema {
  root: string;
  node_count: number;
  edge_count: number;
  file_count: number;
  symbol_count: number;
  nodes: GraphNode[];
  edges: Edge[];
  generated_at: string;
  schema_version: number;
}

export interface SymbolIndex {
  [name: string]: Array<{ file: string; line: number; kind: SymbolKind }>;
}
