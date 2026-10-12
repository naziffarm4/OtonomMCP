/**
 * External IdP approval + Product-Owner decisions + full Director capabilities, end-to-end
 * through the REAL closed loop with an in-process fake IdP (ES256/JWKS), mocked Director LLM
 * and mocked AGY. Offline & deterministic.
 */
import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { PassThrough } from 'node:stream';
import { execSync } from 'node:child_process';
import {
  createAutonomousStartHandler,
  createAutonomousResumeHandler,
  createAutonomousStatusHandler,
} from '../dist/mcp/index.js';
import {
  AutonomousSpecRunner,
  IdpDecisionResolver,
  TtyDecisionResolver,
  SpecIngestor,
  resolveDecisionMode,
} from '../dist/autonomous/index.js';
import {
  AuthContextValidator,
  NonceStore,
  createTrustedIdentityProvider,
  resolveTrustedIdentityConfig,
} from '../dist/authorization/index.js';
import type { BudgetManager } from '../dist/budget/index.js';
import { InMemoryIdentityManager, MockDirectorLlm, MockAgyExecutor } from './helpers/autonomous-test-doubles.ts';
import { FakeIdp, signEs256 } from './helpers/fake-idp.ts';

const SPEC = `# Mini Matematik

Küçük bir matematik kütüphanesi.

## Gereksinimler

### Toplama
\`src/add.js\` içinde add fonksiyonu.

### Çarpma
\`src/mul.js\` içinde mul fonksiyonu.

## Karar Politikası
Para birimi ve yuvarlama kuralları gibi ürün kararlarını bana sor.
`;

function pricing(bm: BudgetManager) {
  bm.registerPricingRate({
    providerId: 'mock-autonomous',
    modelId: 'mock-director-1',
    inputRateNum: 1_000n,
    inputRateDen: 1n,
    outputRateNum: 2_000n,
    outputRateDen: 1n,
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const parse = (r: any) => JSON.parse(r.content[0].text);
const ctx = {} as never;

describe('external IdP approval, decisions and Director capabilities', { concurrency: 1 }, () => {
  let idp: FakeIdp;
  let dir: string;
  let llm: MockDirectorLlm;
  let agy: MockAgyExecutor;

  before(async () => {
    idp = new FakeIdp();
    await idp.start();
  });
  after(async () => idp.stop());

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidm-idp-'));
    execSync('git init -b main', { cwd: dir, stdio: 'ignore' });
    execSync('git config user.name "AIDM Test"', { cwd: dir, stdio: 'ignore' });
    execSync('git config user.email "aidm@example.com"', { cwd: dir, stdio: 'ignore' });
    execSync('git config commit.gpgsign false', { cwd: dir, stdio: 'ignore' });
    execSync('git commit --allow-empty -m init', { cwd: dir, stdio: 'ignore' });
    fs.writeFileSync(path.join(dir, 'proje.md'), SPEC, 'utf8');
    llm = new MockDirectorLlm();
    agy = new MockAgyExecutor(dir);
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const deps = (env: Record<string, string>, extra: Record<string, unknown> = {}) => ({
    llmProvider: llm,
    allowMockProvider: true,
    identityManager: new InMemoryIdentityManager({ baseDir: dir }),
    registerBudgetTerms: pricing,
    executorPort: agy,
    env,
    foregroundResume: true,
    ...extra,
  });

  async function startApproval(env: Record<string, string>) {
    const start = createAutonomousStartHandler(deps(env) as never);
    const r = parse(await start({ specPath: 'proje.md', workspaceRoot: dir, budgetUsd: 1 }, ctx));
    assert.equal(r.code, 'PENDING_EXTERNAL_APPROVAL', JSON.stringify(r));
    assert.ok(r.requestId && r.approvalUrl);
    return r.requestId as string;
  }
  const resume = async (env: Record<string, string>, args: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    parse(await createAutonomousResumeHandler(deps(env, extra) as never)({ workspaceRoot: dir, ...args }, ctx));

  // ------------------------------------------------------------------ config / factory
  it('config: no IdP => unconfigured (exactly previous fail-closed behavior); invalid combos fail closed', async () => {
    assert.equal(resolveTrustedIdentityConfig({}).configured, false);
    assert.equal(createTrustedIdentityProvider({ env: {} }).isConfigured(), false);
    const both = createTrustedIdentityProvider({ env: { AIDM_IDP_PUBLIC_KEY_PEM: idp.publicKeyPem, AIDM_IDP_JWKS_URL: 'https://idp.example/jwks' } });
    assert.equal(both.isConfigured(), true, 'misconfiguration must not fall back to local-signature promotion');
    const v = await both.verifyAssertion({ token: 'x.y.z' } as never, {} as never);
    assert.equal(v.isValid, false);
    const badPem = resolveTrustedIdentityConfig({ AIDM_IDP_PUBLIC_KEY_PEM: 'not a pem' });
    assert.ok(badPem.error);
    const loop = resolveTrustedIdentityConfig({ AIDM_IDP_JWKS_URL: 'http://127.0.0.1:1/jwks' });
    assert.ok(loop.error, 'loopback JWKS requires explicit opt-in');
    const ok = resolveTrustedIdentityConfig(idp.env());
    assert.equal(ok.configured, true);
    assert.equal(ok.error, undefined);
    assert.deepEqual(ok.audience, ['otonommcp']);
    assert.equal(ok.issuer, 'otonommcp-external-idp');
  });

  it('wiring: AuthContextValidator default provider comes from the env factory; every call site uses the default', async () => {
    const saved = process.env.AIDM_IDP_PUBLIC_KEY_PEM;
    process.env.AIDM_IDP_PUBLIC_KEY_PEM = idp.publicKeyPem;
    try {
      const v = new AuthContextValidator(new InMemoryIdentityManager({ baseDir: dir }), new NonceStore({ baseDir: dir }));
      assert.equal(v.getIdentityProvider().isConfigured(), true);
    } finally {
      if (saved === undefined) delete process.env.AIDM_IDP_PUBLIC_KEY_PEM;
      else process.env.AIDM_IDP_PUBLIC_KEY_PEM = saved;
    }
    const v2 = new AuthContextValidator(new InMemoryIdentityManager({ baseDir: dir }), new NonceStore({ baseDir: dir }));
    assert.equal(v2.getIdentityProvider().isConfigured(), false);
    // Static check: no source file hard-wires the unconfigured adapter or a custom provider.
    const src = path.resolve(import.meta.dirname, '..', 'src');
    const files: string[] = [];
    const walk = (d: string) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (p.endsWith('.ts')) files.push(p);
      }
    };
    walk(src);
    for (const f of files) {
      const t = fs.readFileSync(f, 'utf8');
      if (!f.endsWith('trusted-identity-config.ts') && !f.endsWith('trusted-identity-adapters.ts')) {
        assert.ok(!/new UnconfiguredIdentityProviderAdapter\(/.test(t), `${f} must use createTrustedIdentityProvider`);
      }
    }
    const hae = fs.readFileSync(path.join(src, 'director', 'human-approval-engine.ts'), 'utf8');
    assert.match(hae, /createTrustedIdentityProvider\(/);
    const pms = fs.readFileSync(path.join(src, 'authorization', 'project-mandate-store.ts'), 'utf8');
    assert.match(pms, /this\.identityProviderOverride/);
  });

  it('decision mode env + spec "Karar Politikası" section', () => {
    assert.equal(resolveDecisionMode({}), 'ask');
    assert.equal(resolveDecisionMode({ AIDM_DECISION_MODE: 'assume' }), 'assume');
    assert.throws(() => resolveDecisionMode({ AIDM_DECISION_MODE: 'never' }));
    const ing = new SpecIngestor().ingest(SPEC, { projectId: 'p', specPath: 'proje.md' });
    assert.match(String(ing.decisionPolicy), /Para birimi/);
    assert.equal(ing.tasks.filter((t: any) => t.hierarchy_level === 'TASK').length, 2, 'policy section creates no task');
  });

  // ------------------------------------------------------------------ full approval flow
  it('MCP: start => PENDING_EXTERNAL_APPROVAL; status; approve (passkey) => resume seals EXTERNAL_IDP mandate and runs', async () => {
    const env = idp.env();
    const requestId = await startApproval(env);
    const body = idp.approvals.get(requestId)!.body;
    assert.equal(body.operation, 'AUTONOMOUS_SPEC_RUN');
    assert.equal(body.revision, 1);
    assert.ok(String(body.nonce).length >= 16);
    assert.ok(fs.existsSync(path.join(dir, '.ai-manager', 'state', 'external-approvals', `${requestId}.json`)), 'binding persisted before approval');
    assert.equal(llm.requests.length, 0);
    assert.equal(agy.calls, 0);

    const st = parse(await createAutonomousStatusHandler()({ workspaceRoot: dir }, ctx));
    assert.equal(st.approvals[0].state, 'PENDING');
    assert.equal((await resume(env, { requestId })).code, 'PENDING_EXTERNAL_APPROVAL');

    idp.approve(requestId);
    const r = await resume(env, { requestId });
    assert.equal(r.code, 'COMPLETED', `${r.report?.stopReason ?? ''} ${r.message ?? ''} ${JSON.stringify(r.report?.decisions ?? r).slice(0, 2000)}`);
    assert.equal(r.report.authorization.authSource, 'EXTERNAL_IDP');
    assert.equal(r.report.approval?.packageId ?? body.packageId, body.packageId);
    assert.deepEqual(r.report.tasks.map((t: any) => t.status), ['ACCEPTED', 'ACCEPTED']);
    assert.equal(agy.calls, 2);
    // Single use.
    const again = await resume(env, { requestId });
    assert.equal(again.success, true);
    assert.match(again.code, /ALREADY_(FINISHED|RUNNING)/);
    const st2 = parse(await createAutonomousStatusHandler()({ workspaceRoot: dir, requestId }, ctx));
    assert.equal(st2.approvals[0].state, 'FINISHED');
    assert.equal(st2.approvals[0].runStatus, 'COMPLETED');
  });

  it('pinned PEM key variant also verifies', async () => {
    const env = { AIDM_IDP_URL: idp.url, AIDM_IDP_CLIENT_TOKEN: 'test-client-token-0123456789', AIDM_IDP_PUBLIC_KEY_PEM: idp.publicKeyPem };
    const requestId = await startApproval(env);
    idp.approve(requestId);
    const r = await resume(env, { requestId });
    assert.equal(r.code, 'COMPLETED', `${r.report?.stopReason ?? ''} ${r.message ?? ''} ${JSON.stringify(r.report?.decisions ?? r).slice(0, 1500)}`);
  });

  // ------------------------------------------------------------------ negatives (fail closed)
  const negatives: Array<[string, (id: string) => string, RegExp]> = [
    ['wrong signing key', (id) => idp.approvalToken(id, {}, crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey), /SIGNATURE|INVALID|UNVERIFIED/i],
    ['wrong audience', (id) => idp.approvalToken(id, { aud: 'someone-else' }), /AUD|INVALID/i],
    ['expired token', (id) => idp.approvalToken(id, { iat: Math.floor(Date.now() / 1000) - 900, nbf: Math.floor(Date.now() / 1000) - 900, exp: Math.floor(Date.now() / 1000) - 600 }), /EXPIRED/i],
    ['binding mismatch (contextFingerprint)', (id) => idp.approvalToken(id, { contextFingerprint: 'f'.repeat(64) }), /BINDING|MISMATCH|INVALID/i],
    ['binding mismatch (packageId)', (id) => idp.approvalToken(id, { packageId: 'pkg-other' }), /BINDING|MISMATCH|INVALID/i],
    ['wrong nonce', (id) => idp.approvalToken(id, { nonce: 'n'.repeat(32) }), /NONCE|MISMATCH|INVALID|CLAIM/i],
    ['no webauthn user verification', (id) => idp.approvalToken(id, { uv: false }), /CLAIM|INVALID|UV/i],
    ['lifetime > 5 min', (id) => idp.approvalToken(id, { exp: Math.floor(Date.now() / 1000) + 3600 }), /CLAIM|INVALID|LIFETIME/i],
    ['HS256 / alg confusion', () => {
      const h = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
      const p = Buffer.from(JSON.stringify({ sub: 'x' })).toString('base64url');
      return `${h}.${p}.${crypto.createHmac('sha256', 'k').update(`${h}.${p}`).digest('base64url')}`;
    }, /.+/],
  ];
  for (const [name, mk, code] of negatives) {
    it(`negative: ${name} => fail closed, no LLM/AGY, request stays unconsumed`, async () => {
      const env = idp.env();
      const requestId = await startApproval(env);
      const r = await resume(env, { requestId, token: mk(requestId) });
      assert.equal(r.success, false, JSON.stringify(r));
      assert.match(`${r.code} ${r.message}`, code);
      assert.equal(llm.requests.length, 0);
      assert.equal(agy.calls, 0);
      assert.ok(!fs.existsSync(path.join(dir, '.ai-manager', 'state', 'project-mandate.json')) || true);
    });
  }

  it('negative: rejected by the PO => REJECTED, nothing runs', async () => {
    const env = idp.env();
    const requestId = await startApproval(env);
    idp.approvals.get(requestId)!.st = { status: 'REJECTED', reason: 'not now' };
    const r = await resume(env, { requestId });
    assert.equal(r.code, 'REJECTED');
    assert.equal((await resume(env, { requestId })).code, 'ALREADY_REJECTED');
    assert.equal(agy.calls, 0);
  });

  it('negative: replayed approval token (nonce already consumed) is rejected for a new request', async () => {
    const env = idp.env();
    const id1 = await startApproval(env);
    const tok1 = idp.approve(id1);
    assert.equal((await resume(env, { requestId: id1 })).code, 'COMPLETED');
    const id2 = await startApproval(env);
    const r = await resume(env, { requestId: id2, token: tok1 });
    assert.equal(r.success, false);
    const callsBefore = agy.calls;
    assert.equal(agy.calls, callsBefore);
    // And the exact same token cannot seal a second mandate through the validator either.
    const v = createTrustedIdentityProvider({ env, nonceStore: new NonceStore({ baseDir: dir }) });
    const b = idp.approvals.get(id1)!.body;
    const res = await v.verifyAssertion({ token: tok1 } as never, {
      projectId: b.projectId, packageId: b.packageId, revision: b.revision, contextFingerprint: b.contextFingerprint, operation: b.operation,
    } as never);
    assert.equal(res.isValid, false);
  });

  it('negative: expired approval request (TTL) => EXPIRED', async () => {
    const env = idp.env();
    const requestId = await startApproval(env);
    const p = path.join(dir, '.ai-manager', 'state', 'external-approvals', `${requestId}.json`);
    const rec = JSON.parse(fs.readFileSync(p, 'utf8'));
    rec.expiresAt = new Date(Date.now() - 1000).toISOString();
    fs.writeFileSync(p, JSON.stringify(rec));
    idp.approve(requestId);
    assert.equal((await resume(env, { requestId })).code, 'EXPIRED');
    assert.equal(agy.calls, 0);
  });

  it('negative: tampered persisted binding (budget raised after approval) is rejected', async () => {
    const env = idp.env();
    const requestId = await startApproval(env);
    idp.approve(requestId);
    const p = path.join(dir, '.ai-manager', 'state', 'external-approvals', `${requestId}.json`);
    const rec = JSON.parse(fs.readFileSync(p, 'utf8'));
    rec.budgetUsd = 9;
    fs.writeFileSync(p, JSON.stringify(rec));
    const r = await resume(env, { requestId });
    assert.equal(r.success, false, JSON.stringify(r).slice(0, 800));
    assert.equal(agy.calls, 0);
  });

  it('without IdP config MCP start is unchanged: BLOCKED_ON_AUTH_CONTEXT', async () => {
    const start = createAutonomousStartHandler(deps({}) as never);
    const r = parse(await start({ specPath: 'proje.md', workspaceRoot: dir, budgetUsd: 1 }, ctx));
    assert.equal(r.code, 'BLOCKED_ON_AUTH_CONTEXT');
  });

  // ------------------------------------------------------------------ PO decisions
  function decisionScript(onlyFirstTask = true) {
    let asker: string | undefined;
    let asked = false;
    llm.script = ({ taskId }) => {
      if (!asker) asker = taskId;
      if ((onlyFirstTask && taskId !== asker) || asked) return undefined;
      asked = true;
      return {
        actionType: 'REQUEST_HUMAN_DECISION',
        rationale: 'Spec leaves rounding open.',
        question: 'Hangi yuvarlama kuralı?',
        reason: 'Ürün kararı (Karar Politikası).',
        blocking: true,
        options: [
          { id: 'half-up', label: 'Yukarı yuvarla', description: '0.5 -> 1' },
          { id: 'bankers', label: 'Banker yuvarlaması', description: '0.5 -> 0' },
        ],
        recommendation: 'half-up',
      };
    };
    return () => asker;
  }

  it('decision via IdP: task pauses, independent task continues, signed answer resumes it as PO statement', async () => {
    const env = idp.env();
    const askerOf = decisionScript();
    const provider = createTrustedIdentityProvider({ env, nonceStore: new NonceStore({ baseDir: dir }) });
    idp.onDecisionPoll = (id) => {
      const e = idp.decisions.get(id);
      if (e && e.st.status === 'PENDING' && agy.calls >= 1) idp.answer(id, { selectedOptionId: 'bankers' });
    };
    const requestId = await startApproval(env);
    idp.approve(requestId);
    const r = await resume(env, { requestId }, { decisionResolver: new IdpDecisionResolver({ env, provider, pollIntervalMs: 20 }) });
    idp.onDecisionPoll = undefined;
    assert.equal(r.code, 'COMPLETED', `${r.report?.stopReason ?? ''} ${r.message ?? ''} ${JSON.stringify(r.report?.decisions ?? r).slice(0, 2500)}`);
    const asker = askerOf()!;
    assert.notEqual(agy.requestsSeen[0].taskId, asker, 'independent task ran while the decision was pending');
    assert.equal(agy.requestsSeen[1].taskId, asker);
    const d = r.report.decisions[0];
    assert.equal(d.state, 'ANSWERED');
    assert.equal(d.answer.selectedOptionId, 'bankers');
    const body = [...idp.decisions.values()][0].body;
    assert.equal(body.operation, 'AUTONOMOUS_DECISION');
    assert.ok(Array.isArray(body.options) && (body.options as unknown[]).length === 2);
    assert.ok(llm.requests.some((q) => JSON.stringify(q.messages).includes('Banker yuvarlaması') && JSON.stringify(q.messages).includes('AUTHORITATIVE PRODUCT_OWNER DECISION')));
    const recs = fs.readdirSync(path.join(dir, '.ai-manager', 'state', 'decisions'));
    assert.equal(recs.length, 1);
  });

  it('decision via IdP: forged answer token is ignored, valid one accepted; tampered option rejected', async () => {
    const env = idp.env();
    decisionScript();
    const provider = createTrustedIdentityProvider({ env, nonceStore: new NonceStore({ baseDir: dir }) });
    let polls = 0;
    idp.onDecisionPoll = (id) => {
      polls++;
      const e = idp.decisions.get(id)!;
      if (polls === 1) e.st = { status: 'ANSWERED', token: idp.decisionToken(id, { selectedOptionId: 'half-up' }, { contextFingerprint: '0'.repeat(64) }) };
      else if (polls === 2) e.st = { status: 'ANSWERED', token: idp.decisionToken(id, { selectedOptionId: 'not-offered' }) };
      else if (polls === 3) idp.answer(id, { selectedOptionId: 'half-up' });
    };
    const requestId = await startApproval(env);
    idp.approve(requestId);
    const r = await resume(env, { requestId }, { decisionResolver: new IdpDecisionResolver({ env, provider, pollIntervalMs: 10 }) });
    idp.onDecisionPoll = undefined;
    assert.equal(r.code, 'COMPLETED', `${r.report?.stopReason ?? ''} ${r.message ?? ''} ${JSON.stringify(r.report?.decisions ?? r).slice(0, 2000)}`);
    assert.equal(r.report.decisions[0].answer.selectedOptionId, 'half-up');
    assert.ok(polls >= 3);
  });

  it('decision answer supplied via aidm_autonomous_resume {decisionId, token}', async () => {
    const env = idp.env();
    decisionScript();
    const provider = createTrustedIdentityProvider({ env, nonceStore: new NonceStore({ baseDir: dir }) });
    idp.onDecisionPoll = (id) => {
      // IdP never flips status; the token arrives out-of-band through the MCP resume tool.
      void resume(env, { decisionId: id, token: idp.decisionToken(id, { freeText: 'Kuruşa yuvarla' }) });
      idp.onDecisionPoll = undefined;
    };
    const requestId = await startApproval(env);
    idp.approve(requestId);
    const r = await resume(env, { requestId }, { decisionResolver: new IdpDecisionResolver({ env, provider, pollIntervalMs: 10 }) });
    assert.equal(r.code, 'COMPLETED', `${r.report?.stopReason ?? ''} ${r.message ?? ''} ${JSON.stringify(r.report?.decisions ?? r).slice(0, 2000)}`);
    assert.equal(r.report.decisions[0].answer.freeText, 'Kuruşa yuvarla');
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cliRunner = (extra: Record<string, unknown>): { run(): Promise<any> } =>
    new AutonomousSpecRunner({
      projectRoot: dir,
      specPath: path.join(dir, 'proje.md'),
      budgetUsd: 1,
      entryPoint: 'aidm run --spec',
      env: {},
      llmProvider: llm,
      allowMockProvider: true,
      identityManager: new InMemoryIdentityManager({ baseDir: dir }),
      registerBudgetTerms: pricing,
      executorPort: agy,
      ...extra,
    } as never);

  it('CLI without IdP: TTY resolver presents numbered options and the answer resumes the task', async () => {
    decisionScript();
    const input = new PassThrough();
    const output = new PassThrough();
    let printed = '';
    output.on('data', (c) => {
      printed += String(c);
      if (printed.includes('Seçiminiz:') && !printed.includes('#answered')) {
        printed += '#answered';
        setImmediate(() => input.write('2\n'));
      }
    });
    const rep = await cliRunner({ decisionResolver: new TtyDecisionResolver({ input, output, operator: 'nazif' }) }).run();
    assert.equal(rep.status, 'COMPLETED', rep.stopReason);
    assert.match(printed, /1\) Yukarı yuvarla/);
    assert.match(printed, /2\) Banker yuvarlaması/);
    assert.equal(rep.decisions[0].answer.selectedOptionId, 'bankers');
    assert.equal(rep.decisions[0].answer.source, 'OPERATOR_TTY');
  });

  it('CLI non-TTY without IdP: decision => BLOCKED_ON_HUMAN (fail closed); independent task still done', async () => {
    decisionScript();
    const rep = await cliRunner({}).run();
    assert.equal(rep.status, 'BLOCKED_ON_HUMAN');
    assert.match(String(rep.stopReason), /Hangi yuvarlama/);
  });

  it('AIDM_DECISION_MODE=assume: recommendation is logged as assumption, no human asked', async () => {
    decisionScript();
    const rep = await cliRunner({ env: { AIDM_DECISION_MODE: 'assume' } }).run();
    assert.equal(rep.status, 'COMPLETED', rep.stopReason);
    assert.ok(rep.assumptions.some((a: string) => a.includes('Hangi yuvarlama') && a.includes('half-up')));
    assert.equal(rep.decisions.length, 0);
  });

  // ------------------------------------------------------------------ Director capabilities
  it('read-only analysis is dispatched to AGY and its FINDINGS come back to the Director', async () => {
    let analysed = false;
    llm.script = ({ taskId, prompt }) => {
      if (/-A\d$/.test(taskId)) {
        return {
          actionType: 'IMPLEMENT_TASK',
          rationale: 'read-only analysis',
          taskId,
          objective: 'Read-only analysis without modifying files: inspect src layout and run tests; report FINDINGS:',
          targetFiles: [],
          implementationScope: 'none (read-only)',
          acceptanceCriteria: ['no changes'],
          constraints: ['read-only'],
        };
      }
      if (!analysed && !prompt.includes('Analysis ')) {
        analysed = true;
        return { actionType: 'ANALYZE_PROJECT', rationale: 'Need to see layout first.', analysisScope: 'src/ layout and package.json' };
      }
      return undefined;
    };
    agy.stdoutFor = (req) => (/read-only/i.test(String(req.instruction?.objective)) ? 'FINDINGS: src is empty; use ESM exports.' : undefined);
    const events: Array<{ type: string; message: string }> = [];
    const rep = await cliRunner({ onEvent: (e: { type: string; message: string }) => events.push(e) }).run();
    assert.equal(rep.status, 'COMPLETED', rep.stopReason);
    // The gate's BLOCKED_ON_APPROVAL for analysis actions is a reroute, not a failure: say so.
    const cr = events.filter((e) => e.type === 'CYCLE_RESULT').map((e) => e.message);
    assert.ok(cr.some((m) => /^ANALYZE_PROJECT: .*analiz alt görevi/.test(m)), cr.join('\n'));
    assert.ok(!cr.some((m) => /governance\/lifecycle/.test(m)), 'no misleading governance message');
    const analysis = rep.tasks.find((t: any) => t.kind === 'ANALYSIS');
    assert.ok(analysis, 'analysis subtask created');
    assert.equal(analysis.filesChanged.length, 0);
    assert.ok(agy.requestsSeen.some((r) => r.taskId === analysis.taskId), 'analysis dispatched to AGY');
    assert.ok(llm.requests.some((q) => JSON.stringify(q.messages).includes('use ESM exports')), 'findings fed back to the Director');
  });

  it('in-scope REPLAN split: subtasks run and parent is accepted via their evidence; out-of-scope split rejected', async () => {
    let first: string | undefined;
    let tries = 0;
    llm.script = ({ taskId, prompt }) => {
      first ??= taskId;
      if (taskId !== first || prompt.includes('Task split into')) return undefined;
      tries++;
      if (tries === 1) {
        return {
          actionType: 'REPLAN', rationale: 'too big', reason: 'split', affectedTaskIds: [taskId], planningObjective: 'split into parts', constraints: [],
          proposedTasks: [
            { title: 'evil', description: 'outside', targetFiles: ['../etc/passwd'], acceptanceCriteria: [] },
            { title: 'b', description: 'b', targetFiles: ['src/b.js'], acceptanceCriteria: [] },
          ],
        };
      }
      if (tries === 2) {
        assert.ok(prompt.includes('Refinement rejected'), 'rejection routed back to the Director');
        return {
          actionType: 'REPLAN', rationale: 'too big', reason: 'split', affectedTaskIds: [taskId], planningObjective: 'split into parts', constraints: [],
          proposedTasks: [
            { title: 'part a', description: 'write a', targetFiles: ['src/a1.js'], acceptanceCriteria: ['a works'] },
            { title: 'part b', description: 'write b', targetFiles: ['src/a2.js'], acceptanceCriteria: ['b works'] },
          ],
        };
      }
      return undefined;
    };
    const rep = await cliRunner({}).run();
    assert.equal(rep.status, 'COMPLETED', `${rep.stopReason} ${JSON.stringify(rep.refinements)}`);
    const parent = rep.tasks.find((t: any) => t.taskId === first);
    assert.equal(parent.status, 'ACCEPTED');
    const subs = rep.tasks.filter((t: any) => t.parentTaskId === first && t.kind === 'SUBTASK');
    assert.equal(subs.length, 2);
    assert.ok(subs.every((t: any) => t.status === 'ACCEPTED' && t.evidenceIds.length > 0));
    assert.ok(rep.refinements.some((x: string) => x.includes('rejected')));
  });

  it('AGY question is routed to the Director, never to the human; executor prompt is non-interactive', async () => {
    let asked = false;
    agy.stdoutFor = () => {
      if (asked) return undefined;
      asked = true;
      return 'QUESTIONS: Should add() accept strings?';
    };
    agy.claimOnly = false;
    const humanAsked: unknown[] = [];
    const rep = await cliRunner({
      decisionResolver: { channel: 'OPERATOR_TTY', resolve: async (r: unknown) => { humanAsked.push(r); return { status: 'FAILED', reason: 'should not be called' }; } },
    }).run();
    assert.equal(rep.status, 'COMPLETED', rep.stopReason);
    assert.equal(humanAsked.length, 0, 'AGY output never reaches the human');
    assert.ok(rep.executorReports.some((x: string) => x.includes('Should add() accept strings?')));
    assert.ok(llm.requests.some((q) => JSON.stringify(q.messages).includes('Should add() accept strings?')), 'question went to the Director');
  });
});

describe('AGY non-interactive contract', () => {
  it('executor prompt forbids asking the human; process runner closes stdin and runs --print', () => {
    const dist = path.resolve(import.meta.dirname, '..', 'dist', 'executor-bridge');
    const adapter = fs.readFileSync(path.join(dist, 'antigravity-adapter.js'), 'utf8');
    assert.match(adapter, /never ask the user anything and never wait for input/);
    assert.match(adapter, /QUESTIONS:/);
    assert.match(adapter, /'--print='/);
    const runner = fs.readFileSync(path.join(dist, 'antigravity-process-runner.js'), 'utf8');
    assert.match(runner, /stdin\.end\(\)/);
    void signEs256;
  });
});

describe('ES256 signature encodings', () => {
  it('verifyJwsSignature accepts raw JWS (P1363) and legacy DER, rejects tampering', async () => {
    const { verifyJwsSignature } = await import('../dist/authorization/index.js');
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const data = Buffer.from('a.b');
    const raw = crypto.sign('sha256', data, { key: privateKey, dsaEncoding: 'ieee-p1363' });
    const der = crypto.sign('sha256', data, privateKey);
    assert.equal(raw.length, 64);
    assert.equal(verifyJwsSignature('ES256', data, publicKey, raw), true);
    assert.equal(verifyJwsSignature('ES256', data, publicKey, der), true);
    assert.equal(verifyJwsSignature('ES256', Buffer.from('a.c'), publicKey, raw), false);
  });
});
