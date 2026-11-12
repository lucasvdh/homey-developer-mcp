# Background

Why this server exists, what it is based on, and the decisions behind it. For the API details it relies on, see [apps-api.md](apps-api.md).

## Origin

Homey has several MCP servers, but they all control a Homey: devices, flows, zones. None of them is for developers who want to look into their own apps. Athom points developers to [tools.developer.homey.app](https://tools.developer.homey.app) for crashes and to `homey app run --remote` for live output, so an AI assistant has nothing to read when you ask it why your app crashes.

The groundwork already existed in [App Insights for Developers](https://homey.app/a/codes.lucasvdh.developer-tools) (`codes.lucasvdh.developer-tools`), a Homey app that shows a developer's app statistics on their own Homey. Its `lib/AthomApi.ts` already:

- exchanges a Personal Access Token (PAT) for a delegated JWT for the apps API;
- loads the account's own apps and the apps of its Developer Organizations;
- reads builds, crashes, install stats, driver stats and suggestions.

This server reuses that client and puts MCP tools on top of it.

## How we found where diagnostic reports live

The starting question was whether the diagnostic reports users send from an app's settings (*Create diagnostics report*) could be fetched through the API, next to crashes.

1. **The developer site's bundle.** The JavaScript bundle of tools.developer.homey.app contains the specification of the Homey (on-device) API. There, *Create diagnostics report* for an app is `POST /app/:id/crashlog` (`getAppStd`) on the **user's** Homey, with an optional message. That shows how a report is created, not where it ends up.
2. **The apps API specification.** `https://apps-api.athom.com/api/v1/specification.json` is public. Its 68 operations have nothing called "diagnostic" or "report". This led to the wrong conclusion that reports could only be read from e-mail.
3. **Looking at real data.** The response of `GET /app/{appId}/build/{buildId}/crash` showed that reports are in there after all: in the `stack` field, opening with `Note: this log has been manually submitted by a user.`

So the crash endpoint returns three kinds of entries, told apart only by how `stack` opens. See [apps-api.md](apps-api.md#the-crash-endpoint) for the format.

Lesson: the specification describes only the shape of a request, not what the response contains. Check real responses before concluding something isn't available.

## Design decisions

### Separate repository, copied API client

The server does not live inside the Homey app's repository:

- `homey app build` and `homey app validate` package the whole app folder. Server code and its dependencies would bloat the app or need constant `.homeyignore` upkeep.
- The app is tied to Node 18 and the Homey SDK types; the server is an npm package started with `npx`, with its own versions and releases.
- Different audience: the app is for Homey users in the App Store, the server for developers.

`src/AthomApi.ts` is a **copy** of `lib/AthomApi.ts` from the app, not a shared package. It is about 300 lines with no Homey dependencies. A shared package only pays off once both sides keep needing the same changes. Until then, port fixes by hand in either direction.

### Write tools behind an opt-in

The first version only read. Releasing and submitting builds was added afterwards, behind `HOMEY_MCP_ALLOW_WRITE`:

- **Releasing to test** is easy to undo: the next build replaces it.
- **Submitting for certification** sends the build to Athom's reviewers. `autoRelease` defaults to `false`, unlike on the developer site, so going live stays a separate step.
- **Releasing to live** was first left out, on the grounds that it reaches every user. It was added after all: Athom only allows live for a build that passed review, so the quality question has already been answered by a person at Athom. What remains is *when* to release, which is the developer's call. The project is open source and comes without warranty.

The write tools are not registered at all without the opt-in, so someone who only wants to read crashes can't publish by accident. They carry `destructiveHint`, so clients that support it ask for confirmation before each call.

Still out of scope: replying to users and changing app settings. The apps API does have `POST /app/crash/{crashId}/reply`, but the crash response contains no id to pass to it (see [apps-api.md](apps-api.md#what-is-not-there)).

### Notifications

An MCP server only answers when it is called, so it can't tell you a build got through. `get_build_status` returns everything needed to check (state, `stateMeta`, reviewer comments, AI review), and a client can call it periodically, such as Claude Code with `/loop`. Push notifications are left to App Insights for Developers on the Homey, which already has flow triggers for build state changes and review outcomes, and works when no AI session is open.

### Regrouping crashes

Homey groups crash entries by their exact stack. An error that mentions a device id therefore gets a separate group, with its own count, for every device. In the data that prompted this server, one bug showed up as several groups of 39 and 1,271 crashes.

`groupCrashes` in `src/crashes.ts` groups by:

- the kind (crash or unhandled rejection);
- the first line of the error, with UUIDs replaced by `<id>`;
- the first stack frame in the app's own code (not `node_modules`, not `/opt/…`, not `node:`), with a leading `/app/` removed, because builds differ in whether the app lives under `/app` or at the root.

If no app frame is found, the whole stack (with ids replaced) is the key, so unrelated errors never merge. Two errors with a different message stay separate even when they come from the same line. That happens across Homey versions: `Error: device_not_found` vs `Error: Not Found: Device with ID …`.

### Builds to search

Crash entries and reports are stored on the build the user was running. The tools look at the newest 5 builds by default (20 for `get_diagnostic_report`, which searches for one Log ID), and skip builds whose crash count is 0 to save requests.

### Configuration

The PAT comes from the `HOMEY_PAT` environment variable, the same token the Homey CLI uses in CI. Each account has exactly one; it is on [tools.developer.homey.app/me](https://tools.developer.homey.app/me).

## Privacy

Diagnostic reports hold what users wrote and the logs of the app on their Homey, including device names. Whatever the tools return reaches the AI assistant they're connected to. The README says so, and the tests use made-up data in the same format rather than real reports.

## Ideas not built yet

- `GET …/build/{buildId}/crash/stats`: crashes per day, for a trend.
- `GET …/build/{buildId}/metrics?start&end&step`: build metrics. The specification doesn't say what it returns; check a real response first.
- `GET /app/{appId}/review`, `/review/stats`: user reviews.
- `POST …/submission/comment`: replying to a reviewer, and `POST …/agent-review/retry`: rerunning the AI review.
- Live output of an app on your **own** Homey through the local Homey API (`ManagerDevkit.getAppStdOut`, `GET /std/:session`). That would need a different token (Homey API instead of apps API).
- A Claude Desktop extension (`.mcpb`) for one-click installation, and a listing in the official MCP registry.
