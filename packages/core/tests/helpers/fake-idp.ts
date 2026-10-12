/**
 * In-process fake external IdP (HTTP, loopback) implementing docs/EXTERNAL-IDP-CONTRACT.md.
 * Signs ES256 JWS (kid, raw P1363 signatures) exactly like a WebAuthn-backed IdP would after
 * a passkey ceremony. Tests drive approvals/answers explicitly.
 */
import * as http from 'node:http';
import * as crypto from 'node:crypto';
import type { AddressInfo } from 'node:net';

export const CLIENT_TOKEN = 'test-client-token-0123456789';

export function b64u(buf: Buffer | string): string {
  return Buffer.from(buf).toString('base64url');
}

export function signEs256(claims: Record<string, unknown>, key: crypto.KeyObject, kid: string): string {
  const header = b64u(JSON.stringify({ alg: 'ES256', typ: 'JWT', kid }));
  const payload = b64u(JSON.stringify(claims));
  const sig = crypto.sign('sha256', Buffer.from(`${header}.${payload}`), { key, dsaEncoding: 'ieee-p1363' });
  return `${header}.${payload}.${b64u(sig)}`;
}

type Status = { status: string; token?: string; reason?: string };

export class FakeIdp {
  readonly keys = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  readonly kid = 'fake-idp-key-1';
  readonly approvals = new Map<string, { body: Record<string, unknown>; st: Status }>();
  readonly decisions = new Map<string, { body: Record<string, unknown>; st: Status }>();
  /** Called on every decision GET poll; may answer the decision by setting st. */
  onDecisionPoll?: (id: string) => void;
  unauthorized = 0;
  private server?: http.Server;
  port = 0;

  get url(): string {
    return `http://127.0.0.1:${this.port}`;
  }
  get publicKeyPem(): string {
    return this.keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  }

  env(extra: Record<string, string> = {}): Record<string, string> {
    return {
      AIDM_IDP_URL: this.url,
      AIDM_IDP_CLIENT_TOKEN: CLIENT_TOKEN,
      AIDM_IDP_JWKS_URL: `${this.url}/.well-known/jwks.json`,
      AIDM_IDP_ALLOW_LOOPBACK_JWKS: '1',
      ...extra,
    };
  }

  baseClaims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    const now = Math.floor(Date.now() / 1000);
    const c: Record<string, unknown> = {
      iss: 'otonommcp-external-idp',
      aud: 'otonommcp',
      sub: 'po-nazif',
      actorRole: 'PRODUCT_OWNER',
      jti: crypto.randomUUID(),
      iat: now,
      nbf: now,
      exp: now + 300,
      amr: ['webauthn'],
      uv: true,
    };
    for (const [k, v] of Object.entries(overrides)) {
      if (v === undefined) delete c[k];
      else c[k] = v;
    }
    return c;
  }

  approvalToken(requestId: string, overrides: Record<string, unknown> = {}, key = this.keys.privateKey): string {
    const b = this.approvals.get(requestId)!.body;
    return signEs256(
      this.baseClaims({
        nonce: b.nonce,
        requestId,
        decision: 'APPROVED',
        projectId: b.projectId,
        packageId: b.packageId,
        revision: b.revision,
        contextFingerprint: b.contextFingerprint,
        operation: b.operation,
        ...overrides,
      }),
      key,
      this.kid
    );
  }

  approve(requestId: string, overrides: Record<string, unknown> = {}, key?: crypto.KeyObject): string {
    const token = this.approvalToken(requestId, overrides, key);
    this.approvals.get(requestId)!.st = { status: 'APPROVED', token };
    return token;
  }

  decisionToken(decisionId: string, answer: { selectedOptionId?: string; freeText?: string }, overrides: Record<string, unknown> = {}): string {
    const b = this.decisions.get(decisionId)!.body;
    return signEs256(
      this.baseClaims({
        nonce: b.nonce,
        decisionId,
        ...answer,
        projectId: b.projectId,
        packageId: b.packageId,
        revision: b.revision,
        runId: b.runId,
        taskId: b.taskId,
        operation: b.operation,
        contextFingerprint: b.contextFingerprint,
        ...overrides,
      }),
      this.keys.privateKey,
      this.kid
    );
  }

  answer(decisionId: string, answer: { selectedOptionId?: string; freeText?: string }, overrides: Record<string, unknown> = {}): void {
    this.decisions.get(decisionId)!.st = { status: 'ANSWERED', token: this.decisionToken(decisionId, answer, overrides) };
  }

  async start(): Promise<void> {
    this.server = http.createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((r) => this.server!.listen(0, '127.0.0.1', r));
    this.port = (this.server!.address() as AddressInfo).port;
  }
  async stop(): Promise<void> {
    await new Promise<void>((r) => this.server?.close(() => r()));
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const send = (code: number, body: unknown) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    const url = new URL(req.url ?? '/', this.url);
    if (req.method === 'GET' && url.pathname === '/.well-known/jwks.json') {
      const jwk = this.keys.publicKey.export({ format: 'jwk' });
      return send(200, { keys: [{ ...jwk, kid: this.kid, alg: 'ES256', use: 'sig' }] });
    }
    if (req.method === 'GET' && url.pathname === '/api/public-key.pem') {
      res.writeHead(200, { 'content-type': 'application/x-pem-file' });
      return void res.end(this.publicKeyPem);
    }
    if (req.headers.authorization !== `Bearer ${CLIENT_TOKEN}`) {
      this.unauthorized++;
      return send(401, { error: 'unauthorized' });
    }
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    const m = url.pathname.match(/^\/api\/(approval|decision)-requests(?:\/([^/]+))?$/);
    if (!m) return send(404, { error: 'not found' });
    const store = m[1] === 'approval' ? this.approvals : this.decisions;
    if (req.method === 'POST' && !m[2]) {
      const id = String(m[1] === 'approval' ? body.requestId : body.decisionId);
      store.set(id, { body, st: { status: 'PENDING' } });
      return send(201, {
        ...(m[1] === 'approval' ? { requestId: id, approvalUrl: `${this.url}/approve/${id}` } : { decisionId: id, decisionUrl: `${this.url}/decide/${id}` }),
        status: 'PENDING',
      });
    }
    if (req.method === 'GET' && m[2]) {
      const id = decodeURIComponent(m[2]);
      if (m[1] === 'decision') this.onDecisionPoll?.(id);
      const e = store.get(id);
      if (!e) return send(404, { error: 'not found' });
      return send(200, e.st);
    }
    return send(405, { error: 'method' });
  }
}
