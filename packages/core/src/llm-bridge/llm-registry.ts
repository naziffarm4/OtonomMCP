/**
 * @file llm-registry.ts
 * @description Provider-agnostic LLM Provider Registry (TASK-P3-03 Requirement 11).
 * 
 * Invariants:
 * 1. DEC-008: Core is decoupled from any specific model or provider vendor.
 * 2. Minimal, provider-agnostic registration and resolution by abstract provider ID.
 * 3. Contains NO vendor-specific branching, if/else chains, or hardcoded provider names.
 * 4. Thread-safe in-memory registry maintaining registered provider instances.
 */

import type { LLMProvider } from './llm-provider.js';

export interface LlmProviderRegistry {
  /**
   * Registers a provider instance.
   * If a provider with the same providerId already exists, it is replaced.
   */
  register(provider: LLMProvider): void;

  /**
   * Unregisters a provider by its identifier.
   * Returns true if a provider was removed, false otherwise.
   */
  unregister(providerId: string): boolean;

  /**
   * Retrieves a registered provider by identifier.
   */
  get(providerId: string): LLMProvider | undefined;

  /**
   * Checks whether a provider with the given identifier is registered.
   */
  has(providerId: string): boolean;

  /**
   * Lists all registered provider instances.
   */
  list(): readonly LLMProvider[];

  /**
   * Returns the designated default provider, or undefined if none is registered.
   */
  getDefault(): LLMProvider | undefined;

  /**
   * Designates a registered provider as the default provider.
   */
  setDefault(providerId: string): void;

  /**
   * Clears all registered providers from the registry.
   */
  clear(): void;
}

export class DefaultLlmProviderRegistry implements LlmProviderRegistry {
  private readonly providers = new Map<string, LLMProvider>();
  private defaultProviderId: string | null = null;

  register(provider: LLMProvider): void {
    if (!provider || typeof provider.providerId !== 'string' || !provider.providerId.trim()) {
      throw new Error('Cannot register provider with empty or invalid providerId');
    }

    this.providers.set(provider.providerId, provider);

    // If no default provider has been designated yet, the first registered becomes default
    if (!this.defaultProviderId) {
      this.defaultProviderId = provider.providerId;
    }
  }

  unregister(providerId: string): boolean {
    const deleted = this.providers.delete(providerId);
    if (this.defaultProviderId === providerId) {
      this.defaultProviderId = this.providers.keys().next().value ?? null;
    }
    return deleted;
  }

  get(providerId: string): LLMProvider | undefined {
    return this.providers.get(providerId);
  }

  has(providerId: string): boolean {
    return this.providers.has(providerId);
  }

  list(): readonly LLMProvider[] {
    return Object.freeze(Array.from(this.providers.values()));
  }

  getDefault(): LLMProvider | undefined {
    if (!this.defaultProviderId) return undefined;
    return this.providers.get(this.defaultProviderId);
  }

  setDefault(providerId: string): void {
    if (!this.providers.has(providerId)) {
      throw new Error(`Cannot set default provider: "${providerId}" is not registered`);
    }
    this.defaultProviderId = providerId;
  }

  clear(): void {
    this.providers.clear();
    this.defaultProviderId = null;
  }
}
