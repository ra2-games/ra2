import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { VmSessionController } from '../../src/app/session/vmSessionController';
import { startSessionRuntime } from '../../src/app/session/startSessionRuntime';
import {
  filterOperationEvent,
  recordCanvasPress,
  recordOperationIssue,
  resetOperationContext,
  sanitizeIssueText,
  sanitizeIssueStack,
  startOperationMonitoring,
  updateOperationContext,
} from '../../src/platform/browser/operationMonitoring';

const sdk = vi.hoisted(() => ({ init: vi.fn(), capture: vi.fn(), shutdown: vi.fn() }));
vi.mock('posthog-js', () => ({ default: sdk }));

let stop: () => void;
beforeEach(async () => {
  vi.clearAllMocks();
  vi.stubGlobal('document', new EventTarget());
  vi.stubGlobal('window', new EventTarget());
  stop = startOperationMonitoring('phc_test', 'https://monitoring.invalid');
  await vi.dynamicImportSettled();
});
afterEach(() => {
  stop();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const press = { x: 123, y: 234, width: 800, height: 600, button: 'left', pointer: 'mouse' } as const;
function guestButton(timestamp?: Date) {
  recordCanvasPress(
    press,
    'ra2',
    'running',
    'GUI:MainMenu',
    {
      lastMouseHitControlId: 1684,
      lastMouseHitClass: 'button',
      lastMouseHitText: 'GUI:SinglePlayer',
      lastMouseInputX: 123,
      lastMouseInputY: 234,
      lastMouseInputMessage: 0x0201,
    },
    timestamp,
  );
}

it('rejects normal-operation events and strips unapproved top-level and nested properties', () => {
  for (const event of ['ra2vm_button', 'ra2vm_canvas_press', '$snapshot', '$exception']) {
    expect(filterOperationEvent({ uuid: 'other', event, properties: {} })).toBeNull();
  }
  const captured = filterOperationEvent({
    uuid: 'event-id',
    event: 'ra2vm_issue',
    properties: {
      token: 'phc_test',
      distinct_id: 'anonymous-id',
      $session_id: 'session-id',
      kind: 'runtime',
      $current_url: 'https://example.test/?file=private.zip',
      playerName: 'private-player',
      recent_operations: [
        {
          action: 'button',
          timestamp: new Date().toISOString(),
          properties: {
            control: 'pick-archive',
            playerName: 'private-player',
            error_message: 'private-error',
          },
        },
        { action: 'text', timestamp: 'private-time', properties: { control: 'private' } },
      ],
    },
  });
  expect(captured?.properties).toMatchObject({ token: 'phc_test', distinct_id: 'anonymous-id', kind: 'runtime' });
  expect(captured?.properties.recent_operations).toEqual([
    { action: 'button', timestamp: expect.any(String), properties: { control: 'pick-archive' } },
  ]);
  expect(JSON.stringify(captured)).not.toMatch(/private|\.zip|\$current_url/);
});

it('redacts URLs, absolute paths, resources, emails, quoted values and credentials with bounded output', () => {
  const text =
    'Failed private.zip C:\\Users\\private\\game.exe /home/private/game.ini ' +
    'https://private.invalid/?token=private-secret person@private.invalid playerName=private-player ' +
    'password="private password" token=private-token "private text"';
  expect(sanitizeIssueText(text)).not.toMatch(/private|person|password|token|Users|home/);
  expect(sanitizeIssueText('x'.repeat(10_000)).length).toBeLessThanOrEqual(512);
  expect(
    filterOperationEvent({
      uuid: 'id',
      event: 'ra2vm_issue',
      properties: {
        error_message: text,
        error_stack: text.repeat(50),
      },
    })?.properties.error_stack.length,
  ).toBeLessThanOrEqual(2048);
});

it.each([
  'Cannot open C:\\Users\\Alice Smith\\config.json',
  'Cannot open C:/Users/Alice Smith/config.json',
  "Cannot open C:\\Users\\Alice (Smith) O'Neil\\config.json",
  'Cannot open \\\\server\\Alice Smith\\config.json',
  'Cannot open /home/Alice Smith/config.json',
  'Cannot open file:///C:/Users/Alice Smith/config.json',
  'Cannot open 我的存档.sav',
  'Cannot open 我的 存档.sav',
  'Cannot open 我的(存档).sav',
  'Cannot open 私人配置.json',
])('removes the complete private path/filename through both sanitization boundaries: %s', (message) => {
  const sanitized = sanitizeIssueText(message);
  expect(sanitized).not.toMatch(/Alice|Smith|config\.json|server|我的|存档|私人配置/);
  recordOperationIssue('runtime', 'ra2', new Error(message));
  const event = { uuid: 'id', event: 'ra2vm_issue', properties: sdk.capture.mock.calls[0]![1] };
  const once = filterOperationEvent(event);
  const twice = filterOperationEvent(once);
  expect(twice?.properties.error_message).toBe(sanitized);
  expect(JSON.stringify(twice)).not.toMatch(/Alice|Smith|config\.json|server|我的|存档|私人配置/);
});

it.each([
  {
    stack:
      'TypeError: failure\n    at render (https://private.invalid/src/ui/App.tsx?t=secret:12:34)\n    at start (https://private.invalid/src/app.ts:56:78)',
    expected: '    at render (ui/App.tsx:12:34)\n    at start (app.ts:56:78)',
  },
  {
    stack: 'render@https://private.invalid/src/ui/App.tsx?t=secret:12:34\nstart@app.ts:56:78',
    expected: '    at render (ui/App.tsx:12:34)\n    at start (app.ts:56:78)',
  },
  { stack: '@https://private.invalid/assets/index-abcd.js?token=secret:1:23', expected: '    at index-abcd.js:1:23' },
  { stack: '    at start@app.ts:56:78', expected: '    at [source]:56:78' },
])('preserves browser frame locations across repeated upload filtering: $stack', ({ stack, expected }) => {
  expect(sanitizeIssueStack(stack)).toBe(expected);
  const error = new Error('Failure');
  error.stack = stack;
  recordOperationIssue('runtime', 'ra2', error);
  const event = { uuid: 'id', event: 'ra2vm_issue', properties: sdk.capture.mock.calls[0]![1] };
  expect(event.properties.error_stack).toBe(expected);
  const once = filterOperationEvent(event);
  const twice = filterOperationEvent(once);
  expect(twice?.properties.error_stack).toBe(expected);
  expect(JSON.stringify(twice)).not.toMatch(/private|secret|\[email\]/);
});

it('redacts private stack sources and bounds frames without uploading an error header', () => {
  const stack =
    'Error: Alice Smith 我的存档.sav\n' +
    [
      'open@C:\\Users\\Alice Smith\\config.json:12:34',
      'load@/home/Alice Smith/我的存档.sav:56:78',
      'start@https://private.invalid/user/Alice/config.js:90:12',
      ...Array.from({ length: 15 }, () => 'run@app.ts:1:2'),
    ].join('\n');
  const sanitized = sanitizeIssueStack(stack);
  expect(sanitized.split('\n')).toHaveLength(12);
  expect(sanitized).toContain('at open ([source]:12:34)');
  expect(sanitized).toContain('at load ([source]:56:78)');
  expect(sanitized).not.toMatch(/Alice|Smith|config|我的|存档|private|Error:/);
  expect(sanitizeIssueStack(sanitized)).toBe(sanitized);
});

it('keeps operations local and attaches bounded recent context and sanitized error details only on issues', () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-08T00:00:00Z'));
  updateOperationContext({ game: 'ra2', phase: 'running', shell: 'GUI:MainMenu', mode: 'worker' });
  for (let index = 0; index < 25; index++) {
    guestButton();
    vi.advanceTimersByTime(1);
  }
  expect(sdk.capture).not.toHaveBeenCalled();
  const error = new TypeError('Cannot read "private-player" from https://private.invalid/?token=secret');
  error.stack =
    'TypeError: private-player\n    at run (https://private.invalid/src/ui/pages/game/page.ts?t=secret:12:34)';
  recordOperationIssue('runtime', undefined, error);
  expect(sdk.capture).toHaveBeenCalledTimes(1);
  const [name, properties] = sdk.capture.mock.calls[0]!;
  expect(name).toBe('ra2vm_issue');
  expect(properties).toMatchObject({
    kind: 'runtime',
    game: 'ra2',
    phase: 'running',
    mode: 'worker',
    app_version: expect.any(String),
    app_revision: expect.any(String),
    error_name: 'TypeError',
    error_stack: '    at run (ui/pages/game/page.ts:12:34)',
  });
  expect(properties.recent_operations).toHaveLength(20);
  expect(properties.recent_operations[0].timestamp).toBe('2026-10-08T00:00:00.005Z');
  expect(JSON.stringify(properties)).not.toMatch(/private|secret/);
  vi.advanceTimersByTime(5 * 60_000 + 1);
  recordOperationIssue('startup', 'yr', 'Different failure');
  expect(sdk.capture.mock.calls[1]![1].recent_operations).toEqual([]);
});

it('omits unknown guest targets and clears context and operations between sessions', () => {
  guestButton();
  resetOperationContext();
  recordCanvasPress(press, 'ra2', 'running', 'GUI:MainMenu');
  recordOperationIssue('startup', undefined, { playerName: 'private-player', message: 'private-message' });
  const properties = sdk.capture.mock.calls[0]![1];
  expect(properties.recent_operations).toEqual([]);
  expect(properties.game).toBeUndefined();
  expect(properties.error_name).toBe('UnknownError');
  expect(JSON.stringify(properties)).not.toMatch(/private/);
});

it('suppresses duplicate reports and caps error bursts, then permits later reports', () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-08T00:00:00Z'));
  const error = new Error('Repeated failure');
  recordOperationIssue('react', undefined, error);
  recordOperationIssue('uncaught', undefined, error);
  for (let index = 0; index < 10; index++) recordOperationIssue('runtime', 'ra2', `Failure ${index}`);
  expect(sdk.capture).toHaveBeenCalledTimes(5);
  vi.advanceTimersByTime(60_000);
  recordOperationIssue('react', undefined, error);
  expect(sdk.capture).toHaveBeenCalledTimes(6);
});

it('stops reporting after destruction and does not reinitialize from a late SDK import', async () => {
  stop();
  const stopAgain = startOperationMonitoring('phc_test', 'https://monitoring.invalid');
  stopAgain();
  await vi.dynamicImportSettled();
  expect(sdk.init).toHaveBeenCalledTimes(1);
  recordOperationIssue('runtime', 'ra2', new Error('Stopped'));
  expect(sdk.capture).not.toHaveBeenCalled();
});

it('queues an immutable issue snapshot while the SDK loads', async () => {
  stop();
  stop = startOperationMonitoring('phc_test', 'https://monitoring.invalid');
  guestButton();
  recordOperationIssue('startup', 'ra2', 'Startup failure');
  resetOperationContext();
  expect(sdk.capture).not.toHaveBeenCalled();
  await vi.dynamicImportSettled();
  expect(sdk.capture).toHaveBeenCalledTimes(1);
  expect(sdk.capture.mock.calls[0]![1].recent_operations).toHaveLength(1);
});

it('does not let malformed error getters disrupt failure handling', () => {
  const error = new Error();
  Object.defineProperty(error, 'message', {
    get() {
      throw new Error('private getter failure');
    },
  });
  expect(() => recordOperationIssue('runtime', 'ra2', error)).not.toThrow();
  expect(sdk.capture.mock.calls[0]![1]).toMatchObject({
    error_name: 'Error',
    error_message: 'Error details unavailable',
  });
});

it.each(['worker', 'main-thread'] as const)('reports %s when a created shell fails to start', async (mode) => {
  const controller = new VmSessionController();
  const shell = {
    runtimeInfo: { mode },
    start: vi.fn(async () => {
      throw new Error('VM initialization failed');
    }),
    destroy: vi.fn(async () => {}),
  };
  const onStarted = vi.fn();
  const result = await startSessionRuntime(
    () =>
      controller.start(
        async () => shell,
        (created) => updateOperationContext({ mode: created.runtimeInfo.mode }),
      ),
    (error) => recordOperationIssue('startup', 'ra2', error, { phase: 'error' }),
    async () => {
      resetOperationContext();
      await controller.destroy();
    },
    onStarted,
  );
  expect(result).toBeNull();
  expect(onStarted).not.toHaveBeenCalled();
  expect(shell.start).toHaveBeenCalledOnce();
  expect(shell.destroy).toHaveBeenCalledOnce();
  expect(sdk.capture).toHaveBeenCalledOnce();
  expect(sdk.capture.mock.calls[0]![1]).toMatchObject({ kind: 'startup', game: 'ra2', phase: 'error', mode });
});
