import assert from 'node:assert/strict';
import test from 'node:test';
import type { Page } from 'playwright';
import {
  dismissZoomOptionalMediaPrompt,
  isZoomOptionalMediaPromptText,
} from './zoomPrejoinModal';

test('recognizes only the optional Zoom media permission prompt', () => {
  assert.equal(isZoomOptionalMediaPromptText(
    'Do you want people to see you in the meeting? You can still turn off your microphone and camera anytime in the meeting Continue without microphone and camera'
  ), true);
  assert.equal(isZoomOptionalMediaPromptText(
    'The host requires you to consent before joining. Continue'
  ), false);
});

test('dismisses the optional Zoom media prompt through its accessible control', async () => {
  let clicks = 0;
  let hiddenWaits = 0;
  const button = {
    first: () => button,
    isVisible: async () => true,
    click: async () => { clicks += 1; },
    waitFor: async () => { hiddenWaits += 1; },
  };
  const prompt = {
    last: () => prompt,
    isVisible: async () => true,
    innerText: async () => 'Do you want people to see you in the meeting? You can still turn off your microphone and camera anytime in the meeting Continue without microphone and camera',
    getByRole: () => button,
  };
  const filtered = { last: () => prompt };
  const root = {
    locator: () => ({ filter: () => filtered }),
  } as unknown as Page;

  assert.equal(await dismissZoomOptionalMediaPrompt(root), true);
  assert.equal(clicks, 1);
  assert.equal(hiddenWaits, 1);
});

test('does not fail when Zoom keeps the reusable modal overlay visible', async () => {
  let overlayHiddenWaits = 0;
  const button = {
    first: () => button,
    isVisible: async () => true,
    click: async () => undefined,
    waitFor: async () => undefined,
  };
  const prompt = {
    last: () => prompt,
    isVisible: async () => true,
    innerText: async () => 'Do you want people to see you in the meeting? You can still turn off your microphone and camera anytime in the meeting Continue without microphone and camera',
    getByRole: () => button,
    waitFor: async () => { overlayHiddenWaits += 1; throw new Error('overlay remained visible'); },
  };
  const root = {
    locator: () => ({ filter: () => ({ last: () => prompt }) }),
  } as unknown as Page;

  assert.equal(await dismissZoomOptionalMediaPrompt(root), true);
  assert.equal(overlayHiddenWaits, 0);
});

test('returns false instead of throwing when Zoom does not dismiss the media prompt', async () => {
  const button = {
    first: () => button,
    isVisible: async () => true,
    click: async () => undefined,
    waitFor: async () => { throw new Error('button remained visible'); },
  };
  const prompt = {
    last: () => prompt,
    isVisible: async () => true,
    innerText: async () => 'Do you want people to see you in the meeting? You can still turn off your microphone and camera anytime in the meeting Continue without microphone and camera',
    getByRole: () => button,
  };
  const root = {
    locator: () => ({ filter: () => ({ last: () => prompt }) }),
  } as unknown as Page;

  assert.equal(await dismissZoomOptionalMediaPrompt(root), false);
});

test('does not interact with an unknown Zoom modal', async () => {
  let clicks = 0;
  const button = {
    first: () => button,
    isVisible: async () => true,
    click: async () => { clicks += 1; },
  };
  const prompt = {
    last: () => prompt,
    isVisible: async () => true,
    innerText: async () => 'The host requires you to consent before joining. Continue',
    getByRole: () => button,
  };
  const root = {
    locator: () => ({ filter: () => ({ last: () => prompt }) }),
  } as unknown as Page;

  assert.equal(await dismissZoomOptionalMediaPrompt(root), false);
  assert.equal(clicks, 0);
});
