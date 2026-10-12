/**
 * Unit tests: automatic Project Mandate generation & sealing (authorization provenance)
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import {
  buildAutonomousMandate,
  sealAutonomousMandate,
  signOperatorInvocation,
  AUTONOMOUS_RUN_LOCK_FILE,
} from '../dist/autonomous/index.js';
import {
  ProjectMandateStore,
  AuthorizationPolicyEngine,
  isValidOperatorCliInvocation,
  OPERATOR_CLI_INVOCATION_MAX_TTL_MS,
} from '../dist/authorization/index.js';
import { HistoryManager, SpecStore } from '../dist/storage/index.js';
import { InMemoryIdentityManager } from './helpers/autonomous-test-doubles.ts';

const FP = 'a'.repeat(64);

describe('Autonomous Project Mandate', { concurrency: 1 }, () => {
  let dir: string;
  let identity: InMemoryIdentityManager;
  let store: ProjectMandateStore;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidm-mandate-'));
    identity = new InMemoryIdentityManager({ baseDir: dir });
    store = new ProjectMandateStore({ baseDir: dir, identityManager: identity });
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const invocation = (overrides: Record<string, unknown> = {}) => ({
    projectId: 'proj',
    specFingerprint: FP,
    specPath: '/x/spec.md',
    entryPoint: 'aidm run --spec',
    budgetUsd: 5,
    ...overrides,
  });

  it('only IMPLEMENTATION is auto-executable; policy/budget changes stay human-gated; escape/push denied', () => {
    const m = buildAutonomousMandate({ projectId: 'proj' });
    assert.deepEqual(m.autoExecutableTaskClasses, ['IMPLEMENTATION']);
    for (const op of ['REPLAN', 'REQUEST_HUMAN_DECISION', 'UPDATE_SECURITY_POLICY', 'POLICY_CHANGE', 'MANDATE_CHANGE', 'BUDGET_OVERRIDE', 'BUDGET_INCREASE', 'OUT_OF_SCOPE_ACTION']) {
      assert.ok(m.humanApprovalRequiredOperations.includes(op), op);
      assert.ok(!m.allowedOperationTypes.includes(op), op);
    }
    for (const op of ['WORKSPACE_ESCAPE', 'GIT_PUSH', 'GIT_FORCE_PUSH', 'SYSTEM_DESTRUCTIVE', 'CREDENTIAL_ACCESS']) {
      assert.ok(m.forbiddenOperations.includes(op), op);
    }
    assert.ok(!m.allowedDirectories.some((d) => d.startsWith('.ai-manager') || d.startsWith('..') || d.startsWith('/')));
    assert.ok(Date.parse(m.authorizationEndTime) - Date.now() <= 8 * 3600_000 + 1000);
  });

  it('validity window is capped at 24h and revision increments over the previous mandate', () => {
    const prev = buildAutonomousMandate({ projectId: 'proj' });
    const m = buildAutonomousMandate({ projectId: 'proj', validityHours: 1000, previous: prev });
    assert.equal(m.mandateRevision, prev.mandateRevision + 1);
    assert.ok(Date.parse(m.authorizationEndTime) - Date.now() <= 24 * 3600_000 + 1000);
  });

  it('seals with a signed human operator invocation and records provenance', async () => {
    const ctx = await signOperatorInvocation(invocation(), identity);
    assert.equal(ctx.authSource, 'OPERATOR_CLI_INVOCATION');
    assert.equal(ctx.actorType, 'USER');
    const { mandate, provenance } = await sealAutonomousMandate(store, buildAutonomousMandate({ projectId: 'proj' }), ctx, {
      specFingerprint: FP,
      entryPoint: 'aidm run --spec',
    });
    assert.equal((await store.loadMandate())?.mandateRevision, mandate.mandateRevision);
    assert.equal(provenance.authSource, 'OPERATOR_CLI_INVOCATION');
    assert.equal(provenance.specFingerprint, FP);
    assert.ok(fs.existsSync(path.join(dir, '.ai-manager', 'state', 'autonomous-authorization.json')));
  });

  it('LLM-style unsigned / self-approving contexts are rejected (BLOCKED, nothing written)', async () => {
    const m = buildAutonomousMandate({ projectId: 'proj' });
    const forged = [
      undefined,
      { authSource: 'OPERATOR_CLI_INVOCATION', actorType: 'USER', verified: true, projectId: 'proj' },
      { actor: 'DIRECTOR', approved: true, selfApproved: true, isTrustedHumanAuth: true },
      { ...(await signOperatorInvocation(invocation(), identity)), budgetUsd: '9999' }, // tampered after signing
    ];
    for (const ctx of forged) {
      await assert.rejects(
        sealAutonomousMandate(store, m, ctx as never, { specFingerprint: FP, entryPoint: 'x' }),
        /WAITING_FOR_TRUSTED_IDENTITY|BLOCKED_ON_AUTH_CONTEXT|Cannot|signature|missing/i
      );
    }
    assert.equal(await store.exists(), false);
  });

  it('a different identity key cannot seal (signature from foreign key)', async () => {
    const other = new InMemoryIdentityManager({ baseDir: dir });
    const ctx = await signOperatorInvocation(invocation(), other);
    await assert.rejects(
      sealAutonomousMandate(store, buildAutonomousMandate({ projectId: 'proj' }), ctx, { specFingerprint: FP, entryPoint: 'x' }),
      /WAITING_FOR_TRUSTED_IDENTITY/
    );
  });

  it('replayed operator context is rejected (nonce anti-replay)', async () => {
    const ctx = await signOperatorInvocation(invocation(), identity);
    const m = buildAutonomousMandate({ projectId: 'proj' });
    await sealAutonomousMandate(store, m, ctx, { specFingerprint: FP, entryPoint: 'x' });
    await assert.rejects(sealAutonomousMandate(store, m, ctx, { specFingerprint: FP, entryPoint: 'x' }), /Replayed|WAITING_FOR_TRUSTED_IDENTITY/);
  });

  it('context bound to another spec or another project is rejected', async () => {
    const ctx = await signOperatorInvocation(invocation(), identity);
    await assert.rejects(
      sealAutonomousMandate(store, buildAutonomousMandate({ projectId: 'proj' }), ctx, { specFingerprint: 'b'.repeat(64), entryPoint: 'x' }),
      /different spec/
    );
    const ctx2 = await signOperatorInvocation(invocation({ projectId: 'other' }), identity);
    await assert.rejects(
      sealAutonomousMandate(store, buildAutonomousMandate({ projectId: 'proj' }), ctx2, { specFingerprint: FP, entryPoint: 'x' }),
      /WAITING_FOR_TRUSTED_IDENTITY/
    );
  });

  it('nested sealing while an autonomous run lock exists is refused', async () => {
    fs.mkdirSync(path.join(dir, '.ai-manager', 'state'), { recursive: true });
    fs.writeFileSync(path.join(dir, AUTONOMOUS_RUN_LOCK_FILE), '{}');
    const ctx = await signOperatorInvocation(invocation(), identity);
    await assert.rejects(
      sealAutonomousMandate(store, buildAutonomousMandate({ projectId: 'proj' }), ctx, { specFingerprint: FP, entryPoint: 'x' }),
      /already active/
    );
  });

  it('operator-invocation predicate enforces USER actor, nonce, project, spec binding and short TTL', () => {
    const now = Date.now();
    const ok = {
      authSource: 'OPERATOR_CLI_INVOCATION',
      actorType: 'USER',
      nonce: crypto.randomUUID(),
      projectId: 'p',
      specFingerprint: FP,
      issuedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + 60_000).toISOString(),
    };
    assert.equal(isValidOperatorCliInvocation(ok, 'p'), true);
    assert.equal(isValidOperatorCliInvocation({ ...ok, actorType: 'DIRECTOR' }, 'p'), false);
    assert.equal(isValidOperatorCliInvocation({ ...ok, nonce: undefined }, 'p'), false);
    assert.equal(isValidOperatorCliInvocation(ok, 'q'), false);
    assert.equal(isValidOperatorCliInvocation({ ...ok, specFingerprint: 'nope' }, 'p'), false);
    assert.equal(
      isValidOperatorCliInvocation({ ...ok, expiresAt: new Date(now + OPERATOR_CLI_INVOCATION_MAX_TTL_MS + 1000).toISOString() }, 'p'),
      false
    );
    assert.equal(isValidOperatorCliInvocation({ ...ok, authSource: 'TRUSTED_IDE' }, 'p'), false);
  });

  it('policy engine: IMPLEMENT_TASK on IMPLEMENTATION task is ALLOW; REPLAN requires human; out-of-scope file denied', async () => {
    const ctx = await signOperatorInvocation(invocation(), identity);
    await sealAutonomousMandate(store, buildAutonomousMandate({ projectId: 'proj' }), ctx, { specFingerprint: FP, entryPoint: 'x' });
    const specStore = new SpecStore({ baseDir: dir });
    await specStore.saveTasks([
      {
        task_id: 'TASK-001', parent_feature_id: 'FEAT', title: 't', description: 'd', traceability_sources: ['SYSTEM_REQUIREMENT: REQ-001'],
        dependencies: [], acceptance_criteria: ['a'], status: 'READY', attempt: 0, max_attempts: 2, priority: 'HIGH', risk_level: 'CAUTION',
        created_at: new Date().toISOString(), started_at: null, completed_at: null, hierarchy_level: 'TASK', metadata: { taskClass: 'IMPLEMENTATION' },
      },
    ] as never, { bypassValidation: true });
    const engine = new AuthorizationPolicyEngine({ mandateStore: store, historyManager: new HistoryManager({ baseDir: dir }), specStore });
    const env = (actionType: string, payload: Record<string, unknown>) => ({
      actionId: crypto.randomUUID(), idempotencyKey: crypto.randomUUID(), projectId: 'proj', directorSessionId: 's', actor: 'DIRECTOR', actorRole: 'DIRECTOR',
      actionType, basedOnContextFingerprint: 'fp', understandingRevision: 1, createdAt: new Date().toISOString(), payload,
    });
    assert.equal((await engine.evaluateAction(env('IMPLEMENT_TASK', { taskId: 'TASK-001', targetFiles: ['src/a.ts'] }) as never)).decisionResult, 'ALLOW');
    assert.equal((await engine.evaluateAction(env('REPLAN', {}) as never)).decisionResult, 'REQUIRE_HUMAN_APPROVAL');
    assert.equal((await engine.evaluateAction(env('REQUEST_HUMAN_DECISION', {}) as never)).decisionResult, 'REQUIRE_HUMAN_APPROVAL');
    assert.equal((await engine.evaluateAction(env('IMPLEMENT_TASK', { taskId: 'TASK-001', targetFiles: ['../outside.ts'] }) as never)).decisionResult, 'DENY');
    assert.equal((await engine.evaluateAction(env('IMPLEMENT_TASK', { taskId: 'TASK-001', targetFiles: ['.ai-manager/state/project-mandate.json'] }) as never)).decisionResult, 'DENY');
    assert.equal((await engine.evaluateAction(env('IMPLEMENT_TASK', { taskId: 'TASK-001', selfApproved: true }) as never)).decisionResult, 'DENY');
  });
});
