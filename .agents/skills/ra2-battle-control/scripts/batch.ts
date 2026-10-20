import { NativeCommandError, type ControlClient } from './client';

/** Validate the envelope before any prerequisite operation can mutate the session. */
export function validateOrders(orders: unknown) {
  if (
    !Array.isArray(orders) ||
    !orders.length ||
    orders.length > 32 ||
    orders.some(
      (o) =>
        !o ||
        typeof o !== 'object' ||
        Array.isArray(o) ||
        typeof o.action !== 'string' ||
        ['sessionId', 'commandId', 'observedFrame'].some((key) => key in o),
    )
  )
    throw new Error(
      'Provide 1..32 orders with action; session and receipt IDs are managed by ctl. ' +
        'Example orders: [{"action":"guard","unit":"VISIBLE_OWNED_ID"}]. ' +
        'Use string unit/units; movement also takes cell: {"x":0,"y":0}. Choose actual IDs and cells from the current view.',
    );
  return orders;
}

export interface BatchResult {
  state: 'submitted' | 'interrupted' | 'completed-with-rejections';
  completed: { index: number; action: string; state: string; commandId?: string }[];
  rejected?: { index: number; action: string; commandId: string; error: string }[];
  failed?: number;
  remaining?: number;
  next?: 'reobserve' | 'inspect';
  error?: string;
}

/** Ordered intents share one session. Only explicit independent orders may continue after confirmed rejection. */
export async function batch(client: ControlClient, params: Record<string, unknown>): Promise<BatchResult> {
  const orders = validateOrders(params.orders);
  const onRejected = params.onRejected ?? 'stop';
  if (onRejected !== 'stop' && onRejected !== 'continue') throw new Error('onRejected must be stop or continue');
  const rejected: NonNullable<BatchResult['rejected']> = [];
  const initial = await client.observe();
  const session = typeof params.sessionId === 'string' ? params.sessionId : initial.sessionId;
  if (session !== initial.sessionId) throw new Error('Session changed');
  const completed: BatchResult['completed'] = [];
  for (const [index, order] of orders.entries()) {
    const { action, ...extra } = order;
    try {
      if (action === 'camera') {
        await client.look(extra, session);
        completed.push({ index, action, state: 'submitted' });
      } else completed.push({ index, action, ...(await client.command(action, extra, session)) });
    } catch (error) {
      if (onRejected === 'continue' && error instanceof NativeCommandError && error.state === 'rejected') {
        rejected.push({ index, action, commandId: error.commandId, error: String(error) });
        continue;
      }
      return {
        state: 'interrupted',
        completed,
        ...(rejected.length ? { rejected } : {}),
        failed: index,
        remaining: orders.length - index - 1,
        next: error instanceof NativeCommandError && error.state === 'rejected' ? 'reobserve' : 'inspect',
        error: String(error),
      };
    }
  }
  return {
    state: rejected.length ? 'completed-with-rejections' : 'submitted',
    completed,
    ...(rejected.length ? { rejected } : {}),
  };
}
