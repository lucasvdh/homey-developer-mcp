import {test} from 'node:test';
import assert from 'node:assert/strict';
import {appFrame, BuildCrash, classify, groupCrashes, parseDiagnosticReport} from './crashes';

const report = [
  'Note: this log has been manually submitted by a user.',
  'Log ID: 11111111-2222-3333-4444-555555555555',
  '',
  'User Message:',
  'It stopped working.',
  'Second line.',
  '',
  '---- stdout ----',
  '2024-01-01T00:00:00.000Z [log] [MyApp] App has been initialized',
  '2024-01-01T00:00:01.000Z [log] [MyApp] Connected',
  '',
  '---- stderr ----',
  'ECONNREFUSED',
  '    ',
].join('\n');

const unhandled = (id: string, sdkLine: string) => [
  'Note: this e-mail is sent because an unhandledRejection occurred in your app. Make sure to catch all errors, this might crash your app in the future. Stack trace attached below:',
  '',
  `  Error: Not Found: Device with ID ${id}`,
  '    at Remote Process',
  `    at RemoteDevice.setUnavailable (/opt/homey-client/node_modules/@athombv/homey-apps-sdk-v3/lib/Device.js:${sdkLine})`,
  '    at MyDevice.<anonymous> (/app/drivers/thing/device.js:95:22)',
  '    at MyDevice.emit (node:events:517:28)',
  '      ',
].join('\n');

const crash = [
  'TypeError: Cannot read properties of undefined (reading \'x\')',
  '    at /node_modules/some-lib/index.js:1:1',
  '    at Thing.run (/lib/Thing.js:12:3)',
].join('\n');

function entry(stack: string, extra: Partial<BuildCrash> = {}): BuildCrash {
  return {count: 1, stack, createdAt: '2024-01-01T00:00:00.000Z', updatedAt: '2024-01-01T00:00:00.000Z', buildId: 1, ...extra};
}

test('classify tells the three kinds apart', () => {
  assert.equal(classify(report), 'diagnostic_report');
  assert.equal(classify(unhandled('a', '1:1')), 'unhandled_rejection');
  assert.equal(classify(crash), 'crash');
});

test('parseDiagnosticReport splits the report', () => {
  assert.deepEqual(parseDiagnosticReport(report), {
    logId: '11111111-2222-3333-4444-555555555555',
    userMessage: 'It stopped working.\nSecond line.',
    stdout: '2024-01-01T00:00:00.000Z [log] [MyApp] App has been initialized\n2024-01-01T00:00:01.000Z [log] [MyApp] Connected',
    stderr: 'ECONNREFUSED',
  });
  assert.equal(parseDiagnosticReport(crash), null);
});

test('parseDiagnosticReport copes with a missing stderr', () => {
  const parsed = parseDiagnosticReport(report.slice(0, report.indexOf('---- stderr ----')));
  assert.equal(parsed?.stderr, '');
  assert.match(parsed?.stdout ?? '', /Connected$/);
});

test('appFrame skips SDK and node frames and strips /app', () => {
  assert.equal(appFrame(unhandled('a', '1:1')), 'drivers/thing/device.js:95:22');
  assert.equal(appFrame(crash), 'lib/Thing.js:12:3');
});

test('groupCrashes merges errors that differ only in a device id, and skips reports', () => {
  const groups = groupCrashes([
    entry(unhandled('941c6e7d-312c-491e-9f27-3acb3922cef1', '366:27'), {count: 39, homeyVersion: '10.0.8'}),
    entry(unhandled('4c62e020-ec04-4c17-8c5d-34f21de748b7', '1:4367'), {
      count: 1271, homeyVersion: '10.0.2', buildId: 2, updatedAt: '2024-02-01T00:00:00.000Z',
    }),
    entry(crash, {count: 5}),
    entry(report),
  ]);

  assert.equal(groups.length, 2);
  assert.deepEqual(
      {...groups[0], stack: undefined},
      {
        kind: 'unhandled_rejection',
        message: 'Error: Not Found: Device with ID <id>',
        location: 'drivers/thing/device.js:95:22',
        count: 1310,
        entries: 2,
        builds: [1, 2],
        homeyVersions: ['10.0.8', '10.0.2'],
        firstSeen: '2024-01-01T00:00:00.000Z',
        lastSeen: '2024-02-01T00:00:00.000Z',
        stack: undefined,
      },
  );
  assert.match(groups[0].stack, /4c62e020/);
  assert.equal(groups[1].kind, 'crash');
});
