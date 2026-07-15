export type ZoomRtmsEventName =
  | 'meeting.rtms_started'
  | 'meeting.rtms_stopped'
  | 'meeting.rtms_interrupted';

export interface ZoomRtmsPayload {
  meeting_uuid: string;
  meeting_id?: string | number;
  operator_id?: string | number;
  rtms_stream_id: string;
  server_urls?: string;
  stop_reason?: number;
  [key: string]: unknown;
}

export interface ZoomRtmsWebhookEvent {
  event: ZoomRtmsEventName;
  event_ts: number;
  payload: ZoomRtmsPayload;
}

export interface ZoomWebhookBody {
  event?: string;
  event_ts?: number;
  payload?: Record<string, unknown>;
}
