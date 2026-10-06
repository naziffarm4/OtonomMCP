/**
 * @file transport-security-registry.ts
 * @description Central Transport Security Registry and Factory for LLM Transports (TASK-P18-02-HARDENING-REMEDIATION).
 *
 * ARCHITECTURAL INVARIANTS:
 * 1. Production mode strictly requires an authentic, verified live network transport (HttpLlmTransport).
 * 2. Unforgeable trust boundary: Relies on module-private WeakSet and internal Symbol branding,
 *    which cannot be forged or inspected by ordinary JavaScript objects or duck typing.
 * 3. Central Factory: Transports must be created and registered through this registry.
 * 4. Anti-Tampering: Instances are frozen upon registration to prevent post-creation modification.
 * 5. Proxies and wrappers around mock transports or untrusted transports are strictly rejected.
 * 6. Deterministic mock transports remain supported in test/dev modes under explicit configuration.
 */

import type { LlmTransport } from './llm-transport.js';
import { LlmProviderUnavailableError } from '../errors/llm-error.js';

// ============================================================================
// 1. UNFORGEABLE INSTANCE IDENTITY & PRIVATE SEALS
// ============================================================================

/**
 * Module-private WeakSet holding references to verified live network transports.
 * Cannot be accessed, enumerated, or forged by external code.
 */
const TRUSTED_LIVE_NETWORK_TRANSPORTS = new WeakSet<object>();

/**
 * Module-private unique Symbol brand attached to verified live network transport instances.
 */
const TRANSPORT_INTEGRITY_BRAND: unique symbol = Symbol('AIDM_TRANSPORT_INTEGRITY_BRAND');

// ============================================================================
// 2. TRANSPORT SECURITY REGISTRY & FACTORY
// ============================================================================

export class TransportSecurityRegistry {
  /**
   * Registers a live network transport instance into the trusted transport registry.
   * Freezes the instance to prevent tampering.
   */
  static registerLiveNetworkTransport<T extends LlmTransport>(transport: T): T {
    if (!transport || typeof transport !== 'object') {
      throw new LlmProviderUnavailableError(
        'Cannot register invalid transport: transport must be a non-null object',
        { reason: 'INVALID_TRANSPORT_OBJECT' }
      );
    }

    // Verify architectural kind and network properties
    if (transport.transportKind !== 'network_http') {
      throw new LlmProviderUnavailableError(
        `Cannot register transport as live network transport: transportKind must be 'network_http', received '${String(transport.transportKind)}'`,
        { reason: 'INVALID_TRANSPORT_KIND', transportName: transport.transportName }
      );
    }

    if (transport.isLiveNetworkTransport !== true) {
      throw new LlmProviderUnavailableError(
        `Cannot register transport as live network transport: isLiveNetworkTransport must be true`,
        { reason: 'NOT_LIVE_NETWORK_TRANSPORT', transportName: transport.transportName }
      );
    }

    // Reject any transport with mock identifiers in name
    const transportName = typeof transport.transportName === 'string' ? transport.transportName : '';
    if (/mock|stub|fake|dummy/i.test(transportName)) {
      throw new LlmProviderUnavailableError(
        `Cannot register mock transport "${transportName}" as live network transport`,
        { reason: 'MOCK_TRANSPORT_NOT_ALLOWED', transportName }
      );
    }

    // Verify mandatory dispatch methods
    if (typeof transport.send !== 'function' || typeof transport.isAvailable !== 'function') {
      throw new LlmProviderUnavailableError(
        `Cannot register transport "${transportName}": missing required methods send() or isAvailable()`,
        { reason: 'MALFORMED_TRANSPORT_CONTRACT', transportName }
      );
    }

    // Attach unforgeable symbol brand
    try {
      Object.defineProperty(transport, TRANSPORT_INTEGRITY_BRAND, {
        value: true,
        writable: false,
        configurable: false,
        enumerable: false,
      });
    } catch {
      // If already frozen or branded, ignore
    }

    // Add to private WeakSet
    TRUSTED_LIVE_NETWORK_TRANSPORTS.add(transport);

    // Freeze instance against runtime tampering
    try {
      Object.freeze(transport);
    } catch {
      // Ignore if already frozen
    }

    return transport;
  }

  /**
   * Checks whether the provided transport is an authentic, verified live network transport.
   * Returns false for duck-typed objects, unregistered proxies, or mock implementations.
   */
  static isTrustedLiveTransport(transport: unknown): boolean {
    if (!transport || typeof transport !== 'object') {
      return false;
    }

    // 1. Must be in the private WeakSet
    if (!TRUSTED_LIVE_NETWORK_TRANSPORTS.has(transport as object)) {
      return false;
    }

    // 2. Must bear the private Symbol brand
    if ((transport as Record<string | symbol, unknown>)[TRANSPORT_INTEGRITY_BRAND] !== true) {
      return false;
    }

    // 3. Must satisfy live network metadata
    const t = transport as LlmTransport;
    if (t.transportKind !== 'network_http' || t.isLiveNetworkTransport !== true) {
      return false;
    }

    // 4. Must not have mock indicators
    if (typeof t.transportName === 'string' && /mock|stub|fake|dummy/i.test(t.transportName)) {
      return false;
    }

    return true;
  }

  /**
   * Determines whether the given transport is a mock or simulated transport.
   */
  static isMockTransport(transport: unknown): boolean {
    if (!transport || typeof transport !== 'object') {
      return false;
    }
    const t = transport as Partial<LlmTransport>;
    if (t.isLiveNetworkTransport === false) return true;
    if (t.transportKind === 'mock_deterministic' || t.transportKind === 'in_memory') return true;
    if (typeof t.transportName === 'string' && /mock|stub|fake|dummy/i.test(t.transportName)) return true;
    return false;
  }

  /**
   * Asserts that the transport is an authentic, verified live network transport.
   * Throws LlmProviderUnavailableError if unverified or mock.
   */
  static assertTrustedLiveTransport(transport: unknown, context: string = 'TransportSecurityRegistry'): void {
    if (!transport) {
      throw new LlmProviderUnavailableError(
        `[${context}] No LLM transport provided. Production mode strictly requires a verified live network transport.`,
        { reason: 'NO_TRANSPORT' }
      );
    }

    if (this.isMockTransport(transport)) {
      const name = (transport as Partial<LlmTransport>).transportName ?? 'mock';
      throw new LlmProviderUnavailableError(
        `[${context}] Mock LLM transport "${name}" is strictly prohibited in production mode.`,
        { reason: 'MOCK_TRANSPORT_NOT_ALLOWED_IN_PRODUCTION', transportName: name }
      );
    }

    if (!this.isTrustedLiveTransport(transport)) {
      const name = (transport as Partial<LlmTransport>).transportName ?? 'unknown';
      throw new LlmProviderUnavailableError(
        `[${context}] Production mode strictly requires an authentic, verified live network transport (HttpLlmTransport) registered through TransportSecurityRegistry. Unverified, custom, proxied, or spoofed transport "${name}" is prohibited.`,
        { reason: 'UNVERIFIED_TRANSPORT_IN_PRODUCTION', transportName: name }
      );
    }
  }
}
