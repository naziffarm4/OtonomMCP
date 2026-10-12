/**
 * Shared deterministic test doubles for the autonomous spec-run tests.
 * Offline only: no network, no real AGY, no OS keystore.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { IdentityManager } from '../../dist/authorization/index.js';
import type { LLMProvider, LlmRequest, LlmResponse } from '../../dist/llm-bridge/index.js';
import { LlmFinishReason } from '../../dist/llm-bridge/llm-types.js';
import type {
  ExecutorPort,
  ExecutionRequestExecutorPort,
  ExecutionRequest,
  RawExecutorOutcome,
} from '../../dist/executor-bridge/index.js';

/** In-memory Ed25519 keystore (replaces Windows DPAPI storage in tests). */
export class InMemoryIdentityManager extends IdentityManager {
  private keys?: { publicKey: crypto.KeyObject; privateKey: crypto.KeyObject; identityId: string };
  override async getOrCreateIdentity() {
    if (!this.keys) {
      const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
      this.keys = { publicKey, privateKey, identityId: `id-test-${crypto.randomUUID()}` };
    }
    return this.keys;
  }
}

export type MockDirectorMode = 'implement' | 'clarify-once' | 'human-decision' | 'self-approve';

/** Deterministic Director LLM: answers with a DirectorAction for the targeted task. */
export class MockDirectorLlm implements LLMProvider {
  readonly providerId = 'llm:mock-autonomous';
  readonly providerName = 'mock-autonomous';
  readonly defaultModel = 'mock-director-1';
  readonly supportedModels = ['mock-director-1'];
  readonly supportedCapabilities = [] as never[];
  readonly isMock = true;
  readonly requests: LlmRequest[] = [];
  private clarified = new Set<string>();

  mode: MockDirectorMode;
  /** Optional scripted override: return a partial action payload (merged over base) or undefined for default. */
  script?: (ctx: { taskId: string; call: number; prompt: string }) => Record<string, unknown> | undefined;
  constructor(mode: MockDirectorMode = 'implement') {
    this.mode = mode;
  }

  async checkAvailability() {
    return { available: true, model: this.defaultModel } as never;
  }

  /** Spec-clarification (pre-implementation review) calls, kept apart from the Director action calls. */
  readonly clarifyRequests: LlmRequest[] = [];
  /** Optional spec-review payload (default: no questions). */
  clarify?: (ctx: { call: number; prompt: string }) => Record<string, unknown> | undefined;

  async generate<T = unknown>(request: LlmRequest): Promise<LlmResponse<T>> {
    if (request.correlation?.task_id === 'SPEC-CLARIFY') {
      this.clarifyRequests.push(request);
      const prompt = request.messages.map((m) => String((m as { content?: unknown }).content ?? '')).join('\n');
      const payload = this.clarify?.({ call: this.clarifyRequests.length, prompt }) ?? { summary: 'Plan açık.', questions: [] };
      return {
        correlation: { correlation_id: request.correlation?.correlation_id ?? 'c', project_id: String(request.correlation?.project_id) },
        provider: this.providerName,
        model: this.defaultModel,
        content: JSON.stringify(payload),
        structured_output: payload as T,
        finish_reason: LlmFinishReason.STOP,
        raw_metadata: null,
        error: null,
        usage: { reported_input_tokens: 100, reported_output_tokens: 50, reported_cached_tokens: 0, estimated_tokens: 150, estimated_cost_usd: null, provider_name: this.providerName, model: this.defaultModel, is_exact_provider_metric: true },
      } as LlmResponse<T>;
    }
    this.requests.push(request);
    const meta = (request.metadata ?? {}) as Record<string, unknown>;
    const taskId = String(request.correlation?.task_id ?? 'TASK-001');
    const base = {
      protocolVersion: 'AIDM-DIRECTOR-ACTION-1',
      schemaVersion: 1,
      actionId: `act-${crypto.randomUUID()}`,
      directorSessionId: String(meta.directorSessionId),
      projectId: String(request.correlation?.project_id),
      basedOnContextFingerprint: String(meta.contextFingerprint),
      confidence: 0.9,
    };
    let payload: Record<string, unknown>;
    const prompt = request.messages.map((m) => String((m as { content?: unknown }).content ?? '')).join('\n');
    const scripted = this.script?.({ taskId, call: this.requests.length, prompt });
    if (scripted) {
      payload = { ...base, ...scripted };
    } else if (this.mode === 'clarify-once' && !this.clarified.has(taskId)) {
      this.clarified.add(taskId);
      payload = {
        ...base,
        actionType: 'REQUEST_CLARIFICATION',
        rationale: 'Ambiguous output format.',
        question: 'Which output format should be used?',
        reason: 'Spec does not specify the output format.',
        blocking: true,
      };
    } else if (this.mode === 'human-decision') {
      payload = {
        ...base,
        actionType: 'REQUEST_HUMAN_DECISION',
        rationale: 'Spec asks to change the security policy.',
        question: 'May I change the security policy?',
        reason: 'Security policy changes are outside routine implementation.',
        blocking: true,
      };
    } else {
      payload = {
        ...base,
        actionType: 'IMPLEMENT_TASK',
        rationale: 'Assumption: conventional layout. Implementing target task.',
        taskId,
        objective: `Implement ${taskId}`,
        targetFiles: [`src/${taskId.toLowerCase()}.js`],
        implementationScope: 'src/',
        acceptanceCriteria: ['implemented'],
        constraints: ['stay inside project root'],
        ...(this.mode === 'self-approve' ? { hasImplementationAuthority: true, approved: true } : {}),
      };
    }
    return {
      correlation: { correlation_id: request.correlation?.correlation_id ?? 'c', project_id: base.projectId },
      provider: this.providerName,
      model: this.defaultModel,
      content: JSON.stringify(payload),
      structured_output: payload as T,
      finish_reason: LlmFinishReason.STOP,
      raw_metadata: null,
      error: null,
      usage: {
        reported_input_tokens: 120,
        reported_output_tokens: 60,
        reported_cached_tokens: 0,
        estimated_tokens: 180,
        estimated_cost_usd: null,
        provider_name: this.providerName,
        model: this.defaultModel,
        is_exact_provider_metric: true,
      },
    } as LlmResponse<T>;
  }
}

/** Mock AGY: writes the requested files for real, but its claims are never trusted. */
export class MockAgyExecutor implements ExecutorPort, ExecutionRequestExecutorPort {
  readonly executorId = 'mock-agy';
  readonly provider = 'antigravity';
  readonly supportedOperations = ['IMPLEMENT_TASK'] as never[];
  calls = 0;
  claimOnly = false;
  /** Optional per-request stdout (e.g. "QUESTIONS: ..." / "FINDINGS: ..."). */
  stdoutFor?: (request: ExecutionRequest) => string | undefined;
  readonly requestsSeen: ExecutionRequest[] = [];
  /** Optional file content per request/file (default: a tiny ESM stub). */
  contentFor?: (request: ExecutionRequest, file: string, call: number) => string;
  /** Called during execute (simulates work in progress). */
  onExecute?: (request: ExecutionRequest) => void | Promise<void>;
  private readonly root: string;
  constructor(root: string) {
    this.root = root;
  }
  async checkAvailability() {
    return { available: true } as never;
  }
  async execute(request: ExecutionRequest): Promise<RawExecutorOutcome> {
    this.calls++;
    this.requestsSeen.push(request);
    const readOnly = /read-only|without modifying/i.test(String(request.instruction?.objective ?? ''));
    const files = readOnly ? [] : request.instruction?.targetFiles?.length ? [...request.instruction.targetFiles] : ['src/index.js'];
    if (!this.claimOnly) {
      for (const f of files) {
        const full = path.join(this.root, f);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, this.contentFor?.(request, f, this.calls) ?? `// ${request.taskId}\nexport const done = true;\n`, 'utf8');
      }
    }
    await this.onExecute?.(request);
    const now = new Date().toISOString();
    return {
      executorIdentity: { provider: 'antigravity', name: this.executorId, version: '1.0.0' },
      requestId: request.requestId,
      requestBinding: {
        requestId: request.requestId,
        projectId: request.projectId,
        taskId: request.taskId,
        taskRevision: request.taskRevision,
        contextFingerprint: request.contextFingerprint,
        understandingRevision: request.understandingRevision,
        approvalPackageRevision: request.approvalPackageRevision,
      },
      status: 'SUCCESS',
      exitCode: 0,
      timedOut: false,
      cancelled: false,
      signal: null,
      stdout: this.stdoutFor?.(request) ?? 'AGY: all done, trust me',
      stderr: '',
      durationMs: 5,
      unverifiedAgentClaims: ['All tests pass'],
      unverifiedModifiedFiles: this.claimOnly ? [] : files,
      ...(readOnly ? {} : {}),
      startedAt: now,
      completedAt: now,
    } as RawExecutorOutcome;
  }
}
