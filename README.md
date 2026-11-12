# Homey Developer MCP

An [MCP](https://modelcontextprotocol.io) server for Homey app developers. It gives an AI assistant read-only access to the crashes, diagnostic reports, builds and install stats of **your own** Homey apps, through Athom's apps API.

## Tools

| Tool | What it returns |
|---|---|
| `list_apps` | Your apps and those of your Developer Organizations: live/test version, installs, crash counts |
| `list_builds` | Builds of an app, newest first |
| `get_crashes` | Crashes and unhandled rejections of the newest builds, grouped by error and app file/line, most frequent first |
| `list_diagnostic_reports` | Reports users submitted with *Create diagnostics report*, with their message and a stderr preview |
| `get_diagnostic_report` | One report in full: user message, stdout and stderr |
| `get_install_stats` | Daily installs, optionally per driver |

Everything is read-only. The server never publishes builds, replies to users or changes settings.

### How crashes and reports are told apart

Athom returns crashes, unhandled rejections and user-submitted diagnostic reports from the same endpoint (`/app/{appId}/build/{buildId}/crash`), all in the `stack` field. This server classifies them by their opening line and splits diagnostic reports into Log ID, user message, stdout and stderr.

Homey groups crashes by their exact stack, so an error that mentions a device id gets a separate group per device. `get_crashes` regroups by error message (with ids replaced by `<id>`) and the first stack frame in your app's own code, so the counts add up per actual bug.

A report or crash is stored on the build the user was running. The tools look at the newest 5 builds by default; pass `builds` or `buildId` to look further back.

## Background

How this server came about, what it is based on and why it works the way it does: [docs/background.md](docs/background.md). What it uses of Athom's apps API, including the format of crash entries and diagnostic reports: [docs/apps-api.md](docs/apps-api.md).

## Setup

You need your **Personal Access Token** (it starts with `pat-`). You'll find it on [tools.developer.homey.app/me](https://tools.developer.homey.app/me), in the *Personal Access Token* section. Requires Node.js 18 or newer.

### Claude Code

```sh
claude mcp add homey-developer --env HOMEY_PAT=pat-... -- npx -y homey-developer-mcp
```

### Claude Desktop, Cursor and other clients

```json
{
  "mcpServers": {
    "homey-developer": {
      "command": "npx",
      "args": ["-y", "homey-developer-mcp"],
      "env": { "HOMEY_PAT": "pat-..." }
    }
  }
}
```

## Privacy

Diagnostic reports contain what your users wrote and the logs of your app on their Homey, including device names. With this server, that content reaches the AI assistant you connect it to. Only connect it to an assistant you're comfortable sharing that data with.

## Development

```sh
npm install
npm test
```

To try a local build in Claude Code: `claude mcp add homey-developer --env HOMEY_PAT=pat-... -- node /path/to/homey-developer-mcp/dist/index.js`.

`src/AthomApi.ts` is copied from [App Insights for Developers](https://github.com/lucasvdh/codes.lucasvdh.developer-tools) (`lib/AthomApi.ts`).

## License

GPL-3.0
