export type ControlActivity =
  | { kind: 'reset' }
  | { kind: 'disconnect' }
  | {
      kind: 'request' | 'reply';
      method: string;
      params: unknown;
      result?: unknown;
      error?: string;
      requestId?: number;
    };

/** Session-owned control connection. Transport and VM implementations are injected. */
export class ControlSession {
  private endpoint: ((method: string, params: unknown) => Promise<unknown>) | null = null;
  private close: (() => void) | null = null;
  private generation = 0;
  private requestSequence = 0;
  private receiptTimer: ReturnType<typeof setTimeout> | undefined;
  private receiptGeneration = 0;
  private receipts = new Map<string, { params: { sessionId: string; commandId: string }; attempts: number }>();

  constructor(private readonly activity: (event: ControlActivity) => void = () => {}) {}

  private report(event: ControlActivity): void {
    // A presentation subscriber must never alter command delivery or its receipt.
    try {
      this.activity(event);
    } catch {
      /* The connection remains usable without a journal. */
    }
  }

  private followReceipt(params: unknown, result: unknown): void {
    if (!params || typeof params !== 'object' || !result || typeof result !== 'object') return;
    const p = params as Record<string, unknown>;
    const r = result as Record<string, unknown>;
    if (typeof p.sessionId !== 'string' || typeof p.commandId !== 'string') return;
    const key = JSON.stringify([p.sessionId, p.commandId]);
    if (r.state !== 'pending') {
      this.receipts.delete(key);
      return;
    }
    if (!this.receipts.has(key) && this.receipts.size < 16)
      this.receipts.set(key, { params: { sessionId: p.sessionId, commandId: p.commandId }, attempts: 0 });
    this.scheduleReceipts();
  }

  private scheduleReceipts(): void {
    if (this.receiptTimer !== undefined || !this.receipts.size || !this.endpoint) return;
    const generation = this.receiptGeneration;
    const endpoint = this.endpoint;
    this.receiptTimer = setTimeout(async () => {
      try {
        for (const [key, receipt] of this.receipts) {
          if (generation !== this.receiptGeneration) return;
          try {
            const result = await endpoint('commandStatus', receipt.params);
            if (generation !== this.receiptGeneration) return;
            if (this.receipts.get(key) !== receipt) continue;
            const state = result && typeof result === 'object' ? (result as { state?: unknown }).state : undefined;
            const expired = state === 'pending' && ++receipt.attempts >= 30;
            this.report({
              kind: 'reply',
              method: 'commandStatus',
              params: receipt.params,
              result: expired ? { state: 'unknown' } : result,
            });
            if (state !== 'pending' || expired) this.receipts.delete(key);
          } catch {
            if (generation !== this.receiptGeneration) return;
            this.report({
              kind: 'reply',
              method: 'commandStatus',
              params: receipt.params,
              result: { state: 'unknown' },
            });
            this.receipts.delete(key);
          }
        }
      } finally {
        if (generation === this.receiptGeneration) {
          this.receiptTimer = undefined;
          this.scheduleReceipts();
        }
      }
    }, 500);
  }

  attach(endpoint: (method: string, params: unknown) => Promise<unknown>): void {
    this.dispose();
    this.endpoint = endpoint;
  }

  connect(factory: (request: (method: string, params: unknown) => Promise<unknown>) => () => void): void {
    this.disconnect();
    if (!this.endpoint) throw new Error('No running game session');
    const endpoint = this.endpoint;
    const generation = this.generation;
    this.close = factory(async (method, params) => {
      if (this.generation !== generation || this.endpoint !== endpoint) throw new Error('Game session replaced');
      const requestId = ++this.requestSequence;
      if (method === 'command' || method === 'ui.quickStart')
        this.report({ kind: 'request', method, params, requestId });
      try {
        const result = await endpoint(method, params);
        if (this.generation !== generation) throw new Error('Game session replaced');
        if (method === 'command' || method === 'commandStatus' || method === 'ui.quickStart') {
          this.report({ kind: 'reply', method, params, result, requestId });
          if (method !== 'ui.quickStart') this.followReceipt(params, result);
        }
        return result;
      } catch (error) {
        if (this.generation === generation && (method === 'command' || method === 'ui.quickStart'))
          this.report({
            kind: 'reply',
            method,
            params,
            requestId,
            error: error instanceof Error ? error.message : String(error),
          });
        throw error;
      }
    });
  }

  disconnect(): void {
    this.generation++;
    this.receiptGeneration++;
    clearTimeout(this.receiptTimer);
    this.receiptTimer = undefined;
    for (const { params } of this.receipts.values())
      this.report({ kind: 'reply', method: 'commandStatus', params, result: { state: 'unknown' } });
    this.receipts.clear();
    this.report({ kind: 'disconnect' });
    this.close?.();
    this.close = null;
  }
  dispose(): void {
    this.generation++;
    this.disconnect();
    this.endpoint = null;
    this.report({ kind: 'reset' });
  }
}
