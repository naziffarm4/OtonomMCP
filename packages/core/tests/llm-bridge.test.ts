import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  // LLM Bridge Contracts & Types
  type LlmRequest,
  type LlmRequestInput,
  type LlmResponse,
  type RawLlmResponse,
  type LLMProvider,
  LlmRole,
  LlmFinishReason,
  LlmResponseFormat,
  LlmCapability,
  BaseLlmAdapter,
  MockLlmAdapter,
  validateLlmRequest,
  validateStructuredOutput,
  validateLlmProtocolEnvelope,
  serializeLlmProtocolPayload,
  deserializeLlmProtocolPayload,
  generateDeterministicLlmCorrelationId,

  // Token Telemetry
  type TokenTelemetry,

  // Error Classes
  AidmError,
  InvalidLlmRequestError,
  InvalidProtocolPayloadError,
  LlmProviderUnavailableError,
  LlmExecutionError,
  LlmTimeoutError,
  MalformedLlmResponseError,
  StructuredOutputValidationError,
  UnsupportedLlmCapabilityError,
} from '../dist/index.js';

describe('LLM Provider Bridge & Typed Protocol Subsystem (TASK-P3-02)', () => {
  const baseValidRequestInput: LlmRequestInput = {
    project_id: 'PROJECT-AIDM-P3',
    task_id: 'TASK-P3-02',
    objective: 'Review evidence and decide whether task implementation satisfies acceptance criteria.',
    acceptance_criteria: ['AC-1: Decision must be ACCEPT or REJECT', 'AC-2: Provide root cause on rejection'],
    attempt: 1,
    max_attempts: 3,
    system_prompt: 'You are the AIDM Project Director acting as technical architecture and QA authority.',
    user_prompt: 'Review the provided test logs and output a structured review decision.',
    model: 'director-gpt-4o',
    temperature: 0.2,
    max_tokens: 1000,
    response_format: LlmResponseFormat.TEXT,
  };

  // ==========================================================================
  // SCENARIO A: Valid LLM Request
  // ==========================================================================
  it('A: Valid LLM request is accepted, normalized, and frozen', () => {
    const request = validateLlmRequest(baseValidRequestInput);

    assert.equal(request.correlation.project_id, 'PROJECT-AIDM-P3');
    assert.equal(request.correlation.task_id, 'TASK-P3-02');
    assert.equal(request.correlation.attempt, 1);
    assert.equal(
      request.correlation.correlation_id,
      'corr:llm:PROJECT-AIDM-P3:TASK-P3-02:director:1'
    );
    assert.equal(request.messages.length, 2);
    assert.equal(request.messages[0].role, LlmRole.SYSTEM);
    assert.equal(request.messages[1].role, LlmRole.USER);
    assert.equal(request.director_context.objective, 'Review evidence and decide whether task implementation satisfies acceptance criteria.');
    assert.equal(request.temperature, 0.2);
    assert.equal(request.max_tokens, 1000);
    assert.equal(request.response_format, LlmResponseFormat.TEXT);
    assert.ok(Object.isFrozen(request));
    assert.ok(Object.isFrozen(request.messages));
  });

  // ==========================================================================
  // SCENARIO B: Invalid Request Rejection
  // ==========================================================================
  it('B: Invalid request (non-object or empty messages) is rejected deterministically', () => {
    assert.throws(
      () => validateLlmRequest(null),
      (err: unknown) => {
        assert.ok(err instanceof InvalidLlmRequestError);
        assert.equal(err.code, 'ERR_INVALID_LLM_REQUEST');
        assert.equal(err.reason, 'NON_OBJECT_INPUT');
        return true;
      }
    );

    assert.throws(
      () => validateLlmRequest({ project_id: 'PROJ-1', messages: [] }),
      (err: unknown) => {
        assert.ok(err instanceof InvalidLlmRequestError);
        assert.equal(err.reason, 'EMPTY_MESSAGES');
        return true;
      }
    );
  });

  // ==========================================================================
  // SCENARIO C: Missing Correlation / Project ID Rejection
  // ==========================================================================
  it('C: Missing project_id is rejected with structured field error', () => {
    assert.throws(
      () => validateLlmRequest({ ...baseValidRequestInput, project_id: '' }),
      (err: unknown) => {
        assert.ok(err instanceof InvalidLlmRequestError);
        assert.equal(err.field, 'project_id');
        assert.equal(err.reason, 'MISSING_PROJECT_ID');
        return true;
      }
    );
  });

  // ==========================================================================
  // SCENARIO D: Missing Required Task/Project Context where required
  // ==========================================================================
  it('D: Malformed message item or invalid temperature is rejected', () => {
    assert.throws(
      () =>
        validateLlmRequest({
          ...baseValidRequestInput,
          temperature: 3.5, // > 2
        }),
      (err: unknown) => {
        assert.ok(err instanceof InvalidLlmRequestError);
        assert.equal(err.field, 'temperature');
        assert.equal(err.reason, 'INVALID_TEMPERATURE');
        return true;
      }
    );

    assert.throws(
      () =>
        validateLlmRequest({
          ...baseValidRequestInput,
          messages: [{ role: 'invalid-role' as any, content: 'test' }],
        }),
      (err: unknown) => {
        assert.ok(err instanceof InvalidLlmRequestError);
        assert.equal(err.field, 'messages[0].role');
        assert.equal(err.reason, 'INVALID_MESSAGE_ROLE');
        return true;
      }
    );
  });

  // ==========================================================================
  // SCENARIO E: Provider-Agnostic Interface Behavior
  // ==========================================================================
  it('E: Provider-agnostic interface decouples core from concrete provider implementations', async () => {
    class DummyProvider implements LLMProvider {
      readonly providerId = 'llm:dummy';
      readonly providerName = 'dummy';
      readonly defaultModel = 'dummy-v1';
      readonly supportedModels = ['dummy-v1'];
      readonly supportedCapabilities = [LlmCapability.TEXT_GENERATION];

      async checkAvailability() {
        return { available: true, model: 'dummy-v1', reason: null };
      }

      async generate<T>(request: LlmRequest): Promise<LlmResponse<T>> {
        const validated = validateLlmRequest(request);
        return {
          correlation: validated.correlation,
          provider: this.providerName,
          model: this.defaultModel,
          content: 'Dummy provider response',
          structured_output: null,
          finish_reason: LlmFinishReason.STOP,
          usage: {
            reported_input_tokens: 10,
            reported_output_tokens: 5,
            reported_cached_tokens: null,
            estimated_tokens: 15,
            estimated_cost_usd: null,
            provider_name: this.providerName,
            model: this.defaultModel,
            is_exact_provider_metric: true,
          },
          raw_metadata: null,
          error: null,
        };
      }
    }

    const provider: LLMProvider = new DummyProvider();
    const req = validateLlmRequest(baseValidRequestInput);
    const res = await provider.generate(req);

    assert.equal(res.provider, 'dummy');
    assert.equal(res.content, 'Dummy provider response');
    assert.equal(res.finish_reason, LlmFinishReason.STOP);
  });

  // ==========================================================================
  // SCENARIO F: Provider Adapter Translation
  // ==========================================================================
  it('F: Provider adapter translates generic LlmRequest into provider wire format', () => {
    const adapter = new MockLlmAdapter();
    const request = validateLlmRequest({
      ...baseValidRequestInput,
      model: 'mock-gpt-4o',
      temperature: 0.1,
      max_tokens: 500,
    });

    const translated = adapter.translateRequest(request);
    assert.equal(translated.provider, 'mock');
    assert.equal(translated.model, 'mock-gpt-4o');
    assert.equal(translated.temperature, 0.1);
    assert.equal(translated.max_tokens, 500);
    assert.equal(translated.correlation_id, request.correlation.correlation_id);
    assert.equal(translated.messages.length, 2);
    assert.equal(translated.messages[0].role, 'system');
  });

  // ==========================================================================
  // SCENARIO G: Deterministic Request Normalization
  // ==========================================================================
  it('G: Repeated request normalization produces identical deep-equal representations', () => {
    const req1 = validateLlmRequest(baseValidRequestInput);
    const req2 = validateLlmRequest(baseValidRequestInput);

    assert.deepEqual(req1, req2);
    assert.equal(req1.correlation.correlation_id, req2.correlation.correlation_id);
  });

  // ==========================================================================
  // SCENARIO H: Deterministic Correlation Preservation
  // ==========================================================================
  it('H: Custom correlation_id is strictly preserved across request, translation, and response', async () => {
    const customCorrelation = 'corr:custom:director:step-42';
    const adapter = new MockLlmAdapter({
      transport: async (_translated, rawReq) => ({
        provider: 'mock',
        content: 'Acknowledged',
      }),
    });

    const request = validateLlmRequest({
      ...baseValidRequestInput,
      correlation_id: customCorrelation,
    });

    const response = await adapter.generate(request);
    assert.equal(response.correlation.correlation_id, customCorrelation);
    assert.equal(response.correlation.project_id, 'PROJECT-AIDM-P3');
    assert.equal(response.correlation.task_id, 'TASK-P3-02');
  });

  // ==========================================================================
  // SCENARIO I: Successful Normalized Response
  // ==========================================================================
  it('I: Successful response is properly normalized with usage and finish reason', async () => {
    const adapter = new MockLlmAdapter({
      transport: async () => ({
        provider: 'mock',
        model: 'mock-gpt-4o',
        content: 'Director review: Task accepted.',
        finish_reason: 'stop',
        usage: {
          reported_input_tokens: 120,
          reported_output_tokens: 30,
          reported_cached_tokens: 50,
          is_exact_provider_metric: true,
        },
        raw_metadata: { latency_ms: 240 },
      }),
    });

    const request = validateLlmRequest(baseValidRequestInput);
    const response = await adapter.generate(request);

    assert.equal(response.content, 'Director review: Task accepted.');
    assert.equal(response.finish_reason, LlmFinishReason.STOP);
    assert.equal(response.usage.reported_input_tokens, 120);
    assert.equal(response.usage.reported_output_tokens, 30);
    assert.equal(response.usage.reported_cached_tokens, 50);
    assert.equal(response.usage.is_exact_provider_metric, true);
    assert.deepEqual(response.raw_metadata, { latency_ms: 240 });
    assert.equal(response.error, null);
  });

  // ==========================================================================
  // SCENARIO J: Provider Failure Normalization
  // ==========================================================================
  it('J: Provider transport failure is wrapped in structured LlmExecutionError', async () => {
    const adapter = new MockLlmAdapter({
      transport: async () => {
        throw new Error('500 Internal Server Error from upstream gateway');
      },
    });

    const request = validateLlmRequest(baseValidRequestInput);

    await assert.rejects(
      async () => adapter.generate(request),
      (err: unknown) => {
        assert.ok(err instanceof LlmExecutionError);
        assert.equal(err.code, 'ERR_LLM_EXECUTION_FAILURE');
        assert.ok(err.message.includes('500 Internal Server Error'));
        assert.equal(err.providerId, 'llm:mock-director');
        return true;
      }
    );
  });

  // ==========================================================================
  // SCENARIO K: Provider Unavailable
  // ==========================================================================
  it('K: Unconfigured provider reports available: false and rejects generate with LlmProviderUnavailableError', async () => {
    // Provider requiring an API key when none was provided
    const unconfiguredAdapter = new BaseLlmAdapter({
      providerId: 'llm:openai-live',
      providerName: 'openai',
      apiKey: null,
    });

    const availability = await unconfiguredAdapter.checkAvailability();
    assert.equal(availability.available, false);
    assert.ok(availability.reason?.includes('API key'));

    const request = validateLlmRequest(baseValidRequestInput);

    await assert.rejects(
      async () => unconfiguredAdapter.generate(request),
      (err: unknown) => {
        assert.ok(err instanceof LlmProviderUnavailableError);
        assert.equal(err.code, 'ERR_LLM_PROVIDER_UNAVAILABLE');
        assert.equal(err.providerId, 'llm:openai-live');
        return true;
      }
    );
  });

  // ==========================================================================
  // SCENARIO L: Timeout Handling
  // ==========================================================================
  it('L: Slow provider execution triggers LlmTimeoutError within specified timeout_ms', async () => {
    const adapter = new MockLlmAdapter({
      transport: async () => {
        // Sleep for 100ms
        await new Promise((resolve) => setTimeout(resolve, 100));
        return { provider: 'mock', content: 'Too late' };
      },
    });

    const request = validateLlmRequest({
      ...baseValidRequestInput,
      timeout_ms: 20, // 20ms timeout
    });

    await assert.rejects(
      async () => adapter.generate(request),
      (err: unknown) => {
        assert.ok(err instanceof LlmTimeoutError);
        assert.equal(err.code, 'ERR_LLM_TIMEOUT');
        assert.equal(err.timeoutMs, 20);
        return true;
      }
    );
  });

  // ==========================================================================
  // SCENARIO M: Malformed Provider Response
  // ==========================================================================
  it('M: Malformed provider response (non-object) throws MalformedLlmResponseError', async () => {
    const adapter = new MockLlmAdapter({
      transport: async () => null as any,
    });

    const request = validateLlmRequest(baseValidRequestInput);

    await assert.rejects(
      async () => adapter.generate(request),
      (err: unknown) => {
        assert.ok(err instanceof MalformedLlmResponseError);
        assert.equal(err.code, 'ERR_MALFORMED_LLM_RESPONSE');
        return true;
      }
    );
  });

  // ==========================================================================
  // SCENARIO N: Structured JSON Response
  // ==========================================================================
  it('N: Structured JSON response is parsed, validated, and returned in structured_output', async () => {
    interface DirectorDecision {
      decision: 'ACCEPT' | 'REJECT';
      confidence: number;
      feedback: string;
    }

    const reviewJson = JSON.stringify({
      decision: 'ACCEPT',
      confidence: 0.98,
      feedback: 'All acceptance criteria AC-1 and AC-2 verified in test output.',
    });

    const adapter = new MockLlmAdapter({
      transport: async () => ({
        provider: 'mock',
        content: reviewJson,
        finish_reason: 'stop',
      }),
    });

    const request = validateLlmRequest({
      ...baseValidRequestInput,
      response_format: LlmResponseFormat.JSON_OBJECT,
    });

    const response = await adapter.generate<DirectorDecision>(request);

    assert.ok(response.structured_output);
    assert.equal(response.structured_output.decision, 'ACCEPT');
    assert.equal(response.structured_output.confidence, 0.98);
    assert.equal(response.structured_output.feedback, 'All acceptance criteria AC-1 and AC-2 verified in test output.');
  });

  // ==========================================================================
  // SCENARIO O: Invalid Structured Response Rejection
  // ==========================================================================
  it('O: Malformed structured JSON or missing required fields throws StructuredOutputValidationError', async () => {
    const schema = {
      name: 'director_review',
      schema: {
        type: 'object',
        required: ['decision', 'feedback'],
      },
    };

    // Case 1: Broken JSON
    assert.throws(
      () => validateStructuredOutput('INVALID_JSON_HERE { missing: quote', schema),
      (err: unknown) => {
        assert.ok(err instanceof StructuredOutputValidationError);
        assert.equal(err.code, 'ERR_STRUCTURED_OUTPUT_VALIDATION');
        assert.equal(err.reason, 'INVALID_JSON');
        return true;
      }
    );

    // Case 2: Missing required schema fields
    const partialJson = JSON.stringify({ decision: 'ACCEPT' }); // missing 'feedback'
    assert.throws(
      () => validateStructuredOutput(partialJson, schema),
      (err: unknown) => {
        assert.ok(err instanceof StructuredOutputValidationError);
        assert.equal(err.reason, 'MISSING_REQUIRED_FIELDS');
        assert.deepEqual(err.missingFields, ['feedback']);
        return true;
      }
    );
  });

  // ==========================================================================
  // SCENARIO P: Usage Telemetry Preservation
  // ==========================================================================
  it('P: Provider-reported exact usage metrics are strictly preserved', async () => {
    const adapter = new MockLlmAdapter({
      transport: async () => ({
        provider: 'mock',
        content: 'Result',
        usage: {
          reported_input_tokens: 450,
          reported_output_tokens: 85,
          reported_cached_tokens: 128,
          is_exact_provider_metric: true,
          estimated_cost_usd: 0.0012,
        },
      }),
    });

    const request = validateLlmRequest(baseValidRequestInput);
    const response = await adapter.generate(request);

    assert.equal(response.usage.reported_input_tokens, 450);
    assert.equal(response.usage.reported_output_tokens, 85);
    assert.equal(response.usage.reported_cached_tokens, 128);
    assert.equal(response.usage.estimated_cost_usd, 0.0012);
    assert.equal(response.usage.is_exact_provider_metric, true);
  });

  // ==========================================================================
  // SCENARIO Q & R: Unavailable Usage Remains Null / Explicitly Estimated (No Fabrication)
  // ==========================================================================
  it('Q & R: When provider usage is unavailable, reported tokens remain null and are never fabricated', async () => {
    const adapter = new MockLlmAdapter({
      transport: async () => ({
        provider: 'mock',
        content: 'Sixteen bytes !!', // ~4 tokens
        // usage completely omitted
      }),
    });

    const request = validateLlmRequest(baseValidRequestInput);
    const response = await adapter.generate(request);

    // Crucial: Must NOT fabricate exact numbers
    assert.equal(response.usage.reported_input_tokens, null);
    assert.equal(response.usage.reported_output_tokens, null);
    assert.equal(response.usage.reported_cached_tokens, null);
    assert.equal(response.usage.is_exact_provider_metric, false);
    assert.ok(response.usage.estimated_tokens > 0);
  });

  // ==========================================================================
  // SCENARIO S: Provider and Model Identity Preservation
  // ==========================================================================
  it('S: Provider identity and model identity are strictly preserved in response', async () => {
    const adapter = new BaseLlmAdapter({
      providerId: 'llm:anthropic-claude',
      providerName: 'anthropic',
      defaultModel: 'claude-3-7-sonnet',
      transport: async (translated) => ({
        provider: 'anthropic',
        model: translated.model,
        content: 'Claude response',
      }),
    });

    const request = validateLlmRequest({
      ...baseValidRequestInput,
      model: 'claude-3-7-sonnet',
    });

    const response = await adapter.generate(request);
    assert.equal(response.provider, 'anthropic');
    assert.equal(response.model, 'claude-3-7-sonnet');
  });

  // ==========================================================================
  // SCENARIO T: Raw Provider Metadata Preservation
  // ==========================================================================
  it('T: Raw provider metadata (e.g. system fingerprints, request IDs) is preserved', async () => {
    const adapter = new MockLlmAdapter({
      transport: async () => ({
        provider: 'mock',
        content: 'Response with metadata',
        raw_metadata: {
          system_fingerprint: 'fp_abc123',
          request_id: 'req-xyz-987',
        },
      }),
    });

    const request = validateLlmRequest(baseValidRequestInput);
    const response = await adapter.generate(request);

    assert.ok(response.raw_metadata);
    assert.equal(response.raw_metadata.system_fingerprint, 'fp_abc123');
    assert.equal(response.raw_metadata.request_id, 'req-xyz-987');
  });

  // ==========================================================================
  // SCENARIO U: Unsupported Capability Rejection
  // ==========================================================================
  it('U: Requesting an unsupported capability (e.g. JSON_SCHEMA on restricted adapter) throws UnsupportedLlmCapabilityError', async () => {
    // Adapter supporting only TEXT_GENERATION, lacking STRUCTURED_OUTPUT
    const textOnlyAdapter = new BaseLlmAdapter({
      providerId: 'llm:text-only',
      supportedCapabilities: [LlmCapability.TEXT_GENERATION],
      transport: async () => ({ provider: 'text-only', content: 'Text' }),
    });

    const schemaRequest = validateLlmRequest({
      ...baseValidRequestInput,
      response_format: LlmResponseFormat.JSON_SCHEMA,
      json_schema: {
        name: 'review',
        schema: { type: 'object' },
      },
    });

    await assert.rejects(
      async () => textOnlyAdapter.generate(schemaRequest),
      (err: unknown) => {
        assert.ok(err instanceof UnsupportedLlmCapabilityError);
        assert.equal(err.code, 'ERR_UNSUPPORTED_LLM_CAPABILITY');
        assert.equal(err.capability, LlmCapability.STRUCTURED_OUTPUT);
        return true;
      }
    );
  });

  // ==========================================================================
  // SCENARIO V: Secret Non-Leakage
  // ==========================================================================
  it('V: Sensitive API keys and tokens are never leaked in error messages or details', () => {
    const secretApiKey = 'sk-live-1234567890abcdefghijklmnopqrstuvwxyz';
    const err = new LlmExecutionError(`Failed using apiKey=${secretApiKey} with Bearer ${secretApiKey}`, {
      apiKey: secretApiKey,
      endpoint: `https://api.openai.com?key=${secretApiKey}`,
    });

    const json = err.toJSON();
    assert.equal(json.message.includes(secretApiKey), false);
    assert.ok(json.message.includes('***REDACTED***'));
    assert.equal(JSON.stringify(json.details).includes(secretApiKey), false);
  });

  // ==========================================================================
  // SCENARIO W: Multiple-Provider Compatibility Through Same Interface
  // ==========================================================================
  it('W: Multiple distinct provider adapters adhere to the identical LLMProvider interface', async () => {
    const providerA: LLMProvider = new MockLlmAdapter({
      providerId: 'provider:openai-mock',
      providerName: 'openai',
      defaultModel: 'gpt-4o',
      transport: async () => ({ provider: 'openai', content: 'OpenAI output' }),
    });

    const providerB: LLMProvider = new MockLlmAdapter({
      providerId: 'provider:anthropic-mock',
      providerName: 'anthropic',
      defaultModel: 'claude-3-5-sonnet',
      transport: async () => ({ provider: 'anthropic', content: 'Anthropic output' }),
    });

    const req = validateLlmRequest(baseValidRequestInput);

    const resA = await providerA.generate(req);
    const resB = await providerB.generate(req);

    assert.equal(resA.provider, 'openai');
    assert.equal(resA.content, 'OpenAI output');

    assert.equal(resB.provider, 'anthropic');
    assert.equal(resB.content, 'Anthropic output');
  });

  // ==========================================================================
  // SCENARIO X: Protocol Serialization / Deserialization
  // ==========================================================================
  it('X: Typed protocol request and response envelopes serialize and deserialize cleanly', () => {
    const request = validateLlmRequest(baseValidRequestInput);
    const envelope = {
      protocol_version: '1.0' as const,
      message_type: 'LLM_REQUEST' as const,
      timestamp: '2026-09-22T06:00:00Z',
      correlation_id: request.correlation.correlation_id,
      payload: request,
    };

    const validated = validateLlmProtocolEnvelope(envelope);
    assert.equal(validated.message_type, 'LLM_REQUEST');

    const json = serializeLlmProtocolPayload(validated);
    const parsed = deserializeLlmProtocolPayload<typeof envelope>(json);
    assert.deepEqual(parsed, envelope);
  });

  // ==========================================================================
  // SCENARIO Y: Invalid Protocol Payload Rejection
  // ==========================================================================
  it('Y: Malformed protocol payloads are rejected with InvalidProtocolPayloadError', () => {
    // Missing correlation_id
    assert.throws(
      () =>
        validateLlmProtocolEnvelope({
          protocol_version: '1.0',
          message_type: 'LLM_REQUEST',
          timestamp: '2026-09-22T06:00:00Z',
          correlation_id: '',
          payload: {},
        }),
      (err: unknown) => {
        assert.ok(err instanceof InvalidProtocolPayloadError);
        assert.equal(err.code, 'ERR_INVALID_PROTOCOL_PAYLOAD');
        assert.equal(err.reason, 'MISSING_CORRELATION_ID');
        return true;
      }
    );

    // Unsupported protocol version
    assert.throws(
      () =>
        validateLlmProtocolEnvelope({
          protocol_version: '99.0',
          message_type: 'LLM_REQUEST',
          timestamp: '2026-09-22T06:00:00Z',
          correlation_id: 'corr:1',
          payload: {},
        }),
      (err: unknown) => {
        assert.ok(err instanceof InvalidProtocolPayloadError);
        assert.equal(err.reason, 'UNSUPPORTED_PROTOCOL_VERSION');
        return true;
      }
    );
  });

  // ==========================================================================
  // SUITE: Error Hierarchy & Code Distinction
  // ==========================================================================
  describe('Structured Error Hierarchy & Serialization', () => {
    it('should have mutually distinct error codes across all LLM error classes', () => {
      const codes = new Set([
        new InvalidLlmRequestError('test').code,
        new InvalidProtocolPayloadError('test').code,
        new LlmProviderUnavailableError('test').code,
        new LlmExecutionError('test').code,
        new LlmTimeoutError('test').code,
        new MalformedLlmResponseError('test').code,
        new StructuredOutputValidationError('test').code,
        new UnsupportedLlmCapabilityError('test').code,
      ]);

      assert.equal(codes.size, 8);
      assert.ok(codes.has('ERR_INVALID_LLM_REQUEST'));
      assert.ok(codes.has('ERR_INVALID_PROTOCOL_PAYLOAD'));
      assert.ok(codes.has('ERR_LLM_PROVIDER_UNAVAILABLE'));
      assert.ok(codes.has('ERR_LLM_EXECUTION_FAILURE'));
      assert.ok(codes.has('ERR_LLM_TIMEOUT'));
      assert.ok(codes.has('ERR_MALFORMED_LLM_RESPONSE'));
      assert.ok(codes.has('ERR_STRUCTURED_OUTPUT_VALIDATION'));
      assert.ok(codes.has('ERR_UNSUPPORTED_LLM_CAPABILITY'));
    });
  });
});
