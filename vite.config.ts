import { defineConfig, type Plugin } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import type { PreviewServer, ViteDevServer } from 'vite';
import { createGameRelay } from 'relay-package/server';
import { parseRelayFaultConfig } from 'relay-package/faults';

type ViteHttpServer = NonNullable<ViteDevServer['httpServer']> | NonNullable<PreviewServer['httpServer']>;

const projectRoot = fileURLToPath(new URL('.', import.meta.url));
const appVersion = (JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string })
  .version;
function appRevision(): string {
  try {
    return execFileSync('git', ['rev-parse', '--short=12', 'HEAD'], {
      cwd: projectRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return 'unknown';
  }
}

function ra2NetworkRelayPlugin(): Plugin {
  return {
    name: 'ra2:network-relay',
    configureServer(server) {
      attachRa2NetworkRelay(server);
    },
    configurePreviewServer(server) {
      attachRa2NetworkRelay(server);
    },
  };
}

/** attachDplayRelay needs only these two members; dev/preview servers are structural subsets. */
interface RelayHostServer {
  httpServer: ViteHttpServer | null;
  close(): Promise<void>;
}

/** Mount the RA2 virtual-LAN relay at /ra2. */
function attachRa2NetworkRelay(server: RelayHostServer): void {
  const httpServer = server.httpServer;
  if (!httpServer) return;
  const relay = createGameRelay({ faults: parseRelayFaultConfig(process.env.RA2_NET_FAULTS) });
  const onUpgrade = (request: IncomingMessage, socket: Duplex, head: Buffer): void => {
    let pathname: string;
    try {
      pathname = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`).pathname;
    } catch {
      return;
    }
    if (pathname !== '/ra2') return;
    relay.handleUpgrade(request, socket, head);
  };
  httpServer.on('upgrade', onUpgrade);
  httpServer.once('close', () => httpServer.off('upgrade', onUpgrade));
  const originalClose = server.close.bind(server);
  server.close = async () => {
    relay.close();
    await relay.drained();
    return originalClose();
  };
}

export default defineConfig({
  define: {
    'import.meta.env.VITE_APP_VERSION': JSON.stringify(appVersion),
    'import.meta.env.VITE_APP_REVISION': JSON.stringify(appRevision()),
  },
  plugins: [basicSsl(), ra2NetworkRelayPlugin()],
  // Linked dependencies must share the application's React dispatcher, including across worktrees.
  resolve: { dedupe: ['react', 'react-dom'] },
  // VM pages with hmr=false cannot rely on reloads to handle a second prebundle. Register JSX and Worker dynamic dependencies
  // up front to avoid a second React instance in lazy pages. This only builds development caches; browser experiments are not preloaded.
  optimizeDeps: {
    include: [
      'react',
      'react-dom',
      'react-dom/client',
      'react/jsx-runtime',
      'react/jsx-dev-runtime',
      'fflate',
      'v86',
      '7z-wasm',
      'onnxruntime-web/webgpu',
    ],
  },
  server: {
    host: true, // Listen on 0.0.0.0 so other LAN devices can connect (the terminal prints the Network address)
    port: 15174,
    strictPort: true,
    // VMs and long regressions are stateful; code changes must not reload pages or destroy VMs under test.
    hmr: false,
    // Disable caching in development to prevent stale modules during hot updates/hard reloads (previously mixed old and new map.ts code).
    headers: { 'Cache-Control': 'no-store' },
    fs: {
      allow: ['.'],
      // Keep private installations out of Vite's ordinary static and /@fs routes too.
      deny: ['.env', '.env.*', '*.{crt,pem}', '**/.git/**', `${resolve('game').replaceAll('\\', '/')}/**`],
    },
  },
  preview: { port: 4174, strictPort: true },
  build: { target: 'es2022' },
  worker: {
    // vmClient.ts starts a module Worker with new Worker(new URL('./vmWorker.ts', import.meta.url), { type: 'module' }).
    // Vite requires ES output for code-split Workers; the default iife format fails.
    format: 'es',
  },
});
