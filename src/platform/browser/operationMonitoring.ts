import type { CaptureResult } from 'posthog-js';

type MonitorClient = typeof import('posthog-js')['default'];
type OperationProperties = Record<string, string | number | boolean>;
interface RecentOperation {
  action: 'button' | 'guest_button';
  timestamp: string;
  properties: OperationProperties;
}
type MonitorEvent = {
  name: 'ra2vm_issue';
  properties: Record<string, string | number | boolean | RecentOperation[]>;
  timestamp?: Date;
};

interface OperationContext {
  game?: string | null;
  phase?: string;
  shell?: string;
  mode?: 'worker' | 'main-thread';
}

export interface CanvasPress {
  x: number;
  y: number;
  width: number;
  height: number;
  button: 'left' | 'right' | 'middle';
  pointer: 'mouse' | 'touch' | 'pen';
}

export interface GuestControlSnapshot {
  lastMouseHitControlId: number;
  lastMouseHitClass: string;
  lastMouseHitText: string;
  lastMouseInputX: number;
  lastMouseInputY: number;
  lastMouseInputMessage: number;
}

const buttonMessages: Record<CanvasPress['button'], readonly number[]> = {
  left: [0x0201, 0x0202, 0x0203],
  right: [0x0204, 0x0205, 0x0206],
  middle: [0x0207, 0x0208, 0x0209],
};

function guestControlProperties(
  press: CanvasPress,
  shell: string,
  pointerState: GuestControlSnapshot | null | undefined,
): OperationProperties | null {
  if (!pointerState) return null;
  if (pointerState.lastMouseInputX !== press.x || pointerState.lastMouseInputY !== press.y) return null;
  if (!buttonMessages[press.button].includes(pointerState.lastMouseInputMessage)) return null;

  const className = pointerState.lastMouseHitClass;
  if (className !== 'button') return null;
  const text = pointerState.lastMouseHitText;
  const controlId = pointerState.lastMouseHitControlId;
  const hasFixedName = /^GUI:[A-Za-z0-9_]{1,48}$/.test(text) && text !== shell;
  const hasFixedButtonId = Number.isInteger(controlId) && controlId > 0 && controlId <= 0xffff;
  if (!hasFixedName && !hasFixedButtonId) return null;

  const properties: OperationProperties = { guest_control_class: className };
  if (hasFixedName) properties.guest_control = text;
  if (Number.isInteger(controlId) && controlId > 0 && controlId <= 0xffff) properties.guest_control_id = controlId;
  return properties;
}

let client: MonitorClient | null = null;
let started = false;
let generation = 0;
const pending: MonitorEvent[] = [];
const MAX_PENDING = 5;
const MAX_RECENT = 20;
const RECENT_MS = 5 * 60_000;
const recent: RecentOperation[] = [];
let context: OperationContext = {};
let issueWindowStart = 0;
let issueCount = 0;
const recentIssues = new Map<string, number>();
const propertyKeys = new Set([
  'token',
  'distinct_id',
  '$session_id',
  '$window_id',
  'control',
  'guest_control',
  'guest_control_id',
  'guest_control_class',
  'x',
  'y',
  'width',
  'height',
  'button',
  'pointer',
  'game',
  'phase',
  'kind',
  'shell',
  'mode',
  'app_version',
  'app_revision',
  'error_name',
  'error_message',
  'error_stack',
]);

const operationKeys = new Set([
  'control',
  'guest_control',
  'guest_control_id',
  'guest_control_class',
  'x',
  'y',
  'width',
  'height',
  'button',
  'pointer',
  'game',
  'phase',
  'shell',
]);

/** Redact common sensitive values before retaining diagnostics; never stringify arbitrary thrown objects. */
export function sanitizeIssueText(text: string, limit = 512): string {
  return (
    text
      .slice(0, 8192)
      // A path may contain spaces; over-redact the remainder up to a clear delimiter rather than expose a suffix.
      .replace(/\b[A-Z]:[\\/][^\r\n<>"]+|\\\\[^\r\n<>"]+|(?:^|[\s(])(?:~\/|\/)[^\r\n<>"]+/gim, ' [path]')
      .replace(/(?:https?|wss?|file|blob|data):[^\s<>"']+/gi, '[url]')
      .replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, '[email]')
      .replace(
        /\b(?:token|password|secret|authorization|player(?:name)?|filename)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
        '[value]',
      )
      .replace(/(["'`])[^\n]*?\1/g, '[value]')
      .replace(
        /[^\r\n<>:"'`/\\[\]{},;]+\.(?:zip|rar|7z|exe|dll|mix|ini|sav|map|mpr|yrm|json|ya?ml|txt|csv|log)\b/gi,
        '[file]',
      )
      .replace(/\b[A-Za-z0-9_-]{32,}\b/g, '[value]')
      .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
      .slice(0, limit)
  );
}

/** Normalize Chrome/V8 and Firefox frames without treating function@source as an email address. */
export function sanitizeIssueStack(stack: string): string {
  const frames: string[] = [];
  for (const raw of stack.slice(0, 8192).split('\n')) {
    const line = raw.trim();
    let functionName = '';
    let location: string;
    if (line.startsWith('at ')) {
      const frame = /^at (.*?) \((.+)\)$/.exec(line);
      functionName = frame?.[1] ?? '';
      location = frame?.[2] ?? line.slice(3);
    } else {
      const frame = /^([^@]*)@(.+)$/.exec(line);
      if (!frame) continue;
      functionName = frame[1]!;
      location = frame[2]!;
    }
    const position = /^(.*):(\d{1,10}):(\d{1,10})$/.exec(location);
    if (!position) continue;
    let source = position[1]!;
    if (/^https?:\/\//i.test(source)) {
      try {
        const url = new URL(source);
        source = /^\/(?:src|assets)\//.test(url.pathname)
          ? url.pathname.replace(/^\/(?:src|assets)\//, '')
          : '[source]';
      } catch {
        source = '[source]';
      }
    }
    // Only application-relative script locations survive; absolute/user paths and unknown sources are omitted.
    if (
      source !== '[source]' &&
      (!/^[A-Za-z0-9_./-]+\.(?:[cm]?js|jsx|tsx?)$/.test(source) ||
        source.startsWith('/') ||
        source.split('/').some((part) => part === '..' || part === '.'))
    )
      source = '[source]';
    const safeFunction = sanitizeIssueText(functionName, 96);
    const name = /^[A-Za-z_$][A-Za-z0-9_.$ <>[\]-]{0,95}$/.test(safeFunction) ? safeFunction : '';
    const at = `${source}:${position[2]}:${position[3]}`;
    frames.push((name ? `    at ${name} (${at})` : `    at ${at}`).slice(0, 256));
    if (frames.length === 12) break;
  }
  return frames.join('\n').slice(0, 2048);
}

function errorProperties(error: unknown): OperationProperties {
  if (error instanceof Error) {
    let message: string;
    let stack: string;
    let name: string;
    try {
      message = typeof error.message === 'string' ? error.message : '';
      stack = typeof error.stack === 'string' ? error.stack : '';
      name = error.name;
    } catch {
      return { error_name: 'Error', error_message: 'Error details unavailable' };
    }
    return {
      error_name:
        /^(Error|EvalError|RangeError|ReferenceError|SyntaxError|TypeError|URIError|AggregateError|AbortError|SecurityError|NotAllowedError|NetworkError)$/.test(
          name,
        )
          ? name
          : 'Error',
      error_message: sanitizeIssueText(message),
      error_stack: sanitizeIssueStack(stack),
    };
  }
  return {
    error_name: typeof error === 'string' ? 'Error' : 'UnknownError',
    error_message: typeof error === 'string' ? sanitizeIssueText(error) : 'No structured error details available',
  };
}

export function updateOperationContext(next: OperationContext): void {
  context = contextProperties({ ...context, ...next });
}

function contextProperties(value: OperationContext): OperationProperties {
  const fields: OperationProperties = {};
  for (const [key, field] of Object.entries(value)) {
    if (['game', 'phase', 'shell', 'mode'].includes(key) && isAllowedProperty(key, field)) fields[key] = field;
  }
  return fields;
}

/** Session owners clear old context and operations; pending issue snapshots remain independent. */
export function resetOperationContext(): void {
  context = {};
  recent.length = 0;
}

function remember(action: RecentOperation['action'], properties: OperationProperties, timestamp = new Date()): void {
  if (!started || !Number.isFinite(timestamp.getTime())) return;
  const now = Date.now();
  if (timestamp.getTime() < now - RECENT_MS || timestamp.getTime() > now) return;
  recent.push({ action, properties, timestamp: timestamp.toISOString() });
  recent.sort((left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp));
  while (recent.length > MAX_RECENT || (recent[0] && Date.parse(recent[0].timestamp) < now - RECENT_MS)) recent.shift();
}

function isAllowedProperty(key: string, value: unknown): value is string | number | boolean {
  if (key === 'mode') return value === 'worker' || value === 'main-thread';
  if (key === 'app_version' || key === 'app_revision')
    return typeof value === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(value);
  if (key === 'error_name') return typeof value === 'string' && /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(value);
  if (key === 'error_message' || key === 'error_stack') return typeof value === 'string';
  if (key === 'x' || key === 'y' || key === 'width' || key === 'height')
    return typeof value === 'number' && Number.isFinite(value);
  if (key === 'guest_control_id')
    return typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= 0xffff;
  if (key === 'button') return value === 'left' || value === 'right' || value === 'middle';
  if (key === 'pointer') return value === 'mouse' || value === 'touch' || value === 'pen';
  if (key === 'game') return value === 'ra2' || value === 'yr';
  if (key === 'phase')
    return typeof value === 'string' && /^(loading|ready|running|blocked|exited|stopped|error)$/.test(value);
  if (key === 'kind')
    return (
      value === 'react' ||
      value === 'startup' ||
      value === 'runtime' ||
      value === 'uncaught' ||
      value === 'unhandled_rejection'
    );
  if (key === 'control') return typeof value === 'string' && /^[a-z0-9-]{1,256}$/.test(value);
  if (key === 'guest_control' || key === 'shell')
    return typeof value === 'string' && /^GUI:[A-Za-z0-9_]{1,48}$/.test(value);
  if (key === 'guest_control_class') return value === 'button';
  if (key === 'token' || key === 'distinct_id' || key === '$session_id' || key === '$window_id')
    return typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(value);
  return false;
}

/** Reject normal-operation events and SDK metadata; revalidate every nested operation at the upload boundary. */
export function filterOperationEvent(event: CaptureResult | null): CaptureResult | null {
  if (!event || event.event !== 'ra2vm_issue') return null;
  const properties: CaptureResult['properties'] = {};
  for (const [key, value] of Object.entries(event.properties)) {
    if (propertyKeys.has(key) && isAllowedProperty(key, value)) {
      properties[key] =
        key === 'error_stack'
          ? sanitizeIssueStack(value as string)
          : key === 'error_message'
            ? sanitizeIssueText(value as string)
            : value;
    }
  }
  if (Array.isArray(event.properties.recent_operations)) {
    properties.recent_operations = event.properties.recent_operations.slice(-MAX_RECENT).flatMap((entry: unknown) => {
      if (!entry || typeof entry !== 'object') return [];
      const operation = entry as Partial<RecentOperation>;
      if (
        (operation.action !== 'button' && operation.action !== 'guest_button') ||
        typeof operation.timestamp !== 'string' ||
        !/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(operation.timestamp) ||
        !Number.isFinite(Date.parse(operation.timestamp)) ||
        !operation.properties ||
        typeof operation.properties !== 'object'
      )
        return [];
      const fields: OperationProperties = {};
      for (const [key, value] of Object.entries(operation.properties)) {
        if (operationKeys.has(key) && isAllowedProperty(key, value)) fields[key] = value;
      }
      return [{ action: operation.action, timestamp: operation.timestamp, properties: fields }];
    });
  }
  return { uuid: event.uuid, event: event.event, timestamp: event.timestamp, properties };
}

function send(event: MonitorEvent): void {
  event.timestamp ??= new Date();
  if (client) {
    try {
      client.capture(event.name, event.properties, { send_instantly: true, timestamp: event.timestamp });
    } catch {
      console.warn('[monitor] Operation event could not be sent');
    }
  } else if (started && pending.length < MAX_PENDING) pending.push(event);
}

function fixedControl(button: HTMLButtonElement | HTMLAnchorElement): string {
  const marked = button.dataset.monitorAction;
  if (marked && /^[a-z][a-z0-9-]{0,63}$/.test(marked)) return marked;
  if (/^(vm|source|game|relay)-[a-z0-9-]{1,56}$/.test(button.id)) return button.id;
  const region = button.closest<HTMLElement>('[id]');
  const regionId = region?.id ?? '';
  if (/^(vm|source|game|relay)-[a-z0-9-]{1,42}$/.test(regionId)) {
    const index = [...region!.querySelectorAll('button, a[data-monitor-action]')].indexOf(button);
    if (index >= 0) return `${regionId}-button-${index}`;
  }
  const path: string[] = [];
  for (let node: Element | null = button; node?.parentElement && path.length < 5; node = node.parentElement) {
    const index = [...node.parentElement.children].indexOf(node);
    path.push(`${node.localName}-${index}`);
  }
  return `dom-${path.reverse().join('-')}`;
}

/** One page-lifetime listener covers React portals and buttons added after startup. */
export function startOperationMonitoring(token: string | undefined, host: string | undefined): () => void {
  if (!token || !host || started) return () => {};
  let endpoint: URL;
  try {
    endpoint = new URL(host);
    if (endpoint.protocol !== 'https:') return () => {};
  } catch {
    return () => {};
  }
  started = true;
  const current = ++generation;
  const onGlobalError = (event: Event) => {
    if (event instanceof ErrorEvent) recordOperationIssue('uncaught', undefined, event.error ?? event.message);
  };
  const onUnhandledRejection = (event: PromiseRejectionEvent) =>
    recordOperationIssue('unhandled_rejection', undefined, event.reason);
  const onClick = (event: MouseEvent) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const button = target.closest<HTMLButtonElement | HTMLAnchorElement>('button, a[data-monitor-action]');
    if (!button || (button instanceof HTMLButtonElement && button.disabled)) return;
    remember('button', { control: fixedControl(button) });
  };
  document.addEventListener('click', onClick, true);
  window.addEventListener('error', onGlobalError);
  window.addEventListener('unhandledrejection', onUnhandledRejection);
  void import('posthog-js')
    .then(({ default: posthog }) => {
      if (generation !== current) return;
      posthog.init(token, {
        api_host: endpoint.href.replace(/\/$/, ''),
        defaults: '2026-05-30',
        autocapture: false,
        capture_pageview: false,
        capture_pageleave: false,
        disable_session_recording: true,
        disable_surveys: true,
        disable_surveys_automatic_display: true,
        disable_product_tours: true,
        disable_conversations: true,
        advanced_disable_feature_flags: true,
        disable_external_dependency_loading: true,
        disable_web_experiments: true,
        rageclick: false,
        request_batching: false,
        persistence: 'sessionStorage',
        person_profiles: 'never',
        save_referrer: false,
        save_campaign_params: false,
        get_current_url: () => `${location.origin}${location.pathname}`,
        before_send: filterOperationEvent,
      });
      client = posthog;
      for (const event of pending.splice(0)) send(event);
    })
    .catch(() => {
      if (generation !== current) return;
      document.removeEventListener('click', onClick, true);
      window.removeEventListener('error', onGlobalError);
      window.removeEventListener('unhandledrejection', onUnhandledRejection);
      started = false;
      pending.length = 0;
      resetOperationContext();
      recentIssues.clear();
      issueCount = 0;
      issueWindowStart = 0;
      console.warn('[monitor] Operation events could not start');
    });
  return () => {
    if (generation !== current) return;
    generation++;
    started = false;
    pending.length = 0;
    resetOperationContext();
    recentIssues.clear();
    issueCount = 0;
    issueWindowStart = 0;
    document.removeEventListener('click', onClick, true);
    window.removeEventListener('error', onGlobalError);
    window.removeEventListener('unhandledrejection', onUnhandledRejection);
    const active = client;
    client = null;
    void active?.shutdown();
  };
}

export function recordCanvasPress(
  press: CanvasPress,
  game: string | null,
  phase: string,
  shell: string,
  pointerState?: GuestControlSnapshot | null,
  timestamp = new Date(),
): void {
  if (!started) return;
  const { x, y, width, height, button, pointer } = press;
  if (![x, y, width, height].every(Number.isFinite) || width < 1 || height < 1) return;
  if (x < 0 || x >= width || y < 0 || y >= height) return;
  const controlProperties = guestControlProperties(press, shell, pointerState);
  if (!controlProperties) return;
  const properties: OperationProperties = { x, y, width, height, button, pointer, ...controlProperties };
  if (game === 'ra2' || game === 'yr') properties.game = game;
  if (/^(loading|ready|running|blocked|exited|stopped|error)$/.test(phase)) properties.phase = phase;
  if (/^GUI:[A-Za-z]{1,32}$/.test(shell)) properties.shell = shell;
  remember('guest_button', properties, timestamp);
}

export function isOperationMonitoringEnabled(): boolean {
  return started;
}

export function recordOperationIssue(
  kind: 'react' | 'startup' | 'runtime' | 'uncaught' | 'unhandled_rejection',
  game?: string | null,
  error?: unknown,
  extra: OperationContext = {},
): void {
  if (!started) return;
  const properties: MonitorEvent['properties'] = {
    ...contextProperties({ ...context, ...extra }),
    kind,
    ...errorProperties(error),
    app_version: import.meta.env.VITE_APP_VERSION ?? 'unknown',
    app_revision: import.meta.env.VITE_APP_REVISION ?? 'unknown',
  };
  if (game !== undefined) {
    if (game === 'ra2' || game === 'yr') properties.game = game;
    else delete properties.game;
  }
  const now = Date.now();
  const signature = JSON.stringify([
    properties.error_name,
    properties.error_message,
    properties.error_stack,
    properties.game,
  ]);
  for (const [key, at] of recentIssues) if (now - at >= 60_000) recentIssues.delete(key);
  if (recentIssues.has(signature)) return;
  if (now - issueWindowStart >= 60_000) {
    issueWindowStart = now;
    issueCount = 0;
  }
  if (issueCount >= 5) return;
  issueCount++;
  recentIssues.set(signature, now);
  properties.recent_operations = recent
    .filter((entry) => Date.parse(entry.timestamp) >= now - RECENT_MS)
    .map((entry) => ({ ...entry, properties: { ...entry.properties } }));
  send({ name: 'ra2vm_issue', properties });
}
