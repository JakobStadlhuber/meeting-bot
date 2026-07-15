import assert from 'node:assert/strict';
import test from 'node:test';
import config from '../config';
import { ZoomRtmsEventStore } from './ZoomRtmsEventStore';
import { ZoomRtmsWebhookEvent } from './types';

const originalRedisEnabled = config.isRedisEnabled;

test.beforeEach(() => {
  config.isRedisEnabled = false;
});

test.afterEach(() => {
  config.isRedisEnabled = originalRedisEnabled;
});

const startEvent = (eventTs: number): ZoomRtmsWebhookEvent => ({
  event: 'meeting.rtms_started',
  event_ts: eventTs,
  payload: {
    meeting_uuid: 'meeting-uuid',
    meeting_id: '12345678901',
    operator_id: 'operator-id',
    rtms_stream_id: 'stream-id',
    server_urls: 'wss://rtms.zoom.us',
  },
});

test('routes initial and recovery start events to their respective queues', async () => {
  const store = new ZoomRtmsEventStore();
  const initial = startEvent(1);

  assert.equal(await store.publish(initial), true);
  assert.equal(await store.publish(initial), false);
  assert.deepEqual(await store.waitForMeetingStart('12345678901', 1), initial);

  await store.markStreamActive('stream-id');
  const recovery = startEvent(2);
  assert.equal(await store.publish(recovery), true);
  assert.deepEqual(await store.waitForStreamEvent('stream-id', 1), recovery);
});

test('releases meeting reservations only for their owner', async () => {
  const store = new ZoomRtmsEventStore();

  assert.equal(await store.reserveMeeting('12345678901', 'owner-a', 60, 'operator-id'), true);
  assert.equal(await store.reserveMeeting('12345678901', 'owner-b', 60, 'operator-id'), false);

  await store.releaseMeeting('12345678901', 'owner-b', 'operator-id');
  assert.equal(await store.reserveMeeting('12345678901', 'owner-b', 60, 'operator-id'), false);

  await store.releaseMeeting('12345678901', 'owner-a', 'operator-id');
  assert.equal(await store.reserveMeeting('12345678901', 'owner-b', 60, 'operator-id'), true);
});
