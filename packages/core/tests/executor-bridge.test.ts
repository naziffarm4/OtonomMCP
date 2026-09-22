import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  // Executor Bridge Types & Contracts
  type ExecutorInstruction,
  type ExecutorInstructionInput,
  type RawExecutorOutcome,
  type NormalizedExecutorResult,
  type ExecutorPort,
  ExecutorOperationType,
  ExecutorExecutionStatus,
  PolicyAuthorizationState,
  AntigravityAdapter,
  validateExecutorInstruction,
  validateInstructionSecurity,
  generateDeterministicCorrelationId,

  // Risk & Actors
  RiskLevel,
  Actor,

  // Error Classes
  AidmError,
  PolicyViolationError,
  InvalidExecutorInstructionError,
  UnsupportedOperationError,
  ExecutorUnavailableError,
  ExecutorExecutionError,
  AdapterTranslationError,
} from '../dist/index.js';

describe('Antigravity Executor Bridge Contract & Adapter Boundary (TASK-P3-01)', () => {
  const baseValidInstructionInput: ExecutorInstructionInput = {
    task_id: 'TASK-P3-01',
    instruction_id: 'INST-001',
    project_id: 'AIDM-PROJECT',
    working_directory: '/workspaces/OtonomMCP',
    objective: 'Implement the Antigravity executor bridge abstraction boundary.',
    acceptance_criteria: [
      'AC-P3-01-1: Strongly typed executor instruction contract',
      'AC-P3-01-2: Normalized executor result contract',
      'AC-P3-01-3: ExecutorPort abstraction',
    ],
    constraints: ['Must not fabricate unavailable metrics', 'Preserve raw execution data'],
    relevant_context: {
      context_hash: 'hash-abc-123',
      target_files: ['packages/core/src/executor-bridge/instruction-types.ts'],
      decisions: ['DEC-002', 'DEC-004', 'DEC-007'],
      requirements: ['REQ-P3-01'],
    },
    attempt: 1,
    max_attempts: 3,
    risk_level: RiskLevel.CAUTION,
    requested_operation_type: ExecutorOperationType.IMPLEMENT_TASK,
    traceability_information: {
      sources: ['REQ:REQ-P3-01', 'DEC:DEC-002', 'SYSTEM_REQUIREMENT:EXECUTOR_BRIDGE'],
      parent_feature_id: 'FEAT-P3-BRIDGE-FOUNDATION',
    },
    policy_decision: {
      state: PolicyAuthorizationState.AUTHORIZED,
      decided_by: 'POLICY_ENGINE',
      decided_at: '2026-09-22T05:00:00Z',
      policy_rule: 'RULE_WORKSPACE_STANDARD_PERMIT',
      decision_token: 'token-policy-permit-123',
    },
  };

  // ==========================================================================
  // SUITE 1: Instruction Contract & Deterministic Validation
  // ==========================================================================
  describe('1. Strongly Typed Executor Instruction Contract & Validation', () => {
    it('should accept a completely valid instruction and freeze the output', () => {
      const instruction = validateExecutorInstruction(baseValidInstructionInput);

      assert.equal(instruction.task_id, 'TASK-P3-01');
      assert.equal(instruction.instruction_id, 'INST-001');
      assert.equal(instruction.project_id, 'AIDM-PROJECT');
      assert.equal(instruction.working_directory, '/workspaces/OtonomMCP');
      assert.equal(
        instruction.objective,
        'Implement the Antigravity executor bridge abstraction boundary.'
      );
      assert.equal(instruction.acceptance_criteria.length, 3);
      assert.equal(instruction.constraints.length, 2);
      assert.equal(instruction.attempt, 1);
      assert.equal(instruction.max_attempts, 3);
      assert.equal(instruction.risk_level, RiskLevel.CAUTION);
      assert.equal(
        instruction.requested_operation_type,
        ExecutorOperationType.IMPLEMENT_TASK
      );
      assert.equal(
        instruction.correlation_id,
        'corr:AIDM-PROJECT:TASK-P3-01:INST-001:1'
      );
      assert.equal(instruction.policy_decision.state, PolicyAuthorizationState.AUTHORIZED);
      assert.ok(Object.isFrozen(instruction));
      assert.ok(Object.isFrozen(instruction.acceptance_criteria));
      assert.ok(Object.isFrozen(instruction.constraints));
    });

    it('should accept camelCase input fields and normalize to canonical snake_case', () => {
      const camelInput: ExecutorInstructionInput = {
        taskId: 'TASK-CAMEL-01',
        instructionId: 'INST-CAMEL-01',
        projectId: 'PROJECT-CAMEL',
        workingDirectory: '/workspaces/OtonomMCP',
        objective: 'Test camelCase normalization',
        acceptanceCriteria: ['AC-1: Test criterion'],
        attempt: 2,
        maxAttempts: 4,
        riskLevel: RiskLevel.SAFE,
        operationType: ExecutorOperationType.EXECUTE_TEST,
        traceabilitySources: ['REQ:REQ-001'],
        policyDecision: {
          state: PolicyAuthorizationState.AUTHORIZED,
          decidedBy: 'POLICY_ENGINE',
        },
      };

      const instruction = validateExecutorInstruction(camelInput);
      assert.equal(instruction.task_id, 'TASK-CAMEL-01');
      assert.equal(instruction.instruction_id, 'INST-CAMEL-01');
      assert.equal(instruction.project_id, 'PROJECT-CAMEL');
      assert.equal(instruction.working_directory, '/workspaces/OtonomMCP');
      assert.equal(instruction.attempt, 2);
      assert.equal(instruction.max_attempts, 4);
      assert.equal(instruction.risk_level, RiskLevel.SAFE);
      assert.equal(instruction.requested_operation_type, ExecutorOperationType.EXECUTE_TEST);
      assert.equal(
        instruction.correlation_id,
        'corr:PROJECT-CAMEL:TASK-CAMEL-01:INST-CAMEL-01:2'
      );
      assert.equal(instruction.policy_decision.state, PolicyAuthorizationState.AUTHORIZED);
    });

    it('should reject non-object or null input with ERR_INVALID_EXECUTOR_INSTRUCTION', () => {
      assert.throws(
        () => validateExecutorInstruction(null),
        (err: unknown) => {
          assert.ok(err instanceof InvalidExecutorInstructionError);
          assert.equal(err.code, 'ERR_INVALID_EXECUTOR_INSTRUCTION');
          assert.equal(err.reason, 'NON_OBJECT_INPUT');
          return true;
        }
      );
    });

    it('should reject missing task_id', () => {
      const invalid = { ...baseValidInstructionInput, task_id: '   ' };
      assert.throws(
        () => validateExecutorInstruction(invalid),
        (err: unknown) => {
          assert.ok(err instanceof InvalidExecutorInstructionError);
          assert.equal(err.field, 'task_id');
          assert.equal(err.reason, 'MISSING_TASK_ID');
          return true;
        }
      );
    });

    it('should reject missing instruction_id', () => {
      const invalid = { ...baseValidInstructionInput, instruction_id: '' };
      assert.throws(
        () => validateExecutorInstruction(invalid),
        (err: unknown) => {
          assert.ok(err instanceof InvalidExecutorInstructionError);
          assert.equal(err.field, 'instruction_id');
          assert.equal(err.reason, 'MISSING_INSTRUCTION_ID');
          return true;
        }
      );
    });

    it('should reject missing project_id', () => {
      const invalid = { ...baseValidInstructionInput, project_id: '' };
      assert.throws(
        () => validateExecutorInstruction(invalid),
        (err: unknown) => {
          assert.ok(err instanceof InvalidExecutorInstructionError);
          assert.equal(err.field, 'project_id');
          assert.equal(err.reason, 'MISSING_PROJECT_ID');
          return true;
        }
      );
    });

    it('should reject missing working_directory', () => {
      const invalid = { ...baseValidInstructionInput, working_directory: '  ' };
      assert.throws(
        () => validateExecutorInstruction(invalid),
        (err: unknown) => {
          assert.ok(err instanceof InvalidExecutorInstructionError);
          assert.equal(err.field, 'working_directory');
          assert.equal(err.reason, 'MISSING_WORKING_DIRECTORY');
          return true;
        }
      );
    });

    it('should reject missing or empty objective', () => {
      const invalid = { ...baseValidInstructionInput, objective: '' };
      assert.throws(
        () => validateExecutorInstruction(invalid),
        (err: unknown) => {
          assert.ok(err instanceof InvalidExecutorInstructionError);
          assert.equal(err.field, 'objective');
          assert.equal(err.reason, 'MISSING_OBJECTIVE');
          return true;
        }
      );
    });

    it('should reject empty acceptance criteria array', () => {
      const invalid = { ...baseValidInstructionInput, acceptance_criteria: [] };
      assert.throws(
        () => validateExecutorInstruction(invalid),
        (err: unknown) => {
          assert.ok(err instanceof InvalidExecutorInstructionError);
          assert.equal(err.field, 'acceptance_criteria');
          assert.equal(err.reason, 'EMPTY_ACCEPTANCE_CRITERIA');
          return true;
        }
      );
    });

    it('should reject non-positive or non-integer attempt numbers', () => {
      assert.throws(
        () => validateExecutorInstruction({ ...baseValidInstructionInput, attempt: 0 }),
        (err: unknown) => {
          assert.ok(err instanceof InvalidExecutorInstructionError);
          assert.equal(err.field, 'attempt');
          assert.equal(err.reason, 'INVALID_ATTEMPT_NUMBER');
          return true;
        }
      );

      assert.throws(
        () => validateExecutorInstruction({ ...baseValidInstructionInput, attempt: -1 }),
        (err: unknown) => {
          assert.ok(err instanceof InvalidExecutorInstructionError);
          assert.equal(err.field, 'attempt');
          return true;
        }
      );

      assert.throws(
        () => validateExecutorInstruction({ ...baseValidInstructionInput, attempt: 1.5 }),
        (err: unknown) => {
          assert.ok(err instanceof InvalidExecutorInstructionError);
          assert.equal(err.field, 'attempt');
          return true;
        }
      );
    });

    it('should reject non-positive or non-integer max_attempts', () => {
      assert.throws(
        () => validateExecutorInstruction({ ...baseValidInstructionInput, max_attempts: 0 }),
        (err: unknown) => {
          assert.ok(err instanceof InvalidExecutorInstructionError);
          assert.equal(err.field, 'max_attempts');
          assert.equal(err.reason, 'INVALID_MAX_ATTEMPTS');
          return true;
        }
      );
    });

    it('should reject invalid attempt/max-attempt relationship when attempt > max_attempts', () => {
      const invalid = { ...baseValidInstructionInput, attempt: 4, max_attempts: 3 };
      assert.throws(
        () => validateExecutorInstruction(invalid),
        (err: unknown) => {
          assert.ok(err instanceof InvalidExecutorInstructionError);
          assert.equal(err.field, 'attempt');
          assert.equal(err.reason, 'ATTEMPT_EXCEEDS_MAX_ATTEMPTS');
          return true;
        }
      );
    });

    it('should reject invalid risk_level string', () => {
      const invalid = { ...baseValidInstructionInput, risk_level: 'SUPER_RISKY' as any };
      assert.throws(
        () => validateExecutorInstruction(invalid),
        (err: unknown) => {
          assert.ok(err instanceof InvalidExecutorInstructionError);
          assert.equal(err.field, 'risk_level');
          assert.equal(err.reason, 'INVALID_RISK_LEVEL');
          return true;
        }
      );
    });

    it('should reject invalid requested_operation_type', () => {
      const invalid = {
        ...baseValidInstructionInput,
        requested_operation_type: 'FORMAT_DISK' as any,
      };
      assert.throws(
        () => validateExecutorInstruction(invalid),
        (err: unknown) => {
          assert.ok(err instanceof InvalidExecutorInstructionError);
          assert.equal(err.field, 'requested_operation_type');
          assert.equal(err.reason, 'INVALID_OPERATION_TYPE');
          return true;
        }
      );
    });

    it('should reject missing traceability sources', () => {
      const invalid = {
        ...baseValidInstructionInput,
        traceability_information: { sources: [] },
      };
      assert.throws(
        () => validateExecutorInstruction(invalid),
        (err: unknown) => {
          assert.ok(err instanceof InvalidExecutorInstructionError);
          assert.equal(err.field, 'traceability_information.sources');
          assert.equal(err.reason, 'MISSING_TRACEABILITY_SOURCES');
          return true;
        }
      );
    });

    it('should reject unrecognized traceability category in sources', () => {
      const invalid = {
        ...baseValidInstructionInput,
        traceability_information: {
          sources: ['UNOFFICIAL_SOURCE:123'],
        },
      };
      assert.throws(
        () => validateExecutorInstruction(invalid),
        (err: unknown) => {
          assert.ok(err instanceof InvalidExecutorInstructionError);
          assert.equal(err.reason, 'INVALID_TRACEABILITY_CATEGORY');
          return true;
        }
      );
    });
  });

  // ==========================================================================
  // SUITE 2: Security & Policy Boundary Behavior (Authoritative DEC-007)
  // ==========================================================================
  describe('2. Security & Policy Boundary Behavior (Correction Tests A - H)', () => {
    // TEST A: Adapter does NOT include --dangerously-skip-permissions
    it('A: Antigravity adapter MUST NOT include --dangerously-skip-permissions', () => {
      const adapter = new AntigravityAdapter();
      const instruction = validateExecutorInstruction(baseValidInstructionInput);
      const payload = adapter.translate(instruction);

      assert.equal(
        payload.args.includes('--dangerously-skip-permissions'),
        false,
        'Adapter must never include --dangerously-skip-permissions'
      );
      // Verify normal invocation flags are present
      assert.ok(payload.args.includes('--print'));
      assert.ok(payload.args.includes('--input-format'));
      assert.ok(payload.args.includes('--output-format'));
      assert.ok(payload.args.includes('--project'));
    });

    // TEST B: SAFE execution does not implicitly bypass executor permissions
    it('B: SAFE execution does NOT implicitly bypass executor permissions', () => {
      const adapter = new AntigravityAdapter();
      const safeInstruction = validateExecutorInstruction({
        ...baseValidInstructionInput,
        risk_level: RiskLevel.SAFE,
      });
      const payload = adapter.translate(safeInstruction);

      assert.equal(
        payload.args.includes('--dangerously-skip-permissions'),
        false,
        'SAFE execution must not bypass executor permissions'
      );
    });

    // TEST C: CAUTION execution does not implicitly bypass executor permissions
    it('C: CAUTION execution does NOT implicitly bypass executor permissions', () => {
      const adapter = new AntigravityAdapter();
      const cautionInstruction = validateExecutorInstruction({
        ...baseValidInstructionInput,
        risk_level: RiskLevel.CAUTION,
      });
      const payload = adapter.translate(cautionInstruction);

      assert.equal(
        payload.args.includes('--dangerously-skip-permissions'),
        false,
        'CAUTION execution must not bypass executor permissions'
      );
    });

    // TEST D: DANGEROUS operation without explicit policy authorization: must NOT execute
    it('D: DANGEROUS operation without explicit policy authorization must NOT execute', async () => {
      let invokerCalled = false;
      const adapter = new AntigravityAdapter({
        invoker: async () => {
          invokerCalled = true;
          return { executor_id: 'test', exit_code: 0 };
        },
      });

      const unauthDangerous = validateExecutorInstruction({
        ...baseValidInstructionInput,
        risk_level: RiskLevel.DANGEROUS,
        policy_decision: {
          state: PolicyAuthorizationState.NOT_AUTHORIZED,
          reason: 'No policy rule permitted dangerous modification',
        },
      });

      const result = await adapter.execute(unauthDangerous);

      // Must NOT execute! Invoker must never have been called!
      assert.equal(invokerCalled, false, 'Invoker must not be called when unauthorized');
      assert.equal(result.success, false);
      assert.equal(result.status, ExecutorExecutionStatus.REJECTED_BY_POLICY);
      assert.equal(result.error?.code, 'ERR_POLICY_VIOLATION');
      assert.equal(result.exit_info, null);
    });

    // TEST E: CRITICAL operation without explicit human authorization: must NOT execute
    it('E: CRITICAL operation without explicit human authorization must NOT execute', async () => {
      let invokerCalled = false;
      const adapter = new AntigravityAdapter({
        invoker: async () => {
          invokerCalled = true;
          return { executor_id: 'test', exit_code: 0 };
        },
      });

      // Attempt 1: State is HUMAN_REQUIRED
      const criticalHumanRequired = validateExecutorInstruction({
        ...baseValidInstructionInput,
        risk_level: RiskLevel.CRITICAL,
        policy_decision: {
          state: PolicyAuthorizationState.HUMAN_REQUIRED,
          reason: 'Critical destructive operation requires human approval',
        },
      });

      const res1 = await adapter.execute(criticalHumanRequired);
      assert.equal(invokerCalled, false);
      assert.equal(res1.success, false);
      assert.equal(res1.status, ExecutorExecutionStatus.REJECTED_BY_POLICY);
      assert.equal(res1.error?.details && (res1.error.details as any).suggestedAction, 'REQUIRE_HUMAN');

      // Attempt 2: Decided by POLICY_ENGINE (non-human actor cannot authorize CRITICAL)
      const criticalNonHuman = validateExecutorInstruction({
        ...baseValidInstructionInput,
        risk_level: RiskLevel.CRITICAL,
        policy_decision: {
          state: PolicyAuthorizationState.AUTHORIZED,
          decided_by: 'POLICY_ENGINE',
          decision_token: 'token-policy',
        },
      });

      const res2 = await adapter.execute(criticalNonHuman);
      assert.equal(invokerCalled, false);
      assert.equal(res2.success, false);
      assert.equal(res2.status, ExecutorExecutionStatus.REJECTED_BY_POLICY);

      // Attempt 3: Just a string 'USER' without valid decision token (string claim is not proof)
      const criticalStringOnly = validateExecutorInstruction({
        ...baseValidInstructionInput,
        risk_level: RiskLevel.CRITICAL,
        policy_decision: {
          state: PolicyAuthorizationState.AUTHORIZED,
          decided_by: Actor.USER,
          decision_token: '', // empty / missing token
        },
      });

      const res3 = await adapter.execute(criticalStringOnly);
      assert.equal(invokerCalled, false);
      assert.equal(res3.success, false);
      assert.equal(res3.status, ExecutorExecutionStatus.REJECTED_BY_POLICY);
    });

    // TEST F: Policy-unavailable state: must NOT execute a protected operation
    it('F: Policy-unavailable state must NOT execute a protected operation', async () => {
      let invokerCalled = false;
      const adapter = new AntigravityAdapter({
        invoker: async () => {
          invokerCalled = true;
          return { executor_id: 'test', exit_code: 0 };
        },
      });

      const policyUnavailable = validateExecutorInstruction({
        ...baseValidInstructionInput,
        policy_decision: {
          state: PolicyAuthorizationState.POLICY_UNAVAILABLE,
          reason: 'Policy engine offline',
        },
      });

      const result = await adapter.execute(policyUnavailable);
      assert.equal(invokerCalled, false);
      assert.equal(result.success, false);
      assert.equal(result.status, ExecutorExecutionStatus.REJECTED_BY_POLICY);
      assert.equal(result.error?.code, 'ERR_POLICY_VIOLATION');
    });

    // TEST G: Authorized execution may proceed through normal Antigravity invocation path
    it('G: Authorized execution may proceed through normal Antigravity invocation path', async () => {
      let capturedArgs: readonly string[] = [];
      let invokerCalled = false;

      const adapter = new AntigravityAdapter({
        invoker: async (payload) => {
          invokerCalled = true;
          capturedArgs = payload.args;
          return {
            executor_id: 'executor:antigravity',
            exit_code: 0,
            stdout: 'Normal execution output',
          };
        },
      });

      const authorizedInstruction = validateExecutorInstruction({
        ...baseValidInstructionInput,
        policy_decision: {
          state: PolicyAuthorizationState.AUTHORIZED,
          decided_by: 'POLICY_ENGINE',
          policy_rule: 'PERMIT_CAUTION_WORKSPACE_EDIT',
        },
      });

      const result = await adapter.execute(authorizedInstruction);

      assert.equal(invokerCalled, true);
      assert.equal(result.success, true);
      assert.equal(result.status, ExecutorExecutionStatus.COMPLETED);
      assert.equal(capturedArgs.includes('--dangerously-skip-permissions'), false);
      assert.ok(capturedArgs.includes('--print'));
      assert.ok(capturedArgs.includes('--project'));
    });

    // TEST H: No policy decision must be fabricated by the adapter
    it('H: No policy decision must be fabricated by the adapter or validator', () => {
      // Instruction created without supplying any policy decision
      const instructionWithoutPolicy = validateExecutorInstruction({
        task_id: 'TASK-P3-01',
        instruction_id: 'INST-001',
        project_id: 'AIDM-PROJECT',
        working_directory: '/workspaces/OtonomMCP',
        objective: 'Test non-fabrication',
        acceptance_criteria: ['AC-1: Test criterion'],
        attempt: 1,
        max_attempts: 1,
        risk_level: RiskLevel.SAFE, // Even though SAFE, must not be fabricated as AUTHORIZED!
        requested_operation_type: ExecutorOperationType.IMPLEMENT_TASK,
        traceability_sources: ['REQ:REQ-001'],
      });

      // Default state must be POLICY_UNAVAILABLE, NEVER AUTHORIZED
      assert.equal(
        instructionWithoutPolicy.policy_decision.state,
        PolicyAuthorizationState.POLICY_UNAVAILABLE,
        'Validator must mark state as POLICY_UNAVAILABLE rather than fabricating AUTHORIZED'
      );
    });

    it('should reject relative path traversal outside workspace in working_directory', async () => {
      const adapter = new AntigravityAdapter({
        invoker: async () => ({ executor_id: 'test', exit_code: 0 }),
      });
      const traversalInstruction = validateExecutorInstruction({
        ...baseValidInstructionInput,
        working_directory: '../../etc/secrets',
      });

      const result = await adapter.execute(traversalInstruction);
      assert.equal(result.success, false);
      assert.equal(result.status, ExecutorExecutionStatus.REJECTED_BY_POLICY);
      assert.ok(result.error?.message.includes('path traversal'));
    });
  });

  // ==========================================================================
  // SUITE 3: ExecutorPort Contract Abstraction (Requirement 3)
  // ==========================================================================
  describe('3. ExecutorPort Abstraction & Pluggability', () => {
    it('should adhere to the ExecutorPort interface contract', async () => {
      class CustomTestExecutorPort implements ExecutorPort {
        readonly executorId = 'executor:custom-llm';
        readonly provider = 'custom-llm';
        readonly supportedOperations = [ExecutorOperationType.IMPLEMENT_TASK];

        async checkAvailability() {
          return { available: true, version: '2.0.0', reason: null };
        }

        async execute(instruction: ExecutorInstruction): Promise<NormalizedExecutorResult> {
          const validated = validateExecutorInstruction(instruction);
          return {
            success: true,
            status: ExecutorExecutionStatus.COMPLETED,
            exit_info: { code: 0, signal: null, terminated: true },
            stdout: 'Custom execution complete',
            stderr: null,
            changed_files: ['src/index.ts'],
            executor_identity: { provider: this.provider, name: this.executorId, version: '2.0.0' },
            timing: { started_at: '2026-09-22T00:00:00Z', completed_at: '2026-09-22T00:00:01Z', duration_ms: 1000 },
            error: null,
            correlation: {
              task_id: validated.task_id,
              instruction_id: validated.instruction_id,
              project_id: validated.project_id,
              attempt: validated.attempt,
              correlation_id: validated.correlation_id,
            },
            raw_outcome: {
              executor_id: this.executorId,
              exit_code: 0,
              stdout: 'Custom execution complete',
            },
            agent_claims: ['Claim: completed task'],
          };
        }
      }

      const customPort: ExecutorPort = new CustomTestExecutorPort();
      assert.equal(customPort.executorId, 'executor:custom-llm');
      assert.equal(customPort.provider, 'custom-llm');

      const availability = await customPort.checkAvailability();
      assert.equal(availability.available, true);
      assert.equal(availability.version, '2.0.0');

      const instruction = validateExecutorInstruction(baseValidInstructionInput);
      const result = await customPort.execute(instruction);
      assert.equal(result.success, true);
      assert.equal(result.status, ExecutorExecutionStatus.COMPLETED);
      assert.equal(result.correlation.task_id, 'TASK-P3-01');
      assert.equal(result.executor_identity.provider, 'custom-llm');
    });
  });

  // ==========================================================================
  // SUITE 4: Antigravity Adapter Translation (Requirement 4, 6 & Test I)
  // ==========================================================================
  describe('4. Antigravity Adapter Translation & Determinism (Test I)', () => {
    it('I: should translate generic instruction into deterministic Antigravity CLI representation without permission bypass', () => {
      const adapter = new AntigravityAdapter({
        binaryPath: '/home/codespace/.local/bin/agy',
      });
      const instruction = validateExecutorInstruction(baseValidInstructionInput);
      const payload = adapter.translate(instruction);

      assert.equal(payload.binary, '/home/codespace/.local/bin/agy');
      assert.equal(payload.inputFormat, 'stream-json');
      assert.equal(payload.outputFormat, 'stream-json');
      assert.equal(payload.workingDirectory, '/workspaces/OtonomMCP');
      assert.equal(payload.correlationId, 'corr:AIDM-PROJECT:TASK-P3-01:INST-001:1');

      // CLI Arguments: Must NEVER have --dangerously-skip-permissions!
      assert.equal(payload.args.includes('--dangerously-skip-permissions'), false);
      assert.ok(payload.args.includes('--print'));
      assert.ok(payload.args.includes('--input-format'));
      assert.ok(payload.args.includes('--output-format'));
      assert.ok(payload.args.includes('--project'));
      assert.ok(payload.args.includes('AIDM-PROJECT'));
      assert.ok(payload.args.includes('--add-dir'));
      assert.ok(payload.args.includes('/workspaces/OtonomMCP'));

      // Structured Prompt content
      assert.ok(payload.structuredPrompt.includes('Task ID: TASK-P3-01'));
      assert.ok(payload.structuredPrompt.includes('Instruction ID: INST-001'));
      assert.ok(payload.structuredPrompt.includes('Project ID: AIDM-PROJECT'));
      assert.ok(payload.structuredPrompt.includes('Operation: IMPLEMENT_TASK'));
      assert.ok(payload.structuredPrompt.includes('Risk Level: CAUTION'));
      assert.ok(payload.structuredPrompt.includes('OBJECTIVE:'));
      assert.ok(payload.structuredPrompt.includes(instruction.objective));
      assert.ok(payload.structuredPrompt.includes('ACCEPTANCE CRITERIA:'));
      for (const ac of instruction.acceptance_criteria) {
        assert.ok(payload.structuredPrompt.includes(ac));
      }
      assert.ok(payload.structuredPrompt.includes('RELEVANT CONTEXT:'));
      assert.ok(payload.structuredPrompt.includes('Context Hash: hash-abc-123'));
      assert.ok(payload.structuredPrompt.includes('TRACEABILITY SOURCES:'));
      assert.ok(payload.structuredPrompt.includes('REQ:REQ-P3-01'));
    });

    it('should include conversation ID flag when provided in context metadata', () => {
      const adapter = new AntigravityAdapter();
      const instruction = validateExecutorInstruction({
        ...baseValidInstructionInput,
        relevant_context: {
          ...baseValidInstructionInput.relevant_context,
          metadata: { conversation_id: 'conv-session-42' },
        },
      });

      const payload = adapter.translate(instruction);
      assert.equal(payload.conversationId, 'conv-session-42');
      assert.ok(payload.args.includes('--conversation'));
      assert.ok(payload.args.includes('conv-session-42'));
    });

    it('should produce identical translation across repeated calls (Determinism)', () => {
      const adapter = new AntigravityAdapter();
      const instruction = validateExecutorInstruction(baseValidInstructionInput);

      const payload1 = adapter.translate(instruction);
      const payload2 = adapter.translate(instruction);

      assert.deepEqual(payload1, payload2);
      assert.equal(payload1.structuredPrompt, payload2.structuredPrompt);
    });

    it('should include previous attempt failure in prompt when retrying (attempt > 1)', () => {
      const adapter = new AntigravityAdapter();
      const retryInstruction = validateExecutorInstruction({
        ...baseValidInstructionInput,
        attempt: 2,
        relevant_context: {
          ...baseValidInstructionInput.relevant_context,
          previous_attempt_failure: {
            attempt: 1,
            error_signature: 'ERR_SYNTAX_ERROR',
            root_cause: 'Unclosed brace in schema definition',
            failed_strategy: 'STRAT-001: Inline bracket repair',
          },
        },
      });

      const payload = adapter.translate(retryInstruction);
      assert.ok(payload.structuredPrompt.includes('PREVIOUS ATTEMPT FAILURE:'));
      assert.ok(payload.structuredPrompt.includes('Failed Attempt: 1'));
      assert.ok(payload.structuredPrompt.includes('Error Signature: ERR_SYNTAX_ERROR'));
      assert.ok(payload.structuredPrompt.includes('Root Cause: Unclosed brace in schema definition'));
      assert.ok(payload.structuredPrompt.includes('Failed Strategy: STRAT-001: Inline bracket repair'));
    });
  });

  // ==========================================================================
  // SUITE 5: Unsupported Operation & Unavailable Executor
  // ==========================================================================
  describe('5. Unsupported Operation & Unavailable Executor Handling', () => {
    it('should reject unsupported operation with UnsupportedOperationError', () => {
      class RestrictedAdapter extends AntigravityAdapter {
        override readonly supportedOperations = [ExecutorOperationType.EXECUTE_TEST];
      }

      const adapter = new RestrictedAdapter();
      const instruction = validateExecutorInstruction({
        ...baseValidInstructionInput,
        requested_operation_type: ExecutorOperationType.IMPLEMENT_TASK,
      });

      assert.throws(
        () => adapter.translate(instruction),
        (err: unknown) => {
          assert.ok(err instanceof UnsupportedOperationError);
          assert.equal(err.code, 'ERR_UNSUPPORTED_OPERATION');
          assert.equal(err.operation, ExecutorOperationType.IMPLEMENT_TASK);
          assert.deepEqual(err.supportedOperations, [ExecutorOperationType.EXECUTE_TEST]);
          return true;
        }
      );
    });

    it('should report availability: false when binary path does not exist', async () => {
      const adapter = new AntigravityAdapter({
        binaryPath: '/non/existent/path/to/agy',
      });

      const availability = await adapter.checkAvailability();
      assert.equal(availability.available, false);
      assert.ok(availability.reason?.includes('not found'));
    });

    it('should throw ExecutorUnavailableError when executing against unavailable binary without invoker', async () => {
      const adapter = new AntigravityAdapter({
        binaryPath: '/non/existent/path/to/agy',
      });
      const instruction = validateExecutorInstruction(baseValidInstructionInput);

      await assert.rejects(
        async () => adapter.execute(instruction),
        (err: unknown) => {
          assert.ok(err instanceof ExecutorUnavailableError);
          assert.equal(err.code, 'ERR_EXECUTOR_UNAVAILABLE');
          assert.equal(err.provider, 'antigravity');
          return true;
        }
      );
    });

    it('should report availability: true when custom invoker is provided', async () => {
      const adapter = new AntigravityAdapter({
        invoker: async () => ({ executor_id: 'mock', exit_code: 0 }),
      });

      const availability = await adapter.checkAvailability();
      assert.equal(availability.available, true);
    });
  });

  // ==========================================================================
  // SUITE 6: Execution Failure Normalization (Requirement 2 & Test J)
  // ==========================================================================
  describe('6. Execution Failure Normalization (Test J)', () => {
    it('should normalize process failure (non-zero exit code) into FAILED status with error info', async () => {
      const rawFailure: RawExecutorOutcome = {
        executor_id: 'executor:antigravity',
        command: 'agy --print ...',
        exit_code: 1,
        stdout: 'Starting task...',
        stderr: 'Error: TypeError: cannot read property of undefined',
        unverified_changed_files: ['src/broken.ts'],
        timing: {
          started_at: '2026-09-22T05:00:00Z',
          completed_at: '2026-09-22T05:00:03Z',
          duration_ms: 3000,
        },
      };

      const adapter = new AntigravityAdapter({
        invoker: async () => rawFailure,
      });
      const instruction = validateExecutorInstruction(baseValidInstructionInput);

      const result = await adapter.execute(instruction);

      assert.equal(result.success, false);
      assert.equal(result.status, ExecutorExecutionStatus.FAILED);
      assert.deepEqual(result.exit_info, { code: 1, signal: null, terminated: true });
      assert.equal(result.stdout, 'Starting task...');
      assert.equal(result.stderr, 'Error: TypeError: cannot read property of undefined');
      assert.deepEqual(result.changed_files, ['src/broken.ts']);
      assert.ok(result.error);
      assert.equal(result.error?.code, 'ERR_EXECUTOR_EXECUTION_FAILURE');
      assert.ok(result.error?.message.includes('TypeError'));
      assert.deepEqual(result.timing, {
        started_at: '2026-09-22T05:00:00Z',
        completed_at: '2026-09-22T05:00:03Z',
        duration_ms: 3000,
      });
    });

    it('should normalize termination signal (e.g. SIGTERM) into CANCELLED status', async () => {
      const rawSignal: RawExecutorOutcome = {
        executor_id: 'executor:antigravity',
        signal: 'SIGTERM',
        exit_code: null,
        stderr: 'Process terminated by signal SIGTERM',
      };

      const adapter = new AntigravityAdapter({
        invoker: async () => rawSignal,
      });
      const instruction = validateExecutorInstruction(baseValidInstructionInput);

      const result = await adapter.execute(instruction);

      assert.equal(result.success, false);
      assert.equal(result.status, ExecutorExecutionStatus.CANCELLED);
      assert.deepEqual(result.exit_info, { code: null, signal: 'SIGTERM', terminated: true });
    });

    it('should normalize exit code 0 into COMPLETED status with success: true and error: null', async () => {
      const rawSuccess: RawExecutorOutcome = {
        executor_id: 'executor:antigravity',
        exit_code: 0,
        stdout: 'Build and tests completed with 0 errors',
        stderr: null,
        unverified_changed_files: ['src/feature.ts', 'tests/feature.test.ts'],
        timing: {
          started_at: '2026-09-22T05:00:00Z',
          completed_at: '2026-09-22T05:00:02Z',
          duration_ms: 2000,
        },
      };

      const adapter = new AntigravityAdapter({
        invoker: async () => rawSuccess,
      });
      const instruction = validateExecutorInstruction(baseValidInstructionInput);

      const result = await adapter.execute(instruction);

      assert.equal(result.success, true);
      assert.equal(result.status, ExecutorExecutionStatus.COMPLETED);
      assert.deepEqual(result.exit_info, { code: 0, signal: null, terminated: true });
      assert.equal(result.error, null);
      assert.equal(result.stdout, 'Build and tests completed with 0 errors');
      assert.deepEqual(result.changed_files, ['src/feature.ts', 'tests/feature.test.ts']);
    });
  });

  // ==========================================================================
  // SUITE 7: Raw Result Preservation & Evidence Boundary (Requirement 8)
  // ==========================================================================
  describe('7. Raw Result Preservation & Evidence Boundary', () => {
    it('should preserve the complete raw executor outcome inside NormalizedExecutorResult', async () => {
      const rawOutcome: RawExecutorOutcome = {
        executor_id: 'executor:antigravity',
        command: 'agy --print test',
        exit_code: 0,
        stdout: 'Raw output chunk 1\nRaw output chunk 2',
        stderr: null,
        raw_payload: { turns: 1, model: 'gemini-exp' },
        agent_claims: ['Claim: JWT service is fully updated and passes tests'],
        unverified_changed_files: ['packages/core/src/auth.ts'],
      };

      const adapter = new AntigravityAdapter({
        invoker: async () => rawOutcome,
      });
      const instruction = validateExecutorInstruction(baseValidInstructionInput);

      const result = await adapter.execute(instruction);

      assert.deepEqual(result.raw_outcome, rawOutcome);
      assert.deepEqual(result.agent_claims, [
        'Claim: JWT service is fully updated and passes tests',
      ]);
      assert.equal((result as any).system_verified_evidence, undefined);
    });
  });

  // ==========================================================================
  // SUITE 8: No Fabricated Telemetry / Metrics (Requirement 2)
  // ==========================================================================
  describe('8. No Fabricated Telemetry & Metrics', () => {
    it('should preserve nulls for missing exit code, stdout, stderr, changed_files, and timing', async () => {
      const sparseOutcome: RawExecutorOutcome = {
        executor_id: 'executor:antigravity',
      };

      const adapter = new AntigravityAdapter({
        invoker: async () => sparseOutcome,
      });
      const instruction = validateExecutorInstruction(baseValidInstructionInput);

      const result = await adapter.execute(instruction);

      assert.equal(result.exit_info, null);
      assert.equal(result.stdout, null);
      assert.equal(result.stderr, null);
      assert.equal(result.changed_files, null);
      assert.equal(result.timing, null);
    });

    it('should not fabricate missing timing subfields if timing is partial', async () => {
      const partialTimingOutcome: RawExecutorOutcome = {
        executor_id: 'executor:antigravity',
        exit_code: 0,
        timing: {
          started_at: '2026-09-22T05:00:00Z',
        },
      };

      const adapter = new AntigravityAdapter({
        invoker: async () => partialTimingOutcome,
      });
      const instruction = validateExecutorInstruction(baseValidInstructionInput);

      const result = await adapter.execute(instruction);

      assert.ok(result.timing);
      assert.equal(result.timing?.started_at, '2026-09-22T05:00:00Z');
      assert.equal(result.timing?.completed_at, null);
      assert.equal(result.timing?.duration_ms, null);
    });
  });

  // ==========================================================================
  // SUITE 9: Deterministic Normalization & Correlation Preservation
  // ==========================================================================
  describe('9. Deterministic Normalization & Correlation Preservation', () => {
    it('should produce identical normalized results on repeated normalization calls', () => {
      const adapter = new AntigravityAdapter();
      const instruction = validateExecutorInstruction(baseValidInstructionInput);
      const rawOutcome: RawExecutorOutcome = {
        executor_id: 'executor:antigravity',
        exit_code: 0,
        stdout: 'Success',
        stderr: null,
        unverified_changed_files: ['file1.ts', 'file2.ts'],
      };

      const res1 = adapter.normalize(rawOutcome, instruction);
      const res2 = adapter.normalize(rawOutcome, instruction);

      assert.deepEqual(res1, res2);
    });

    it('should strictly preserve correlation identifiers', async () => {
      const adapter = new AntigravityAdapter({
        invoker: async () => ({ executor_id: 'executor:antigravity', exit_code: 0 }),
      });
      const customCorrelationId = 'custom:corr:999';
      const instruction = validateExecutorInstruction({
        ...baseValidInstructionInput,
        task_id: 'TASK-CORR-01',
        instruction_id: 'INST-CORR-01',
        project_id: 'PROJ-CORR',
        attempt: 2,
        correlation_id: customCorrelationId,
      });

      const result = await adapter.execute(instruction);

      assert.equal(result.correlation.task_id, 'TASK-CORR-01');
      assert.equal(result.correlation.instruction_id, 'INST-CORR-01');
      assert.equal(result.correlation.project_id, 'PROJ-CORR');
      assert.equal(result.correlation.attempt, 2);
      assert.equal(result.correlation.correlation_id, customCorrelationId);
    });
  });

  // ==========================================================================
  // SUITE 10: Structured Errors Hierarchy & Serialization
  // ==========================================================================
  describe('10. Structured Errors Hierarchy & Serialization', () => {
    it('should ensure all executor errors inherit from AidmError and Error', () => {
      const invalidErr = new InvalidExecutorInstructionError('Invalid instruction', {
        taskId: 'T1',
        field: 'task_id',
      });
      const unsupportedErr = new UnsupportedOperationError('Unsupported op', {
        operation: 'DELETE',
      });
      const unavailableErr = new ExecutorUnavailableError('Unavailable', {
        provider: 'antigravity',
      });
      const executionErr = new ExecutorExecutionError('Failed', {
        exitCode: 1,
      });
      const translationErr = new AdapterTranslationError('Translation failed', {
        adapterName: 'AntigravityAdapter',
      });

      const errors = [
        invalidErr,
        unsupportedErr,
        unavailableErr,
        executionErr,
        translationErr,
      ];

      for (const err of errors) {
        assert.ok(err instanceof Error);
        assert.ok(err instanceof AidmError);
        assert.ok(err.code.startsWith('ERR_'));
        const json = err.toJSON();
        assert.equal(json.code, err.code);
        assert.ok(typeof json.message === 'string');
      }
    });

    it('should have distinct error codes across all executor error classes', () => {
      const codes = new Set([
        new InvalidExecutorInstructionError('test').code,
        new UnsupportedOperationError('test').code,
        new ExecutorUnavailableError('test').code,
        new ExecutorExecutionError('test').code,
        new AdapterTranslationError('test').code,
      ]);

      assert.equal(codes.size, 5);
      assert.ok(codes.has('ERR_INVALID_EXECUTOR_INSTRUCTION'));
      assert.ok(codes.has('ERR_UNSUPPORTED_OPERATION'));
      assert.ok(codes.has('ERR_EXECUTOR_UNAVAILABLE'));
      assert.ok(codes.has('ERR_EXECUTOR_EXECUTION_FAILURE'));
      assert.ok(codes.has('ERR_ADAPTER_TRANSLATION_FAILURE'));
    });
  });
});
