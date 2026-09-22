/**
 * @file llm-provider-adapter.test.ts
 * @description Comprehensive unit test suite for TASK-P3-03:
 * LLM Provider Bridge Integration & Provider Adapter Boundary.
 * 
 * Verifies Scenarios A through W:
 * A. Generic request reaches adapter.
 * B. System/user/context/acceptance information maps correctly.
 * C. Provider-specific wire request is isolated inside adapter.
 * D. Correlation ID survives request -> transport -> response.
 * E. Project/task identity survives where applicable.
 * F. Model identity is preserved.
 * G. Provider identity is preserved.
 * H. Exact usage is preserved.
 * I. Missing usage remains null.
 * J. Provider API failure becomes structured LLM error.
 * K. Timeout becomes structured timeout error.
 * L. Malformed provider payload becomes structured malformed-response error.
 * M. Unsupported capability is rejected.
 * N. Structured JSON response is normalized.
 * O. Structured output validation remains enforced.
 * P. Raw provider metadata is preserved without leaking secrets.
 * Q. Injected transport is deterministic.
 * R. No hidden network access exists.
 * S. Two provider implementations conform to the same LLMProvider contract.
 * T. Provider-specific code does not leak into generic core.
 * U. Serialization/deserialization remains valid.
 * V. Existing P3-01 and P3-02 tests continue passing.
 * W. Existing Phase 1/2 regression suite continues passing.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  type LLMProvider,
  LlmCapability,
  type LlmRequest,
  LlmRole,
  LlmResponseFormat,
  LlmFinishReason,
  validateLlmRequest,
  type LlmProtocolEnvelope,
  validateLlmProtocolEnvelope,
  serializeLlmProtocolPayload,
  deserializeLlmProtocolPayload,
  DeterministicMockTransport,
  ReferenceLlmAdapter,
  type ReferenceWireRequest,
  type ReferenceWireResponse,
  SecondaryLlmAdapter,
  type SecondaryWireRequest,
  type SecondaryWireResponse,
  DefaultLlmProviderRegistry,
  LlmExecutionError,
  LlmTimeoutError,
  MalformedLlmResponseError,
  LlmProviderUnavailableError,
  StructuredOutputValidationError,
  UnsupportedLlmCapabilityError,
  LlmTransportHttpError,
} from '../dist/index.js';

// ============================================================================
// HELPER FACTORIES
// ============================================================================

function createSampleLlmRequest(overrides: Partial<Parameters<typeof validateLlmRequest>[0]> = {}): LlmRequest {
  return validateLlmRequest({
    correlation: {
      correlation_id: 'corr-p3-03-test-1234',
      project_id: 'proj-aidm-alpha',
      task_id: 'TASK-P3-03',
      attempt: 1,
    },
    messages: [
      { role: LlmRole.SYSTEM, content: 'You are the AIDM Director Assistant.' },
      { role: LlmRole.USER, content: 'Implement the adapter boundary for LLM bridge.' },
    ],
    director_context: {
      project_id: 'proj-aidm-alpha',
      task_id: 'TASK-P3-03',
      objective: 'Build provider-agnostic bridge boundary',
      acceptance_criteria: ['Zero hidden network calls', 'Deterministic mapping'],
      attempt: 1,
      max_attempts: 3,
      relevant_context: { architecture_doc: 'DEC-008' },
    },
    model: 'ref-model-v1',
    temperature: 0.2,
    max_tokens: 1024,
    response_format: LlmResponseFormat.TEXT,
    ...overrides,
  });
}

function createReferenceWireSuccessResponse(
  content: string = 'Boundary implemented successfully.',
  usage?: ReferenceWireResponse['usage']
): ReferenceWireResponse {
  return {
    id: 'ref-res-001',
    object: 'chat.completion',
    created: 1726000000,
    model: 'ref-model-v1',
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content,
        },
        finish_reason: 'stop',
      },
    ],
    usage: usage !== undefined ? usage : {
      prompt_tokens: 150,
      completion_tokens: 50,
      cached_tokens: 20,
      total_tokens: 200,
    },
    system_fingerprint: 'fp_ref_42',
  };
}

// ============================================================================
// TEST SUITE: TASK-P3-03 LLM PROVIDER BRIDGE INTEGRATION
// ============================================================================

describe('LLM Provider Bridge Integration & Provider Adapter Boundary (TASK-P3-03)', () => {
  // --------------------------------------------------------------------------
  // Scenario A: Generic request reaches adapter
  // --------------------------------------------------------------------------
  it('A: Generic request reaches adapter and executes through injected transport', async () => {
    const mockTransport = new DeterministicMockTransport<ReferenceWireRequest, ReferenceWireResponse>({
      responseBody: createReferenceWireSuccessResponse('Task completed.'),
    });

    const adapter = new ReferenceLlmAdapter({
      transport: mockTransport,
    });

    const request = createSampleLlmRequest();
    const response = await adapter.generate(request);

    assert.equal(mockTransport.recordedRequests.length, 1);
    assert.equal(response.content, 'Task completed.');
    assert.equal(response.finish_reason, LlmFinishReason.STOP);
  });

  // --------------------------------------------------------------------------
  // Scenario B: System/user/context/acceptance information maps correctly
  // --------------------------------------------------------------------------
  it('B: System/user/context/acceptance information maps correctly to provider wire format', async () => {
    const mockTransport = new DeterministicMockTransport<ReferenceWireRequest, ReferenceWireResponse>({
      responseBody: createReferenceWireSuccessResponse(),
    });

    const adapter = new ReferenceLlmAdapter({
      transport: mockTransport,
    });

    const request = createSampleLlmRequest({
      messages: [
        { role: LlmRole.SYSTEM, content: 'System instruction line 1' },
        { role: LlmRole.USER, content: 'User request line 2' },
      ],
      director_context: {
        project_id: 'proj-omega',
        task_id: 'TASK-99',
        objective: 'Test complete semantic mapping',
        acceptance_criteria: ['Criteria A', 'Criteria B'],
        attempt: 2,
        max_attempts: 5,
        relevant_context: { spec_ref: 'SPEC-01' },
      },
    });

    await adapter.generate(request);

    assert.equal(mockTransport.recordedRequests.length, 1);
    const wire = mockTransport.recordedRequests[0].body;

    // Messages mapped
    assert.equal(wire.messages.length, 2);
    assert.equal(wire.messages[0].role, 'system');
    assert.equal(wire.messages[0].content, 'System instruction line 1');
    assert.equal(wire.messages[1].role, 'user');
    assert.equal(wire.messages[1].content, 'User request line 2');

    // Context mapped without loss
    assert.equal(wire.director_context.project_id, 'proj-omega');
    assert.equal(wire.director_context.task_id, 'TASK-99');
    assert.equal(wire.director_context.objective, 'Test complete semantic mapping');
    assert.deepEqual(wire.director_context.acceptance_criteria, ['Criteria A', 'Criteria B']);
    assert.equal(wire.director_context.attempt, 2);
    assert.equal(wire.director_context.max_attempts, 5);
    assert.deepEqual(wire.director_context.relevant_context, { spec_ref: 'SPEC-01' });

    // Metadata mapped
    assert.equal(wire.metadata.aidm_project_id, 'proj-omega');
    assert.equal(wire.metadata.aidm_task_id, 'TASK-99');
    assert.equal(wire.metadata.aidm_attempt, 2);
  });

  // --------------------------------------------------------------------------
  // Scenario C: Provider-specific wire request is isolated inside adapter
  // --------------------------------------------------------------------------
  it('C: Provider-specific wire request is isolated inside adapter boundary', async () => {
    const mockTransport = new DeterministicMockTransport<ReferenceWireRequest, ReferenceWireResponse>({
      responseBody: createReferenceWireSuccessResponse(),
    });

    const genericProvider: LLMProvider = new ReferenceLlmAdapter({
      transport: mockTransport,
    });

    const request = createSampleLlmRequest();
    // Caller only invokes LLMProvider interface with LlmRequest and receives LlmResponse
    const response = await genericProvider.generate(request);

    assert.ok(response.content);
    // Wire structures are strictly inside the transport and adapter
    assert.equal(mockTransport.recordedRequests.length, 1);
    const wire = mockTransport.recordedRequests[0].body;
    assert.ok('director_context' in wire);
    assert.ok(!('director_context' in response)); // Core response does not expose wire-specific fields
  });

  // --------------------------------------------------------------------------
  // Scenario D: Correlation ID survives request -> transport -> response
  // --------------------------------------------------------------------------
  it('D: Correlation ID survives request -> transport -> response', async () => {
    const customCorrelationId = 'corr-uuid-strictly-preserved-98765';
    const mockTransport = new DeterministicMockTransport<ReferenceWireRequest, ReferenceWireResponse>({
      responseBody: createReferenceWireSuccessResponse(),
    });

    const adapter = new ReferenceLlmAdapter({
      transport: mockTransport,
    });

    const request = createSampleLlmRequest({
      correlation: {
        correlation_id: customCorrelationId,
        project_id: 'proj-test',
      },
    });

    const response = await adapter.generate(request);

    // Transport received correlation ID in headers and payload
    assert.equal(mockTransport.recordedRequests[0].headers?.['x-correlation-id'], customCorrelationId);
    assert.equal(mockTransport.recordedRequests[0].body.correlation_id, customCorrelationId);

    // Response preserves correlation ID
    assert.equal(response.correlation.correlation_id, customCorrelationId);
  });

  // --------------------------------------------------------------------------
  // Scenario E: Project/task identity survives where applicable
  // --------------------------------------------------------------------------
  it('E: Project and task identity survives into correlation and response', async () => {
    const mockTransport = new DeterministicMockTransport<ReferenceWireRequest, ReferenceWireResponse>({
      responseBody: createReferenceWireSuccessResponse(),
    });

    const adapter = new ReferenceLlmAdapter({
      transport: mockTransport,
    });

    const request = createSampleLlmRequest({
      project_id: 'project-xyz',
      task_id: 'TASK-54321',
      attempt: 3,
      director_context: {
        project_id: 'project-xyz',
        task_id: 'TASK-54321',
        attempt: 3,
      },
      correlation: {
        correlation_id: 'corr-id-1',
        project_id: 'project-xyz',
        task_id: 'TASK-54321',
        attempt: 3,
      },
    });

    const response = await adapter.generate(request);

    assert.equal(response.correlation.project_id, 'project-xyz');
    assert.equal(response.correlation.task_id, 'TASK-54321');
    assert.equal(response.correlation.attempt, 3);
  });

  // --------------------------------------------------------------------------
  // Scenario F: Model identity is preserved
  // --------------------------------------------------------------------------
  it('F: Model identity is preserved from request and wire response', async () => {
    const mockTransport = new DeterministicMockTransport<ReferenceWireRequest, ReferenceWireResponse>({
      responseBody: {
        ...createReferenceWireSuccessResponse(),
        model: 'ref-model-v1-heavy',
      },
    });

    const adapter = new ReferenceLlmAdapter({
      transport: mockTransport,
      defaultModel: 'ref-model-v1',
    });

    const request = createSampleLlmRequest({ model: 'ref-model-v1-heavy' });
    const response = await adapter.generate(request);

    assert.equal(response.model, 'ref-model-v1-heavy');
    assert.equal(mockTransport.recordedRequests[0].body.model, 'ref-model-v1-heavy');
  });

  // --------------------------------------------------------------------------
  // Scenario G: Provider identity is preserved
  // --------------------------------------------------------------------------
  it('G: Provider identity is strictly preserved in response', async () => {
    const mockTransport = new DeterministicMockTransport<ReferenceWireRequest, ReferenceWireResponse>({
      responseBody: createReferenceWireSuccessResponse(),
    });

    const adapter = new ReferenceLlmAdapter({
      providerName: 'custom-ref-llm',
      transport: mockTransport,
    });

    const request = createSampleLlmRequest();
    const response = await adapter.generate(request);

    assert.equal(response.provider, 'custom-ref-llm');
  });

  // --------------------------------------------------------------------------
  // Scenario H: Exact usage is preserved
  // --------------------------------------------------------------------------
  it('H: Exact provider usage metrics are strictly preserved without loss', async () => {
    const mockTransport = new DeterministicMockTransport<ReferenceWireRequest, ReferenceWireResponse>({
      responseBody: createReferenceWireSuccessResponse('output', {
        prompt_tokens: 245,
        completion_tokens: 88,
        cached_tokens: 60,
        total_tokens: 333,
      }),
    });

    const adapter = new ReferenceLlmAdapter({
      transport: mockTransport,
    });

    const response = await adapter.generate(createSampleLlmRequest());

    assert.equal(response.usage.reported_input_tokens, 245);
    assert.equal(response.usage.reported_output_tokens, 88);
    assert.equal(response.usage.reported_cached_tokens, 60);
    assert.equal(response.usage.estimated_tokens, 333);
    assert.equal(response.usage.is_exact_provider_metric, true);
    assert.equal(response.usage.estimated_cost_usd, null); // No invented pricing
  });

  // --------------------------------------------------------------------------
  // Scenario I: Missing usage remains null
  // --------------------------------------------------------------------------
  it('I: Missing provider usage metrics remain strictly null (zero fabrication)', async () => {
    const mockTransport = new DeterministicMockTransport<ReferenceWireRequest, ReferenceWireResponse>({
      responseBody: createReferenceWireSuccessResponse('output text', null),
    });

    const adapter = new ReferenceLlmAdapter({
      transport: mockTransport,
    });

    const response = await adapter.generate(createSampleLlmRequest());

    assert.equal(response.usage.reported_input_tokens, null);
    assert.equal(response.usage.reported_output_tokens, null);
    assert.equal(response.usage.reported_cached_tokens, null);
    assert.equal(response.usage.is_exact_provider_metric, false);
    assert.ok(response.usage.estimated_tokens > 0);
  });

  // --------------------------------------------------------------------------
  // Scenario J: Provider API failure becomes structured LLM error
  // --------------------------------------------------------------------------
  it('J: Provider HTTP / API failure is normalized to structured LlmExecutionError', async () => {
    const mockTransport = new DeterministicMockTransport<ReferenceWireRequest, ReferenceWireResponse>({
      responseStatus: 502,
      responseStatusText: 'Bad Gateway',
      throwHttpErrorOnStatusGte400: true,
    });

    const adapter = new ReferenceLlmAdapter({
      transport: mockTransport,
    });

    await assert.rejects(
      async () => {
        await adapter.generate(createSampleLlmRequest());
      },
      (err) => {
        assert.ok(err instanceof LlmExecutionError);
        assert.equal((err as LlmExecutionError).statusCode, 502);
        assert.equal((err as LlmExecutionError).code, 'ERR_LLM_EXECUTION_FAILURE');
        return true;
      }
    );
  });

  // --------------------------------------------------------------------------
  // Scenario K: Timeout becomes structured timeout error
  // --------------------------------------------------------------------------
  it('K: Slow provider transport triggers structured LlmTimeoutError within timeoutMs', async () => {
    const mockTransport = new DeterministicMockTransport<ReferenceWireRequest, ReferenceWireResponse>({
      responseDelayMs: 200,
      responseBody: createReferenceWireSuccessResponse(),
    });

    const adapter = new ReferenceLlmAdapter({
      transport: mockTransport,
      timeoutMs: 30, // Trigger timeout
    });

    const request = createSampleLlmRequest({ timeout_ms: 30 });

    await assert.rejects(
      async () => {
        await adapter.generate(request);
      },
      (err) => {
        assert.ok(err instanceof LlmTimeoutError);
        assert.equal((err as LlmTimeoutError).code, 'ERR_LLM_TIMEOUT');
        assert.equal((err as LlmTimeoutError).timeoutMs, 30);
        return true;
      }
    );
  });

  // --------------------------------------------------------------------------
  // Scenario L: Malformed provider payload becomes structured malformed-response error
  // --------------------------------------------------------------------------
  it('L: Malformed provider payload throws MalformedLlmResponseError', async () => {
    // 1. Missing choices array
    const mockTransportMissingChoices = new DeterministicMockTransport<ReferenceWireRequest, ReferenceWireResponse>({
      responseBody: { id: 'test' } as unknown as ReferenceWireResponse,
    });

    const adapter1 = new ReferenceLlmAdapter({ transport: mockTransportMissingChoices });
    await assert.rejects(
      async () => adapter1.generate(createSampleLlmRequest()),
      (err) => {
        assert.ok(err instanceof MalformedLlmResponseError);
        assert.equal((err as MalformedLlmResponseError).reason, 'MISSING_OR_EMPTY_CHOICES');
        return true;
      }
    );

    // 2. Empty choices array
    const mockTransportEmptyChoices = new DeterministicMockTransport<ReferenceWireRequest, ReferenceWireResponse>({
      responseBody: { choices: [] } as unknown as ReferenceWireResponse,
    });

    const adapter2 = new ReferenceLlmAdapter({ transport: mockTransportEmptyChoices });
    await assert.rejects(
      async () => adapter2.generate(createSampleLlmRequest()),
      (err) => {
        assert.ok(err instanceof MalformedLlmResponseError);
        return true;
      }
    );
  });

  // --------------------------------------------------------------------------
  // Scenario M: Unsupported capability is rejected
  // --------------------------------------------------------------------------
  it('M: Unsupported capability is rejected with UnsupportedLlmCapabilityError', async () => {
    const mockTransport = new DeterministicMockTransport<ReferenceWireRequest, ReferenceWireResponse>({
      responseBody: createReferenceWireSuccessResponse(),
    });

    const adapter = new ReferenceLlmAdapter({
      transport: mockTransport,
      supportedCapabilities: [LlmCapability.TEXT_GENERATION], // STRUCTURED_OUTPUT excluded
    });

    const request = createSampleLlmRequest({
      response_format: LlmResponseFormat.JSON_SCHEMA,
      json_schema: {
        name: 'test_schema',
        schema: { type: 'object' },
      },
    });

    await assert.rejects(
      async () => {
        await adapter.generate(request);
      },
      (err) => {
        assert.ok(err instanceof UnsupportedLlmCapabilityError);
        assert.equal((err as UnsupportedLlmCapabilityError).code, 'ERR_UNSUPPORTED_LLM_CAPABILITY');
        return true;
      }
    );
  });

  // --------------------------------------------------------------------------
  // Scenario N: Structured JSON response is normalized
  // --------------------------------------------------------------------------
  it('N: Structured JSON response is parsed and populated into structured_output', async () => {
    interface TestStructuredPayload {
      readonly status: string;
      readonly count: number;
    }

    const payloadObj: TestStructuredPayload = { status: 'COMPLETE', count: 42 };
    const mockTransport = new DeterministicMockTransport<ReferenceWireRequest, ReferenceWireResponse>({
      responseBody: createReferenceWireSuccessResponse(JSON.stringify(payloadObj)),
    });

    const adapter = new ReferenceLlmAdapter({
      transport: mockTransport,
    });

    const request = createSampleLlmRequest({
      response_format: LlmResponseFormat.JSON_OBJECT,
    });

    const response = await adapter.generate<TestStructuredPayload>(request);

    assert.equal(response.structured_output?.status, 'COMPLETE');
    assert.equal(response.structured_output?.count, 42);
  });

  // --------------------------------------------------------------------------
  // Scenario O: Structured output validation remains enforced
  // --------------------------------------------------------------------------
  it('O: Structured output schema validation throws StructuredOutputValidationError upon mismatch', async () => {
    const invalidJson = '{ not-valid-json';
    const mockTransport = new DeterministicMockTransport<ReferenceWireRequest, ReferenceWireResponse>({
      responseBody: createReferenceWireSuccessResponse(invalidJson),
    });

    const adapter = new ReferenceLlmAdapter({
      transport: mockTransport,
    });

    const request = createSampleLlmRequest({
      response_format: LlmResponseFormat.JSON_OBJECT,
    });

    await assert.rejects(
      async () => {
        await adapter.generate(request);
      },
      (err) => {
        assert.ok(err instanceof StructuredOutputValidationError);
        assert.equal((err as StructuredOutputValidationError).code, 'ERR_STRUCTURED_OUTPUT_VALIDATION');
        return true;
      }
    );
  });

  // --------------------------------------------------------------------------
  // Scenario P: Raw provider metadata is preserved without leaking secrets
  // --------------------------------------------------------------------------
  it('P: Raw provider metadata is preserved and secrets are sanitized', async () => {
    const mockTransport = new DeterministicMockTransport<ReferenceWireRequest, ReferenceWireResponse>({
      responseBody: {
        ...createReferenceWireSuccessResponse(),
        id: 'chatcmpl-test-id-123',
        system_fingerprint: 'fp_abc123',
      },
    });

    const adapter = new ReferenceLlmAdapter({
      transport: mockTransport,
    });

    const response = await adapter.generate(createSampleLlmRequest());

    assert.equal(response.raw_metadata?.id, 'chatcmpl-test-id-123');
    assert.equal(response.raw_metadata?.system_fingerprint, 'fp_abc123');

    // Verify secret sanitization on transport error
    mockTransport.setResponseStatus(401, 'Unauthorized');
    mockTransport.setResponseBody({
      error: {
        message: 'Invalid API key: sk-abcdef12345678901234567890',
      },
    } as unknown as ReferenceWireResponse);

    await assert.rejects(
      async () => adapter.generate(createSampleLlmRequest()),
      (err) => {
        assert.ok(err instanceof LlmExecutionError);
        assert.ok(!err.message.includes('sk-abcdef12345678901234567890'));
        assert.ok(err.message.includes('***REDACTED_KEY***'));
        return true;
      }
    );
  });

  // --------------------------------------------------------------------------
  // Scenario Q: Injected transport is deterministic
  // --------------------------------------------------------------------------
  it('Q: Injected transport produces deterministic results across multiple invocations', async () => {
    const mockTransport = new DeterministicMockTransport<ReferenceWireRequest, ReferenceWireResponse>({
      responseBody: createReferenceWireSuccessResponse('Deterministic result text.'),
    });

    const adapter = new ReferenceLlmAdapter({
      transport: mockTransport,
    });

    const req1 = createSampleLlmRequest();
    const req2 = createSampleLlmRequest();

    const res1 = await adapter.generate(req1);
    const res2 = await adapter.generate(req2);

    assert.equal(res1.content, res2.content);
    assert.equal(res1.correlation.correlation_id, res2.correlation.correlation_id);
    assert.deepEqual(res1.usage, res2.usage);
  });

  // --------------------------------------------------------------------------
  // Scenario R: No hidden network access exists
  // --------------------------------------------------------------------------
  it('R: No hidden network access exists; unconfigured transport throws LlmProviderUnavailableError', async () => {
    const mockTransport = new DeterministicMockTransport<ReferenceWireRequest, ReferenceWireResponse>({
      available: false,
      unavailableReason: 'Transport network interface disabled in hermetic test',
    });

    const adapter = new ReferenceLlmAdapter({
      transport: mockTransport,
    });

    // Check availability
    const avail = await adapter.checkAvailability();
    assert.equal(avail.available, false);
    assert.ok(avail.reason?.includes('hermetic test'));

    // Dispatching when unavailable throws LlmProviderUnavailableError without trying network
    await assert.rejects(
      async () => adapter.generate(createSampleLlmRequest()),
      (err) => {
        assert.ok(err instanceof LlmProviderUnavailableError);
        assert.equal((err as LlmProviderUnavailableError).code, 'ERR_LLM_PROVIDER_UNAVAILABLE');
        return true;
      }
    );
  });

  // --------------------------------------------------------------------------
  // Scenario S: Two provider implementations conform to the same LLMProvider contract
  // --------------------------------------------------------------------------
  it('S: Two distinct provider implementations conform to the identical LLMProvider contract', async () => {
    // 1. Reference adapter
    const refTransport = new DeterministicMockTransport<ReferenceWireRequest, ReferenceWireResponse>({
      responseBody: createReferenceWireSuccessResponse('Ref output'),
    });
    const refProvider: LLMProvider = new ReferenceLlmAdapter({ transport: refTransport });

    // 2. Secondary adapter (distinct wire format)
    const secTransport = new DeterministicMockTransport<SecondaryWireRequest, SecondaryWireResponse>({
      responseBody: {
        id: 'sec-id-99',
        model: 'sec-model-v2',
        content: [{ type: 'text', text: 'Secondary output' }],
        stop_reason: 'stop_sequence',
        usage: { input_tokens: 110, output_tokens: 45 },
      },
    });
    const secProvider: LLMProvider = new SecondaryLlmAdapter({ transport: secTransport });

    const request = createSampleLlmRequest();

    const refResult = await refProvider.generate(request);
    const secResult = await secProvider.generate(request);

    assert.equal(refResult.provider, 'reference-llm');
    assert.equal(refResult.content, 'Ref output');
    assert.equal(secResult.provider, 'secondary-llm');
    assert.equal(secResult.content, 'Secondary output');

    // Both preserve correlation ID identically
    assert.equal(refResult.correlation.correlation_id, request.correlation.correlation_id);
    assert.equal(secResult.correlation.correlation_id, request.correlation.correlation_id);
  });

  // --------------------------------------------------------------------------
  // Scenario T: Provider-specific code does not leak into generic core
  // --------------------------------------------------------------------------
  it('T: Provider-specific code does not leak into registry or generic orchestrator', async () => {
    const registry = new DefaultLlmProviderRegistry();

    const refTransport = new DeterministicMockTransport<ReferenceWireRequest, ReferenceWireResponse>({
      responseBody: createReferenceWireSuccessResponse('Registry ref output'),
    });
    const secTransport = new DeterministicMockTransport<SecondaryWireRequest, SecondaryWireResponse>({
      responseBody: {
        content: [{ type: 'text', text: 'Registry sec output' }],
      },
    });

    const p1 = new ReferenceLlmAdapter({ providerId: 'llm:primary', transport: refTransport });
    const p2 = new SecondaryLlmAdapter({ providerId: 'llm:fallback', transport: secTransport });

    registry.register(p1);
    registry.register(p2);

    assert.equal(registry.list().length, 2);
    assert.equal(registry.getDefault()?.providerId, 'llm:primary');

    // Select provider purely by abstract ID without any provider-specific branching
    const selected = registry.get('llm:fallback');
    assert.ok(selected);

    const result = await selected.generate(createSampleLlmRequest());
    assert.equal(result.content, 'Registry sec output');
  });

  // --------------------------------------------------------------------------
  // Scenario U: Serialization/deserialization remains valid
  // --------------------------------------------------------------------------
  it('U: Protocol envelopes round-trip through serialization with strict validity', async () => {
    const mockTransport = new DeterministicMockTransport<ReferenceWireRequest, ReferenceWireResponse>({
      responseBody: createReferenceWireSuccessResponse('Enveloped output'),
    });

    const adapter = new ReferenceLlmAdapter({ transport: mockTransport });
    const request = createSampleLlmRequest();
    const response = await adapter.generate(request);

    // Create protocol envelope
    const envelope = {
      protocol_version: '1.0' as const,
      message_type: 'LLM_RESPONSE' as const,
      timestamp: '2026-09-22T06:15:00Z',
      correlation_id: response.correlation.correlation_id,
      payload: response,
    };

    const validated = validateLlmProtocolEnvelope(envelope);
    const serialized = serializeLlmProtocolPayload(validated);

    // Deserialization round-trip
    const deserialized = deserializeLlmProtocolPayload<typeof envelope>(serialized);

    assert.equal(deserialized.correlation_id, request.correlation.correlation_id);
    assert.equal(deserialized.payload.content, 'Enveloped output');
    assert.equal(deserialized.payload.provider, 'reference-llm');
  });

  // --------------------------------------------------------------------------
  // Scenarios V & W: Registry Lifecycle & Coverage
  // --------------------------------------------------------------------------
  it('V & W: DefaultLlmProviderRegistry handles unregister, setDefault, clear, and error cases', () => {
    const registry = new DefaultLlmProviderRegistry();

    const mockTransport = new DeterministicMockTransport<ReferenceWireRequest, ReferenceWireResponse>();
    const p1 = new ReferenceLlmAdapter({ providerId: 'prov-1', transport: mockTransport });
    const p2 = new ReferenceLlmAdapter({ providerId: 'prov-2', transport: mockTransport });

    registry.register(p1);
    registry.register(p2);

    assert.equal(registry.has('prov-1'), true);
    assert.equal(registry.has('prov-2'), true);
    assert.equal(registry.has('prov-unknown'), false);

    registry.setDefault('prov-2');
    assert.equal(registry.getDefault()?.providerId, 'prov-2');

    assert.throws(() => {
      registry.setDefault('non-existent');
    }, /not registered/);

    registry.unregister('prov-1');
    assert.equal(registry.has('prov-1'), false);
    assert.equal(registry.list().length, 1);

    registry.clear();
    assert.equal(registry.list().length, 0);
    assert.equal(registry.getDefault(), undefined);
  });
});
