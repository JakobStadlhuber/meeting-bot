import axios, { AxiosError } from 'axios';
import config from '../config';
import { KnownError } from '../error';

type RtmsAction = 'start' | 'stop';

const REQUEST_TIMEOUT_MS = 15_000;
const START_RETRY_INITIAL_DELAY_MS = 1_000;
const START_RETRY_MAX_DELAY_MS = 10_000;

interface CachedToken {
  value: string;
  expiresAt: number;
}

interface ZoomApiErrorBody {
  code?: number;
  message?: string;
  reason?: string;
}

const asAxiosError = (error: unknown): AxiosError<ZoomApiErrorBody> | undefined =>
  axios.isAxiosError<ZoomApiErrorBody>(error) ? error : undefined;

export class ZoomRtmsApi {
  private cachedToken?: CachedToken;

  constructor(
    private readonly wait: (milliseconds: number) => Promise<void> =
      (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    private readonly now: () => number = Date.now
  ) {}

  async start(meetingId: string, retryTimeoutMs = 0): Promise<void> {
    const retryWindowMs = Number.isFinite(retryTimeoutMs)
      ? Math.max(0, retryTimeoutMs)
      : 0;
    const deadline = this.now() + retryWindowMs;
    let retryDelayMs = START_RETRY_INITIAL_DELAY_MS;

    while (true) {
      try {
        const remainingMs = deadline - this.now();
        const requestTimeoutMs = retryWindowMs > 0
          ? Math.max(1, Math.min(REQUEST_TIMEOUT_MS, remainingMs))
          : REQUEST_TIMEOUT_MS;
        await this.sendStatusRequest(meetingId, 'start', requestTimeoutMs);
        return;
      } catch (error: unknown) {
        const remainingMs = deadline - this.now();
        if (!this.isRetryableStartError(error) || remainingMs <= 0) {
          throw this.toKnownError(error, 'start');
        }

        await this.wait(Math.min(retryDelayMs, remainingMs));
        if (this.now() >= deadline) {
          throw this.toKnownError(error, 'start');
        }
        retryDelayMs = Math.min(retryDelayMs * 2, START_RETRY_MAX_DELAY_MS);
      }
    }
  }

  async stop(meetingId: string): Promise<void> {
    try {
      await this.sendStatusRequest(meetingId, 'stop', REQUEST_TIMEOUT_MS);
    } catch (error: unknown) {
      throw this.toKnownError(error, 'stop');
    }
  }

  private async sendStatusRequest(
    meetingId: string,
    action: RtmsAction,
    timeout: number
  ): Promise<void> {
    const clientId = config.zoomRtms.clientId;
    if (!clientId) {
      throw new KnownError('ZOOM_RTMS_CLIENT_ID is required for RTMS', false, 0);
    }

    const accessToken = await this.getAccessToken();
    const settings: { client_id: string; participant_user_id?: string } = {
      client_id: clientId,
    };
    if (config.zoomRtms.participantUserId) {
      settings.participant_user_id = config.zoomRtms.participantUserId;
    }

    await axios.patch(
      `https://api.zoom.us/v2/live_meetings/${encodeURIComponent(meetingId)}/rtms_app/status`,
      { action, settings },
      {
        headers: { Authorization: `Bearer ${accessToken}` },
        timeout,
      }
    );
  }

  private isRetryableStartError(error: unknown): boolean {
    const axiosError = asAxiosError(error);
    if (!axiosError) return false;
    const status = Number(axiosError.response?.status);
    const code = Number(axiosError.response?.data?.code);
    return !axiosError.response
      || code === 3000
      || status === 429
      || (status >= 500 && status < 600);
  }

  private toKnownError(error: unknown, action: RtmsAction): KnownError {
    if (error instanceof KnownError) return error;

    const axiosError = asAxiosError(error);
    const status = axiosError?.response?.status;
    const message = axiosError?.response?.data?.message
      || (error instanceof Error ? error.message : undefined)
      || 'Unknown Zoom API error';
    return new KnownError(
      `Zoom RTMS ${action} failed${status ? ` (${status})` : ''}: ${message}`,
      false,
      0
    );
  }

  private async getAccessToken(): Promise<string> {
    if (config.zoomRtms.oauthAccessToken) {
      return config.zoomRtms.oauthAccessToken;
    }

    if (this.cachedToken && this.cachedToken.expiresAt > Date.now()) {
      return this.cachedToken.value;
    }

    const { oauthAccountId, oauthClientId, oauthClientSecret } = config.zoomRtms;
    if (!oauthAccountId || !oauthClientId || !oauthClientSecret) {
      throw new KnownError(
        'Configure ZOOM_RTMS_OAUTH_ACCESS_TOKEN or the ZOOM_RTMS_OAUTH_ACCOUNT_ID/CLIENT_ID/CLIENT_SECRET settings',
        false,
        0
      );
    }

    try {
      const response = await axios.post<{ access_token: string; expires_in?: number }>(
        'https://zoom.us/oauth/token',
        undefined,
        {
          auth: { username: oauthClientId, password: oauthClientSecret },
          params: {
            grant_type: 'account_credentials',
            account_id: oauthAccountId,
          },
          timeout: 15_000,
        }
      );
      const expiresIn = Math.max(60, response.data.expires_in ?? 3600);
      this.cachedToken = {
        value: response.data.access_token,
        expiresAt: Date.now() + (expiresIn - 30) * 1000,
      };
      return this.cachedToken.value;
    } catch (error: unknown) {
      const axiosError = asAxiosError(error);
      const status = axiosError?.response?.status;
      const message = axiosError?.response?.data?.reason
        || (error instanceof Error ? error.message : undefined)
        || 'Unknown OAuth error';
      throw new KnownError(
        `Unable to obtain Zoom RTMS OAuth token${status ? ` (${status})` : ''}: ${message}`,
        false,
        0
      );
    }
  }
}
