/**
 * Authoritative Read-Only Evidence Inspector Tool: aidm.evidence.get (Phase 8 TASK-P8-02)
 *
 * Exposes system-verified evidence for tasks and iterations through the authoritative
 * EvidenceValidator boundary.
 *
 * ARCHITECTURAL INVARIANTS:
 * 1. Strictly read-only: does not create or alter evidence.
 * 2. CRITICAL: Never promotes AGENT_CLAIM into SYSTEM_VERIFIED_EVIDENCE.
 * 3. All evidence is validated through authoritative EvidenceValidator.
 * 4. Applies MCP secret sanitization to protect sensitive command/output values.
 */

import * as path from 'node:path';
import { z } from 'zod';
import {
  type McpToolDefinition,
  type McpToolRegistration,
  type McpToolResult,
  type McpRequestContext,
} from '../mcp-types.js';
import { sanitizeMcpPayload, McpInvalidRequestError } from '../mcp-errors.js';
import {
  type SystemVerifiedEvidence,
  type ExecutorIdentity,
  EvidenceType,
  EvidenceSource,
  isEvidenceType,
} from '../../evidence/evidence-types.js';
import { validateSystemVerifiedEvidence } from '../../evidence/evidence-validator.js';
import { HistoryManager } from '../../storage/history-manager.js';

export const AIDM_EVIDENCE_GET_TOOL_NAME = 'aidm.evidence.get';

export const EvidenceGetInputZodSchema = z.object({
  taskId: z.string().optional(),
  iterationId: z.string().optional(),
  evidenceId: z.string().optional(),
  evidenceType: z
    .enum(['COMMAND', 'TEST', 'BUILD', 'GIT', 'DIFF', 'FILE_HASH', 'UI'])
    .optional(),
  limit: z.number().int().positive().max(200).default(50),
  offset: z.number().int().min(0).default(0),
}).strict();

export type EvidenceGetInput = z.infer<typeof EvidenceGetInputZodSchema>;

export interface EvidenceItemOutput {
  readonly evidenceId: string;
  readonly taskId: string;
  readonly instructionId: string | null;
  readonly projectId: string;
  readonly correlationId: string;
  readonly command: string;
  readonly exitCode: number;
  readonly stdoutTail: string | null;
  readonly stderr: string | null;
  readonly workingDirectory: string;
  readonly executionTimeMs: number;
  readonly gitHeadBefore: string | null;
  readonly gitHeadAfter: string | null;
  readonly unifiedDiff: string | null;
  readonly fileHashesAfter: Readonly<Record<string, string>> | null;
  readonly evidenceType: string;
  readonly executorIdentity: ExecutorIdentity | null;
  readonly capturedAt: string | null;
  readonly metadata: Readonly<Record<string, unknown>> | null;
  readonly source: 'SYSTEM_VERIFIED_EVIDENCE';
  readonly validationStatus: 'VALID';
}

export interface EvidenceGetOutput {
  readonly evidence: readonly EvidenceItemOutput[];
  readonly total: number;
  readonly rejectedClaimsCount: number;
  readonly correlationId: string;
}

export const evidenceGetToolDefinition: McpToolDefinition = Object.freeze({
  name: AIDM_EVIDENCE_GET_TOOL_NAME,
  description:
    'Returns system-verified evidence for tasks or iterations through the authoritative EvidenceValidator. Strictly read-only; never promotes AGENT_CLAIM into system evidence and sanitizes secrets.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      taskId: {
        type: 'string',
        description: 'Optional task ID filter.',
      },
      iterationId: {
        type: 'string',
        description: 'Optional execution iteration ID filter.',
      },
      evidenceId: {
        type: 'string',
        description: 'Optional specific evidence ID filter.',
      },
      evidenceType: {
        type: 'string',
        enum: ['COMMAND', 'TEST', 'BUILD', 'GIT', 'DIFF', 'FILE_HASH', 'UI'],
        description: 'Optional evidence type filter.',
      },
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: 200,
        default: 50,
        description: 'Maximum number of evidence items to return (default 50).',
      },
      offset: {
        type: 'integer',
        minimum: 0,
        default: 0,
        description: 'Offset for pagination (default 0).',
      },
    },
    additionalProperties: false,
  },
});

export function createEvidenceGetTool(): McpToolRegistration {
  return {
    definition: evidenceGetToolDefinition,
    handler: async (
      args: Readonly<Record<string, unknown>>,
      context: McpRequestContext
    ): Promise<McpToolResult> => {
      const parseResult = EvidenceGetInputZodSchema.safeParse(args);
      if (!parseResult.success) {
        throw new McpInvalidRequestError(
          `Invalid arguments for tool ${AIDM_EVIDENCE_GET_TOOL_NAME}: ${parseResult.error.message}`,
          { issues: parseResult.error.issues },
          context.correlation.correlationId
        );
      }

      const input = parseResult.data;
      const delegate = context.delegate;
      const projectRoot = delegate?.projectRoot ? path.resolve(delegate.projectRoot) : process.cwd();

      const candidateList: unknown[] = [];

      // 1. Check if delegate provides evidence
      if (delegate && typeof delegate.getEvidence === 'function') {
        try {
          const delegateEvidence = await delegate.getEvidence(input, context.correlation);
          if (Array.isArray(delegateEvidence)) {
            candidateList.push(...delegateEvidence);
          }
        } catch {
          // delegate query failed, proceed to history check
        }
      }

      // 2. Check history events for evidence payloads
      const historyManager =
        delegate?.historyManager ?? new HistoryManager({ baseDir: projectRoot });
      try {
        const events = await historyManager.readEvents();
        for (const event of events) {
          const payload = event.payload;
          if (payload) {
            // Check for evidence array in event payload
            if (Array.isArray(payload.evidence)) {
              candidateList.push(...payload.evidence);
            }
            if (Array.isArray(payload.collectedEvidence)) {
              candidateList.push(...payload.collectedEvidence);
            }
            // Check if payload itself is an evidence object
            if (payload.evidence_id || payload.evidenceId) {
              candidateList.push(payload);
            }
          }
        }
      } catch {
        // history unreadable or missing
      }

      // 3. Strict verification boundary:
      // Filter candidates using authoritative EvidenceValidator.
      // Explicitly reject any AGENT_CLAIM.
      const verifiedList: EvidenceItemOutput[] = [];
      let rejectedClaimsCount = 0;
      const seenIds = new Set<string>();

      for (const item of candidateList) {
        if (!item || typeof item !== 'object') {
          rejectedClaimsCount++;
          continue;
        }

        const raw = item as Record<string, unknown>;

        // Explicit AGENT_CLAIM check: NEVER promote to system evidence
        if (
          raw.source === EvidenceSource.AGENT_CLAIM ||
          raw.source_type === EvidenceSource.AGENT_CLAIM ||
          raw.is_agent_claim === true ||
          raw.isAgentClaim === true
        ) {
          rejectedClaimsCount++;
          continue;
        }

        // Validate via authoritative EvidenceValidator
        const validation = validateSystemVerifiedEvidence(item);
        if (!validation.valid || !validation.evidence) {
          rejectedClaimsCount++;
          continue;
        }

        const evi: SystemVerifiedEvidence = validation.evidence;

        // Deduplicate by evidence_id
        if (seenIds.has(evi.evidence_id)) {
          continue;
        }
        seenIds.add(evi.evidence_id);

        verifiedList.push({
          evidenceId: evi.evidence_id,
          taskId: evi.task_id,
          instructionId: evi.instruction_id,
          projectId: evi.project_id,
          correlationId: evi.correlation_id,
          command: evi.command,
          exitCode: evi.exit_code,
          stdoutTail: evi.stdout_tail,
          stderr: evi.stderr,
          workingDirectory: evi.working_directory,
          executionTimeMs: evi.execution_time_ms,
          gitHeadBefore: evi.git_head_before,
          gitHeadAfter: evi.git_head_after,
          unifiedDiff: evi.unified_diff,
          fileHashesAfter: evi.file_hashes_after,
          evidenceType: evi.evidence_type,
          executorIdentity: evi.executor_identity,
          capturedAt: evi.captured_at,
          metadata: evi.metadata,
          source: 'SYSTEM_VERIFIED_EVIDENCE',
          validationStatus: 'VALID',
        });
      }

      // 4. Apply filters
      let filtered = verifiedList;
      if (input.evidenceId) {
        filtered = filtered.filter((e) => e.evidenceId === input.evidenceId);
      }
      if (input.taskId) {
        filtered = filtered.filter((e) => e.taskId === input.taskId);
      }
      if (input.evidenceType) {
        filtered = filtered.filter((e) => e.evidenceType === input.evidenceType);
      }
      if (input.iterationId) {
        filtered = filtered.filter(
          (e) =>
            e.instructionId?.includes(input.iterationId!) ||
            (e.metadata as Record<string, unknown> | null)?.iterationId === input.iterationId ||
            (e.metadata as Record<string, unknown> | null)?.iteration === input.iterationId
        );
      }

      const total = filtered.length;
      const paginated = filtered.slice(input.offset, input.offset + input.limit);

      const payload: EvidenceGetOutput = {
        evidence: paginated,
        total,
        rejectedClaimsCount,
        correlationId: context.correlation.correlationId,
      };

      const sanitized = sanitizeMcpPayload(payload);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(sanitized, null, 2),
          },
        ],
        isError: false,
      };
    },
  };
}
