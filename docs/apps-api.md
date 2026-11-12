# Athom apps API

What this server uses of Athom's apps API, and what we learned about it. The API is not documented for third parties; this is based on its public specification and on real responses.

- Base URL: `https://apps-api.athom.com/api/v1`
- Specification (Swagger 2.0, public): `https://apps-api.athom.com/api/v1/specification.json`

## Authentication

1. Take the account's **Personal Access Token** (starts with `pat-`, shown on [tools.developer.homey.app/me](https://tools.developer.homey.app/me)).
2. `POST https://api.athom.com/delegation/token?audience=apps` with `Authorization: Bearer <PAT>`. The body of the response is a JSON string: a JWT.
3. Call the apps API with `Authorization: Bearer <JWT>`.

The JWT expires; `AthomApi` reads `exp` from its payload and requests a new one a minute before. On a 401 or 403 it drops the cached JWT. The delegation request can redirect, which is why `AthomApi` uses `follow-redirects`.

## Endpoints in use

| Endpoint | Used for |
|---|---|
| `GET /app/me` | The account's own apps |
| `GET /org`, `GET /org/{orgId}` | Developer Organizations and their apps (as ids or full objects) |
| `GET /app/{appId}` | An organization app that is listed only by id |
| `GET /app/{appId}/build` | Builds, with `crashes` and `installs` per build |
| `GET /app/{appId}/build/{buildId}/crash` | Crashes, unhandled rejections and diagnostic reports |
| `GET /app/{appId}/install/stats` | Installs per day |
| `GET /app/{appId}/drivers/stats` | Installs per driver per day |

A build's `crashes` count includes diagnostic reports, so a build with 0 has neither.

## The crash endpoint

`GET /app/{appId}/build/{buildId}/crash` returns an array of:

```json
{
  "count": 39,
  "homeyVersion": "10.0.8",
  "stack": "…",
  "createdAt": "2023-10-14T15:38:20.180Z",
  "updatedAt": "2023-10-14T16:16:32.062Z"
}
```

`count` is how often this exact `stack` occurred; `createdAt` is the first and `updatedAt` the last time. Three kinds of entries share this shape, told apart by how `stack` opens.

### Diagnostic report

Sent by a user with *Create diagnostics report* in the app's settings. Always `count: 1`.

```text
Note: this log has been manually submitted by a user.
Log ID: <uuid>

User Message:
<what the user typed, may span lines or be empty>

---- stdout ----
<the app's stdout>

---- stderr ----
<the app's stderr>
```

The Log ID is the one the user is shown and the one in the report e-mail. `parseDiagnosticReport` copes with a missing stdout or stderr section.

### Unhandled rejection

```text
Note: this e-mail is sent because an unhandledRejection occurred in your app. Make sure to catch all errors, this might crash your app in the future. Stack trace attached below:

  Error: device_not_found
    at Remote Process
    at …
```

The process did not necessarily crash. Counts can run into the tens of thousands because every rejection is counted.

### Crash

Anything else: the stack trace itself, starting with the error line.

### Stack paths differ per Homey version

The same error can come with differently shaped paths, depending on the Homey version that reported it:

- SDK frames: `/node_modules/@athombv/homey-apps-sdk-v3/lib/Device.js:358:23` or `/opt/homey-client/system/manager/ManagerApps/AppProcess/node_modules/…/Device.js:1:4367` (minified, so different line and column numbers).
- App frames: `/app/drivers/remote/device.js:95:22` or `/drivers/remote/device.js:95:22`.

## What is not there

- **No id per crash entry.** The specification has `POST /app/crash/{crashId}/reply` (body: `subject`, `body`, `from`), but the crash response has no `_id`, so there is nothing to pass. Whether the Log ID of a diagnostic report works as `crashId` is unknown.
- **No separate endpoint for diagnostic reports.** They are only in the crash endpoint (see above).
- **No filter or pagination** on the crash endpoint; it returns all entries of a build.

## Related: the Homey (on-device) API

Not used by this server, but useful context. The bundle of tools.developer.homey.app contains the specification of the API every Homey serves:

- `POST /app/:id/crashlog` (`getAppStd`, scope `homey.app.readonly`): what *Create diagnostics report* calls on the user's Homey. Its result ends up in the crash endpoint above.
- `GET /std/:session` (`ManagerDevkit.getAppStdOut`): live output of an app run with the CLI.
- `POST /journalctl` (`ManagerSystem.sendLog`): the Homey's own diagnostics report, not an app's.

These run on a specific Homey and need a token for that Homey, not the apps API JWT.
