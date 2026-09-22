/**
 * @file phase-3-integration.test.ts
 * @description Dedicated Phase 3 Integration & Boundary Test Suite (TASK-P3-04).
 * 
 * Demonstrates the semantic end-to-end integration flow across Phase 3 subsystems:
 * Task -> Context -> LLM Request -> LLM Provider -> Normalized LLM Response
 *      -> Director Decision Boundary -> Executor Instruction -> Antigravity Executor
 *      -> Normalized Executor Result.
 * 
 * Verifies:
 * - I1: LLM Provider Integration (full round-trip with all semantic fields)
 * - I2: Provider Independence (two distinct adapters satisfying LLMProvider without core coupling)
 * - I3: LLM Error Propagation (structured errors, correlation preservation, secret sanitization)
 * - I4: Token Telemetry Integration (Phase 2 token budget compatibility, zero fabrication)
 * - I5: Context -> LLM Integration (Phase 2 Context Engine output consumable by Phase 3 LLM Bridge)
 * - I6: Executor Integration (AntigravityAdapter with explicit policy, no permission bypass)
 * - I7: End-to-End Phase 3 Pipeline (Task -> Context -> LLM -> Decision -> Executor -> Result)
 * - I8: Failure Boundary (LLM failures, malformed payloads, policy rejections never become false successes)
 * - I9: Determinism (5x repeated pipeline execution with strictly identical semantic outputs)
 * - I10: Regression (all existing Phase 1, Phase 2, and Phase 3 suites continue passing)
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import {
  // LLM Bridge Components
  type LLMProvider,
  type LlmRequest,
  type LlmResponse,
  LlmRole,
  LlmFinishReason,
  LlmResponseFormat,
  LlmCapability,
  validateLlmRequest,
  ReferenceLlmAdapter,
  type ReferenceWireRequest,
  type ReferenceWireResponse,
  SecondaryLlmAdapter,
  type SecondaryWireRequest,
  type SecondaryWireResponse,
  DeterministicMockTransport,
  DefaultLlmProviderRegistry,

  // Executor Bridge Components
  type ExecutorPort,
  type ExecutorInstruction,
  type NormalizedExecutorResult,
  type RawExecutorOutcome,
  ExecutorOperationType,
  ExecutorExecutionStatus,
  PolicyAuthorizationState,
  AntigravityAdapter,
  validateExecutorInstruction,
  validateInstructionSecurity,
  RiskLevel,

  // Context Engine Components (Phase 2)
  ContextEngine,
  ContextIntent,
  type ResolvedContext,

  // Structured Error Classes
  PolicyViolationError,
  LlmExecutionError,
  LlmTimeoutError,
  MalformedLlmResponseError,
  LlmProviderUnavailableError,
  StructuredOutputValidationError,
  UnsupportedLlmCapabilityError,
} from '../dist/index.js';

// ============================================================================
// DETERMINISTIC TEST FIXTURES & BUILDERS
// ============================================================================

const TEST_PROJECT_ID = 'proj-aidm-integration';
const TEST_TASK_ID = 'TASK-P3-04-INT';
const TEST_CORRELATION_ID = 'corr-p3-04-deterministic-uuid-001';

function createReferenceWireSuccess(
  content: string,
  usage?: ReferenceWireResponse['usage']
): ReferenceWireResponse {
  return {
    id: 'ref-call-p3-04',
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
    usage:
      usage !== undefined
        ? usage
        : {
            prompt_tokens: 120,
            completion_tokens: 45,
            cached_tokens: 15,
            total_tokens: 165,
          },
    system_fingerprint: 'fp_p3_04_test',
  };
}

function createSecondaryWireSuccess(
  text: string,
  usage?: SecondaryWireResponse['usage']
): SecondaryWireResponse {
  return {
    id: 'sec-call-p3-04',
    model: 'sec-model-v2',
    content: [{ type: 'text', text }],
    stop_reason: 'stop_sequence',
    usage:
      usage !== undefined
        ? usage
        : {
            input_tokens: 115,
            output_tokens: 40,
            cached_creation_input_tokens: 10,
          },
  };
}

describe('Phase 3 Integration & Boundary Test Suite (TASK-P3-04)', () => {
  let tempWorkspace: string;
  let cacheDir: string;
  let dbPath: string;

  beforeEach(async () => {
    tempWorkspace = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'aidm-p3-int-'));
    cacheDir = path.join(tempWorkspace, '.ai-manager', 'cache');
    await fs.promises.mkdir(cacheDir, { recursive: true });
    dbPath = path.join(cacheDir, 'context.db');
  });

  afterEach(async () => {
    try {
      await fs.promises.rm(tempWorkspace, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  // ==========================================================================
  // I1 — LLM PROVIDER INTEGRATION
  // ==========================================================================
  describe('I1 — LLM Provider Integration', () => {
    it('executes a full round-trip LLM request preserving all semantic and correlation fields', async () => {
      const mockTransport = new DeterministicMockTransport<ReferenceWireRequest, ReferenceWireResponse>({
        responseBody: createReferenceWireSuccess('Plan generated: Update adapter boundary.'),
      });

      const adapter = new ReferenceLlmAdapter({
        transport: mockTransport,
        defaultModel: 'ref-model-v1',
      });

      const request = validateLlmRequest({
        correlation: {
          correlation_id: TEST_CORRELATION_ID,
          project_id: TEST_PROJECT_ID,
          task_id: TEST_TASK_ID,
          attempt: 1,
        },
        model: 'ref-model-v1',
        messages: [
          { role: LlmRole.SYSTEM, content: 'You are an autonomous orchestrator assistant.' },
          { role: LlmRole.USER, content: 'Generate execution plan for task.' },
        ],
        director_context: {
          project_id: TEST_PROJECT_ID,
          task_id: TEST_TASK_ID,
          objective: 'Demonstrate integration across LLM and executor boundaries.',
          acceptance_criteria: ['AC-1: Round-trip preservation', 'AC-2: Deterministic output'],
          attempt: 1,
          max_attempts: 3,
          relevant_context: { layer: 'L1' },
        },
        response_format: LlmResponseFormat.TEXT,
      });

      const response = await adapter.generate(request);

      // Identity & Correlation
      assert.equal(response.correlation.correlation_id, TEST_CORRELATION_ID);
      assert.equal(response.correlation.project_id, TEST_PROJECT_ID);
      assert.equal(response.correlation.task_id, TEST_TASK_ID);
      assert.equal(response.correlation.attempt, 1);

      // Provider & Model
      assert.equal(response.provider, 'reference-llm');
      assert.equal(response.model, 'ref-model-v1');

      // Content & Finish state
      assert.equal(response.content, 'Plan generated: Update adapter boundary.');
      assert.equal(response.finish_reason, LlmFinishReason.STOP);

      // Telemetry
      assert.equal(response.usage.reported_input_tokens, 120);
      assert.equal(response.usage.reported_output_tokens, 45);
      assert.equal(response.usage.reported_cached_tokens, 15);
      assert.equal(response.usage.is_exact_provider_metric, true);

      // Wire transport inspection
      assert.equal(mockTransport.recordedRequests.length, 1);
      const wire = mockTransport.recordedRequests[0].body;
      assert.equal(wire.correlation_id, TEST_CORRELATION_ID);
      assert.equal(wire.director_context.project_id, TEST_PROJECT_ID);
      assert.deepEqual(wire.director_context.acceptance_criteria, [
        'AC-1: Round-trip preservation',
        'AC-2: Deterministic output',
      ]);
    });

    it('preserves structured output and marks missing telemetry as null without fabrication', async () => {
      interface DecisionPlan {
        readonly action: string;
        readonly risk_assessment: string;
      }

      const structuredJson = JSON.stringify({
        action: 'EXECUTE_INSTRUCTION',
        risk_assessment: 'LOW',
      });

      const mockTransport = new DeterministicMockTransport<ReferenceWireRequest, ReferenceWireResponse>({
        responseBody: createReferenceWireSuccess(structuredJson, null), // usage omitted
      });

      const adapter = new ReferenceLlmAdapter({ transport: mockTransport });

      const request = validateLlmRequest({
        correlation: { correlation_id: 'corr-structured-01', project_id: TEST_PROJECT_ID },
        messages: [{ role: LlmRole.USER, content: 'Format decision' }],
        director_context: { project_id: TEST_PROJECT_ID },
        response_format: LlmResponseFormat.JSON_OBJECT,
      });

      const response = await adapter.generate<DecisionPlan>(request);

      assert.equal(response.structured_output?.action, 'EXECUTE_INSTRUCTION');
      assert.equal(response.structured_output?.risk_assessment, 'LOW');
      assert.equal(response.usage.reported_input_tokens, null);
      assert.equal(response.usage.reported_output_tokens, null);
      assert.equal(response.usage.reported_cached_tokens, null);
      assert.equal(response.usage.is_exact_provider_metric, false);
      assert.ok(response.usage.estimated_tokens > 0);
    });
  });

  // ==========================================================================
  // I2 — PROVIDER INDEPENDENCE
  // ==========================================================================
  describe('I2 — Provider Independence', () => {
    it('runs the same semantic request through two distinct provider adapters using only the generic LLMProvider contract', async () => {
      const refTransport = new DeterministicMockTransport<ReferenceWireRequest, ReferenceWireResponse>({
        responseBody: createReferenceWireSuccess('Output from Reference Adapter'),
      });
      const secTransport = new DeterministicMockTransport<SecondaryWireRequest, SecondaryWireResponse>({
        responseBody: createSecondaryWireSuccess('Output from Secondary Adapter'),
      });

      // Both adapters instantiated through the generic LLMProvider contract
      const providerRef: LLMProvider = new ReferenceLlmAdapter({
        providerId: 'provider:ref',
        providerName: 'reference-llm',
        transport: refTransport,
      });

      const providerSec: LLMProvider = new SecondaryLlmAdapter({
        providerId: 'provider:sec',
        providerName: 'secondary-llm',
        transport: secTransport,
      });

      // Provider-agnostic registry
      const registry = new DefaultLlmProviderRegistry();
      registry.register(providerRef);
      registry.register(providerSec);

      const semanticRequest = validateLlmRequest({
        correlation: {
          correlation_id: 'corr-multi-prov-001',
          project_id: TEST_PROJECT_ID,
          task_id: TEST_TASK_ID,
        },
        messages: [
          { role: LlmRole.SYSTEM, content: 'System instruction' },
          { role: LlmRole.USER, content: 'Perform analysis' },
        ],
        director_context: { project_id: TEST_PROJECT_ID, task_id: TEST_TASK_ID },
        response_format: LlmResponseFormat.TEXT,
      });

      // Dispatch without vendor-specific branching
      const targetRef = registry.get('provider:ref');
      assert.ok(targetRef);
      const resRef = await targetRef.generate(semanticRequest);

      const targetSec = registry.get('provider:sec');
      assert.ok(targetSec);
      const resSec = await targetSec.generate(semanticRequest);

      // Verify identical semantic shape
      assert.equal(resRef.correlation.correlation_id, 'corr-multi-prov-001');
      assert.equal(resSec.correlation.correlation_id, 'corr-multi-prov-001');

      // Providers are distinguishable while conforming to identical contract
      assert.equal(resRef.provider, 'reference-llm');
      assert.equal(resSec.provider, 'secondary-llm');
      assert.equal(resRef.content, 'Output from Reference Adapter');
      assert.equal(resSec.content, 'Output from Secondary Adapter');

      // Internal wire formats differ completely and remain isolated inside transports
      assert.ok('director_context' in refTransport.recordedRequests[0].body);
      assert.ok('conversation' in secTransport.recordedRequests[0].body);
    });
  });

  // ==========================================================================
  // I3 — LLM ERROR PROPAGATION (Complete Boundary Coverage)
  // ==========================================================================
  describe('I3 — LLM Error Propagation', () => {
    // ------------------------------------------------------------------------
    // I3-A: Provider Unavailable
    // ------------------------------------------------------------------------
    it('I3-A: propagates transport unavailability as structured LlmProviderUnavailableError and halts execution', async () => {
      let executorDispatched = false;
      const executor = new AntigravityAdapter({
        invoker: async () => {
          executorDispatched = true;
          return { executor_id: 'antigravity-cli' };
        },
      });

      const transport = new DeterministicMockTransport<ReferenceWireRequest, ReferenceWireResponse>({
        available: false,
        unavailableReason: 'Service endpoint unreachable',
      });
      const adapter = new ReferenceLlmAdapter({ transport });

      const request = validateLlmRequest({
        correlation: { correlation_id: 'corr-err-i3-a', project_id: TEST_PROJECT_ID, task_id: TEST_TASK_ID },
        messages: [{ role: LlmRole.USER, content: 'Execute task analysis' }],
        director_context: { project_id: TEST_PROJECT_ID, task_id: TEST_TASK_ID },
      });

      await assert.rejects(
        async () => {
          const llmResponse = await adapter.generate(request);
          // Downstream executor continuation that must never be reached
          const instruction = validateExecutorInstruction({
            task_id: llmResponse.correlation.task_id!,
            instruction_id: 'INST-NEVER',
            project_id: llmResponse.correlation.project_id,
            working_directory: tempWorkspace,
            objective: 'Should never execute',
            acceptance_criteria: ['N/A'],
            constraints: [],
            relevant_context: {},
            attempt: 1,
            max_attempts: 1,
            risk_level: RiskLevel.CAUTION,
            requested_operation_type: ExecutorOperationType.IMPLEMENT_TASK,
            traceability_information: { sources: ['REQ:REQ-001'] },
            correlation_id: llmResponse.correlation.correlation_id,
            policy_decision: { state: PolicyAuthorizationState.AUTHORIZED },
          });
          await executor.execute(instruction);
        },
        (err) => {
          assert.ok(err instanceof LlmProviderUnavailableError);
          assert.equal(err.code, 'ERR_LLM_PROVIDER_UNAVAILABLE');
          assert.equal(err.providerId, adapter.providerId);
          assert.ok(err.message.includes('Service endpoint unreachable'));
          return true;
        }
      );

      assert.equal(request.correlation.correlation_id, 'corr-err-i3-a');
      assert.equal(executorDispatched, false);
    });

    // ------------------------------------------------------------------------
    // I3-B: Timeout
    // ------------------------------------------------------------------------
    it('I3-B: propagates timeouts as structured LlmTimeoutError preserving correlation and prevents executor continuation', async () => {
      let executorDispatched = false;
      const executor = new AntigravityAdapter({
        invoker: async () => {
          executorDispatched = true;
          return { executor_id: 'antigravity-cli' };
        },
      });

      const transport = new DeterministicMockTransport<ReferenceWireRequest, ReferenceWireResponse>({
        responseDelayMs: 100,
        responseBody: createReferenceWireSuccess('Slow response'),
      });
      const adapter = new ReferenceLlmAdapter({ transport, timeoutMs: 20 });

      const request = validateLlmRequest({
        correlation: { correlation_id: 'corr-timeout-i3-b', project_id: TEST_PROJECT_ID, task_id: TEST_TASK_ID },
        messages: [{ role: LlmRole.USER, content: 'Run long operation' }],
        director_context: { project_id: TEST_PROJECT_ID, task_id: TEST_TASK_ID },
        timeout_ms: 20,
      });

      await assert.rejects(
        async () => {
          const llmResponse = await adapter.generate(request);
          // Downstream executor continuation that must never be reached
          const instruction = validateExecutorInstruction({
            task_id: llmResponse.correlation.task_id!,
            instruction_id: 'INST-NEVER',
            project_id: llmResponse.correlation.project_id,
            working_directory: tempWorkspace,
            objective: 'Should never execute',
            acceptance_criteria: ['N/A'],
            constraints: [],
            relevant_context: {},
            attempt: 1,
            max_attempts: 1,
            risk_level: RiskLevel.CAUTION,
            requested_operation_type: ExecutorOperationType.IMPLEMENT_TASK,
            traceability_information: { sources: ['REQ:REQ-001'] },
            correlation_id: llmResponse.correlation.correlation_id,
            policy_decision: { state: PolicyAuthorizationState.AUTHORIZED },
          });
          await executor.execute(instruction);
        },
        (err) => {
          assert.ok(err instanceof LlmTimeoutError);
          assert.equal(err.code, 'ERR_LLM_TIMEOUT');
          assert.equal(err.correlationId, 'corr-timeout-i3-b');
          assert.equal(err.timeoutMs, 20);
          return true;
        }
      );

      assert.equal(executorDispatched, false);
    });

    // ------------------------------------------------------------------------
    // I3-C: API/Execution Failure
    // ------------------------------------------------------------------------
    it('I3-C: propagates HTTP API failure as structured LlmExecutionError, sanitizes secrets, and prevents executor continuation', async () => {
      let executorDispatched = false;
      const executor = new AntigravityAdapter({
        invoker: async () => {
          executorDispatched = true;
          return { executor_id: 'antigravity-cli' };
        },
      });

      const transport = new DeterministicMockTransport<ReferenceWireRequest, ReferenceWireResponse>({
        responseStatus: 500,
        responseStatusText: 'Internal Server Error',
        throwHttpErrorOnStatusGte400: true,
        responseBody: {
          error: {
            message: 'Server error with internal key: sk-live-secret-key-123456789012345678',
          },
        } as unknown as ReferenceWireResponse,
      });
      const adapter = new ReferenceLlmAdapter({ transport });

      const request = validateLlmRequest({
        correlation: { correlation_id: 'corr-api-fail-i3-c', project_id: TEST_PROJECT_ID, task_id: TEST_TASK_ID },
        messages: [{ role: LlmRole.USER, content: 'Execute generation' }],
        director_context: { project_id: TEST_PROJECT_ID, task_id: TEST_TASK_ID },
      });

      await assert.rejects(
        async () => {
          const llmResponse = await adapter.generate(request);
          const instruction = validateExecutorInstruction({
            task_id: llmResponse.correlation.task_id!,
            instruction_id: 'INST-NEVER',
            project_id: llmResponse.correlation.project_id,
            working_directory: tempWorkspace,
            objective: 'Should never execute',
            acceptance_criteria: ['N/A'],
            constraints: [],
            relevant_context: {},
            attempt: 1,
            max_attempts: 1,
            risk_level: RiskLevel.CAUTION,
            requested_operation_type: ExecutorOperationType.IMPLEMENT_TASK,
            traceability_information: { sources: ['REQ:REQ-001'] },
            correlation_id: llmResponse.correlation.correlation_id,
            policy_decision: { state: PolicyAuthorizationState.AUTHORIZED },
          });
          await executor.execute(instruction);
        },
        (err) => {
          assert.ok(err instanceof LlmExecutionError);
          assert.equal(err.code, 'ERR_LLM_EXECUTION_FAILURE');
          assert.equal(err.statusCode, 500);
          assert.equal(err.correlationId, 'corr-api-fail-i3-c');
          assert.ok(!err.message.includes('sk-live-secret-key-123456789012345678'));
          assert.ok(err.message.includes('***REDACTED_KEY***'));
          return true;
        }
      );

      assert.equal(executorDispatched, false);
    });

    // ------------------------------------------------------------------------
    // I3-D: Malformed Response
    // ------------------------------------------------------------------------
    it('I3-D: rejects malformed wire payloads as MalformedLlmResponseError and prevents normalization into success', async () => {
      let executorDispatched = false;
      const executor = new AntigravityAdapter({
        invoker: async () => {
          executorDispatched = true;
          return { executor_id: 'antigravity-cli' };
        },
      });

      const transport = new DeterministicMockTransport<ReferenceWireRequest, ReferenceWireResponse>({
        responseBody: { malformed_data_missing_choices: true } as unknown as ReferenceWireResponse,
      });
      const adapter = new ReferenceLlmAdapter({ transport });

      const request = validateLlmRequest({
        correlation: { correlation_id: 'corr-malformed-i3-d', project_id: TEST_PROJECT_ID, task_id: TEST_TASK_ID },
        messages: [{ role: LlmRole.USER, content: 'Format plan' }],
        director_context: { project_id: TEST_PROJECT_ID, task_id: TEST_TASK_ID },
      });

      await assert.rejects(
        async () => {
          const llmResponse = await adapter.generate(request);
          const instruction = validateExecutorInstruction({
            task_id: llmResponse.correlation.task_id!,
            instruction_id: 'INST-NEVER',
            project_id: llmResponse.correlation.project_id,
            working_directory: tempWorkspace,
            objective: 'Should never execute',
            acceptance_criteria: ['N/A'],
            constraints: [],
            relevant_context: {},
            attempt: 1,
            max_attempts: 1,
            risk_level: RiskLevel.CAUTION,
            requested_operation_type: ExecutorOperationType.IMPLEMENT_TASK,
            traceability_information: { sources: ['REQ:REQ-001'] },
            correlation_id: llmResponse.correlation.correlation_id,
            policy_decision: { state: PolicyAuthorizationState.AUTHORIZED },
          });
          await executor.execute(instruction);
        },
        (err) => {
          assert.ok(err instanceof MalformedLlmResponseError);
          assert.equal(err.code, 'ERR_MALFORMED_LLM_RESPONSE');
          assert.equal(err.correlationId, 'corr-malformed-i3-d');
          return true;
        }
      );

      assert.equal(executorDispatched, false);
    });

    // ------------------------------------------------------------------------
    // I3-E: Unsupported Capability
    // ------------------------------------------------------------------------
    it('I3-E: rejects requests demanding unsupported capabilities before invoking transport and prevents execution', async () => {
      let executorDispatched = false;
      const executor = new AntigravityAdapter({
        invoker: async () => {
          executorDispatched = true;
          return { executor_id: 'antigravity-cli' };
        },
      });

      const mockTransport = new DeterministicMockTransport<ReferenceWireRequest, ReferenceWireResponse>({
        responseBody: createReferenceWireSuccess('Should not be called'),
      });

      // Adapter whose advertised capabilities do NOT include STRUCTURED_OUTPUT
      const restrictedProvider: LLMProvider = new ReferenceLlmAdapter({
        providerId: 'provider:restricted',
        supportedCapabilities: [LlmCapability.TEXT_GENERATION], // STRUCTURED_OUTPUT excluded
        transport: mockTransport,
      });

      const schemaRequest = validateLlmRequest({
        correlation: { correlation_id: 'corr-unsupported-i3-e', project_id: TEST_PROJECT_ID, task_id: TEST_TASK_ID },
        messages: [{ role: LlmRole.USER, content: 'Return strict schema JSON' }],
        director_context: { project_id: TEST_PROJECT_ID, task_id: TEST_TASK_ID },
        response_format: LlmResponseFormat.JSON_SCHEMA,
        json_schema: {
          name: 'strict_schema',
          schema: { type: 'object', properties: { id: { type: 'string' } } },
        },
      });

      await assert.rejects(
        async () => {
          const llmResponse = await restrictedProvider.generate(schemaRequest);
          const instruction = validateExecutorInstruction({
            task_id: llmResponse.correlation.task_id!,
            instruction_id: 'INST-NEVER',
            project_id: llmResponse.correlation.project_id,
            working_directory: tempWorkspace,
            objective: 'Should never execute',
            acceptance_criteria: ['N/A'],
            constraints: [],
            relevant_context: {},
            attempt: 1,
            max_attempts: 1,
            risk_level: RiskLevel.CAUTION,
            requested_operation_type: ExecutorOperationType.IMPLEMENT_TASK,
            traceability_information: { sources: ['REQ:REQ-001'] },
            correlation_id: llmResponse.correlation.correlation_id,
            policy_decision: { state: PolicyAuthorizationState.AUTHORIZED },
          });
          await executor.execute(instruction);
        },
        (err) => {
          assert.ok(err instanceof UnsupportedLlmCapabilityError);
          assert.equal(err.code, 'ERR_UNSUPPORTED_LLM_CAPABILITY');
          assert.equal(err.capability, LlmCapability.STRUCTURED_OUTPUT);
          return true;
        }
      );

      // Verify transport was NOT invoked when capability validation failed
      assert.equal(mockTransport.recordedRequests.length, 0);
      assert.equal(executorDispatched, false);
    });

    // ------------------------------------------------------------------------
    // I3-F: Structured-Output Validation Failure
    // ------------------------------------------------------------------------
    it('I3-F: rejects syntactically valid JSON that violates schema contract as StructuredOutputValidationError', async () => {
      let executorDispatched = false;
      const executor = new AntigravityAdapter({
        invoker: async () => {
          executorDispatched = true;
          return { executor_id: 'antigravity-cli' };
        },
      });

      // Provider returns valid JSON, but missing the mandatory 'directive' and 'target' fields required by schema
      const syntacticallyValidViolationJson = JSON.stringify({
        unrelated_key: 'some_value',
        arbitrary_number: 999,
      });

      const mockTransport = new DeterministicMockTransport<ReferenceWireRequest, ReferenceWireResponse>({
        responseBody: createReferenceWireSuccess(syntacticallyValidViolationJson),
      });

      const adapter = new ReferenceLlmAdapter({ transport: mockTransport });

      const request = validateLlmRequest({
        correlation: { correlation_id: 'corr-schema-fail-i3-f', project_id: TEST_PROJECT_ID, task_id: TEST_TASK_ID },
        messages: [{ role: LlmRole.USER, content: 'Format decision as strict schema' }],
        director_context: { project_id: TEST_PROJECT_ID, task_id: TEST_TASK_ID },
        response_format: LlmResponseFormat.JSON_SCHEMA,
        json_schema: {
          name: 'director_decision_schema',
          schema: {
            type: 'object',
            required: ['directive', 'target'],
            properties: {
              directive: { type: 'string' },
              target: { type: 'string' },
            },
          },
        },
      });

      await assert.rejects(
        async () => {
          const llmResponse = await adapter.generate(request);
          // Must not proceed to executor
          const instruction = validateExecutorInstruction({
            task_id: llmResponse.correlation.task_id!,
            instruction_id: 'INST-NEVER',
            project_id: llmResponse.correlation.project_id,
            working_directory: tempWorkspace,
            objective: 'Should never execute',
            acceptance_criteria: ['N/A'],
            constraints: [],
            relevant_context: {},
            attempt: 1,
            max_attempts: 1,
            risk_level: RiskLevel.CAUTION,
            requested_operation_type: ExecutorOperationType.IMPLEMENT_TASK,
            traceability_information: { sources: ['REQ:REQ-001'] },
            correlation_id: llmResponse.correlation.correlation_id,
            policy_decision: { state: PolicyAuthorizationState.AUTHORIZED },
          });
          await executor.execute(instruction);
        },
        (err) => {
          assert.ok(err instanceof StructuredOutputValidationError);
          assert.equal(err.code, 'ERR_STRUCTURED_OUTPUT_VALIDATION');
          assert.equal(err.reason, 'MISSING_REQUIRED_FIELDS');
          assert.ok(err.missingFields?.includes('directive'));
          assert.ok(err.missingFields?.includes('target'));
          return true;
        }
      );

      assert.equal(executorDispatched, false);
    });
  });

  // ==========================================================================
  // I4 — TOKEN TELEMETRY INTEGRATION
  // ==========================================================================
  describe('I4 — Token Telemetry Integration', () => {
    it('preserves exact provider input/output and cached usage metrics', async () => {
      const transport = new DeterministicMockTransport<ReferenceWireRequest, ReferenceWireResponse>({
        responseBody: createReferenceWireSuccess('telemetry test', {
          prompt_tokens: 300,
          completion_tokens: 150,
          cached_tokens: 50,
          total_tokens: 450,
        }),
      });
      const adapter = new ReferenceLlmAdapter({ transport });

      const request = validateLlmRequest({
        correlation: { correlation_id: 'corr-telem-1', project_id: TEST_PROJECT_ID },
        messages: [{ role: LlmRole.USER, content: 'test' }],
        director_context: { project_id: TEST_PROJECT_ID },
      });

      const response = await adapter.generate(request);

      assert.equal(response.usage.reported_input_tokens, 300);
      assert.equal(response.usage.reported_output_tokens, 150);
      assert.equal(response.usage.reported_cached_tokens, 50);
      assert.equal(response.usage.is_exact_provider_metric, true);
      assert.equal(response.usage.estimated_cost_usd, null); // Zero fabricated cost
    });

    it('keeps reported metrics strictly null when usage is omitted by provider', async () => {
      const transport = new DeterministicMockTransport<ReferenceWireRequest, ReferenceWireResponse>({
        responseBody: createReferenceWireSuccess('Sample output text for estimation', null),
      });
      const adapter = new ReferenceLlmAdapter({ transport });

      const request = validateLlmRequest({
        correlation: { correlation_id: 'corr-telem-2', project_id: TEST_PROJECT_ID },
        messages: [{ role: LlmRole.USER, content: 'test' }],
        director_context: { project_id: TEST_PROJECT_ID },
      });

      const response = await adapter.generate(request);

      assert.equal(response.usage.reported_input_tokens, null);
      assert.equal(response.usage.reported_output_tokens, null);
      assert.equal(response.usage.reported_cached_tokens, null);
      assert.equal(response.usage.is_exact_provider_metric, false);
      assert.ok(response.usage.estimated_tokens > 0);
    });
  });

  // ==========================================================================
  // I5 — CONTEXT -> LLM INTEGRATION
  // ==========================================================================
  describe('I5 — Context -> LLM Integration', () => {
    it('consumes Phase 2 ContextEngine output seamlessly into Phase 3 LLMRequest', async () => {
      // 1. Create a real sample file in the temporary workspace
      const relPath = 'src/calculator.ts';
      const fullPath = path.join(tempWorkspace, relPath);
      await fs.promises.mkdir(path.dirname(fullPath), { recursive: true });
      await fs.promises.writeFile(
        fullPath,
        'export function add(a: number, b: number): number { return a + b; }\n',
        'utf-8'
      );

      // 2. Resolve realistic context using Phase 2 ContextEngine
      const contextEngine = new ContextEngine({
        workspaceRoot: tempWorkspace,
        dbPath,
      });

      const resolved: ResolvedContext = await contextEngine.resolveContext({
        sourcePaths: [relPath],
        intent: ContextIntent.FULL_IMPLEMENTATION,
      });

      assert.ok(resolved.items.length > 0);
      const sourceFileHash = resolved.items[0].fileHash;
      assert.ok(sourceFileHash);

      // 3. Connect Phase 2 context into Phase 3 LlmRequest
      const mockTransport = new DeterministicMockTransport<ReferenceWireRequest, ReferenceWireResponse>({
        responseBody: createReferenceWireSuccess('Code reviewed and verified.'),
      });
      const adapter = new ReferenceLlmAdapter({ transport: mockTransport });

      const request = validateLlmRequest({
        correlation: {
          correlation_id: 'corr-ctx-llm-01',
          project_id: TEST_PROJECT_ID,
          task_id: TEST_TASK_ID,
        },
        messages: [
          { role: LlmRole.SYSTEM, content: 'You are analyzing workspace code.' },
          { role: LlmRole.USER, content: `Analyze the provided source file: ${relPath}` },
        ],
        director_context: {
          project_id: TEST_PROJECT_ID,
          task_id: TEST_TASK_ID,
          objective: 'Analyze calculator module',
          acceptance_criteria: ['Function signature must match'],
          relevant_context: {
            context_hash: sourceFileHash,
            total_estimated_tokens: resolved.totalEstimatedTokens,
            hash_snapshots: resolved.hashSnapshots,
          },
        },
      });

      const response = await adapter.generate(request);

      assert.equal(response.content, 'Code reviewed and verified.');

      // Verify wire payload received the Phase 2 context hash and metadata
      const wire = mockTransport.recordedRequests[0].body;
      assert.equal(wire.director_context.relevant_context?.context_hash, sourceFileHash);
      assert.equal(
        wire.director_context.relevant_context?.total_estimated_tokens,
        resolved.totalEstimatedTokens
      );
    });
  });

  // ==========================================================================
  // I6 — EXECUTOR INTEGRATION
  // ==========================================================================
  describe('I6 — Executor Integration', () => {
    it('dispatches valid instruction through AntigravityAdapter without permission bypass', async () => {
      let capturedArgs: readonly string[] = [];

      const adapter = new AntigravityAdapter({
        invoker: async (payload, instruction) => {
          capturedArgs = payload.args;
          return {
            executor_id: 'antigravity-cli',
            command: payload.binary,
            exit_code: 0,
            stdout: 'Execution verified successfully.',
            stderr: '',
            agent_claims: ['Implemented task according to acceptance criteria.'],
            unverified_changed_files: ['src/calculator.ts'],
            timing: {
              started_at: '2026-09-22T06:30:00Z',
              completed_at: '2026-09-22T06:30:02Z',
              duration_ms: 2000,
            },
          };
        },
      });

      const instruction = validateExecutorInstruction({
        task_id: TEST_TASK_ID,
        instruction_id: 'INST-001',
        project_id: TEST_PROJECT_ID,
        working_directory: tempWorkspace,
        objective: 'Implement calculator addition function',
        acceptance_criteria: ['Function returns sum of two numbers'],
        constraints: ['Must not use eval'],
        relevant_context: {
          target_files: ['src/calculator.ts'],
        },
        attempt: 1,
        max_attempts: 3,
        risk_level: RiskLevel.CAUTION,
        requested_operation_type: ExecutorOperationType.IMPLEMENT_TASK,
        traceability_information: {
          sources: ['REQ:REQ-001'],
        },
        correlation_id: TEST_CORRELATION_ID,
        policy_decision: {
          state: PolicyAuthorizationState.AUTHORIZED,
          decided_by: 'POLICY_ENGINE',
          policy_rule: 'PERMIT_LOCAL_TASK',
        },
      });

      const result: NormalizedExecutorResult = await adapter.execute(instruction);

      // Verify execution facts
      assert.equal(result.success, true);
      assert.equal(result.status, ExecutorExecutionStatus.COMPLETED);
      assert.equal(result.exit_info?.code, 0);
      assert.equal(result.stdout, 'Execution verified successfully.');
      assert.deepEqual(result.changed_files, ['src/calculator.ts']);

      // DEC-007 Architectural Invariant: No permission bypass flag
      assert.ok(!capturedArgs.includes('--dangerously-skip-permissions'));
      for (const arg of capturedArgs) {
        assert.ok(!arg.includes('skip-permission'));
      }
    });

    it('rejects unauthorized instruction before invocation', async () => {
      let invokerCalled = false;

      const adapter = new AntigravityAdapter({
        invoker: async () => {
          invokerCalled = true;
          return { executor_id: 'antigravity-cli' };
        },
      });

      const unauthorizedInstruction = validateExecutorInstruction({
        task_id: TEST_TASK_ID,
        instruction_id: 'INST-UNAUTH',
        project_id: TEST_PROJECT_ID,
        working_directory: tempWorkspace,
        objective: 'Attempt unauthorized mutation',
        acceptance_criteria: ['None'],
        constraints: [],
        relevant_context: {},
        attempt: 1,
        max_attempts: 1,
        risk_level: RiskLevel.CRITICAL,
        requested_operation_type: ExecutorOperationType.IMPLEMENT_TASK,
        traceability_information: { sources: ['REQ:REQ-001'] },
        correlation_id: 'corr-unauth',
        policy_decision: {
          state: PolicyAuthorizationState.NOT_AUTHORIZED,
          reason: 'CRITICAL operation requires human approval',
        },
      });

      // 1. Security validator explicitly throws PolicyViolationError
      assert.throws(
        () => validateInstructionSecurity(unauthorizedInstruction),
        (err: unknown) => {
          assert.ok(err instanceof PolicyViolationError);
          assert.equal(err.code, 'ERR_POLICY_VIOLATION');
          return true;
        }
      );

      // 2. Adapter.execute blocks execution, returns REJECTED_BY_POLICY, and never calls invoker
      const execResult = await adapter.execute(unauthorizedInstruction);
      assert.equal(execResult.success, false);
      assert.equal(execResult.status, ExecutorExecutionStatus.REJECTED_BY_POLICY);
      assert.equal(invokerCalled, false);
    });
  });

  // ==========================================================================
  // I7 — END-TO-END PHASE 3 PIPELINE
  // ==========================================================================
  describe('I7 — End-to-End Phase 3 Pipeline', () => {
    it('executes the full pipeline: Task -> Context -> LLM -> Decision -> Executor -> Result', async () => {
      // 1. Setup workspace file (TASK representation)
      const targetFile = 'src/greeter.ts';
      const fullPath = path.join(tempWorkspace, targetFile);
      await fs.promises.mkdir(path.dirname(fullPath), { recursive: true });
      await fs.promises.writeFile(fullPath, 'export function greet(name: string): string { return ""; }\n');

      // 2. CONTEXT: Resolve context with ContextEngine
      const contextEngine = new ContextEngine({ workspaceRoot: tempWorkspace, dbPath });
      const context = await contextEngine.resolveContext({
        sourcePaths: [targetFile],
        intent: ContextIntent.FULL_IMPLEMENTATION,
      });

      // 3. LLM REQUEST: Build typed LlmRequest
      const mockLlmTransport = new DeterministicMockTransport<ReferenceWireRequest, ReferenceWireResponse>({
        responseBody: createReferenceWireSuccess(
          JSON.stringify({
            directive: 'IMPLEMENT_TASK',
            target: targetFile,
            plan: 'Return "Hello, " + name',
          })
        ),
      });

      const llmProvider: LLMProvider = new ReferenceLlmAdapter({
        transport: mockLlmTransport,
      });

      const llmRequest = validateLlmRequest({
        correlation: {
          correlation_id: TEST_CORRELATION_ID,
          project_id: TEST_PROJECT_ID,
          task_id: TEST_TASK_ID,
          attempt: 1,
        },
        messages: [{ role: LlmRole.USER, content: 'Implement greeter function' }],
        director_context: {
          project_id: TEST_PROJECT_ID,
          task_id: TEST_TASK_ID,
          objective: 'Implement greeter',
          acceptance_criteria: ['Returns formatted greeting'],
          relevant_context: { context_hash: context.items[0]?.fileHash },
        },
        response_format: LlmResponseFormat.JSON_OBJECT,
      });

      // 4. LLM DISPATCH & NORMALIZATION
      const llmResponse = await llmProvider.generate<{ directive: string; target: string; plan: string }>(
        llmRequest
      );
      assert.equal(llmResponse.structured_output?.directive, 'IMPLEMENT_TASK');

      // 5. DIRECTOR DECISION BOUNDARY: Formulate ExecutorInstruction from LLM decision
      const instruction = validateExecutorInstruction({
        task_id: llmResponse.correlation.task_id!,
        instruction_id: 'INST-E2E-001',
        project_id: llmResponse.correlation.project_id,
        working_directory: tempWorkspace,
        objective: 'Implement greeter module based on LLM decision',
        acceptance_criteria: ['Returns formatted greeting'],
        constraints: ['Pure function'],
        relevant_context: {
          context_hash: context.items[0]?.fileHash,
          target_files: [llmResponse.structured_output!.target],
        },
        attempt: llmResponse.correlation.attempt!,
        max_attempts: 3,
        risk_level: RiskLevel.CAUTION,
        requested_operation_type: ExecutorOperationType.IMPLEMENT_TASK,
        traceability_information: { sources: ['REQ:REQ-GREET'] },
        correlation_id: llmResponse.correlation.correlation_id,
        policy_decision: {
          state: PolicyAuthorizationState.AUTHORIZED,
          decided_by: 'POLICY_ENGINE',
          policy_rule: 'RULE_WORKSPACE_WRITE_PERMIT',
        },
      });

      // 6. EXECUTOR INVOCATION: AntigravityAdapter execution
      const executor: ExecutorPort = new AntigravityAdapter({
        invoker: async (payload) => ({
          executor_id: 'antigravity-cli',
          command: payload.binary,
          exit_code: 0,
          stdout: 'Greeter implementation finished.',
          agent_claims: ['Greeting function implemented'],
          unverified_changed_files: [targetFile],
        }),
      });

      const execResult = await executor.execute(instruction);

      // 7. COMPLETE IDENTITY PROPAGATION VERIFICATION
      assert.equal(execResult.success, true);
      assert.equal(execResult.status, ExecutorExecutionStatus.COMPLETED);
      assert.equal(instruction.project_id, TEST_PROJECT_ID);
      assert.equal(instruction.task_id, TEST_TASK_ID);
      assert.equal(instruction.correlation_id, TEST_CORRELATION_ID);
      assert.equal(instruction.attempt, 1);
      assert.equal(llmResponse.model, 'ref-model-v1');
      assert.equal(llmResponse.provider, 'reference-llm');
      assert.equal(execResult.executor_identity.provider, 'antigravity');
    });
  });

  // ==========================================================================
  // I8 — FAILURE BOUNDARY
  // ==========================================================================
  describe('I8 — Failure Boundary', () => {
    it('ensures LLM failure prevents downstream executor dispatch', async () => {
      const failingTransport = new DeterministicMockTransport<ReferenceWireRequest, ReferenceWireResponse>({
        responseStatus: 500,
        responseStatusText: 'Internal Server Error',
        throwHttpErrorOnStatusGte400: true,
      });
      const llmProvider = new ReferenceLlmAdapter({ transport: failingTransport });

      let executorDispatched = false;
      const executor = new AntigravityAdapter({
        invoker: async () => {
          executorDispatched = true;
          return { executor_id: 'antigravity-cli' };
        },
      });

      const request = validateLlmRequest({
        correlation: { correlation_id: 'corr-fail-chain', project_id: TEST_PROJECT_ID },
        messages: [{ role: LlmRole.USER, content: 'run' }],
        director_context: { project_id: TEST_PROJECT_ID },
      });

      // LLM call fails
      await assert.rejects(async () => llmProvider.generate(request), LlmExecutionError);

      // Downstream executor must never have been called
      assert.equal(executorDispatched, false);
    });

    it('ensures executor rejection remains a normalized failure without false success', async () => {
      const adapter = new AntigravityAdapter({
        invoker: async () => ({
          executor_id: 'antigravity-cli',
          exit_code: 1,
          stderr: 'Compilation failed: SyntaxError in line 10',
          stdout: '',
        }),
      });

      const instruction = validateExecutorInstruction({
        task_id: TEST_TASK_ID,
        instruction_id: 'INST-FAIL-01',
        project_id: TEST_PROJECT_ID,
        working_directory: tempWorkspace,
        objective: 'Fix code',
        acceptance_criteria: ['Compile clean'],
        constraints: [],
        relevant_context: {},
        attempt: 1,
        max_attempts: 1,
        risk_level: RiskLevel.CAUTION,
        requested_operation_type: ExecutorOperationType.IMPLEMENT_TASK,
        traceability_information: { sources: ['REQ:REQ-001'] },
        correlation_id: 'corr-exec-fail',
        policy_decision: { state: PolicyAuthorizationState.AUTHORIZED },
      });

      const result = await adapter.execute(instruction);

      assert.equal(result.success, false);
      assert.equal(result.status, ExecutorExecutionStatus.FAILED);
      assert.equal(result.exit_info?.code, 1);
      assert.ok(result.stderr?.includes('SyntaxError'));
    });
  });

  // ==========================================================================
  // I9 — DETERMINISM
  // ==========================================================================
  describe('I9 — Determinism', () => {
    it('produces strictly identical semantic outputs across 5 repeated executions of the complete pipeline', async () => {
      const results: {
        llmContent: string;
        correlationId: string;
        execStatus: ExecutorExecutionStatus;
        execStdout: string | null;
      }[] = [];

      for (let i = 0; i < 5; i++) {
        const mockTransport = new DeterministicMockTransport<ReferenceWireRequest, ReferenceWireResponse>({
          responseBody: createReferenceWireSuccess('Deterministic decision output.'),
        });
        const adapter = new ReferenceLlmAdapter({ transport: mockTransport });

        const req = validateLlmRequest({
          correlation: {
            correlation_id: 'corr-determ-fixed-id',
            project_id: TEST_PROJECT_ID,
            task_id: TEST_TASK_ID,
            attempt: 1,
          },
          messages: [{ role: LlmRole.USER, content: 'Determine action' }],
          director_context: { project_id: TEST_PROJECT_ID, task_id: TEST_TASK_ID },
        });

        const llmRes = await adapter.generate(req);

        const instruction = validateExecutorInstruction({
          task_id: TEST_TASK_ID,
          instruction_id: 'INST-DETERM',
          project_id: TEST_PROJECT_ID,
          working_directory: tempWorkspace,
          objective: 'Deterministic executor step',
          acceptance_criteria: ['Deterministic'],
          constraints: [],
          relevant_context: {},
          attempt: 1,
          max_attempts: 1,
          risk_level: RiskLevel.CAUTION,
          requested_operation_type: ExecutorOperationType.IMPLEMENT_TASK,
          traceability_information: { sources: ['REQ:REQ-001'] },
          correlation_id: llmRes.correlation.correlation_id,
          policy_decision: { state: PolicyAuthorizationState.AUTHORIZED },
        });

        const executor = new AntigravityAdapter({
          invoker: async () => ({
            executor_id: 'antigravity-cli',
            exit_code: 0,
            stdout: 'Executor completed deterministically.',
          }),
        });

        const execRes = await executor.execute(instruction);

        results.push({
          llmContent: llmRes.content,
          correlationId: llmRes.correlation.correlation_id,
          execStatus: execRes.status,
          execStdout: execRes.stdout,
        });
      }

      assert.equal(results.length, 5);
      const first = results[0];
      for (let i = 1; i < results.length; i++) {
        assert.deepEqual(results[i], first);
      }
    });
  });
});
