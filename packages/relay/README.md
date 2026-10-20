# relay-package

An independent generic WebSocket relay with server, client, Worker bridge, and a [compact protocol specification](RELAY_PROTOCOL.md). One TCP connection carries control and game data in binary frames; datagram headers are fixed at 13 bytes.

## Startup and distribution

The package declares no Node version range; source development uses the pnpm version in package.json. Compatibility with every Node.js version is not guaranteed. From the repository root:

```bash
pnpm install --frozen-lockfile
pnpm --filter relay-package run check
pnpm run build:relay
pnpm run server:relay
```

During development, watch mode restarts after changes to the server entry or its imported source:

```bash
pnpm run server:relay:dev --host 127.0.0.1 --port 15176
# From the relay package directory:
pnpm run dev --host 127.0.0.1 --port 15176
```

CLI options such as `--delay-ms 50` pass through normally. Restarts disconnect existing game sessions, requiring players to reenter multiplayer. `server:relay` and distribution startup commands remain single-run commands.

Root `build:relay` or package-local `build` generates the server, protocol, licenses, and client library in `packages/relay/dist/`. Distribute `gameRelay.cjs`, `RELAY_PROTOCOL.md`, `LICENSE`, and `licenses/`. Recipients need only Node, with no dependency installation:

```bash
node gameRelay.cjs --host 0.0.0.0 --port 15176
```

The Red Alert page's `relay` field accepts `host:port` and defaults to `/ra2`. It selects a single protocol from the host: RFC1918 private, 127/8 loopback, 169.254/16 link-local, 100.64/10 shared VPN addresses, IPv6 ULA/link-local/loopback, and embedded private IPv4 use WS. localhost is also loopback. Other IPs/domains use WSS, without DNS probing or failure fallback. Even complete URLs have their protocol reselected by host, preserving explicit ports and room paths. Generic RelayClient separately tries WSS then WS for bare addresses. All players must use the same address/path. Direct relay access needs TCP 15176 opened.

The standalone server accepts `/room-name` and determines the room from the path, without requiring a separate client room option. Names are case-sensitive, URL-decoded single segments of 1–64 characters, excluding whitespace, control characters, and ? & # /. The path is the room name. Direct root-path upgrades are rejected. Generic clients add a path from the room option when absent, defaulting to /default; the game frontend defaults to /ra2. Same-room members still need matching compatibility hashes. Embedded web services retain their own upgrade routing instead of turning arbitrary web/HMR paths into relay endpoints.

## Simulated game-data delay

```bash
node gameRelay.cjs --port 15176 --delay-ms 50
# In the repository:
pnpm run server:relay --port 15176 --delay-ms 50
```

`--delay-ms` accepts integers 0–60000 and defaults to disabled. It adds the specified delay per game-datagram forwarding operation: A→B adds 50 ms and B→A another 50 ms, about 100 ms combined, not a single player's relay RTT. Handshakes, membership notifications, and heartbeats are unaffected, so page RTT excludes this injection. Actual delay also includes scheduling/network time.

Queues preserve order and are bounded; departure cleans pending work. Extreme backlog may drop data, observable in healthz faults. Use `--faults` for jitter or selected-player rules; `--delay-ms` and faults.delayMs cannot both be specified. This does not simulate TCP loss, retransmission, or congestion, or establish absence of low-RTT regressions.

The server needs no HTTPS certificate for WS; page security contexts, mixed content, and LNA permissions remain subject to browser policy. VPNs may remain enabled if the WS address is reachable; no specific VPN is integrated.

## Docker deployment

From the repository root:

```bash
docker compose -f packages/relay/compose.yaml up -d --build
docker compose -f packages/relay/compose.yaml logs -f relay
```

From this package directory:

```bash
docker build -t relay-package:local .
docker compose up -d --build
```

[Dockerfile](Dockerfile) builds `relay-package:local` from the package's independent lockfile, installing only relay dependencies. [compose.yaml](compose.yaml) maps one TCP port; change the left side of `ports` to select a host port. It restarts the service unless stopped and checks `/healthz`. The runtime image uses a non-root user and includes the server, protocol, and dependency licenses, without games, frontend files, or build tools. Its base is `node:alpine` without a pinned Node version. The image has not been published to a remote registry. Build context is only the relay directory; no prebuilt dist or root dependencies are required.

```bash
docker save -o relay-image.tar relay-package:local
# Recipients load the image and use the copied compose.yaml without building source.
docker load -i relay-image.tar
docker compose -f compose.yaml up -d --no-build --pull never
```

### Public WSS access

For public IPs and domains, the Red Alert frontend selects WSS. Place a TLS reverse proxy with a valid certificate in front of the relay. Forward WebSocket upgrades and retain the full room path, such as `/ra2`. Expose the proxy's TLS TCP port to players; the relay may stay on a private upstream address. A local upstream is `http://127.0.0.1:15176`. Configure the public hostname/certificate in the deployment environment.

The reverse proxy must support long-lived WebSocket connections. Check `/healthz` locally and verify a WebSocket connection through the public proxy before sharing its address. The static frontend does not start a relay. Leaving the page's relay field empty works only when the site already has a same-origin relay configured.

## Application usage

Applications declare `"relay-package": "workspace:*"`. Public entries provide source types and ESM from `dist/lib`; application dev/build/test commands build the package automatically. Browser entries do not load Node's ws dependency.

```ts
import { RelayClient } from 'relay-package/client';
const client = new RelayClient(
  {
    url: '127.0.0.1:15176/example',
    compatibilityHash: 'a'.repeat(64),
    metadata: new Uint8Array(),
  },
  {
    onReady(self) {
      console.log('Connected', self.addr);
    },
    onPeerJoin(peer) {
      console.log('Peer joined', peer);
    },
    onDatagram(src, srcPort, destPort, bytes) {
      console.log(src, bytes);
    },
    onClose(reason) {
      console.log('Connection closed', reason);
    },
  },
);
// After onReady: client.sendDatagram(destAddr, destPort, srcPort, bytes).
// At session end: client.close().
```

The example hash is illustrative; applications supply the actual compatibility SHA-256. RelayClient handles handshakes, membership, heartbeats, RTT, and close cleanup. Sending before ready returns false, with no buffering, replay, or automatic reconnect. Applications own game conversion. WsRelaySocket/codecs remain available for lower-level access. `relay-package/server` exports createGameRelay, `relay-package/wire` provides codecs, and the default entry equals client.

Workers may use WsRelaySocket directly or PortRelaySocket. The page owns connections through serveRelayPort and must call its returned cleanup function on VM exit or abnormal Worker termination. Ordinary sends immediately copy logical bytes without transferring guest memory. After handing an exclusive frame to sendOwned, the caller must stop accessing it; dispatch detaches the buffer.

Frames from the current execution segment hand off in a microtask, dispatching at most 64 messages per batch or upon reaching 256 KiB, without waiting for timers or the next game frame. Each batch gets one byte-count ACK, while each message retains an independent ws.send with actual WS-backlog checks. Batching does not combine separate WS event tasks, guarantee batching of every inbound message, or reduce encoding operations.

Source/tests live in `src/` and `tests/`; builds live in `scripts/`. ws is the only runtime dependency. The independent pnpm-lock.yaml allows copying the whole package elsewhere and building without game-repository files. In the Red Alert workspace, shared dependency changes also require updating the root lockfile.

## Finding the address

The server's actual IP and room virtual addresses are different:

- Same-host testing uses `ws://127.0.0.1:15176/ra2`.
- LAN players need the server computer's LAN IPv4. On macOS, inspect TCP/IP in System Settings network details; on Windows use `ipconfig`; on Linux use `ip -4 addr`. With multiple interfaces, choose one reachable by players. A reachable VPN address works without disabling the VPN.
- The default `--host 0.0.0.0` accepts remote connections. `0.0.0.0` is a listen address, not a destination. For containers, use the reachable host IP and mapped TCP port, usually not the container's internal IP.
- After connection, `self.addr` in `onReady(self)` or `client.selfAddr` is the server-assigned virtual address. Obtain peers from `onPeerJoin(peer)`'s `peer.addr`; `onPeerLeave(id, addr)` reports departure. No discovery of peers' actual IPs is needed: pass `peer.addr` to `sendDatagram`.

Virtual addresses are unsigned big-endian IPv4 integers. Format them as:

```ts
const formatAddress = (addr: number) => [24, 16, 8, 0].map((shift) => (addr >>> shift) & 255).join('.');
```

## Standalone testing

`pnpm --filter relay-package run check` checks types, protocol, server, client, and standalone server distribution. Tests require no RA2, assets, external relay, or public network; real WS tests listen on random local ports. Coverage includes fixed binary vectors, invalid frames, field boundaries, handshake/compatibility isolation, source-address rewriting, broadcasts, rate limiting, slow connections, maintenance draining, departure cancellation of delayed messages, bidirectional client traffic, and lifecycle.

These protocol/service checks do not establish real-game long-match or reconnect acceptance. `packages/relay/tests/relayPort.test.ts` and related tests cover Worker bridges, exclusive frame handoff, port ACKs, ordinary-send copying, and real WS backlog.

Startup logs provide an `IP:port` relay address. Copy it into the resource picker's multiplayer relay field or the page's `relay` query parameter. The service never changes game/browser configuration automatically. An empty field uses the default service. Editing the field updates the URL so refresh preserves it; changing connection settings after startup requires ending the current VM first.

Standalone configuration uses CLI options only, without environment variables:

```bash
node gameRelay.cjs --help
node gameRelay.cjs --host 127.0.0.1 --port 15178 --max-connections 128
node gameRelay.cjs --faults '{"delayMs":100}'
```

Docker `command` accepts the same options. Changing the container's internal port also requires updating port mapping and healthcheck. Usually change only the host mapping while retaining internal 15176.

The homepage defaults to single-player. Enabling multiplayer reveals relay settings; leaving them empty selects the same-origin default service. Links containing `relay` enable multiplayer automatically; explicit `network=0` disables it.

## License

This package is GPL-3.0-or-later; see [LICENSE](LICENSE). Third-party components such as ws retain their own licenses. Distribute the server with LICENSE, the protocol, and licenses/. Corresponding source consists of this package's source and build scripts.
