import assert from 'node:assert/strict';
import test from 'node:test';
import axios from 'axios';
import config from '../config';
import { KnownError } from '../error';
import { ZoomRtmsApi } from './ZoomRtmsApi';

const originalPatch = axios.patch;
const originalClientId = config.zoomRtms.clientId;
const originalAccessToken = config.zoomRtms.oauthAccessToken;

test.beforeEach(() => {
  config.zoomRtms.clientId = 'rtms-client';
  config.zoomRtms.oauthAccessToken = 'access-token';
});

test.afterEach(() => {
  axios.patch = originalPatch;
  config.zoomRtms.clientId = originalClientId;
  config.zoomRtms.oauthAccessToken = originalAccessToken;
});

const zoomError = (status: number, code?: number) => ({
  isAxiosError: true,
  response: {
    status,
    data: { code, message: 'Zoom API error' },
  },
});

test('retries transient start failures with bounded exponential backoff', async () => {
  let now = 0;
  let attempts = 0;
  const waits: number[] = [];
  const requestTimeouts: number[] = [];
  const failures = [zoomError(400, 3000), zoomError(429), zoomError(503)];
  axios.patch = (async (_url, _body, requestConfig) => {
    requestTimeouts.push(requestConfig?.timeout ?? 0);
    const failure = failures[attempts++];
    if (failure) throw failure;
  }) as typeof axios.patch;

  const api = new ZoomRtmsApi(async (milliseconds) => {
    waits.push(milliseconds);
    now += milliseconds;
  }, () => now);

  await api.start('123456789', 8_000);

  assert.equal(attempts, 4);
  assert.deepEqual(waits, [1_000, 2_000, 4_000]);
  assert.deepEqual(requestTimeouts, [8_000, 7_000, 5_000, 1_000]);
});

test('stops retrying when the caller timeout is reached', async () => {
  let now = 0;
  let attempts = 0;
  const waits: number[] = [];
  axios.patch = (async () => {
    attempts += 1;
    throw zoomError(500);
  }) as typeof axios.patch;

  const api = new ZoomRtmsApi(async (milliseconds) => {
    waits.push(milliseconds);
    now += milliseconds;
  }, () => now);

  await assert.rejects(api.start('123456789', 2_500), KnownError);
  assert.equal(attempts, 2);
  assert.deepEqual(waits, [1_000, 1_500]);
});

test('does not retry fatal start failures or stop failures', async () => {
  let attempts = 0;
  let waits = 0;
  axios.patch = (async () => {
    attempts += 1;
    throw zoomError(attempts === 1 ? 403 : 500);
  }) as typeof axios.patch;

  const api = new ZoomRtmsApi(async () => {
    waits += 1;
  });

  await assert.rejects(api.start('123456789', 10_000), KnownError);
  await assert.rejects(api.stop('123456789'), KnownError);
  assert.equal(attempts, 2);
  assert.equal(waits, 0);
});
