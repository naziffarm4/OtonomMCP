// ============================================================================
// 1. CONTEXT LAYERS (Architecture Section 8: L0, L1, L2)
// ============================================================================

export const ContextLayer = {
  L0: 'L0',
  L1: 'L1',
  L2: 'L2',
} as const;

export type ContextLayer = (typeof ContextLayer)[keyof typeof ContextLayer];
export const CONTEXT_LAYERS = Object.values(ContextLayer) as readonly ContextLayer[];

export function isContextLayer(value: unknown): value is ContextLayer {
  return typeof value === 'string' && (CONTEXT_LAYERS as readonly string[]).includes(value);
}

// ============================================================================
// 2. CONTEXT REQUEST INTENT
// ============================================================================

export const ContextIntent = {
  LOCATE_FILE: 'LOCATE_FILE',                 // File presence, path, metadata -> L0 sufficient
  METADATA: 'METADATA',                       // File hashes, size, mtime -> L0 sufficient
  CONTRACT: 'CONTRACT',                       // Interfaces, types, function signatures -> L1 sufficient
  STRUCTURAL: 'STRUCTURAL',                   // Layout, exports, diff chunk -> L1 sufficient
  FULL_IMPLEMENTATION: 'FULL_IMPLEMENTATION', // Complete code modifications or reasoning -> L2 required
  AUTO: 'AUTO',                               // Dynamic evaluation based on sufficiency rule
} as const;

export type ContextIntent = (typeof ContextIntent)[keyof typeof ContextIntent];
export const CONTEXT_INTENTS = Object.values(ContextIntent) as readonly ContextIntent[];

// ============================================================================
// 3. TOKEN TELEMETRY METRICS (Architecture Section 9)
// ============================================================================

export interface ContextTokenInfo {
  reported_input_tokens: number | null;
  reported_output_tokens: number | null;
  reported_cached_tokens: number | null;
  estimated_tokens: number;
  estimated_cost_usd: number | null;
  provider_name: string | null;
  model: string | null;
  is_exact_provider_metric: boolean;
}

// ============================================================================
// 4. L0 CONTEXT MODEL (SQLite Metadata, SHA-256, Symbols)
// ============================================================================

export interface L0Context {
  layer: 'L0';
  sourcePath: string;
  fileHash: string; // SHA-256 from SQLite index
  size: number;
  mtimeMs: number;
  indexedAt: string;
  symbols?: string[];
  metadata?: Record<string, unknown>;
  tokenInfo: ContextTokenInfo;
}

// ============================================================================
// 5. L1 CONTEXT MODEL (Structural Context, Interfaces, Signatures, Diff)
// ============================================================================

export interface L1StructuralItem {
  name: string;
  kind: 'interface' | 'type' | 'class' | 'function' | 'export' | 'import' | 'section';
  signature: string;
  lineStart?: number;
  lineEnd?: number;
}

export interface L1Context {
  layer: 'L1';
  sourcePath: string;
  fileHash: string; // authoritative source hash
  size: number;
  interfaces: string[];
  typeDefinitions: string[];
  signatures: string[];
  imports: string[];
  exports: string[];
  structuralItems: L1StructuralItem[];
  relevantDiffChunk?: string;
  summary: string;
  tokenInfo: ContextTokenInfo;
}

// ============================================================================
// 6. L2 CONTEXT MODEL (Full Filesystem Content & Verified Current Hash)
// ============================================================================

export interface L2Context {
  layer: 'L2';
  sourcePath: string;
  fileHash: string; // actual current filesystem hash
  content: string;
  size: number;
  encoding: 'utf-8' | 'base64';
  tokenInfo: ContextTokenInfo;
}

export type ContextItem = L0Context | L1Context | L2Context;

// ============================================================================
// 7. CONTEXT REQUEST & RESOLUTION
// ============================================================================

export interface ContextRequest {
  requestId?: string;
  taskId?: string;
  sourcePaths: string[];
  intent?: ContextIntent;
  requiredLayer?: ContextLayer;
  maxLayer?: ContextLayer;
  relevantSymbols?: string[];
  diffChunk?: string;
  isSufficient?: (item: ContextItem, layer: ContextLayer) => boolean;
}

export interface FileHashSnapshot {
  indexedHash: string;
  currentHash: string;
  isStale: boolean;
}

export interface ResolvedContext {
  requestId: string;
  taskId?: string;
  resolvedAt: string;
  targetLayer: ContextLayer;
  items: ContextItem[];
  sufficiencyReason: string;
  isSufficient: boolean;
  totalEstimatedTokens: number;
  hashSnapshots: Record<string, FileHashSnapshot>;
}

export interface ContextEngineOptions {
  workspaceRoot: string;
  dbPath?: string;
  defaultIntent?: ContextIntent;
  maxDefaultLayer?: ContextLayer;
}
