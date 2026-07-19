# Zoom RTMS operations and customer onboarding

This guide covers two supported RTMS use cases:

1. An internal private Zoom app used only by the developer's own Zoom account.
2. Explicit customer enablement selected by the exact Winkk `teamId`.

RTMS does not join a meeting as an anonymous participant. It streams meeting media for an authorized Zoom user. The meeting URL is used only to extract the meeting ID; its password does not authorize RTMS.

## Deployment modes

| Mode | Primary transport | Credential selection | Intended use |
| --- | --- | --- | --- |
| Browser only | `browser` | None | Disable RTMS |
| Internal RTMS | `rtms` | Exact `ZOOM_RTMS_GLOBAL_TEAM_ID` | Private app in the company's own Zoom account |
| Customer fallback | `browser` with fallback enabled | Exact customer JSON entry or exact `ZOOM_RTMS_GLOBAL_TEAM_ID` | Browser first; RTMS only after an automated-bot block before admission |
| Customer RTMS first | `rtms` | Exact customer JSON entry | RTMS first for every configured team |

Credential selection is fail-closed:

- An enabled exact customer entry uses that customer's S2S OAuth credentials.
- The exact `ZOOM_RTMS_GLOBAL_TEAM_ID` uses the global/internal OAuth credentials.
- Disabled, invalid, and unknown teams do not receive global credentials.

`ZOOM_RECORDING_TRANSPORT` is deployment-wide. A single deployment cannot currently use RTMS first for the internal team while using browser first for customers. That requires a future per-team transport policy or separate deployments.

`teamId` is a routing key, not proof of tenant ownership. The credential resolver assumes that the job producer already authenticated the caller and verified that the caller belongs to that team. Restrict the HTTP endpoint and Redis queue to trusted producers, validate bearer-token-to-team membership upstream, and never authorize RTMS from an unverified client-supplied `teamId`.

## Common Zoom prerequisites

Create one user-managed Zoom General app with RTMS enabled. Configure:

- `meeting:read:meeting_audio`
- `meeting:read:meeting_video`
- `meeting.rtms_started`
- `meeting.rtms_stopped`
- `meeting.rtms_interrupted`
- A public HTTPS event endpoint ending in `/zoom/rtms/webhook`

The app must have Zoom Developer Pack credits and the Zoom account must allow apps to access shared real-time meeting content. In staging and production, run the meeting bot with `REDIS_CONSUMER_ENABLED=true` so webhook events reach the correct replica.

The following global app credentials are always required:

```env
ZOOM_RTMS_CLIENT_ID=general-app-client-id
ZOOM_RTMS_CLIENT_SECRET=general-app-client-secret
ZOOM_RTMS_WEBHOOK_SECRET=general-app-webhook-secret
```

They belong to the shared RTMS General app and are used to verify webhooks and connect to RTMS media servers. Customer JSON entries do not replace these values.

## Mode A: internal private app

A private General app can be used without Marketplace publication by users in its own Zoom account. This is different from an unlisted app: an unlisted production app still completes Zoom review before external distribution.

Create a Server-to-Server OAuth app in the same internal Zoom account with:

- `meeting:update:participant_rtms_app_status`, or
- `meeting:update:participant_rtms_app_status:admin`

Configure the internal Winkk team and the account-level OAuth credentials:

```env
ZOOM_RECORDING_TRANSPORT=rtms
ZOOM_RTMS_GLOBAL_TEAM_ID=internal-winkk-team-id
ZOOM_RTMS_OAUTH_ACCOUNT_ID=internal-zoom-account-id
ZOOM_RTMS_OAUTH_CLIENT_ID=internal-s2s-client-id
ZOOM_RTMS_OAUTH_CLIENT_SECRET=internal-s2s-client-secret
ZOOM_RTMS_PARTICIPANT_USER_ID=internal-zoom-user-id
```

Every Zoom job still contains a Winkk `teamId`. Only a job whose `teamId` exactly matches `ZOOM_RTMS_GLOBAL_TEAM_ID` can use these credentials. No customer JSON entry is required for that internal team.

For a short local test, `ZOOM_RTMS_OAUTH_ACCESS_TOKEN` can replace the account ID, client ID, and client secret. Do not store an expiring access token in production.

## Mode B: customer enablement

External customers must be able to authorize the shared RTMS General app. Use either:

- a Zoom-approved Beta authorization URL for limited testing, or
- a published or unlisted production app after Zoom review.

A private app cannot be shared with a different Zoom account.

Each customer currently creates a private Server-to-Server OAuth app in their own Zoom account and grants:

```text
meeting:update:participant_rtms_app_status:admin
```

Collect these values through an approved secret-sharing channel:

- Zoom account ID
- S2S client ID
- S2S client secret
- Zoom user ID of the participant or host used for RTMS
- Exact Winkk `teamId`

Do not accept credentials in chat, email, screenshots, tickets, or source control.

Add the customer to `ZOOM_RTMS_CUSTOMER_CREDENTIALS_JSON`:

```json
{
  "customer-team-id": {
    "enabled": true,
    "accountId": "zoom-account-id",
    "clientId": "zoom-s2s-client-id",
    "clientSecret": "zoom-s2s-client-secret",
    "participantUserId": "zoom-user-id"
  }
}
```

The outer key is the Winkk `teamId`. `participantUserId` is the Zoom user ID, not an email address. All values are required.

For browser-first customer fallback:

```env
ZOOM_RECORDING_TRANSPORT=browser
ZOOM_RTMS_FALLBACK_ENABLED=true
ZOOM_RTMS_CUSTOMER_CREDENTIALS_JSON={...}
```

Only an explicit Zoom automated-bot block before browser admission triggers RTMS. Host rejection, sign-in requirements, lobby timeout, browser failure, and recording failure do not trigger the fallback.

For RTMS first, set `ZOOM_RECORDING_TRANSPORT=rtms`. Enabled exact customer mappings and the exact internal team remain eligible; all other teams fail closed.

## Customer onboarding checklist

1. Confirm the customer's exact Winkk `teamId` from the job payload.
2. Ensure the shared Winkk General app is approved for external authorization.
3. Have the customer or their Zoom admin authorize the Winkk app.
4. Enable shared real-time meeting content in the customer's Zoom account settings.
5. Have the customer create and activate their S2S OAuth app with the required admin scope.
6. Obtain the account ID, client ID, client secret, and Zoom participant user ID securely.
7. Add an enabled exact entry to the customer JSON in the correct environment.
8. Restart the process or pods so the environment is reloaded.
9. Start a controlled meeting and verify the webhook, stream connection, finalization, and upload.

## Own and external meetings

| Scenario | Browser | RTMS REST start |
| --- | --- | --- |
| Customer hosts the meeting | Can join as a visible guest | Supported when the app and user are authorized |
| Customer is invited to an external meeting and has joined | Can join as a visible guest | Supported subject to host policy and approval |
| Customer only received a shared public link | Can attempt a visible guest join | The link alone is insufficient |
| Customer is the actual host but has not joined | Can attempt a visible guest join | May start before the host only when Zoom's Join Before Host setting permits it |
| Customer is an alternate host or invited participant but has not joined | Can attempt a visible guest join | Unavailable until that authorized user joins |

For an external meeting, an authorized alternate host or invited participant must have joined; the meeting host or a designated alternate host must also be present. The actual host is the exception: Zoom can permit RTMS before the host joins when Join Before Host is enabled. The meeting host can allow, require approval for, or reject RTMS access.

An in-meeting Zoom App can also call `startRTMS()` after the user opens it and the host approves. That in-meeting UI is not implemented in this repository.

## Dev, production, and 1Password

Use separate Zoom development and production credentials and separate 1Password vault items.

Production RTMS workloads must run on `linux/amd64`. The Zoom RTMS SDK rejects Linux ARM64 even if a multi-architecture meeting-bot image is available; pin RTMS-capable pods to x86-64 nodes.

Recommended items:

- `Meeting Bot App Secrets`: shared General app credentials, internal S2S credentials, Sentry, and other application secrets.
- `Meeting Bot Customer RTMS Credentials`: only `ZOOM_RTMS_CUSTOMER_CREDENTIALS_JSON`.

The automatically generated 1Password `Password` field is not used by the meeting bot. The internal team ID and transport flags are not secrets and can live in the deployment configuration.

Configure a separate public HTTPS `/zoom/rtms/webhook` endpoint for each environment and verify the rendered URL against the current infrastructure before entering it in Zoom.

After changing a secret, confirm that the 1Password operator updated the Kubernetes Secret and restarted the meeting-bot pods. Never print secret values while checking the deployment.

## Rotation and offboarding

- Rotate a client secret immediately if it appears in chat, a screenshot, a log, or source control.
- Update every environment that uses the credential.
- Set a customer entry to `enabled: false` to revoke RTMS for that team, then restart the pods.
- Remove the entry after the retention period required by the operating process.
- When a customer is offboarded, have that customer remove its installation of the shared General app from its Zoom account. Do not disable the shared app globally while other tenants use it.

Disabled and invalid customer entries never fall back to internal credentials.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Missing credentials for a team | Exact job `teamId`, spelling, JSON key, and `enabled` |
| Invalid customer configuration | JSON syntax and all required string fields |
| OAuth token request fails | Customer account ID, S2S client ID, secret, activation, and scopes |
| Zoom code `3000` | Meeting has not started; the bot retries until the join deadline |
| Zoom code `2308` or `2309` | Participant role or external-host authorization; customer credentials wait for approval, while global/internal credentials fail immediately |
| Zoom code `2310` | RTMS entitlement, app authorization, account setting, meeting state, and scope |
| Zoom code `2312` | `participantUserId` is incorrect |
| Zoom code `13262` | The General app client ID is missing from Zoom's "Allow apps to access meeting content" setting |
| Zoom code `13267` | RTMS app access is disabled in Zoom settings |
| Zoom code `13273` | The meeting does not support RTMS |
| No fresh start event | Webhook URL, webhook secret, event subscriptions, Redis, and operator ID |
| SDK unavailable | Run RTMS on Linux x64 or macOS arm64 |
| Duplicate recording rejected | Another stream is already reserved for the meeting and operator |

The meeting bot waits up to `JOIN_WAIT_TIME_MINUTES` for initial authorization and a fresh `meeting.rtms_started` event.

## Current product boundary

Customer onboarding is manual and team-scoped. The repository does not yet implement:

- a Zoom OAuth authorization-code callback,
- encrypted refresh-token storage per customer,
- a self-service "Connect Zoom" flow,
- per-user RTMS enablement within one Winkk team,
- per-team primary transport selection, or
- an in-meeting `startRTMS()` Zoom App interface.

For self-service onboarding, use a reviewed shared General app and store OAuth grants dynamically per Winkk team instead of collecting customer S2S secrets.

## Zoom references

- [Add Realtime Media Streams to your app](https://developers.zoom.us/docs/rtms/meetings/add-features/)
- [Work with RTMS streams](https://developers.zoom.us/docs/rtms/meetings/work-with-streams/)
- [Zoom OAuth 2.0](https://developers.zoom.us/docs/integrations/oauth/)
- [Zoom app distribution](https://developers.zoom.us/docs/distribute/)
- [Sharing private and Beta apps](https://developers.zoom.us/docs/distribute/sharing-private-and-beta-apps/)
