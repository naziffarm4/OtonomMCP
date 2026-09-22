import { z } from 'zod';
import type { BlockedStateData } from '../fsm/fsm-types.js';

export const BlockedStateZodSchema = z.preprocess((val) => {
  if (val && typeof val === 'object' && !Array.isArray(val)) {
    const raw = val as Record<string, unknown>;
    return {
      blockedTaskId: raw.blockedTaskId ?? raw.blocked_task_id,
      blockedIteration: raw.blockedIteration ?? raw.blocked_iteration,
      blockedContextReference: raw.blockedContextReference ?? raw.blocked_context_reference,
      blockingReason: raw.blockingReason ?? raw.blocking_reason,
      resumePoint: raw.resumePoint ?? raw.resume_point,
      timestamp: raw.timestamp,
      metadata: raw.metadata,
    };
  }
  return val;
}, z.object({
  blockedTaskId: z.string().min(1, 'blockedTaskId/blocked_task_id cannot be empty'),
  blockedIteration: z.number().int('blockedIteration/blocked_iteration must be an integer').nonnegative('blockedIteration/blocked_iteration must be >= 0'),
  blockedContextReference: z.string().min(1, 'blockedContextReference/blocked_context_reference cannot be empty'),
  blockingReason: z.string().min(1, 'blockingReason/blocking_reason cannot be empty'),
  resumePoint: z.string().min(1, 'resumePoint/resume_point cannot be empty'),
  timestamp: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
}));

export type BlockedState = z.infer<typeof BlockedStateZodSchema>;

/**
 * Helper to convert BlockedStateData into both camelCase and snake_case representations
 * for deterministic storage compatibility.
 */
export function toSnakeCaseBlockedState(blocked: BlockedStateData | null | undefined): Record<string, unknown> | null {
  if (!blocked) return null;
  return {
    blocked_task_id: blocked.blockedTaskId,
    blocked_iteration: blocked.blockedIteration,
    blocked_context_reference: blocked.blockedContextReference,
    blocking_reason: blocked.blockingReason,
    resume_point: blocked.resumePoint,
    timestamp: blocked.timestamp,
    metadata: blocked.metadata,
  };
}
