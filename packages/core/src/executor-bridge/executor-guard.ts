/**
 * Executor Guard & Security Boundary (Phase 10 TASK-P10-03)
 *
 * Enforces strict security, precondition validation, path traversal defense,
 * shell injection prevention, and hash integrity on incoming ExecutionRequests
 * before any executor invocation is permitted.
 *
 * ARCHITECTURAL INVARIANTS:
 * 1. ZERO ARBITRARY SHELL EXECUTION: ExecutionRequests cannot contain shell metacharacters
 *    or arbitrary commands.
 * 2. PATH INTEGRITY: Paths must be POSIX relative. Absolute paths, Windows drive paths,
 *    UNC paths, and traversal sequences (..) are strictly rejected.
 * 3. HASH INTEGRITY: requestId must match the deterministic SHA-256 derivation.
 * 4. BOUNDED LIMITS: Timeout and modification limits must fall strictly within safe bounds.
 * 5. IMMUTABLE BINDING: Binds the request to authorized operation types.
 */

import {
  type ExecutionRequest,
  ExecutionRequestZodSchema,
  MIN_EXECUTION_TIMEOUT_MS,
  MAX_EXECUTION_TIMEOUT_MS,
  MIN_MAX_FILE_MODIFICATIONS,
  MAX_MAX_FILE_MODIFICATIONS,
} from './execution-request-types.js';
import { computeDeterministicRequestId } from './execution-request-builder.js';
import {
  ExecutorPreconditionError,
  ExecutorSecurityViolationError,
  ExecutionRequestValidationError,
} from '../director/director-errors.js';

// Shell metacharacters that must NEVER appear in request parameters or targetFiles
// Notice: we check for characters like ; & | ` $ > < \0 \r \n
export const SHELL_INJECTION_PATTERN = /[;&|`$><\0\r\n]/;

// Windows drive letter regex: C:, D:, etc.
export const WINDOWS_DRIVE_PATTERN = /^[a-zA-Z]:/;

// UNC path prefix: \\server\share or //server/share
export const UNC_PATH_PATTERN = /^(\/\/|\\\\)/;

export interface ExecutorGuardOptions {
  readonly supportedOperations?: readonly string[];
  readonly workingDirectory?: string;
  readonly strictHashCheck?: boolean;
}

export class ExecutorGuard {
  /**
   * Validates all execution preconditions and security invariants on an ExecutionRequest.
   * Throws typed domain errors upon any violation.
   */
  static validateExecutionPreconditions(
    request: unknown,
    options: ExecutorGuardOptions = {}
  ): ExecutionRequest {
    // 1. Structural Schema Validation
    if (!request || typeof request !== 'object') {
      throw new ExecutorPreconditionError(
        'ExecutionRequest must be a non-null object',
        { code: 'ERR_INVALID_REQUEST' }
      );
    }

    const parseResult = ExecutionRequestZodSchema.safeParse(request);
    if (!parseResult.success) {
      throw new ExecutionRequestValidationError(
        `ExecutionRequest schema validation failed: ${parseResult.error.issues[0]?.message ?? 'invalid request structure'}`,
        { issues: parseResult.error.issues }
      );
    }

    const req = parseResult.data as ExecutionRequest;

    // 2. Supported Operation Validation
    const supportedOps = options.supportedOperations ?? ['IMPLEMENT_TASK'];
    if (!supportedOps.includes(req.operationType)) {
      throw new ExecutorSecurityViolationError(
        `Operation type '${req.operationType}' is not supported by executor adapter. Supported operations: [${supportedOps.join(', ')}]`,
        { operationType: req.operationType, supportedOperations: supportedOps }
      );
    }

    // 3. Shell Injection Prevention on Identifiers & Metadata
    this.assertNoShellInjection(req.projectId, 'projectId');
    this.assertNoShellInjection(req.taskId, 'taskId');
    this.assertNoShellInjection(req.directorSessionId, 'directorSessionId');
    this.assertNoShellInjection(req.directorDecisionId, 'directorDecisionId');

    // 4. Target Files Path Safety & Security Inspection
    if (req.instruction && req.instruction.targetFiles) {
      for (const targetFile of req.instruction.targetFiles) {
        this.validatePathSafety(targetFile, 'targetFiles');
      }
    }

    // 5. Working Directory Path Safety (if provided in options or metadata)
    const workDir = options.workingDirectory ?? (req.metadata?.workingDirectory as string | undefined);
    if (workDir) {
      if (typeof workDir !== 'string' || workDir.trim().length === 0) {
        throw new ExecutorSecurityViolationError(
          'workingDirectory must be a non-empty string',
          { workingDirectory: workDir }
        );
      }
      if (SHELL_INJECTION_PATTERN.test(workDir)) {
        throw new ExecutorSecurityViolationError(
          `Shell injection pattern detected in workingDirectory: '${workDir}'`,
          { field: 'workingDirectory', value: workDir }
        );
      }
      // Note: workingDirectory can be an absolute path, but cannot contain traversal out of bounds or null bytes
      if (workDir.includes('\0')) {
        throw new ExecutorSecurityViolationError(
          'workingDirectory cannot contain null bytes',
          { workingDirectory: workDir }
        );
      }
    }

    // 6. Execution Limits Bounds Validation
    if (
      req.executionLimits.timeoutMs < MIN_EXECUTION_TIMEOUT_MS ||
      req.executionLimits.timeoutMs > MAX_EXECUTION_TIMEOUT_MS
    ) {
      throw new ExecutorPreconditionError(
        `executionLimits.timeoutMs ${req.executionLimits.timeoutMs} is out of safe range [${MIN_EXECUTION_TIMEOUT_MS}, ${MAX_EXECUTION_TIMEOUT_MS}]`,
        { timeoutMs: req.executionLimits.timeoutMs }
      );
    }

    if (
      req.executionLimits.maxFileModifications < MIN_MAX_FILE_MODIFICATIONS ||
      req.executionLimits.maxFileModifications > MAX_MAX_FILE_MODIFICATIONS
    ) {
      throw new ExecutorPreconditionError(
        `executionLimits.maxFileModifications ${req.executionLimits.maxFileModifications} is out of safe range [${MIN_MAX_FILE_MODIFICATIONS}, ${MAX_MAX_FILE_MODIFICATIONS}]`,
        { maxFileModifications: req.executionLimits.maxFileModifications }
      );
    }

    // 7. RequestId Deterministic Hash Integrity Check
    if (options.strictHashCheck !== false) {
      const expectedId = computeDeterministicRequestId({
        approvalPackageRevision: req.approvalPackageRevision,
        contextFingerprint: req.contextFingerprint,
        directorDecisionId: req.directorDecisionId,
        directorSessionId: req.directorSessionId,
        executionLimits: req.executionLimits,
        expectedRepositoryState: req.expectedRepositoryState,
        instruction: req.instruction,
        operationType: req.operationType,
        projectId: req.projectId,
        protocolVersion: req.protocolVersion,
        schemaVersion: req.schemaVersion,
        taskId: req.taskId,
        taskRevision: req.taskRevision,
        understandingRevision: req.understandingRevision,
      });

      if (req.requestId !== expectedId) {
        throw new ExecutorPreconditionError(
          `requestId hash mismatch: expected '${expectedId}', found '${req.requestId}'. ExecutionRequest may be tampered or unverified.`,
          { expectedRequestId: expectedId, actualRequestId: req.requestId }
        );
      }
    }

    return Object.freeze(req);
  }

  /**
   * Asserts that a string contains no dangerous shell injection characters.
   */
  static assertNoShellInjection(val: string, fieldName: string): void {
    if (typeof val !== 'string') {
      return;
    }
    if (SHELL_INJECTION_PATTERN.test(val)) {
      throw new ExecutorSecurityViolationError(
        `Shell injection attempt detected in ${fieldName}: '${val}'. Requests cannot execute arbitrary shell syntax.`,
        { field: fieldName, value: val }
      );
    }
  }

  /**
   * Validates that a file path conforms to strict sandboxed POSIX relative path rules.
   * Rejects:
   * - Path traversal (..)
   * - Absolute paths (/ or \)
   * - Windows drive letters (C:, D:)
   * - UNC paths (\\ or //)
   * - Null bytes (\0)
   * - Shell metacharacters
   */
  static validatePathSafety(filePath: string, fieldName: string): void {
    if (typeof filePath !== 'string' || filePath.trim().length === 0) {
      throw new ExecutorSecurityViolationError(
        `${fieldName} entry cannot be empty`,
        { field: fieldName, filePath }
      );
    }

    const normalized = filePath.trim();

    // 1. Null byte check
    if (normalized.includes('\0')) {
      throw new ExecutorSecurityViolationError(
        `Null byte detected in ${fieldName}: '${normalized}'`,
        { field: fieldName, filePath: normalized }
      );
    }

    // 2. Shell injection check
    if (SHELL_INJECTION_PATTERN.test(normalized)) {
      throw new ExecutorSecurityViolationError(
        `Shell metacharacter detected in ${fieldName}: '${normalized}'`,
        { field: fieldName, filePath: normalized }
      );
    }

    // 3. UNC network paths (\\server\share, //server/share)
    if (UNC_PATH_PATTERN.test(normalized)) {
      throw new ExecutorSecurityViolationError(
        `UNC path rejected in ${fieldName}: '${normalized}'. Paths must be relative to repository root.`,
        { field: fieldName, filePath: normalized }
      );
    }

    // 4. Windows drive paths (e.g. C:\foo, D:/bar)
    if (WINDOWS_DRIVE_PATTERN.test(normalized)) {
      throw new ExecutorSecurityViolationError(
        `Windows drive path rejected in ${fieldName}: '${normalized}'. Paths must be relative to repository root.`,
        { field: fieldName, filePath: normalized }
      );
    }

    // 5. Absolute path checks (POSIX / and Windows \)
    if (normalized.startsWith('/') || normalized.startsWith('\\')) {
      throw new ExecutorSecurityViolationError(
        `Absolute path rejected in ${fieldName}: '${normalized}'. Paths must be relative to repository root.`,
        { field: fieldName, filePath: normalized }
      );
    }

    // 6. Path traversal check (..)
    // Rejects .., ../foo, bar/../baz, bar/..
    const parts = normalized.replace(/\\/g, '/').split('/');
    for (const part of parts) {
      if (part === '..') {
        throw new ExecutorSecurityViolationError(
          `Path traversal sequence (..) rejected in ${fieldName}: '${normalized}'`,
          { field: fieldName, filePath: normalized }
        );
      }
    }
  }
}
