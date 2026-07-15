import crypto from 'crypto';
import { createClient } from 'redis';
import config from '../config';
import { normalizeZoomMeetingId } from './utils';
import { ZoomRtmsWebhookEvent } from './types';

type RedisClient = ReturnType<typeof createClient>;
type LocalWaiter = (event: ZoomRtmsWebhookEvent | null) => void;

const PREFIX = 'meeting-bot:zoom:rtms';

export class ZoomRtmsEventStore {
  private commandClient?: RedisClient;
  private blockingClient?: RedisClient;
  private connectPromise?: Promise<void>;
  private readonly localQueues = new Map<string, ZoomRtmsWebhookEvent[]>();
  private readonly localWaiters = new Map<string, LocalWaiter[]>();
  private readonly localActiveStreams = new Set<string>();
  private readonly localDedupe = new Set<string>();
  private readonly localReservations = new Map<string, string>();

  private meetingQueue(meetingId: string): string {
    return `${PREFIX}:meeting:${meetingId}:events`;
  }

  private streamQueue(streamId: string): string {
    return `${PREFIX}:stream:${streamId}:events`;
  }

  private activeStreamKey(streamId: string): string {
    return `${PREFIX}:stream:${streamId}:active`;
  }

  private reservationKey(meetingId: string, operatorId?: string): string {
    const operator = operatorId || 'token-user';
    const digest = crypto.createHash('sha256').update(operator).digest('hex');
    return `${PREFIX}:meeting:${normalizeZoomMeetingId(meetingId)}:operator:${digest}:owner`;
  }

  private dedupeKey(event: ZoomRtmsWebhookEvent): string {
    const identity = [
      event.event,
      event.event_ts ?? '',
      event.payload.meeting_uuid,
      event.payload.rtms_stream_id,
      event.payload.server_urls ?? '',
      event.payload.stop_reason ?? '',
    ].join(':');
    const digest = crypto
      .createHash('sha256')
      .update(identity)
      .digest('hex');
    return `${PREFIX}:event:${digest}`;
  }

  private async connect(): Promise<void> {
    if (!config.isRedisEnabled) return;
    if (this.commandClient?.isReady && this.blockingClient?.isReady) return;

    if (!this.connectPromise) {
      this.commandClient = createClient({ url: config.redisUri, name: 'zoom-rtms-events' });
      this.blockingClient = createClient({ url: config.redisUri, name: 'zoom-rtms-blocking' });
      this.commandClient.on('error', (error) => console.error('Zoom RTMS Redis error', error));
      this.blockingClient.on('error', (error) => console.error('Zoom RTMS blocking Redis error', error));
      this.connectPromise = Promise.all([
        this.commandClient.connect(),
        this.blockingClient.connect(),
      ]).then(() => undefined).catch(async (error) => {
        const openClients = [this.commandClient, this.blockingClient]
          .filter((client): client is RedisClient => Boolean(client?.isOpen));
        await Promise.all(openClients.map((client) => client.disconnect()));
        this.commandClient = undefined;
        this.blockingClient = undefined;
        this.connectPromise = undefined;
        throw error;
      });
    }

    await this.connectPromise;
  }

  private getCommandClient(): RedisClient {
    if (!this.commandClient) throw new Error('Zoom RTMS Redis client is unavailable');
    return this.commandClient;
  }

  private getBlockingClient(): RedisClient {
    if (!this.blockingClient) throw new Error('Zoom RTMS blocking Redis client is unavailable');
    return this.blockingClient;
  }

  async publish(event: ZoomRtmsWebhookEvent): Promise<boolean> {
    const streamId = event.payload.rtms_stream_id;
    if (!streamId) throw new Error('RTMS webhook is missing rtms_stream_id');

    if (!config.isRedisEnabled) {
      return this.publishLocally(event);
    }

    await this.connect();
    const client = this.getCommandClient();
    const ttl = config.zoomRtms.eventTtlSeconds;
    let queueKey: string;
    if (event.event === 'meeting.rtms_started') {
      const meetingId = normalizeZoomMeetingId(event.payload.meeting_id ?? '');
      const isActive = await client.exists(this.activeStreamKey(streamId));
      queueKey = isActive
        ? this.streamQueue(streamId)
        : this.meetingQueue(meetingId);
    } else {
      queueKey = this.streamQueue(streamId);
    }

    const published = await client.sendCommand([
      'EVAL',
      'if redis.call("SET", KEYS[1], "1", "EX", ARGV[2], "NX") then redis.call("RPUSH", KEYS[2], ARGV[1]); redis.call("EXPIRE", KEYS[2], ARGV[2]); return 1; end; return 0;',
      '2',
      this.dedupeKey(event),
      queueKey,
      JSON.stringify(event),
      String(ttl),
    ]);
    return Number(published) === 1;
  }

  async waitForMeetingStart(
    meetingId: string,
    timeoutSeconds: number
  ): Promise<ZoomRtmsWebhookEvent | null> {
    return this.waitFor(this.meetingQueue(normalizeZoomMeetingId(meetingId)), timeoutSeconds);
  }

  async waitForStreamEvent(
    streamId: string,
    timeoutSeconds: number
  ): Promise<ZoomRtmsWebhookEvent | null> {
    return this.waitFor(this.streamQueue(streamId), timeoutSeconds);
  }

  async markStreamActive(streamId: string): Promise<void> {
    if (!config.isRedisEnabled) {
      this.localActiveStreams.add(streamId);
      return;
    }

    await this.connect();
    const activeTtl = Math.max(
      config.zoomRtms.eventTtlSeconds,
      config.maxRecordingDuration * 60 + 600
    );
    await this.getCommandClient().set(
      this.activeStreamKey(streamId),
      '1',
      { EX: activeTtl }
    );
  }

  async markStreamInactive(streamId: string): Promise<void> {
    if (!config.isRedisEnabled) {
      this.localActiveStreams.delete(streamId);
      return;
    }

    await this.connect();
    await this.getCommandClient().del(this.activeStreamKey(streamId));
  }

  async reserveMeeting(
    meetingId: string,
    ownerId: string,
    ttlSeconds: number,
    operatorId?: string
  ): Promise<boolean> {
    const key = this.reservationKey(meetingId, operatorId);
    if (!config.isRedisEnabled) {
      if (this.localReservations.has(key)) return false;
      this.localReservations.set(key, ownerId);
      return true;
    }

    await this.connect();
    const result = await this.getCommandClient().set(key, ownerId, {
      EX: Math.max(1, Math.ceil(ttlSeconds)),
      NX: true,
    });
    return result === 'OK';
  }

  async releaseMeeting(
    meetingId: string,
    ownerId: string,
    operatorId?: string
  ): Promise<void> {
    const key = this.reservationKey(meetingId, operatorId);
    if (!config.isRedisEnabled) {
      if (this.localReservations.get(key) === ownerId) {
        this.localReservations.delete(key);
      }
      return;
    }

    await this.connect();
    await this.getCommandClient().sendCommand([
      'EVAL',
      'if redis.call("GET", KEYS[1]) == ARGV[1] then return redis.call("DEL", KEYS[1]); end; return 0;',
      '1',
      key,
      ownerId,
    ]);
  }

  async close(): Promise<void> {
    const clients = [this.commandClient, this.blockingClient]
      .filter((client): client is RedisClient => Boolean(client?.isOpen));
    await Promise.all(clients.map((client) => client.quit()));
    this.commandClient = undefined;
    this.blockingClient = undefined;
    this.connectPromise = undefined;
  }

  private async waitFor(
    queueKey: string,
    timeoutSeconds: number
  ): Promise<ZoomRtmsWebhookEvent | null> {
    if (!config.isRedisEnabled) {
      return this.waitForLocal(queueKey, timeoutSeconds);
    }

    await this.connect();
    const result = await this.getBlockingClient().blPop(
      queueKey,
      Math.max(1, Math.ceil(timeoutSeconds))
    );
    return result ? JSON.parse(result.element) as ZoomRtmsWebhookEvent : null;
  }

  private publishLocally(event: ZoomRtmsWebhookEvent): boolean {
    const dedupeKey = this.dedupeKey(event);
    if (this.localDedupe.has(dedupeKey)) return false;
    this.localDedupe.add(dedupeKey);
    const timer = setTimeout(
      () => this.localDedupe.delete(dedupeKey),
      config.zoomRtms.eventTtlSeconds * 1000
    );
    timer.unref();

    const streamId = event.payload.rtms_stream_id;
    let queueKey: string;
    if (event.event === 'meeting.rtms_started') {
      const meetingId = normalizeZoomMeetingId(event.payload.meeting_id ?? '');
      queueKey = this.localActiveStreams.has(streamId)
        ? this.streamQueue(streamId)
        : this.meetingQueue(meetingId);
    } else {
      queueKey = this.streamQueue(streamId);
    }

    const waiter = this.localWaiters.get(queueKey)?.shift();
    if (waiter) {
      waiter(event);
    } else {
      const queue = this.localQueues.get(queueKey) ?? [];
      queue.push(event);
      this.localQueues.set(queueKey, queue);
    }
    return true;
  }

  private waitForLocal(
    queueKey: string,
    timeoutSeconds: number
  ): Promise<ZoomRtmsWebhookEvent | null> {
    const queued = this.localQueues.get(queueKey)?.shift();
    if (queued) return Promise.resolve(queued);

    return new Promise((resolve) => {
      const waiters = this.localWaiters.get(queueKey) ?? [];
      let settled = false;
      const finish = (event: ZoomRtmsWebhookEvent | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(event);
      };
      waiters.push(finish);
      this.localWaiters.set(queueKey, waiters);

      const timer = setTimeout(() => {
        const current = this.localWaiters.get(queueKey) ?? [];
        const index = current.indexOf(finish);
        if (index >= 0) current.splice(index, 1);
        finish(null);
      }, Math.max(1, timeoutSeconds) * 1000);
    });
  }
}

export const zoomRtmsEventStore = new ZoomRtmsEventStore();
