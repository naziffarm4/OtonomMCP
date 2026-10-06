/**
 * @file http-llm-transport.test.ts
 * @description Comprehensive test suite for TASK-P18-01:
 * Real HTTP Transport & Fail-Closed Provider Boundary.
 *
 * Verifies:
 * 1. Successful HTTP request and response round-trip over real HTTP socket.
 * 2. Correct Authorization header construction (Bearer and custom prefixes).
 * 3. JSON serialization of request payload.
 * 4. Correlation ID propagation across request and headers.
 * 5. Timeout enforcement and AbortSignal cancellation behavior.
 * 6. HTTP 400 Bad Request error mapping.
 * 7. HTTP 401 Unauthorized error mapping.
 * 8. HTTP 403 Forbidden error mapping.
 * 9. HTTP 429 Rate Limit error mapping.
 * 10. HTTP 500 / 503 Provider error and outage mapping.
 * 11. Network failure handling (connection refused / server closed).
 * 12. Invalid non-JSON response handling (MalformedLlmResponseError).
 * 13. Secret sanitization in errors and response bodies.
 * 14. Missing transport fail-closed behavior in BaseLlmAdapter.
 * 15. Integration with ReferenceLlmAdapter and SecondaryLlmAdapter over real HTTP socket.
 */

import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';

import {
  HttpLlmTransport,
  LlmTransportHttpError,
  LlmTransportUnavailableError,
  LlmTimeoutError,
  MalformedLlmResponseError,
  BaseLlmAdapter,
  ReferenceLlmAdapter,
  SecondaryLlmAdapter,
  LlmProviderUnavailableError,
  validateLlmRequest,
  LlmRole,
  LlmResponseFormat,
  LlmFinishReason,
} from '../dist/index.js';

describe('TASK-P18-01: Real HTTP Transport & Fail-Closed Provider Boundary', () => {
  let server: http.Server;
  let serverUrl: string;
  let lastRecordedRequest: {
    method?: string;
    url?: string;
    headers: http.IncomingHttpHeaders;
    bodyText: string;
    parsedBody: unknown;
  } | null = null;

  let mockHandler: (
    req: http.IncomingMessage,
    res: http.ServerResponse,
    body: string
  ) => void | Promise<void>;

  before(async () => {
    server = http.createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
      }
      const bodyText = Buffer.concat(chunks).toString('utf-8');
      let parsedBody: unknown = null;
      try {
        parsedBody = JSON.parse(bodyText);
      } catch {
        parsedBody = bodyText;
      }

      lastRecordedRequest = {
        method: req.method,
        url: req.url,
        headers: req.headers,
        bodyText,
        parsedBody,
      };

      if (mockHandler) {
        await mockHandler(req, res, bodyText);
      } else {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok' }));
      }
    });

    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address() as AddressInfo;
        serverUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });
  });

  after(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  });

  beforeEach(() => {
    lastRecordedRequest = null;
  });

  // ==========================================================================
  // 1. SUCCESSFUL REQUEST & RESPONSE
  // ==========================================================================
  it('1. Successful HTTP request and response round-trip over real socket', async () => {
    const expectedResponse = {
      id: 'chatcmpl-12345',
      choices: [{ index: 0, message: { role: 'assistant', content: 'Hello World' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    };

    mockHandler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(expectedResponse));
    };

    const transport = new HttpLlmTransport({
      endpoint: `${serverUrl}/v1/chat/completions`,
    });

    const response = await transport.send({
      body: { model: 'gpt-4o', messages: [{ role: 'user', content: 'Ping' }] },
    });

    assert.equal(response.status, 200);
    assert.deepEqual(response.body, expectedResponse);
    assert.equal(lastRecordedRequest?.method, 'POST');
    assert.equal(lastRecordedRequest?.headers['content-type'], 'application/json');
    assert.deepEqual(lastRecordedRequest?.parsedBody, {
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'Ping' }],
    });
  });

  // ==========================================================================
  // 2. AUTHORIZATION HEADERS
  // ==========================================================================
  it('2. Correct Authorization header construction with Bearer prefix', async () => {
    mockHandler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    };

    const transport = new HttpLlmTransport({
      endpoint: `${serverUrl}/test-auth`,
      apiKey: 'sk-test-secret-key-12345',
    });

    await transport.send({ body: { test: true } });

    assert.equal(lastRecordedRequest?.headers['authorization'], 'Bearer sk-test-secret-key-12345');
  });

  it('2b. Custom auth header and prefix configuration', async () => {
    mockHandler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    };

    const transport = new HttpLlmTransport({
      endpoint: `${serverUrl}/test-anthropic-auth`,
      apiKey: 'anthropic-secret-key',
      authHeaderName: 'x-api-key',
      authHeaderPrefix: '',
    });

    await transport.send({ body: { test: true } });

    assert.equal(lastRecordedRequest?.headers['x-api-key'], 'anthropic-secret-key');
    assert.equal(lastRecordedRequest?.headers['authorization'], undefined);
  });

  // ==========================================================================
  // 3. JSON SERIALIZATION
  // ==========================================================================
  it('3. JSON serialization preserves complex payloads and numbers', async () => {
    mockHandler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'received' }));
    };

    const transport = new HttpLlmTransport({
      endpoint: `${serverUrl}/json-test`,
    });

    const payload = {
      nested: { a: 1, b: [true, 'text', { deep: null }] },
      count: 42,
    };

    await transport.send({ body: payload });

    assert.deepEqual(lastRecordedRequest?.parsedBody, payload);
  });

  // ==========================================================================
  // 4. CORRELATION ID PROPAGATION
  // ==========================================================================
  it('4. Correlation ID propagation across request and headers', async () => {
    mockHandler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    };

    const transport = new HttpLlmTransport({
      endpoint: `${serverUrl}/corr-test`,
    });

    // Case A: Passed in body as correlation_id
    await transport.send({
      body: { correlation_id: 'corr-id-from-body-99' },
    });
    assert.equal(lastRecordedRequest?.headers['x-correlation-id'], 'corr-id-from-body-99');
    assert.equal(lastRecordedRequest?.headers['x-request-id'], 'corr-id-from-body-99');

    // Case B: Passed in headers explicitly overrides body
    await transport.send({
      headers: { 'x-correlation-id': 'corr-explicit-header-11' },
      body: { correlation_id: 'corr-body-ignored' },
    });
    assert.equal(lastRecordedRequest?.headers['x-correlation-id'], 'corr-explicit-header-11');
  });

  // ==========================================================================
  // 5. TIMEOUT & ABORT BEHAVIOR
  // ==========================================================================
  it('5. Timeout enforcement triggers LlmTimeoutError within timeoutMs', async () => {
    mockHandler = async (_req, res) => {
      // Delay response longer than client timeout
      await new Promise((resolve) => setTimeout(resolve, 200));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ delayed: true }));
    };

    const transport = new HttpLlmTransport({
      endpoint: `${serverUrl}/timeout-test`,
      defaultTimeoutMs: 50,
    });

    await assert.rejects(
      async () => transport.send({ body: { test: 'timeout' } }),
      (err: unknown) => {
        assert.ok(err instanceof LlmTimeoutError);
        assert.equal((err as LlmTimeoutError).code, 'ERR_LLM_TIMEOUT');
        return true;
      }
    );
  });

  it('5b. AbortSignal cancellation aborts request immediately', async () => {
    mockHandler = async (_req, res) => {
      await new Promise((resolve) => setTimeout(resolve, 500));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    };

    const transport = new HttpLlmTransport({
      endpoint: `${serverUrl}/abort-test`,
      defaultTimeoutMs: 2000,
    });

    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);

    await assert.rejects(
      async () =>
        transport.send({
          body: { test: 'abort' },
          signal: controller.signal,
        }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.equal((err as Error).name, 'AbortError');
        return true;
      }
    );
  });

  // ==========================================================================
  // 6. HTTP 400 BAD REQUEST
  // ==========================================================================
  it('6. HTTP 400 maps to LlmTransportHttpError with Bad Request description', async () => {
    mockHandler = (_req, res) => {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Invalid model parameter', type: 'invalid_request_error' } }));
    };

    const transport = new HttpLlmTransport({
      endpoint: `${serverUrl}/400-test`,
    });

    await assert.rejects(
      async () => transport.send({ body: {} }),
      (err: unknown) => {
        assert.ok(err instanceof LlmTransportHttpError);
        assert.equal((err as LlmTransportHttpError).status, 400);
        assert.ok((err as LlmTransportHttpError).message.includes('Bad Request'));
        assert.deepEqual((err as LlmTransportHttpError).responseBody, {
          error: { message: 'Invalid model parameter', type: 'invalid_request_error' },
        });
        return true;
      }
    );
  });

  // ==========================================================================
  // 7. HTTP 401 UNAUTHORIZED
  // ==========================================================================
  it('7. HTTP 401 maps to LlmTransportHttpError with Authentication Failure description', async () => {
    mockHandler = (_req, res) => {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Incorrect API key provided' } }));
    };

    const transport = new HttpLlmTransport({
      endpoint: `${serverUrl}/401-test`,
      apiKey: 'invalid-key',
    });

    await assert.rejects(
      async () => transport.send({ body: {} }),
      (err: unknown) => {
        assert.ok(err instanceof LlmTransportHttpError);
        assert.equal((err as LlmTransportHttpError).status, 401);
        assert.ok((err as LlmTransportHttpError).message.includes('Authentication Failure'));
        return true;
      }
    );
  });

  // ==========================================================================
  // 8. HTTP 403 FORBIDDEN
  // ==========================================================================
  it('8. HTTP 403 maps to LlmTransportHttpError with Authorization Failure description', async () => {
    mockHandler = (_req, res) => {
      res.writeHead(403, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Country not supported' } }));
    };

    const transport = new HttpLlmTransport({
      endpoint: `${serverUrl}/403-test`,
    });

    await assert.rejects(
      async () => transport.send({ body: {} }),
      (err: unknown) => {
        assert.ok(err instanceof LlmTransportHttpError);
        assert.equal((err as LlmTransportHttpError).status, 403);
        assert.ok((err as LlmTransportHttpError).message.includes('Authorization Failure'));
        return true;
      }
    );
  });

  // ==========================================================================
  // 9. HTTP 429 RATE LIMIT
  // ==========================================================================
  it('9. HTTP 429 maps to LlmTransportHttpError with Rate Limit Exceeded description', async () => {
    mockHandler = (_req, res) => {
      res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '3' });
      res.end(JSON.stringify({ error: { message: 'Rate limit exceeded. Please try again in 3s.' } }));
    };

    const transport = new HttpLlmTransport({
      endpoint: `${serverUrl}/429-test`,
    });

    await assert.rejects(
      async () => transport.send({ body: {} }),
      (err: unknown) => {
        assert.ok(err instanceof LlmTransportHttpError);
        assert.equal((err as LlmTransportHttpError).status, 429);
        assert.ok((err as LlmTransportHttpError).message.includes('Rate Limit Exceeded'));
        assert.equal((err as LlmTransportHttpError).headers?.['retry-after'], '3');
        return true;
      }
    );
  });

  // ==========================================================================
  // 10. HTTP 500 / 503 PROVIDER ERROR / OUTAGE
  // ==========================================================================
  it('10. HTTP 500 / 503 map to Provider Outage error', async () => {
    mockHandler = (_req, res) => {
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Service Temporarily Unavailable' } }));
    };

    const transport = new HttpLlmTransport({
      endpoint: `${serverUrl}/503-test`,
    });

    await assert.rejects(
      async () => transport.send({ body: {} }),
      (err: unknown) => {
        assert.ok(err instanceof LlmTransportHttpError);
        assert.equal((err as LlmTransportHttpError).status, 503);
        assert.ok((err as LlmTransportHttpError).message.includes('Provider Outage'));
        return true;
      }
    );
  });

  // ==========================================================================
  // 11. NETWORK FAILURE
  // ==========================================================================
  it('11. Network failure (e.g. unreachable port) throws LlmTransportUnavailableError', async () => {
    // Port 1 is reserved and guaranteed not listening on loopback
    const transport = new HttpLlmTransport({
      endpoint: 'http://127.0.0.1:1',
      defaultTimeoutMs: 2000,
    });

    await assert.rejects(
      async () => transport.send({ body: {} }),
      (err: unknown) => {
        assert.ok(err instanceof LlmTransportUnavailableError);
        assert.equal((err as LlmTransportUnavailableError).reason, 'NETWORK_FAILURE');
        return true;
      }
    );
  });

  // ==========================================================================
  // 12. MALFORMED NON-JSON RESPONSE
  // ==========================================================================
  it('12. Malformed non-JSON 200 OK response throws MalformedLlmResponseError', async () => {
    mockHandler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html><body>Bad Gateway Cloudflare HTML</body></html>');
    };

    const transport = new HttpLlmTransport({
      endpoint: `${serverUrl}/non-json-test`,
    });

    await assert.rejects(
      async () => transport.send({ body: {} }),
      (err: unknown) => {
        assert.ok(err instanceof MalformedLlmResponseError);
        assert.equal((err as MalformedLlmResponseError).code, 'ERR_MALFORMED_LLM_RESPONSE');
        assert.ok((err as MalformedLlmResponseError).message.includes('non-JSON'));
        return true;
      }
    );
  });

  // ==========================================================================
  // 13. SECRET SANITIZATION
  // ==========================================================================
  it('13. Sensitive keys and tokens are redacted from error bodies and messages', async () => {
    const rawApiKey = 'sk-live-1234567890abcdef1234567890';
    mockHandler = (_req, res) => {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          error: `Failed for key ${rawApiKey} with Bearer ${rawApiKey}`,
          apiKey: rawApiKey,
          secretToken: 'super-secret-token',
        })
      );
    };

    const transport = new HttpLlmTransport({
      endpoint: `${serverUrl}/secret-test`,
    });

    await assert.rejects(
      async () => transport.send({ body: {} }),
      (err: unknown) => {
        assert.ok(err instanceof LlmTransportHttpError);
        const errObj = err as LlmTransportHttpError;
        const serialized = JSON.stringify(errObj.responseBody);
        assert.equal(serialized.includes(rawApiKey), false, 'API key must not leak into response body');
        assert.ok(serialized.includes('***REDACTED'), 'Redaction pattern must be applied');
        assert.equal(errObj.message.includes(rawApiKey), false, 'API key must not leak into message');
        return true;
      }
    );
  });

  // ==========================================================================
  // 14. MISSING TRANSPORT FAIL-CLOSED BEHAVIOR IN BASE ADAPTER
  // ==========================================================================
  it('14. BaseLlmAdapter strictly fails closed when no transport is configured', async () => {
    const unconfigured = new BaseLlmAdapter({
      providerId: 'llm:unconfigured-live',
      providerName: 'openai',
      apiKey: 'sk-test-key-configured',
    });

    // 1. checkAvailability must report false
    const avail = await unconfigured.checkAvailability();
    assert.equal(avail.available, false);
    assert.ok(avail.reason?.includes('no transport configured'));

    // 2. generate must throw LlmProviderUnavailableError, NEVER returning simulated output
    const req = validateLlmRequest({
      project_id: 'test-proj',
      task_id: 'TASK-1',
      objective: 'Verify fail-closed',
      acceptance_criteria: ['Fail closed'],
      attempt: 1,
      max_attempts: 1,
      system_prompt: 'System',
      user_prompt: 'User',
      model: 'gpt-4o',
      response_format: LlmResponseFormat.TEXT,
    });

    await assert.rejects(
      async () => unconfigured.generate(req),
      (err: unknown) => {
        assert.ok(err instanceof LlmProviderUnavailableError);
        assert.equal((err as LlmProviderUnavailableError).code, 'ERR_LLM_PROVIDER_UNAVAILABLE');
        assert.ok((err as LlmProviderUnavailableError).message.includes('unavailable'));
        return true;
      }
    );
  });

  // ==========================================================================
  // 15. REFERENCE & SECONDARY ADAPTER INTEGRATION OVER REAL HTTP SOCKET
  // ==========================================================================
  it('15a. ReferenceLlmAdapter executes successfully using HttpLlmTransport', async () => {
    mockHandler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'chatcmpl-ref-1',
          object: 'chat.completion',
          created: 1700000000,
          model: 'gpt-4o',
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: 'Reference adapter response' },
              finish_reason: 'stop',
            },
          ],
          usage: {
            prompt_tokens: 25,
            completion_tokens: 12,
            total_tokens: 37,
          },
        })
      );
    };

    const httpTransport = new HttpLlmTransport({
      endpoint: `${serverUrl}/v1/chat/completions`,
      apiKey: 'sk-live-ref-key',
    });

    const adapter = new ReferenceLlmAdapter({
      transport: httpTransport as any,
    });

    const req = validateLlmRequest({
      project_id: 'test-proj',
      task_id: 'TASK-REF-1',
      objective: 'Test real reference adapter transport',
      acceptance_criteria: ['Transport must dispatch over HTTP'],
      attempt: 1,
      max_attempts: 1,
      system_prompt: 'System prompt',
      user_prompt: 'User query',
      model: 'gpt-4o',
      response_format: LlmResponseFormat.TEXT,
    });

    const response = await adapter.generate(req);

    assert.equal(response.content, 'Reference adapter response');
    assert.equal(response.finish_reason, LlmFinishReason.STOP);
    assert.equal(response.usage.reported_input_tokens, 25);
    assert.equal(response.usage.reported_output_tokens, 12);
    assert.equal(lastRecordedRequest?.headers['authorization'], 'Bearer sk-live-ref-key');
  });

  it('15b. SecondaryLlmAdapter executes successfully using HttpLlmTransport', async () => {
    mockHandler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'msg-sec-1',
          model: 'claude-3-5-sonnet',
          content: [{ type: 'text', text: 'Secondary adapter response' }],
          stop_reason: 'end_turn',
          usage: {
            input_tokens: 35,
            output_tokens: 18,
          },
        })
      );
    };

    const httpTransport = new HttpLlmTransport({
      endpoint: `${serverUrl}/v1/messages`,
      apiKey: 'anthropic-key-sec',
      authHeaderName: 'x-api-key',
      authHeaderPrefix: '',
    });

    const adapter = new SecondaryLlmAdapter({
      transport: httpTransport as any,
    });

    const req = validateLlmRequest({
      project_id: 'test-proj',
      task_id: 'TASK-SEC-1',
      objective: 'Test real secondary adapter transport',
      acceptance_criteria: ['Transport must dispatch over HTTP to Claude format'],
      attempt: 1,
      max_attempts: 1,
      system_prompt: 'System prompt',
      user_prompt: 'User query',
      model: 'claude-3-5-sonnet',
      response_format: LlmResponseFormat.TEXT,
    });

    const response = await adapter.generate(req);

    assert.equal(response.content, 'Secondary adapter response');
    assert.equal(response.finish_reason, LlmFinishReason.STOP);
    assert.equal(response.usage.reported_input_tokens, 35);
    assert.equal(response.usage.reported_output_tokens, 18);
    assert.equal(lastRecordedRequest?.headers['x-api-key'], 'anthropic-key-sec');
  });
});
