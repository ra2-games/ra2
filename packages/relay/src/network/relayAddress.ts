import { isRelayRoomId } from './relayWire';

/** Every single-segment path identifies a room; there are no reserved game paths or legacy endpoints. */
export function relayRoomFromPath(path: string): string {
  let room: string;
  try {
    room = decodeURIComponent(path.slice(1));
  } catch {
    throw new Error('relay 房间路径编码无效');
  }
  if (!path.startsWith('/') || !isRelayRoomId(room) || ['.', '..'].includes(room) || /[\u0000-\u001f\u007f]/.test(room))
    throw new Error('relay 房间路径必须是 1–64 字符的单段房间名');
  return room;
}

/** Preserve an omitted protocol so the client can probe before connecting; do not depend on the page protocol. */
export function normalizeRelayAddress(value: string, defaultRoom = 'default'): string {
  const input = value.trim();
  const explicit = /^[a-z][a-z0-9+.-]*:\/\//i.test(input);
  if (!input || /\s|\\/.test(input) || input.startsWith('/')) throw new Error('relay 必须包含主机地址');
  const authorityAndPath = (explicit ? input.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '') : input).split(/[?#]/, 1)[0]!;
  const slash = authorityAndPath.indexOf('/');
  // Validate before URL dot-segment normalization so /a/../b cannot silently become a different room.
  if (slash >= 0 && authorityAndPath.slice(slash) !== '/') relayRoomFromPath(authorityAndPath.slice(slash));
  let url: URL;
  try {
    url = new URL(explicit ? input : `ws://${input}`);
  } catch {
    throw new Error('relay 必须是有效的主机地址或 WS/WSS 地址');
  }
  if (!['ws:', 'wss:'].includes(url.protocol) || url.username || url.password || url.hash) {
    throw new Error('relay 必须是无用户名、密码和片段的 WS/WSS 地址');
  }
  if (url.pathname === '/') url.pathname = '/' + encodeURIComponent(defaultRoom);
  relayRoomFromPath(url.pathname);
  if (explicit) return url.href;
  // URL omits the default WS port 80; WSS probing must still use port 80 when explicitly supplied by the caller.
  const authority = input.split(/[/?#]/, 1)[0]!;
  return (
    url.hostname + (url.port ? ':' + url.port : authority.endsWith(':80') ? ':80' : '') + url.pathname + url.search
  );
}

export function relayAddressCandidates(value: string, defaultRoom = 'default'): string[] {
  const normalized = normalizeRelayAddress(value, defaultRoom);
  if (/^wss?:\/\//.test(normalized)) return [normalized];
  return [`wss://${normalized}`, `ws://${normalized}`];
}
