import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { BattleObservation } from './contracts';
import { CHANNEL_PATTERN } from './protocol';

export class NativeCommandError extends Error {
  constructor(
    readonly commandId: string,
    readonly state: string,
    reason?: string,
  ) {
    super(`Command ${commandId}: ${state}${reason ? ` (${reason})` : ''}`);
  }
}

class ControlReplyError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** Public loopback transport only. A client never reads guest memory or changes camera implicitly. */
export class ControlClient {
  constructor(
    readonly port: number,
    readonly channel: string,
  ) {
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid port');
    if (!CHANNEL_PATTERN.test(channel)) throw new Error('Invalid channel');
  }
  async request<T = unknown>(method: string, params?: unknown): Promise<T> {
    const response = await fetch(`http://127.0.0.1:${this.port}/channels/${this.channel}/request`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: randomUUID(), method, params }),
      signal: AbortSignal.timeout(15000),
    });
    const reply = await response.json();
    if (reply.error) throw new ControlReplyError(reply.error, response.status);
    if (!response.ok) throw new Error(`Control HTTP ${response.status}`);
    return reply.result as T;
  }
  observe() {
    return this.request<BattleObservation>('observe');
  }
  async look(focus: Record<string, unknown>, expectedSession: string): Promise<BattleObservation> {
    await this.command('camera', focus, expectedSession);
    let settled = await this.observe();
    const deadline = performance.now() + 5000;
    while (performance.now() < deadline) {
      if (settled.sessionId !== expectedSession) throw new Error('Session changed during camera observation');
      await delay(100);
      const current = await this.observe();
      if (current.sessionId !== expectedSession) throw new Error('Session changed during camera observation');
      // Native object visibility is refreshed after the camera mailbox has completed.
      // Wait for simulation advancement too; repeated reads within one CPU slice are insufficient.
      if (JSON.stringify(current.viewport) !== JSON.stringify(settled.viewport)) settled = current;
      else if (current.frame >= settled.frame + 2) return current;
    }
    throw new Error('Camera view did not settle; stop camera writers and inspect simulation progress');
  }
  async command(action: string, extra: Record<string, unknown>, expectedSession: string) {
    const state = await this.observe();
    if (state.sessionId !== expectedSession) throw new Error('Session changed; stop and re-observe');
    const params = {
      ...extra,
      action,
      sessionId: state.sessionId,
      observedFrame: state.frame,
      commandId: randomUUID(),
    };
    // Never blindly retry an ambiguous HTTP failure: the command may already have executed.
    const requestReceipt = async (method: string) => {
      try {
        return await this.request<{ state: string }>(method, params);
      } catch (error) {
        // A delivered game rejection can be distinguished from transport uncertainty
        // by its receipt in the same session. Never replay the write.
        if (
          method === 'command' &&
          error instanceof ControlReplyError &&
          (error.status === 200 || error.status === 422)
        ) {
          let receipt: { state: string } | undefined;
          try {
            receipt = await this.request<{ state: string }>('commandStatus', params);
          } catch {
            /* Preserve uncertainty. */
          }
          if (receipt?.state === 'unknown') throw new NativeCommandError(params.commandId, 'rejected', error.message);
        }
        throw new Error(
          `Command ${params.commandId} in session ${state.sessionId}: ${String(error)}; inspect commandStatus before retrying`,
        );
      }
    };
    await requestReceipt('command');
    const deadline = performance.now() + 15000;
    while (performance.now() < deadline) {
      const receipt = await requestReceipt('commandStatus');
      if (receipt.state === 'submitted') return { ...receipt, commandId: params.commandId };
      if (receipt.state !== 'pending') throw new NativeCommandError(params.commandId, receipt.state);
      await delay(100);
    }
    throw new Error(`Command ${params.commandId} outcome unknown; inspect commandStatus before retrying`);
  }
}
