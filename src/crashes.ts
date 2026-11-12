import type {CrashReport} from './AthomApi';

/**
 * The apps-api returns three kinds of entries from the same crash endpoint;
 * only the opening line of `stack` tells them apart.
 */
export type CrashKind = 'diagnostic_report' | 'unhandled_rejection' | 'crash';

const DIAGNOSTIC_HEADER = 'Note: this log has been manually submitted by a user.';
const UNHANDLED_HEADER = 'Note: this e-mail is sent because an unhandledRejection occurred in your app.';

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

export function classify(stack: string): CrashKind {
  const start = stack.trimStart();
  if (start.startsWith(DIAGNOSTIC_HEADER)) return 'diagnostic_report';
  if (start.startsWith(UNHANDLED_HEADER)) return 'unhandled_rejection';
  return 'crash';
}

export interface DiagnosticReport {
  logId: string | null;
  userMessage: string;
  stdout: string;
  stderr: string;
}

/** Splits a manually submitted log into its parts; null when `stack` is not one. */
export function parseDiagnosticReport(stack: string): DiagnosticReport | null {
  if (classify(stack) !== 'diagnostic_report') return null;

  const logId = /^Log ID:\s*(\S+)/m.exec(stack)?.[1] ?? null;
  const stdoutAt = stack.indexOf('---- stdout ----');
  const stderrAt = stack.indexOf('---- stderr ----');

  const messageAt = stack.indexOf('User Message:');
  const messageEnd = [stdoutAt, stderrAt].filter((i) => i >= 0).sort((a, b) => a - b)[0] ?? stack.length;
  const userMessage = messageAt >= 0
      ? stack.slice(messageAt + 'User Message:'.length, messageEnd).trim()
      : '';

  const section = (from: number, to: number) => from < 0 ? '' : stack.slice(from + 16, to < 0 || to < from ? stack.length : to).trim();

  return {
    logId,
    userMessage,
    stdout: section(stdoutAt, stderrAt),
    stderr: section(stderrAt, -1),
  };
}

/** The error itself, without the header Homey puts in front of unhandled rejections. */
export function errorText(stack: string): string {
  const text = classify(stack) === 'unhandled_rejection'
      ? stack.slice(stack.indexOf('Stack trace attached below:') + 'Stack trace attached below:'.length)
      : stack;
  return text.trim();
}

/** The first frame that points into the app's own code, e.g. "drivers/remote/device.js:95:22". */
export function appFrame(stack: string): string | null {
  for (const line of errorText(stack).split('\n')) {
    const match = /^\s*at (?:.*\()?(\/[^()\s]+:\d+:\d+)\)?\s*$/.exec(line);
    if (!match) continue;
    const path = match[1];
    if (path.includes('/node_modules/') || path.startsWith('/opt/')) continue;
    // Builds differ in whether the app lives under /app or at the root.
    return path.replace(/^\/app\//, '').replace(/^\//, '');
  }
  return null;
}

export interface CrashGroup {
  kind: Exclude<CrashKind, 'diagnostic_report'>;
  message: string;
  location: string | null;
  count: number;
  entries: number;
  builds: number[];
  homeyVersions: string[];
  firstSeen: string;
  lastSeen: string;
  stack: string;
}

export interface BuildCrash extends CrashReport {
  buildId: number;
  version?: string;
}

/**
 * Groups crashes that are the same error at the same place. Homey groups by
 * exact stack, so an error that mentions a device id gets a group per device.
 */
export function groupCrashes(crashes: BuildCrash[]): CrashGroup[] {
  const groups = new Map<string, CrashGroup>();

  for (const crash of crashes) {
    const kind = classify(crash.stack);
    if (kind === 'diagnostic_report') continue;

    const text = errorText(crash.stack);
    const message = (text.split('\n')[0] ?? '').trim();
    const location = appFrame(crash.stack);
    const key = `${kind}\u0000${message.replace(UUID, '<id>')}\u0000${location ?? text.replace(UUID, '<id>')}`;

    const group = groups.get(key);
    if (!group) {
      groups.set(key, {
        kind,
        message: message.replace(UUID, '<id>'),
        location,
        count: crash.count,
        entries: 1,
        builds: [crash.buildId],
        homeyVersions: crash.homeyVersion ? [crash.homeyVersion] : [],
        firstSeen: crash.createdAt,
        lastSeen: crash.updatedAt,
        stack: text,
      });
      continue;
    }

    group.count += crash.count;
    group.entries += 1;
    if (!group.builds.includes(crash.buildId)) group.builds.push(crash.buildId);
    if (crash.homeyVersion && !group.homeyVersions.includes(crash.homeyVersion)) group.homeyVersions.push(crash.homeyVersion);
    if (crash.createdAt < group.firstSeen) group.firstSeen = crash.createdAt;
    if (crash.updatedAt > group.lastSeen) {
      group.lastSeen = crash.updatedAt;
      group.stack = text;
    }
  }

  return Array.from(groups.values()).sort((a, b) => b.count - a.count);
}
