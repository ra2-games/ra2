export interface ApplicationControlState {
  pageId: string;
  phase: string;
  hasResources: boolean;
  hasRuntime: boolean;
}

/** Page-owned routing survives VM replacement; each restart is explicitly bound to the observed page generation. */
export function createApplicationControl(deps: {
  state(): ApplicationControlState;
  runtime(method: string, params?: unknown): Promise<unknown>;
  quickStart(isCurrent: () => boolean): Promise<void>;
  capture?(): Promise<unknown>;
}) {
  let starting = false;
  let failure: string | null = null;
  let disposed = false;
  const receipts = new Map<string, { fingerprint: string; result: { state: string; commandId: string } }>();
  return {
    async request(method: string, params?: unknown): Promise<unknown> {
      if (disposed) throw new Error('Application control disposed');
      const state = deps.state();
      if (method === 'ui.status') {
        const runtime = state.hasRuntime ? await deps.runtime('ui.status') : null;
        return {
          ...state,
          starting,
          failure,
          runtime,
          actions: [
            ...(state.hasResources && !starting ? ['ui.quickStart'] : []),
            ...(state.hasRuntime && deps.capture && !starting ? ['ui.screenshot'] : []),
          ],
        };
      }
      if (method === 'ui.screenshot') {
        const pageId = state.pageId;
        const p = params && typeof params === 'object' ? (params as Record<string, unknown>) : {};
        if (p.expectedPageId !== state.pageId) throw new Error('Stale page; call ui.status first');
        if (!state.hasRuntime || starting || !deps.capture) throw new Error('Screenshot unavailable');
        const image = await deps.capture();
        const after = deps.state();
        if (disposed || starting || !after.hasRuntime || after.pageId !== pageId)
          throw new Error('Session changed during screenshot');
        return { pageId, image };
      }
      if (method !== 'ui.quickStart') return deps.runtime(method, params);
      const p = params && typeof params === 'object' ? (params as Record<string, unknown>) : {};
      if (typeof p.commandId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(p.commandId))
        throw new Error('Invalid commandId');
      const fingerprint = JSON.stringify(params);
      const previous = receipts.get(p.commandId);
      if (previous) {
        if (previous.fingerprint !== fingerprint) throw new Error('commandId reused with different parameters');
        return previous.result;
      }
      if (p.expectedPageId !== state.pageId) throw new Error('Stale page; call ui.status first');
      if (!state.hasResources) throw new Error('Import game resources in the web page first');
      if (starting) throw new Error('Quick start already in progress');
      if (state.hasRuntime && p.replaceSession !== true)
        throw new Error('Set replaceSession=true to discard the current runtime and unsaved match');
      if (receipts.size >= 100) throw new Error('Page restart command limit reached');
      const result = { state: 'submitted', commandId: p.commandId };
      receipts.set(p.commandId, { fingerprint, result });
      starting = true;
      failure = null;
      // Return acceptance without waiting for native loading. The status endpoint reports startup failures.
      void Promise.resolve()
        .then(() => {
          if (disposed) return;
          return deps.quickStart(() => !disposed);
        })
        .catch((error: unknown) => {
          if (!disposed) failure = error instanceof Error ? error.message : String(error);
        })
        .finally(() => {
          if (!disposed) starting = false;
        });
      return result;
    },
    dispose() {
      disposed = true;
      receipts.clear();
    },
  };
}
