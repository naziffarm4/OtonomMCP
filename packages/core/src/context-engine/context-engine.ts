import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  type ContextLayer,
  type ContextRequest,
  type ContextItem,
  type L0Context,
  type L1Context,
  type L2Context,
  type ResolvedContext,
  type FileHashSnapshot,
  type ContextEngineOptions,
  ContextIntent,
  isContextLayer,
} from './context-types.js';
import type {
  ContextValidationResult,
  ContextRefreshResult,
  ContextGuardResult,
} from './invalidation-types.js';
import { ContextInvalidator } from './context-invalidator.js';
import { estimateContextTokens } from './token-estimator.js';
import { extractL1Structure } from './structural-extractor.js';
import { L0Indexer } from '../l0/indexer.js';
import { computeFileSha256 } from '../l0/hasher.js';
import { ContextEngineError } from '../errors/context-engine-error.js';

export class ContextEngine {
  readonly workspaceRoot: string;
  readonly dbPath: string;
  private readonly l0Indexer: L0Indexer;
  private readonly defaultIntent: string;
  private readonly invalidator: ContextInvalidator;

  constructor(options: ContextEngineOptions) {
    if (!options.workspaceRoot) {
      throw new ContextEngineError(
        'workspaceRoot must be provided to ContextEngine',
        'ERR_INVALID_CONTEXT_REQUEST'
      );
    }

    this.workspaceRoot = path.resolve(options.workspaceRoot);
    this.dbPath = options.dbPath
      ? path.resolve(options.dbPath)
      : path.join(this.workspaceRoot, '.ai-manager', 'cache', 'context.db');

    this.defaultIntent = options.defaultIntent ?? ContextIntent.AUTO;

    this.l0Indexer = new L0Indexer({
      workspaceRoot: this.workspaceRoot,
      dbPath: this.dbPath,
    });

    this.invalidator = new ContextInvalidator({
      workspaceRoot: this.workspaceRoot,
      contextEngine: this,
    });
  }

  /**
   * Initializes underlying L0 SQLite cache database.
   */
  async initialize(): Promise<void> {
    await this.l0Indexer.initialize();
  }

  /**
   * Synchronizes the workspace files with the L0 index.
   */
  async syncIndex(): Promise<void> {
    await this.l0Indexer.sync();
  }

  /**
   * Retrieves lightweight L0 context (metadata, SHA-256 hash) from SQLite index.
   * Does NOT read complete file content.
   */
  async getL0Context(relativePath: string): Promise<L0Context> {
    const normalizedPath = this.normalizePath(relativePath);
    const fullPath = path.join(this.workspaceRoot, normalizedPath);

    await this.l0Indexer.initialize();
    const indexedRecord = await this.l0Indexer.getFile(normalizedPath);

    if (indexedRecord) {
      return {
        layer: 'L0',
        sourcePath: normalizedPath,
        fileHash: indexedRecord.sha256,
        size: indexedRecord.size,
        mtimeMs: indexedRecord.mtimeMs,
        indexedAt: indexedRecord.indexedAt,
        tokenInfo: estimateContextTokens(`${normalizedPath} ${indexedRecord.sha256}`),
      };
    }

    // If not in index, check if file exists on disk
    if (!fs.existsSync(fullPath)) {
      throw new ContextEngineError(
        `Source file not found: '${normalizedPath}'`,
        'ERR_CONTEXT_SOURCE_NOT_FOUND',
        { sourcePath: normalizedPath, requestedLayer: 'L0' }
      );
    }

    const stat = fs.statSync(fullPath);
    if (!stat.isFile()) {
      throw new ContextEngineError(
        `Source is not a regular file: '${normalizedPath}'`,
        'ERR_CONTEXT_SOURCE_NOT_FOUND',
        { sourcePath: normalizedPath, requestedLayer: 'L0' }
      );
    }

    const currentHash = await computeFileSha256(fullPath);
    const now = new Date().toISOString();

    return {
      layer: 'L0',
      sourcePath: normalizedPath,
      fileHash: currentHash,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      indexedAt: now,
      tokenInfo: estimateContextTokens(`${normalizedPath} ${currentHash}`),
    };
  }

  /**
   * Retrieves focused structural L1 context (interfaces, types, signatures, imports/exports).
   */
  async getL1Context(
    relativePath: string,
    options?: { relevantSymbols?: string[]; diffChunk?: string }
  ): Promise<L1Context> {
    const normalizedPath = this.normalizePath(relativePath);
    const fullPath = path.join(this.workspaceRoot, normalizedPath);

    if (!fs.existsSync(fullPath)) {
      throw new ContextEngineError(
        `Source file not found for L1 extraction: '${normalizedPath}'`,
        'ERR_CONTEXT_SOURCE_NOT_FOUND',
        { sourcePath: normalizedPath, requestedLayer: 'L1' }
      );
    }

    let content: string;
    try {
      content = fs.readFileSync(fullPath, 'utf-8');
    } catch (err) {
      throw new ContextEngineError(
        `Failed to read file for L1 context: '${normalizedPath}'`,
        'ERR_STRUCTURAL_CONTEXT_UNAVAILABLE',
        { sourcePath: normalizedPath, requestedLayer: 'L1', cause: err }
      );
    }

    // Retrieve hash from L0 index or compute
    await this.l0Indexer.initialize();
    const indexed = await this.l0Indexer.getFile(normalizedPath);
    const fileHash = indexed ? indexed.sha256 : await computeFileSha256(fullPath);

    const extracted = extractL1Structure(content, normalizedPath, options);
    const tokenInfo = estimateContextTokens(extracted.summary);

    return {
      layer: 'L1',
      sourcePath: normalizedPath,
      fileHash,
      size: content.length,
      interfaces: extracted.interfaces,
      typeDefinitions: extracted.typeDefinitions,
      signatures: extracted.signatures,
      imports: extracted.imports,
      exports: extracted.exports,
      structuralItems: extracted.structuralItems,
      relevantDiffChunk: options?.diffChunk,
      summary: extracted.summary,
      tokenInfo,
    };
  }

  /**
   * Retrieves full file L2 context from filesystem and verifies current disk hash.
   */
  async getL2Context(relativePath: string): Promise<L2Context> {
    const normalizedPath = this.normalizePath(relativePath);
    const fullPath = path.join(this.workspaceRoot, normalizedPath);

    if (!fs.existsSync(fullPath)) {
      throw new ContextEngineError(
        `Source file not found for L2 retrieval: '${normalizedPath}'`,
        'ERR_CONTEXT_SOURCE_NOT_FOUND',
        { sourcePath: normalizedPath, requestedLayer: 'L2' }
      );
    }

    let content: string;
    try {
      content = fs.readFileSync(fullPath, 'utf-8');
    } catch (err) {
      throw new ContextEngineError(
        `Failed to read file for L2 context: '${normalizedPath}'`,
        'ERR_CONTEXT_SOURCE_NOT_FOUND',
        { sourcePath: normalizedPath, requestedLayer: 'L2', cause: err }
      );
    }

    const currentHash = await computeFileSha256(fullPath);
    const tokenInfo = estimateContextTokens(content);

    return {
      layer: 'L2',
      sourcePath: normalizedPath,
      fileHash: currentHash,
      content,
      size: content.length,
      encoding: 'utf-8',
      tokenInfo,
    };
  }

  /**
   * Resolves Minimum Sufficient Context for the given request.
   * Follows deterministic escalation: L0 -> L1 -> L2 based on explicit request requirements.
   */
  async resolveContext(request: ContextRequest): Promise<ResolvedContext> {
    if (!request.sourcePaths || request.sourcePaths.length === 0) {
      throw new ContextEngineError(
        'ContextRequest must specify at least one sourcePath',
        'ERR_INVALID_CONTEXT_REQUEST'
      );
    }

    if (request.requiredLayer && !isContextLayer(request.requiredLayer)) {
      throw new ContextEngineError(
        `Unsupported context layer: '${request.requiredLayer}'`,
        'ERR_UNSUPPORTED_CONTEXT_LAYER',
        { requestedLayer: request.requiredLayer }
      );
    }

    const resolvedAt = new Date().toISOString();
    const requestId = request.requestId ?? `req-${Date.now()}`;
    const intent = request.intent ?? this.defaultIntent;

    // Stable sort of sourcePaths for deterministic resolution
    const sortedPaths = [...request.sourcePaths].map((p) => this.normalizePath(p)).sort();

    const items: ContextItem[] = [];
    const hashSnapshots: Record<string, FileHashSnapshot> = {};
    let highestLayer: ContextLayer = 'L0';
    let sufficiencyReason = 'Default resolution';

    for (const sourcePath of sortedPaths) {
      const fullPath = path.join(this.workspaceRoot, sourcePath);

      // Step 1: Always retrieve L0 first
      const l0Context = await this.getL0Context(sourcePath);

      // Record hash snapshot for stale detection
      const currentFsHash = fs.existsSync(fullPath)
        ? await computeFileSha256(fullPath)
        : l0Context.fileHash;

      const isStale = l0Context.fileHash !== currentFsHash;
      hashSnapshots[sourcePath] = {
        indexedHash: l0Context.fileHash,
        currentHash: currentFsHash,
        isStale,
      };

      // Step 2: Evaluate L0 sufficiency
      if (this.isL0Sufficient(request, l0Context, intent)) {
        items.push(l0Context);
        sufficiencyReason = 'L0 metadata and file hash sufficient for request intent';
        continue;
      }

      // Step 3: L0 insufficient -> escalate to L1
      highestLayer = this.elevateLayer(highestLayer, 'L1');
      const l1Context = await this.getL1Context(sourcePath, {
        relevantSymbols: request.relevantSymbols,
        diffChunk: request.diffChunk,
      });

      // Step 4: Evaluate L1 sufficiency
      if (this.isL1Sufficient(request, l1Context, intent)) {
        items.push(l1Context);
        sufficiencyReason = 'L1 structural interfaces and signatures sufficient for request intent';
        continue;
      }

      // Step 5: L1 insufficient -> escalate to L2
      highestLayer = this.elevateLayer(highestLayer, 'L2');
      const l2Context = await this.getL2Context(sourcePath);
      items.push(l2Context);
      sufficiencyReason = 'L2 full implementation content required for request intent';
    }

    // Sort items deterministically by sourcePath
    items.sort((a, b) => a.sourcePath.localeCompare(b.sourcePath));

    const totalEstimatedTokens = items.reduce(
      (sum, item) => sum + item.tokenInfo.estimated_tokens,
      0
    );

    return {
      requestId,
      taskId: request.taskId,
      resolvedAt,
      targetLayer: highestLayer,
      items,
      sufficiencyReason,
      isSufficient: true,
      totalEstimatedTokens,
      hashSnapshots,
    };
  }

  private isL0Sufficient(
    request: ContextRequest,
    l0: L0Context,
    intent: string
  ): boolean {
    if (request.maxLayer === 'L0') return true;
    if (request.requiredLayer === 'L0') return true;
    if (request.requiredLayer === 'L1' || request.requiredLayer === 'L2') return false;

    if (intent === ContextIntent.LOCATE_FILE || intent === ContextIntent.METADATA) {
      return true;
    }

    if (
      intent === ContextIntent.CONTRACT ||
      intent === ContextIntent.STRUCTURAL ||
      intent === ContextIntent.FULL_IMPLEMENTATION
    ) {
      return false;
    }

    if (request.isSufficient) {
      return request.isSufficient(l0, 'L0');
    }

    return false;
  }

  private isL1Sufficient(
    request: ContextRequest,
    l1: L1Context,
    intent: string
  ): boolean {
    if (request.maxLayer === 'L1') return true;
    if (request.requiredLayer === 'L1') return true;
    if (request.requiredLayer === 'L2') return false;

    if (intent === ContextIntent.FULL_IMPLEMENTATION) {
      return false;
    }

    // If specific symbols were requested, verify they are represented in L1 structural items
    if (request.relevantSymbols && request.relevantSymbols.length > 0) {
      const presentSymbols = new Set(l1.structuralItems.map((s) => s.name));
      const allFound = request.relevantSymbols.every((sym) => presentSymbols.has(sym));
      if (!allFound) {
        return false; // Symbol missing in L1, escalate to L2
      }
      return true;
    }

    if (intent === ContextIntent.CONTRACT || intent === ContextIntent.STRUCTURAL) {
      return true;
    }

    if (request.isSufficient) {
      return request.isSufficient(l1, 'L1');
    }

    return true;
  }

  private elevateLayer(current: ContextLayer, target: ContextLayer): ContextLayer {
    const ranks: Record<ContextLayer, number> = { L0: 0, L1: 1, L2: 2 };
    return ranks[target] > ranks[current] ? target : current;
  }

  private normalizePath(filePath: string): string {
    return filePath.replace(/\\/g, '/').replace(/^\.\//, '');
  }

  /**
   * Validates previously resolved context against current filesystem state.
   */
  async validateContext(context: ResolvedContext): Promise<ContextValidationResult> {
    return this.invalidator.validateContext(context);
  }

  /**
   * Refreshes a stale context using current filesystem content.
   */
  async refreshContext(
    context: ResolvedContext,
    options?: Partial<ContextRequest>
  ): Promise<ContextRefreshResult> {
    return this.invalidator.refreshContext(context, options);
  }

  /**
   * Asserts context validity before write/modification, throwing if stale.
   */
  async assertValidForWrite(context: ResolvedContext, targetPath?: string): Promise<void> {
    return this.invalidator.assertValidForWrite(context, targetPath);
  }

  /**
   * Non-throwing write guard check.
   */
  async checkWriteGuard(
    context: ResolvedContext,
    targetPath?: string
  ): Promise<ContextGuardResult> {
    return this.invalidator.checkWriteGuard(context, targetPath);
  }

  /**
   * Wraps an operation with the context validity guard.
   */
  async guardOperation<T>(
    context: ResolvedContext,
    operation: () => Promise<T> | T,
    targetPath?: string
  ): Promise<T> {
    return this.invalidator.guardOperation(context, operation, targetPath);
  }

  getInvalidator(): ContextInvalidator {
    return this.invalidator;
  }

  close(): void {
    this.l0Indexer.close();
  }
}
