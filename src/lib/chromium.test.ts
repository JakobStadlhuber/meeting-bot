import assert from 'node:assert/strict';
import test from 'node:test';
import { Browser, BrowserContext } from 'playwright';
import { cleanupFailedBrowserSetup } from './chromium';

test('closes an owned browser when setup fails before creating a page', async () => {
  let closeCalls = 0;
  const browser = {
    isConnected: () => true,
    close: async () => {
      closeCalls += 1;
    },
  } as unknown as Browser;

  await cleanupFailedBrowserSetup({
    browser,
    closeBrowser: true,
    closeContext: true,
    correlationId: 'test',
  });

  assert.equal(closeCalls, 1);
});

test('closes an isolated external context without closing shared Chrome', async () => {
  let browserCloseCalls = 0;
  let contextCloseCalls = 0;
  const browser = {
    isConnected: () => true,
    close: async () => {
      browserCloseCalls += 1;
    },
  } as unknown as Browser;
  const context = {
    close: async () => {
      contextCloseCalls += 1;
    },
  } as unknown as BrowserContext;

  await cleanupFailedBrowserSetup({
    browser,
    context,
    closeBrowser: false,
    closeContext: true,
    correlationId: 'test',
  });

  assert.equal(contextCloseCalls, 1);
  assert.equal(browserCloseCalls, 0);
});
