/**
 * MCP Tool Name Compatibility & Normalization Mapper
 *
 * Implements deterministic, collision-safe mapping from internal tool identifiers
 * (e.g., 'aidm.health') to Antigravity-compatible MCP names (e.g., 'aidm_health').
 *
 * Antigravity Invariants:
 * 1. Only characters matching [a-zA-Z0-9_-] are permitted.
 * 2. Maximum length of 64 characters is enforced.
 * 3. Every exposed tool name must be unique.
 * 4. Preserves 100% of underlying tool functionality, handler mappings, input schemas,
 *    and authorization rules.
 */

import * as crypto from 'node:crypto';

export const MCP_TOOL_NAME_REGEX = /^[a-zA-Z0-9_-]{1,64}$/;
export const MAX_MCP_TOOL_NAME_LENGTH = 64;

/**
 * Normalizes an internal tool identifier to an Antigravity-compatible MCP name.
 *
 * - Replaces any character not in [a-zA-Z0-9_-] (such as '.') with '_'.
 * - If the resulting name exceeds 64 characters, deterministically truncates to 55 characters
 *   and appends an '_' followed by an 8-character SHA-256 hash of the full original name,
 *   guaranteeing the result is strictly <= 64 characters and collision-resistant.
 */
export function normalizeMcpToolName(name: string): string {
  if (typeof name !== 'string' || name.trim().length === 0) {
    throw new Error('Tool name must be a non-empty string');
  }

  // Replace all unsupported characters (including dots) with underscore
  const normalized = name.replace(/[^a-zA-Z0-9_-]/g, '_');

  if (normalized.length <= MAX_MCP_TOOL_NAME_LENGTH) {
    return normalized;
  }

  // Enforce 64-character maximum length using deterministic SHA-256 truncation
  const hash = crypto.createHash('sha256').update(name).digest('hex').slice(0, 8);
  const prefix = normalized.slice(0, MAX_MCP_TOOL_NAME_LENGTH - 1 - 8); // 55 characters
  return `${prefix}_${hash}`;
}

/**
 * Validates whether a tool name complies with the MCP naming specification:
 * ^[a-zA-Z0-9_-]{1,64}$
 */
export function isValidMcpToolName(name: string): boolean {
  return typeof name === 'string' && MCP_TOOL_NAME_REGEX.test(name);
}

/**
 * Disambiguates an exposed tool name if a collision occurs with an already registered name.
 * Uses a deterministic hash of the internal identifier and, if necessary, an incrementing counter.
 */
export function createCollisionSafeToolName(
  internalName: string,
  existingNames: ReadonlySet<string> | Set<string>
): string {
  const baseName = normalizeMcpToolName(internalName);

  if (!existingNames.has(baseName)) {
    return baseName;
  }

  // Generate deterministic disambiguation using internalName hash
  const hash = crypto.createHash('sha256').update(internalName).digest('hex').slice(0, 6);
  const prefix = baseName.slice(0, MAX_MCP_TOOL_NAME_LENGTH - 1 - 6);
  const candidate = `${prefix}_${hash}`;

  if (!existingNames.has(candidate)) {
    return candidate;
  }

  // Fallback for repeated collisions
  let counter = 2;
  while (true) {
    const counterSuffix = `_${counter}`;
    const truncatedPrefix = baseName.slice(0, MAX_MCP_TOOL_NAME_LENGTH - counterSuffix.length);
    const retryCandidate = `${truncatedPrefix}${counterSuffix}`;
    if (!existingNames.has(retryCandidate)) {
      return retryCandidate;
    }
    counter++;
  }
}
