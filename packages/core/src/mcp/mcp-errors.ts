/**
 * MCP Error Normalization & Hierarchy Boundary (Phase 8 TASK-P8-01)
 *
 * Implements a typed error normalization boundary conforming to JSON-RPC 2.0
 * and MCP protocol standards while preserving machine-readable identity without
 * leaking secrets.
 */

import { AidmError, type AidmErrorDetails } from '../errors/aidm-error.js';
import { PolicyViolationError } from '../errors/policy-violation-error.js';
import { sanitizeSecrets } from '../errors/llm-error.js';
import type { McpJsonRpcErrorObject } from './mcp-types.js';
import type { McpRequestCorrelation } from './mcp-correlation.js';

// ============================================================================
// 1. ERROR CODES
// ============================================================================

/**
 * Standard JSON-RPC 2.0 error codes.
 */
export const McpJsonRpcErrorCode = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
} as const;

export type McpJsonRpcErrorCode =
  (typeof McpJsonRpcErrorCode)[keyof typeof McpJsonRpcErrorCode];

/**
 * Domain-specific application error codes in the standard JSON-RPC reserved range (-32000 to -32099).
 */
export const McpDomainErrorCode = {
  ORCHESTRATOR_UNAVAILABLE: -32001,
  POLICY_BLOCKED: -32002,
  HUMAN_BLOCKED: -32003,
  INVALID_STATE: -32004,
  RESOURCE_NOT_FOUND: -32005,
} as const;

export type McpDomainErrorCode =
  (typeof McpDomainErrorCode)[keyof typeof McpDomainErrorCode];

/**
 * Machine-readable string error codes for the MCP layer.
 */
export const McpErrorCode = {
  PARSE_ERROR: 'ERR_MCP_PARSE_ERROR',
  INVALID_REQUEST: 'ERR_MCP_INVALID_REQUEST',
  UNSUPPORTED_OPERATION: 'ERR_MCP_UNSUPPORTED_OPERATION',
  INVALID_PARAMS: 'ERR_MCP_INVALID_PARAMS',
  ORCHESTRATOR_UNAVAILABLE: 'ERR_MCP_ORCHESTRATOR_UNAVAILABLE',
  POLICY_BLOCKED: 'ERR_MCP_POLICY_BLOCKED',
  HUMAN_BLOCKED: 'ERR_MCP_HUMAN_BLOCKED',
  INTERNAL_FAILURE: 'ERR_MCP_INTERNAL_FAILURE',
} as const;

export type McpErrorCode = (typeof McpErrorCode)[keyof typeof McpErrorCode];

// ============================================================================
// 2. SECRET SANITIZATION UTILITIES
// ============================================================================

/**
 * Recursively sanitize objects to prevent leaking secrets in error details.
 */
export function sanitizeMcpPayload<T>(value: T): T {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') {
    return sanitizeSecrets(value) as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeMcpPayload(item)) as unknown as T;
  }
  if (typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      const lowerKey = k.toLowerCase();
      if (
        lowerKey.includes('secret') ||
        lowerKey.includes('token') ||
        lowerKey.includes('key') ||
        lowerKey.includes('password') ||
        lowerKey.includes('auth') ||
        lowerKey.includes('credential')
      ) {
        result[k] = '***REDACTED***';
      } else {
        result[k] = sanitizeMcpPayload(v);
      }
    }
    return result as unknown as T;
  }
  return value;
}

// ============================================================================
// 3. MCP ERROR CLASSES
// ============================================================================

/**
 * Base MCP boundary error class extending authoritative AidmError.
 */
export class McpError extends AidmError {
  readonly rpcCode: number;
  readonly correlationId?: string;

  constructor(
    message: string,
    rpcCode: number = McpJsonRpcErrorCode.INTERNAL_ERROR,
    aidmCode: string = McpErrorCode.INTERNAL_FAILURE,
    details?: AidmErrorDetails,
    correlationId?: string
  ) {
    const cleanMessage = sanitizeSecrets(message);
    const cleanDetails = details ? sanitizeMcpPayload(details) : undefined;
    super(cleanMessage, aidmCode, cleanDetails);
    this.name = this.constructor.name;
    this.rpcCode = rpcCode;
    this.correlationId = correlationId;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Thrown when an incoming MCP request is malformed or invalid.
 */
export class McpInvalidRequestError extends McpError {
  constructor(message: string, details?: AidmErrorDetails, correlationId?: string) {
    super(
      message,
      McpJsonRpcErrorCode.INVALID_REQUEST,
      McpErrorCode.INVALID_REQUEST,
      details,
      correlationId
    );
  }
}

/**
 * Thrown when an unsupported MCP method or operation is requested.
 */
export class McpUnsupportedOperationError extends McpError {
  constructor(message: string, details?: AidmErrorDetails, correlationId?: string) {
    super(
      message,
      McpJsonRpcErrorCode.METHOD_NOT_FOUND,
      McpErrorCode.UNSUPPORTED_OPERATION,
      details,
      correlationId
    );
  }
}

/**
 * Thrown when the AIDM orchestrator / state authority is unavailable.
 */
export class McpOrchestratorUnavailableError extends McpError {
  constructor(
    message = 'AIDM Orchestrator is unavailable or uninitialized',
    details?: AidmErrorDetails,
    correlationId?: string
  ) {
    super(
      message,
      McpDomainErrorCode.ORCHESTRATOR_UNAVAILABLE,
      McpErrorCode.ORCHESTRATOR_UNAVAILABLE,
      details,
      correlationId
    );
  }
}

/**
 * Thrown when an operation is blocked by the AIDM Policy Engine.
 */
export class McpPolicyBlockedError extends McpError {
  constructor(message: string, details?: AidmErrorDetails, correlationId?: string) {
    super(
      message,
      McpDomainErrorCode.POLICY_BLOCKED,
      McpErrorCode.POLICY_BLOCKED,
      details,
      correlationId
    );
  }
}

/**
 * Thrown when an operation requires explicit human decision / authorization.
 */
export class McpHumanBlockedError extends McpError {
  constructor(message: string, details?: AidmErrorDetails, correlationId?: string) {
    super(
      message,
      McpDomainErrorCode.HUMAN_BLOCKED,
      McpErrorCode.HUMAN_BLOCKED,
      details,
      correlationId
    );
  }
}

/**
 * Thrown on unhandled internal failures.
 */
export class McpInternalFailureError extends McpError {
  constructor(message: string, details?: AidmErrorDetails, correlationId?: string) {
    super(
      message,
      McpJsonRpcErrorCode.INTERNAL_ERROR,
      McpErrorCode.INTERNAL_FAILURE,
      details,
      correlationId
    );
  }
}

// ============================================================================
// 4. ERROR NORMALIZATION BOUNDARY
// ============================================================================

export class McpErrorNormalizer {
  /**
   * Normalizes any thrown error or rejection into a deterministic, safe McpJsonRpcErrorObject.
   */
  static normalize(error: unknown, correlation?: McpRequestCorrelation): McpJsonRpcErrorObject {
    const correlationId = correlation?.correlationId;

    // 1. Direct McpError instance
    if (error instanceof McpError) {
      return {
        code: error.rpcCode,
        message: sanitizeSecrets(error.message),
        data: {
          code: error.code,
          correlationId: error.correlationId ?? correlationId,
          details: error.details ? sanitizeMcpPayload(error.details) : undefined,
        },
      };
    }

    // 2. PolicyViolationError from AIDM core
    if (error instanceof PolicyViolationError) {
      return {
        code: McpDomainErrorCode.POLICY_BLOCKED,
        message: sanitizeSecrets(error.message),
        data: {
          code: McpErrorCode.POLICY_BLOCKED,
          correlationId,
          details: error.details ? sanitizeMcpPayload(error.details) : undefined,
        },
      };
    }

    // 3. Generic AidmError from existing phases
    if (error instanceof AidmError) {
      const isPolicy = error.code.includes('POLICY') || error.code.includes('BLOCKED');
      const isHuman = error.code.includes('HUMAN');
      const code = isPolicy
        ? McpDomainErrorCode.POLICY_BLOCKED
        : isHuman
          ? McpDomainErrorCode.HUMAN_BLOCKED
          : McpJsonRpcErrorCode.INTERNAL_ERROR;

      const mcpCode = isPolicy
        ? McpErrorCode.POLICY_BLOCKED
        : isHuman
          ? McpErrorCode.HUMAN_BLOCKED
          : McpErrorCode.INTERNAL_FAILURE;

      return {
        code,
        message: sanitizeSecrets(error.message),
        data: {
          code: mcpCode,
          correlationId,
          details: error.details ? sanitizeMcpPayload(error.details) : undefined,
        },
      };
    }

    // 4. Standard JavaScript Error
    if (error instanceof Error) {
      const cleanMsg = sanitizeSecrets(error.message);
      // Check message hints for policy or unavailable
      if (cleanMsg.toLowerCase().includes('policy')) {
        return {
          code: McpDomainErrorCode.POLICY_BLOCKED,
          message: cleanMsg,
          data: {
            code: McpErrorCode.POLICY_BLOCKED,
            correlationId,
          },
        };
      }

      if (cleanMsg.toLowerCase().includes('orchestrator') && cleanMsg.toLowerCase().includes('unavailable')) {
        return {
          code: McpDomainErrorCode.ORCHESTRATOR_UNAVAILABLE,
          message: cleanMsg,
          data: {
            code: McpErrorCode.ORCHESTRATOR_UNAVAILABLE,
            correlationId,
          },
        };
      }

      return {
        code: McpJsonRpcErrorCode.INTERNAL_ERROR,
        message: cleanMsg,
        data: {
          code: McpErrorCode.INTERNAL_FAILURE,
          correlationId,
        },
      };
    }

    // 5. Unknown primitive or non-error rejection
    return {
      code: McpJsonRpcErrorCode.INTERNAL_ERROR,
      message: 'An unexpected internal error occurred',
      data: {
        code: McpErrorCode.INTERNAL_FAILURE,
        correlationId,
      },
    };
  }
}
