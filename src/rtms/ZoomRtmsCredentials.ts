import config from '../config';
import { KnownError, ZoomRtmsCredentialsMissingError } from '../error';
import { ZoomRtmsApiCredentials, ZoomRtmsEventScope } from './types';

export type ZoomRtmsCredentialErrorReason =
  | 'disabled'
  | 'invalid_customer_configuration'
  | 'invalid_global_configuration';

export class ZoomRtmsCredentialConfigurationError extends KnownError {
  constructor(
    public readonly reason: ZoomRtmsCredentialErrorReason,
    public readonly teamId: string,
    message: string
  ) {
    super(message, false, 0);
    this.name = 'ZoomRtmsCredentialConfigurationError';
  }
}

export interface ResolvedZoomRtmsCredentials {
  api: ZoomRtmsApiCredentials;
  eventScope: ZoomRtmsEventScope;
}

const legacyCredentials = (): ResolvedZoomRtmsCredentials => {
  const rtmsClientId = config.zoomRtms.clientId;
  if (!rtmsClientId) {
    throw new ZoomRtmsCredentialConfigurationError(
      'invalid_global_configuration',
      'legacy',
      'ZOOM_RTMS_CLIENT_ID is required for RTMS'
    );
  }

  const hasAccessToken = Boolean(config.zoomRtms.oauthAccessToken);
  const hasServerCredentials = Boolean(
    config.zoomRtms.oauthAccountId
    && config.zoomRtms.oauthClientId
    && config.zoomRtms.oauthClientSecret
  );
  if (!hasAccessToken && !hasServerCredentials) {
    throw new ZoomRtmsCredentialConfigurationError(
      'invalid_global_configuration',
      'legacy',
      'Configure ZOOM_RTMS_OAUTH_ACCESS_TOKEN or the legacy Zoom RTMS OAuth account credentials'
    );
  }

  return {
    api: {
      source: 'legacy',
      customerId: 'legacy',
      rtmsClientId,
      participantUserId: config.zoomRtms.participantUserId,
      oauthAccessToken: config.zoomRtms.oauthAccessToken,
      oauthAccountId: config.zoomRtms.oauthAccountId,
      oauthClientId: config.zoomRtms.oauthClientId,
      oauthClientSecret: config.zoomRtms.oauthClientSecret,
    },
    eventScope: {
      customerId: 'legacy',
      operatorId: config.zoomRtms.participantUserId,
    },
  };
};

export const resolveZoomRtmsCredentials = (
  teamId: string,
  allowLegacy = config.zoomRecordingTransport === 'rtms'
): ResolvedZoomRtmsCredentials => {
  const customer = config.zoomRtms.customerCredentials[teamId];
  if (customer?.enabled) {
    const rtmsClientId = config.zoomRtms.clientId;
    if (!rtmsClientId) {
      throw new ZoomRtmsCredentialConfigurationError(
        'invalid_global_configuration',
        teamId,
        'ZOOM_RTMS_CLIENT_ID is required for customer RTMS recordings'
      );
    }

    return {
      api: {
        source: 'customer',
        customerId: teamId,
        rtmsClientId,
        participantUserId: customer.participantUserId,
        oauthAccountId: customer.accountId,
        oauthClientId: customer.clientId,
        oauthClientSecret: customer.clientSecret,
      },
      eventScope: {
        customerId: teamId,
        operatorId: customer.participantUserId,
      },
    };
  }

  if (allowLegacy) return legacyCredentials();

  if (config.zoomRtms.customerCredentialsError) {
    throw new ZoomRtmsCredentialConfigurationError(
      'invalid_customer_configuration',
      teamId,
      config.zoomRtms.customerCredentialsError
    );
  }

  const entryError = config.zoomRtms.customerCredentialErrors[teamId];
  if (entryError) {
    throw new ZoomRtmsCredentialConfigurationError(
      'invalid_customer_configuration',
      teamId,
      `Zoom RTMS credentials for team ${teamId} are invalid: ${entryError}`
    );
  }

  if (customer && !customer.enabled) {
    throw new ZoomRtmsCredentialConfigurationError(
      'disabled',
      teamId,
      `Zoom RTMS fallback is disabled for team ${teamId}`
    );
  }

  throw new ZoomRtmsCredentialsMissingError(teamId);
};
