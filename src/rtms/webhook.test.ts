import assert from 'node:assert/strict';
import test from 'node:test';
import { Request, Response } from 'express';
import config from '../config';
import { zoomRtmsEventStore } from './ZoomRtmsEventStore';
import { buildZoomWebhookSignature, buildZoomUrlValidationResponse } from './utils';
import { handleZoomRtmsWebhook } from './webhook';

interface TestResponse {
  statusCode: number;
  body?: unknown;
  status(code: number): TestResponse;
  json(body: unknown): TestResponse;
  sendStatus(code: number): TestResponse;
}

const createResponse = (): TestResponse => ({
  statusCode: 200,
  status(code) {
    this.statusCode = code;
    return this;
  },
  json(body) {
    this.body = body;
    return this;
  },
  sendStatus(code) {
    this.statusCode = code;
    return this;
  },
});

const send = async ({
  body,
  timestamp,
  signature,
}: {
  body: Record<string, unknown>;
  timestamp?: string;
  signature?: string;
}): Promise<TestResponse> => {
  const rawBody = Buffer.from(JSON.stringify(body));
  const req = {
    body,
    rawBody,
    headers: {
      'x-zm-request-timestamp': timestamp,
      'x-zm-signature': signature,
    },
  } as unknown as Request;
  const res = createResponse();
  await handleZoomRtmsWebhook(req, res as unknown as Response);
  return res;
};

test('validates Zoom challenges and signed RTMS events', async () => {
  const originalSecret = config.zoomRtms.webhookSecret;
  const originalRedisEnabled = config.isRedisEnabled;
  config.zoomRtms.webhookSecret = 'webhook-secret';
  config.isRedisEnabled = false;
  const eventScope = { customerId: 'team-a', operatorId: 'operator-id' };

  try {
    await zoomRtmsEventStore.reserveMeeting(
      '12345678901',
      'webhook-test-owner',
      60,
      eventScope
    );
    const challenge = await send({
      body: {
        event: 'endpoint.url_validation',
        payload: { plainToken: 'plain-token' },
      },
    });
    assert.equal(challenge.statusCode, 200);
    assert.deepEqual(
      challenge.body,
      buildZoomUrlValidationResponse('plain-token', 'webhook-secret')
    );

    const timestamp = String(Math.floor(Date.now() / 1000));
    const body = {
      event: 'meeting.rtms_started',
      event_ts: Date.now(),
      payload: {
        meeting_uuid: 'meeting-uuid',
        meeting_id: '12345678901',
        operator_id: 'operator-id',
        rtms_stream_id: 'stream-id',
        server_urls: 'wss://rtms.zoom.us',
      },
    };
    const signed = await send({
      body,
      timestamp,
      signature: buildZoomWebhookSignature(
        JSON.stringify(body),
        timestamp,
        'webhook-secret'
      ),
    });
    assert.equal(signed.statusCode, 204);
    assert.equal(
      (
        await zoomRtmsEventStore.waitForMeetingStart(
          '12345678901',
          eventScope,
          1
        )
      )?.payload.rtms_stream_id,
      'stream-id'
    );

    const rejected = await send({
      body,
      timestamp,
      signature: 'v0=invalid',
    });
    assert.equal(rejected.statusCode, 401);
  } finally {
    await zoomRtmsEventStore.releaseMeeting(
      '12345678901',
      'webhook-test-owner',
      eventScope
    );
    config.zoomRtms.webhookSecret = originalSecret;
    config.isRedisEnabled = originalRedisEnabled;
  }
});
