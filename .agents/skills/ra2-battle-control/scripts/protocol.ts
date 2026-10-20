/** Local control transport. Game schemas belong to the game capability, not the router. */
export const CONTROL_PORT = 15180;
export const MAX_CONTROL_MESSAGE = 1024 * 1024;
export const CHANNEL_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

export interface ControlRequest {
  id: string;
  method: string;
  params?: unknown;
}

export type ControlReply = { id: string; result: unknown } | { id: string; error: string };

export function isControlRequest(value: unknown): value is ControlRequest {
  if (!value || typeof value !== 'object') return false;
  const v = value as Partial<ControlRequest>;
  return (
    typeof v.id === 'string' &&
    v.id.length > 0 &&
    v.id.length <= 128 &&
    typeof v.method === 'string' &&
    v.method.length > 0 &&
    v.method.length <= 64
  );
}
