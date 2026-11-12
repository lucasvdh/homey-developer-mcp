#!/usr/bin/env node
import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {z} from 'zod';
import AthomApi, {AppData, BuildSummary} from './AthomApi';
import {BuildCrash, classify, groupCrashes, parseDiagnosticReport} from './crashes';

const token = process.env.HOMEY_PAT?.trim();
if (!token) {
  console.error('HOMEY_PAT is not set. Create a Personal Access Token at https://tools.developer.homey.app/me and pass it as HOMEY_PAT.');
  process.exit(1);
}

const api = new AthomApi(token);
const server = new McpServer({name: 'homey-developer', version: '0.1.0'});

function json(value: unknown) {
  return {content: [{type: 'text' as const, text: JSON.stringify(value, null, 2)}]};
}

async function run<T>(fn: () => Promise<T>) {
  try {
    return json(await fn());
  } catch (error) {
    return {content: [{type: 'text' as const, text: `Error: ${(error as Error).message}`}], isError: true};
  }
}

function appName(app: AppData): string | undefined {
  const name = app.liveBuild?.name ?? app.testBuild?.name;
  return name?.en ?? (name ? Object.values(name)[0] : undefined);
}

/** Newest builds first. */
async function recentBuilds(appId: string, limit: number, buildId?: number): Promise<BuildSummary[]> {
  const builds = (await api.getBuilds(appId)).sort((a, b) => b.id - a.id);
  if (buildId !== undefined) {
    const build = builds.find((b) => b.id === buildId);
    if (!build) throw new Error(`Build ${buildId} not found for ${appId}`);
    return [build];
  }
  return builds.slice(0, limit);
}

async function crashesOf(appId: string, builds: BuildSummary[]): Promise<BuildCrash[]> {
  const perBuild = await Promise.all(builds.map(async (build) => {
    // Skip the request for builds that never crashed or got a report.
    if (build.crashes === 0) return [];
    const crashes = await api.getBuildCrashes(appId, build.id);
    return crashes.map((crash) => ({...crash, buildId: build.id, version: build.version}));
  }));
  return perBuild.flat();
}

const appId = z.string().describe('App id, e.g. "com.example.myapp"');
const builds = z.number().int().min(1).max(50).optional()
    .describe('How many of the newest builds to look at (default 5). Reports land on the build the user was running.');
const buildId = z.number().int().optional().describe('Only this build');

server.registerTool('list_apps', {
  title: 'List my Homey apps',
  description: 'The apps of the account and its Developer Organizations, with live/test version, installs and crash counts.',
  inputSchema: {},
}, () => run(async () => {
  const {apps, failures} = await api.getAppsWithFailures();
  return {
    apps: apps.filter((app) => !app.deleted).map((app) => ({
      id: app.id,
      name: appName(app),
      organization: app.organization?.name,
      installs: app.installs,
      rating: app.rating,
      live: app.liveBuild ? {build: app.liveBuild.id, version: app.liveVersion, crashes: app.liveBuild.crashes} : null,
      test: app.testBuild ? {build: app.testBuild.id, version: app.testVersion, crashes: app.testBuild.crashes} : null,
    })),
    ...(failures.length ? {failures} : {}),
  };
}));

server.registerTool('list_builds', {
  title: 'List builds of an app',
  description: 'Builds of one app, newest first, with version, state, installs and crash count (crashes include diagnostic reports).',
  inputSchema: {appId, limit: z.number().int().min(1).max(200).optional().describe('Default 20')},
}, ({appId, limit}) => run(async () => recentBuilds(appId, limit ?? 20)));

server.registerTool('get_crashes', {
  title: 'Get crashes of an app',
  description: 'Crashes and unhandled rejections of the newest builds, grouped by error and the app file/line it came from, '
      + 'most frequent first. Errors that differ only in a device id are one group. Diagnostic reports are left out; '
      + 'use list_diagnostic_reports for those.',
  inputSchema: {
    appId,
    builds,
    buildId,
    kind: z.enum(['crash', 'unhandled_rejection']).optional().describe('Only this kind'),
    limit: z.number().int().min(1).max(100).optional().describe('Max groups (default 20)'),
  },
}, ({appId, builds: n, buildId, kind, limit}) => run(async () => {
  const groups = groupCrashes(await crashesOf(appId, await recentBuilds(appId, n ?? 5, buildId)))
      .filter((group) => !kind || group.kind === kind);
  return {totalGroups: groups.length, groups: groups.slice(0, limit ?? 20)};
}));

server.registerTool('list_diagnostic_reports', {
  title: 'List diagnostic reports of an app',
  description: 'Diagnostic reports users submitted from the app settings ("Create diagnostics report"), newest first, '
      + 'with their message and a preview of stderr. Use get_diagnostic_report for the full log.',
  inputSchema: {appId, builds, buildId},
}, ({appId, builds: n, buildId}) => run(async () => {
  const crashes = await crashesOf(appId, await recentBuilds(appId, n ?? 5, buildId));
  return crashes
      .filter((crash) => classify(crash.stack) === 'diagnostic_report')
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((crash) => {
        const report = parseDiagnosticReport(crash.stack)!;
        return {
          logId: report.logId,
          build: crash.buildId,
          version: crash.version,
          homeyVersion: crash.homeyVersion,
          createdAt: crash.createdAt,
          userMessage: report.userMessage,
          stdoutLines: report.stdout ? report.stdout.split('\n').length : 0,
          stderrPreview: report.stderr.split('\n').slice(0, 5).join('\n'),
        };
      });
}));

server.registerTool('get_diagnostic_report', {
  title: 'Get a diagnostic report',
  description: 'The full diagnostic report with this Log ID: user message, stdout and stderr.',
  inputSchema: {
    appId,
    logId: z.string().describe('Log ID from list_diagnostic_reports or the report e-mail'),
    builds: z.number().int().min(1).max(50).optional().describe('How many of the newest builds to search (default 20)'),
  },
}, ({appId, logId, builds: n}) => run(async () => {
  for (const crash of await crashesOf(appId, await recentBuilds(appId, n ?? 20))) {
    const report = parseDiagnosticReport(crash.stack);
    if (report?.logId === logId) {
      return {build: crash.buildId, version: crash.version, homeyVersion: crash.homeyVersion, createdAt: crash.createdAt, ...report};
    }
  }
  throw new Error(`No diagnostic report ${logId} in the newest ${n ?? 20} builds of ${appId}`);
}));

server.registerTool('get_install_stats', {
  title: 'Get install stats of an app',
  description: 'Daily install counts of an app, and optionally per driver.',
  inputSchema: {
    appId,
    days: z.number().int().min(1).optional().describe('Only the last N data points (default 30)'),
    perDriver: z.boolean().optional().describe('Also return the counts per driver'),
  },
}, ({appId, days, perDriver}) => run(async () => {
  const n = days ?? 30;
  const installs = (await api.getInstallStats(appId)).slice(-n);
  if (!perDriver) return {installs};
  const drivers = Object.fromEntries(
      Object.entries(await api.getDriverStats(appId)).map(([driver, points]) => [driver, points.slice(-n)]),
  );
  return {installs, drivers};
}));

server.connect(new StdioServerTransport()).catch((error) => {
  console.error(error);
  process.exit(1);
});
