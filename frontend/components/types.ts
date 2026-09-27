export type GraphNode = {
  id: string;
  name: string;
  kind: string;
  repo: string;
  file_path: string;
  start_line: number;
  end_line: number;
  signature: string | null;
  x?: number;
  y?: number;
  fx?: number | null;
  fy?: number | null;
};

export type GraphLink = {
  source: string | GraphNode;
  target: string | GraphNode;
  type: string;
  repo: string;
};

export type Repo = {
  name: string;
  path: string;
  node_count: number;
  edge_count: number;
  file_count: number;
};

export type GraphPayload = {
  nodes: GraphNode[];
  links: GraphLink[];
  repos: Repo[];
  stats: { nodes: number; edges: number; files: number };
};

export type SourceResult = {
  found: boolean;
  error?: string;
  content?: string;
  bytes?: number;
  truncated?: boolean;
  line_count?: number;
};

export type NodeContext = {
  found: boolean;
  error?: string;
  node: {
    repo: string;
    kind: string;
    name: string;
    qualified_name: string;
    file_path: string;
    start_line: number;
    end_line: number;
    signature: string | null;
  };
  source: SourceResult;
  callers: Array<{
    repo: string;
    kind: string;
    qualified_name: string;
    file_path: string;
    start_line: number;
  }>;
  callees: Array<{
    callee: string;
    resolved: number;
    kind: string | null;
    file_path: string | null;
    start_line: number | null;
  }>;
  dependencies: Array<{
    local_name: string;
    target: string;
    kind: string;
    in_project: boolean;
  }>;
  dependents: Array<{ file_path: string; imported: string }>;
  siblings: Array<{
    kind: string;
    name: string;
    qualified_name: string;
    start_line: number;
  }>;
};

export const KIND_COLORS: Record<string, string> = {
  File: "#0d9488",
  Class: "#f59e0b",
  Function: "#10b981",
  Method: "#06b6d4",
  Interface: "#8b5cf6",
  Config: "#94a3a2",
  Service: "#ef4444",
};

export const KIND_RADIUS: Record<string, number> = {
  File: 7, Class: 9, Function: 5, Method: 4.5, Interface: 8, Config: 6, Service: 8,
};

export const EDGE_COLORS: Record<string, string> = {
  CONTAINS: "#cbd5d4",
  IMPORTS: "#0d9488",
  CALLS: "#10b981",
  INHERITS: "#f59e0b",
  IMPLEMENTS: "#8b5cf6",
  USES_TYPE: "#06b6d4",
};

export const ALL_KINDS = [
  "File", "Class", "Function", "Method", "Interface", "Config", "Service",
];
export const ALL_EDGES = [
  "IMPORTS", "CALLS", "INHERITS", "IMPLEMENTS", "USES_TYPE", "CONTAINS",
];

export function isFileKind(kind: string): boolean {
  return kind === "File" || kind === "Config" || kind === "Service";
}
