/**
 * Authoritative Executor Context Package MCP Tool
 *
 * Exposes the automated context-to-executor packaging pipeline through the MCP boundary:
 * - aidm.executor.context.package
 *
 * ARCHITECTURAL INVARIANTS:
 * 1. AUTHORITATIVE SOURCES ONLY: Assembles context exclusively from SpecStore, ContextEngine, GitPort, ApprovalStore.
 * 2. ZERO EXECUTOR TRUST: Ground-truth codebase and specification packaging.
 * 3. READ-ONLY CONTRACT: Packaging does NOT mutate Task DAG, FSM, or SpecStore.
 * 4. DETERMINISTIC REPRODUCIBILITY: Identical project state generates identical packageId.
 */

import type { McpToolDefinition, McpToolHandler } from '../mcp-types.js';
import type { McpServer } from '../mcp-server.js';
import { sanitizeMcpPayload, McpInvalidRequestError } from '../mcp-errors.js';
import { ExecutorContextService } from '../../executor-bridge/executor-context-service.js';
import {
  BuildExecutorContextInputZodSchema,
  type BuildExecutorContextInput,
} from '../../executor-bridge/executor-context-types.js';

export const AIDM_EXECUTOR_CONTEXT_PACKAGE_TOOL_NAME = 'aidm.executor.context.package';

export const executorContextPackageToolDefinition: McpToolDefinition = {
  name: AIDM_EXECUTOR_CONTEXT_PACKAGE_TOOL_NAME,
  description:
    'Authoritatively resolves and packages complete, bounded executor context (Task specs, Traced requirements & decisions, L0/L1 AST signatures, Technology stack, Git repository baseline, and Recovery lineage) for an execution task. Enforces token budgets and produces a deterministic, content-addressed packageId.',
  inputSchema: {
    type: 'object',
    required: ['taskId'],
    properties: {
      taskId: { type: 'string', description: 'Target task identifier from Task DAG / SpecStore' },
      taskRevision: { type: 'number', description: 'Optional task revision integer' },
      projectId: { type: 'string', description: 'Optional project identifier' },
      requestId: { type: 'string', description: 'Optional bound ExecutionRequest ID' },
      targetFiles: {
        type: 'array',
        items: { type: 'string' },
        description: 'Target file paths to extract L0/L1 AST structures and interfaces for',
      },
      analysisScope: {
        type: 'array',
        items: { type: 'string' },
        description: 'Permitted analysis scope paths for context summarization',
      },
      implementationScope: {
        type: 'array',
        items: { type: 'string' },
        description: 'Permitted implementation scope paths',
      },
      maxTokenBudget: {
        type: 'number',
        description: 'Strict maximum token budget for the context package (default: 16,000)',
      },
      includeL1Structure: { type: 'boolean', description: 'Whether to extract L1 AST structures (default: true)' },
      includeSpecDetails: { type: 'boolean', description: 'Whether to include traced requirements/decisions (default: true)' },
      includeBaseline: { type: 'boolean', description: 'Whether to include Git/tech stack baseline (default: true)' },
      includeRecovery: { type: 'boolean', description: 'Whether to include recovery lineage (default: true)' },
      workingDirectory: { type: 'string', description: 'Project workspace directory' },
      persist: { type: 'boolean', description: 'Whether to persist the context package to cache disk (default: false)' },
    },
  },
};

export function createExecutorContextPackageTool(): {
  definition: McpToolDefinition;
  handler: McpToolHandler;
} {
  const handler: McpToolHandler = async (args, context) => {
    try {
      const parsed = BuildExecutorContextInputZodSchema.safeParse(args ?? {});
      if (!parsed.success) {
        throw new McpInvalidRequestError(
          `Invalid arguments for '${AIDM_EXECUTOR_CONTEXT_PACKAGE_TOOL_NAME}': ${parsed.error.issues[0]?.message ?? 'validation failed'}`
        );
      }

      const delegate = context.delegate;
      const workspaceRoot =
        parsed.data.workingDirectory ??
        (args.workspaceRoot as string | undefined) ??
        delegate?.projectRoot ??
        process.cwd();

      const service =
        delegate?.contextService ??
        new ExecutorContextService({
          workspaceRoot,
          specStore: delegate?.specStore,
          contextEngine: delegate?.contextEngine,
          gitPort: delegate?.gitPort,
          approvalStore: delegate?.approvalStore,
          discoveryEngine: delegate?.discoveryEngine,
          durableStateManager: delegate?.durableStateManager,
          dagEngine: delegate?.dagEngine,
          delegate,
        });

      const contextPackage = await service.buildContextPackage(parsed.data as BuildExecutorContextInput);

      let persistedPath: string | undefined;
      if (args?.persist === true) {
        persistedPath = await service.persistContextPackage(contextPackage);
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              sanitizeMcpPayload({
                success: true,
                packageId: contextPackage.packageId,
                contentHash: contextPackage.contentHash,
                persistedPath,
                contextPackage,
              }),
              null,
              2
            ),
          },
        ],
      };
    } catch (err) {
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              sanitizeMcpPayload({
                success: false,
                error: err instanceof Error ? err.message : String(err),
                code: (err as any).code ?? 'ERR_EXECUTOR_CONTEXT_PACKAGE_FAILED',
              }),
              null,
              2
            ),
          },
        ],
      };
    }
  };

  return {
    definition: executorContextPackageToolDefinition,
    handler,
  };
}

export const AIDM_EXECUTOR_CONTEXT_VALIDATE_TOOL_NAME = 'aidm.executor.context.validate';

export const executorContextValidateToolDefinition: McpToolDefinition = {
  name: AIDM_EXECUTOR_CONTEXT_VALIDATE_TOOL_NAME,
  description:
    'Validates an ExecutorContextPackage (loaded by packageId from persistent cache or passed directly) against current disk state and file SHA-256 hashes to detect stale context.',
  inputSchema: {
    type: 'object',
    properties: {
      packageId: { type: 'string', description: 'Package ID to load from persistent cache and validate' },
      contextPackage: { type: 'object', description: 'Direct context package object to validate' },
      workingDirectory: { type: 'string', description: 'Project workspace directory' },
    },
  },
};

export function createExecutorContextValidateTool(): {
  definition: McpToolDefinition;
  handler: McpToolHandler;
} {
  const handler: McpToolHandler = async (args, context) => {
    try {
      const delegate = context.delegate;
      const workspaceRoot =
        (args?.workingDirectory as string | undefined) ??
        delegate?.projectRoot ??
        process.cwd();

      const service =
        delegate?.contextService ??
        new ExecutorContextService({
          workspaceRoot,
          specStore: delegate?.specStore,
          contextEngine: delegate?.contextEngine,
          gitPort: delegate?.gitPort,
          approvalStore: delegate?.approvalStore,
          discoveryEngine: delegate?.discoveryEngine,
          durableStateManager: delegate?.durableStateManager,
          dagEngine: delegate?.dagEngine,
          delegate,
        });

      const packageId = args?.packageId as string | undefined;
      const directPackage = args?.contextPackage as any;

      if (!packageId && !directPackage) {
        throw new McpInvalidRequestError(
          `Either 'packageId' or 'contextPackage' must be provided to '${AIDM_EXECUTOR_CONTEXT_VALIDATE_TOOL_NAME}'`
        );
      }

      if (packageId) {
        const loaded = await service.validateAndLoadContextPackage(packageId);
        if (!loaded) {
          return {
            isError: true,
            content: [
              {
                type: 'text',
                text: JSON.stringify(
                  sanitizeMcpPayload({
                    success: false,
                    error: `Context package '${packageId}' not found in cache`,
                    code: 'ERR_CONTEXT_PACKAGE_NOT_FOUND',
                  }),
                  null,
                  2
                ),
              },
            ],
          };
        }

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                sanitizeMcpPayload({
                  success: true,
                  packageId,
                  isValid: loaded.validation.isValid,
                  isStale: loaded.validation.isStale,
                  message: loaded.validation.message,
                  details: loaded.validation.details,
                }),
                null,
                2
              ),
            },
          ],
        };
      }

      const validation = await service.validateContextPackage(directPackage);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              sanitizeMcpPayload({
                success: true,
                packageId: directPackage?.packageId,
                isValid: validation.isValid,
                isStale: validation.isStale,
                message: validation.message,
                details: validation.details,
              }),
              null,
              2
            ),
          },
        ],
      };
    } catch (err) {
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              sanitizeMcpPayload({
                success: false,
                error: err instanceof Error ? err.message : String(err),
                code: (err as any).code ?? 'ERR_EXECUTOR_CONTEXT_VALIDATION_FAILED',
              }),
              null,
              2
            ),
          },
        ],
      };
    }
  };

  return {
    definition: executorContextValidateToolDefinition,
    handler,
  };
}

export function registerExecutorContextTools(server: McpServer): void {
  const packageTool = createExecutorContextPackageTool();
  server.registerTool(packageTool.definition, packageTool.handler);

  const validateTool = createExecutorContextValidateTool();
  server.registerTool(validateTool.definition, validateTool.handler);
}
