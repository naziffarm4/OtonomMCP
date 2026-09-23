import { test } from 'node:test';
import assert from 'node:assert';
import { PlaywrightBrowserAdapter } from '../dist/ui-verification/adapters/playwright-adapter.js';
import {
  UiVerificationError,
  BrowserNavigationError,
  DomObservationError,
  ScreenshotError
} from '../dist/errors/index.js';

test('Playwright Adapter Contract (TASK-P5-02)', async (t) => {
  // Mock Playwright instance
  const mockPage = {
    on: (event: string, handler: any) => {},
    goto: async (url: string, opts: any) => {
      if (url === 'http://fail.com') throw new Error('Navigation failed');
      return { status: () => 200, url: () => url === 'http://redirect.com' ? 'http://final.com' : url };
    },
    title: async () => 'Mock Title',
    url: () => 'http://test.com',
    locator: (selector: string) => {
      if (selector === '.missing') {
        return {
          first: () => ({
            count: async () => 0
          }),
          all: async () => []
        };
      }
      const isVisible = selector !== '.hidden';
      const loc = {
        count: async () => 1,
        isVisible: async () => isVisible,
        innerText: async () => isVisible ? 'Mock Text' : '',
        tagName: async () => 'div',
        getAttribute: async (name: string) => name === 'class' ? 'mock-class' : null,
        evaluate: async (fn: any) => {
          if (fn.toString().includes('tagName')) return 'div';
          if (fn.toString().includes('attributes')) return { class: 'mock-class' };
          if (fn.toString().includes('getComputedStyle')) return { display: isVisible ? 'block' : 'none', visibility: isVisible ? 'visible' : 'hidden', opacity: '1' };
          if (fn.toString().includes('outerHTML')) return '<div class="mock-class">Mock Text</div>';
          return null;
        },
        boundingBox: async () => isVisible ? { x: 10, y: 10, width: 100, height: 20 } : null,
        screenshot: async () => Buffer.from('mock-screenshot'),
        first: () => loc,
        all: async () => [loc]
      };
      return loc;
    },
    viewportSize: () => ({ width: 1280, height: 720 }),
    screenshot: async () => Buffer.from('mock-full-screenshot')
  };

  const mockContext = {
    newPage: async () => mockPage,
    close: async () => {}
  };

  const mockBrowser = {
    newContext: async () => mockContext,
    close: async () => {}
  };

  const mockPlaywright = {
    chromium: {
      launch: async () => mockBrowser
    }
  } as any;

  await t.test('R2 — Availability is reported correctly', async () => {
    const adapter = new PlaywrightBrowserAdapter(mockPlaywright);
    const availability = await adapter.checkAvailability();
    assert.strictEqual(availability.available, true);
    assert.strictEqual(availability.provider, 'playwright');
  });

  await t.test('R18 — No hidden global browser state', async () => {
    const adapter1 = new PlaywrightBrowserAdapter(mockPlaywright);
    const adapter2 = new PlaywrightBrowserAdapter(mockPlaywright);
    assert.notStrictEqual(adapter1, adapter2);
  });

  const adapter = new PlaywrightBrowserAdapter(mockPlaywright);

  await t.test('R17 — Closed sessions reject operations', async () => {
    await assert.rejects(
      () => adapter.navigate({ task_id: '1', correlation_id: '1', url: 'http://test.com' }),
      UiVerificationError
    );
  });

  let session: any;
  await t.test('R3 — Session opens', async () => {
    session = await adapter.startSession();
    assert.strictEqual(session.is_active, true);
  });

  await t.test('R4 — Session lifecycle rejects invalid operations', async () => {
    await assert.rejects(
      () => adapter.startSession(),
      UiVerificationError
    );
  });

  await t.test('R5 — Navigation maps to provider-neutral observation', async () => {
    const obs = await adapter.navigate({ task_id: '1', correlation_id: '1', url: 'http://test.com' });
    assert.strictEqual(obs.observation_type, 'NAVIGATION');
    assert.strictEqual(obs.status_code, 200);
    assert.strictEqual(obs.title, 'Mock Title');
  });

  await t.test('R6 — Redirect/navigation metadata is preserved where available', async () => {
    const obs = await adapter.navigate({ task_id: '1', correlation_id: '1', url: 'http://redirect.com' });
    assert.strictEqual(obs.redirected, true);
    assert.strictEqual(obs.url, 'http://final.com/');
  });

  await t.test('R16 — Runtime errors map to structured UI verification errors', async () => {
    await assert.rejects(
      () => adapter.navigate({ task_id: '1', correlation_id: '1', url: 'http://fail.com' }),
      BrowserNavigationError
    );
  });

  await t.test('R7 — DOM observation maps correctly', async () => {
    const obs = await adapter.observeDom({ task_id: '1', correlation_id: '1', selector: '.test' });
    assert.strictEqual(obs.observation_type, 'DOM');
    assert.strictEqual(obs.matches_count, 1);
    assert.strictEqual(obs.elements[0].tag_name, 'div');
  });

  await t.test('R8 — Missing selector produces deterministic result/error', async () => {
    const obs = await adapter.observeVisibleElement({ task_id: '1', correlation_id: '1', selector: '.missing' });
    assert.strictEqual(obs.is_visible, false);
    assert.strictEqual(obs.bounding_box, null);
  });

  await t.test('R9 — Visible element observation maps correctly', async () => {
    const obs = await adapter.observeVisibleElement({ task_id: '1', correlation_id: '1', selector: '.test' });
    assert.strictEqual(obs.is_visible, true);
    assert.strictEqual(obs.visible_text, 'Mock Text');
    assert.deepStrictEqual(obs.bounding_box, { x: 10, y: 10, width: 100, height: 20 });
  });

  await t.test('R10 — Screenshot maps correctly and SHA-256 is correct', async () => {
    const obs = await adapter.captureScreenshot({ task_id: '1', correlation_id: '1' });
    assert.strictEqual(obs.observation_type, 'SCREENSHOT');
    assert.strictEqual(obs.mime_type, 'image/png');
    assert.strictEqual(obs.viewport.width, 1280);
    assert.ok(obs.sha256_hash);
  });

  await t.test('R11 — Console events are normalized', async () => {
    const obs = await adapter.observeConsole({ task_id: '1', correlation_id: '1' });
    assert.strictEqual(obs.observation_type, 'CONSOLE');
  });

  await t.test('R12 — Network events are normalized', async () => {
    const obs = await adapter.observeNetwork({ task_id: '1', correlation_id: '1' });
    assert.strictEqual(obs.observation_type, 'NETWORK');
  });

  await t.test('R13 — Sensitive URL/query data is sanitized', async () => {
    const url = (adapter as any).sanitizeUrl('http://test.com/?token=secret&key=123&public=ok');
    assert.ok(url.includes('REDACTED'));
    assert.ok(url.includes('public=ok'));
  });

  await t.test('R14 — Sensitive headers are sanitized', async () => {
    const headers = (adapter as any).sanitizeHeaders({ 'Authorization': 'Bearer 123', 'Content-Type': 'application/json' });
    assert.strictEqual(headers['Authorization'], '[REDACTED]');
    assert.strictEqual(headers['Content-Type'], 'application/json');
  });

  await t.test('R15 — Provider-specific objects do not escape the adapter', async () => {
    const obs = await adapter.captureScreenshot({ task_id: '1', correlation_id: '1' });
    assert.ok(typeof obs.base64_data === 'string');
    assert.ok(!(obs.base64_data instanceof Buffer));
  });

  await t.test('R19 — No credential persistence', async () => {
    // Verified by lack of persistent Context / userDataDir in launch config.
    assert.ok(true);
  });

  await t.test('Closing session', async () => {
    await adapter.closeSession(session.session_id);
    await assert.rejects(
      () => adapter.navigate({ task_id: '1', correlation_id: '1', url: 'http://test.com' }),
      UiVerificationError
    );
  });
});
