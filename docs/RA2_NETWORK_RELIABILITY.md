# WebSocket multiplayer and poor-network testing

The current implementation retains native RA2/YR IPX datagram synchronization and transports it through a WebSocket relay. Existing server-side fault injection does not establish brief-disconnect recovery or acceptance of long matches on poor networks.

The acceptance target for one impaired player is that brief faults may cause synchronization waits, but both clients must execute new commands after recovery. A slow connection must not block relay routing for other connections. This does not mean other players' simulation can advance without waiting for a slow player, or guarantee match resumption after indefinite disconnection.

## Startup

The development server includes `/ra2` with no fault injection by default. Restart it with faults when needed:

```bash
RA2_NET_FAULTS='{"seed":42,"room":"ra2","delayMs":50,"jitterMs":20}' pnpm run dev
```

Players still enter through the default page without client URL parameters. This adds about 50 ms delay and ±20 ms jitter to each relay forwarding operation in the selected room. A round trip includes two forwarding operations, so this is not a fixed 50 ms RTT. Per-recipient order is preserved, and actual queueing delay can exceed configured values.

Standalone service, without static pages:

```bash
pnpm run server:relay --port 15176
```

The default listen address is 0.0.0.0. Players can deploy their own relay using `pnpm run server:relay` and select it with `?relay=127.0.0.1:15176`. The default path is /ra2; remote players must use a reachable address. The Red Alert adapter selects WS for private IP addresses and WSS for public IP addresses/domains, without failure fallback. Custom URL paths identify rooms. `--delay-ms 50` adds 50 ms to each game-datagram forwarding operation without delaying heartbeats. The page's RTT does not reflect this injection, and it is not a full TCP impairment simulation.

The standalone service uses the WebSocket frame protocol and CLI configuration. `pnpm run build:relay` produces independently distributable server files; the package Dockerfile can build an image. Running the build requires only Node, without installing the whole project. See [Relay deployment](../packages/relay/README.md) and [Protocol](../packages/relay/RELAY_PROTOCOL.md).

Relay control and game data share one WS/TCP connection. Plaintext WS works without certificates, but HTTPS pages accessing LAN WS are still subject to browser mixed-content and local-network permission policies. Connection behavior after LNA denial remains unverified. Same-origin deployments can obtain TLS through a reverse proxy. Static dist does not include a relay, but can connect to player-hosted services.

The standalone `/healthz` endpoint returns routing/drop and fault-queue statistics; management-network access is recommended. It has no user authentication and should not be treated as a complete public production match platform.

### Maintenance and connection protection

`--max-connections` defaults to 2048, including connections that have not sent hello. Exceeding the limit rejects only new connections, leaving existing ones connected. Each virtual LAN supports at most 20 members; native matches still support at most 8 players. Public lobbies and virtual LANs are not yet separated. Relay regressions cover 20-connection broadcast interoperability and rejection of the 21st, but do not establish acceptance with 20 real game clients in a lobby. These limits protect memory resources; they are neither authentication nor evidence of load-tested 2048-player capacity.

For Linux maintenance, send SIGUSR2 to the **Node service process** to stop accepting new connections and players that have not completed hello while continuing to forward existing rooms. Observe `draining`, `connections`, `rooms`, and `players` in `/healthz`, then send SIGTERM after connections=0. SIGTERM still stops the service without automatically waiting for matches to end. Process-manager restarts do not replace draining. No public HTTP administration endpoint, authentication, or management plane is provided.

### Player-visible status

RA2/YR Worker and main-thread fallback share `onNetworkStatus`. The page shows connecting/connected state, other LAN member count, relay RTT, and disconnect reasons. RTT measures application-layer browser-to-relay round trips, including scheduling, not opponent latency. Member count is not current-match player count, and status indicators do not establish game synchronization.

Each WS connection/welcome handshake defaults to a 10-second timeout; late probes on established connections do not evict players. Normal departure shows closed status; abnormal disconnection explains that match resumption is unsupported. Page lifecycle filtering rejects late status from old VMs. Exit clears UI and network timers; room-close shuts down transport, and pre-handshake datagrams must not reach the guest.

### Public-match limitations

- Authentication and signed admission credentials are not provided. Neither clientId nor random names are identity credentials.
- Lobby/match separation and effective rules/MOD/map content fingerprints are unimplemented; currently only executables are compared.
- True reconnection requires stable identity, delivery sequence numbers, and a recovery window. There is no automatic reconnect or historical-command replay.
- Real 8-player long matches, actual TCP impairment, desynchronization CRC, anti-cheat, and trusted results have not passed acceptance.

## Fault configuration

`RA2_NET_FAULTS` is server-side JSON for dev/preview; standalone service uses `--faults`. Invalid configuration rejects startup, and logs clearly indicate whether injection is enabled. Clients cannot set rules.

Server code may use `relay.setFaults(config)` to change rules after battlefield startup, or pass undefined to disable them. Changes are allowed only after pending queues drain, preventing old packets from being released early, dropped, or reordered with new packets. Each change resets that round's fault statistics/blackhole timer, without resetting cumulative routing statistics. No HTTP management interface is exposed.

| Field                         | Meaning/default                                                                                   |
| ----------------------------- | ------------------------------------------------------------------------------------------------- |
| `seed`                        | uint32 random seed, default 1; identical ordered input produces identical random decisions        |
| `room`                        | Affect only this room; omission means all rooms                                                   |
| `fromClientId` / `toClientId` | Exact sender/recipient ID match, permitting directional faults; not a game display name           |
| `delayMs` / `jitterMs`        | Delay and uniform ±jitter per outbound forwarding operation, default 0                            |
| `lossRate`                    | Application-datagram drop probability, 0–1, default 0; broadcasts decide separately per recipient |
| `blackholeMs`                 | Duration from fault-module creation during which matching datagrams are dropped, default 0        |
| `bytesPerSecond`              | Per-recipient bandwidth cap for selected traffic, including wire headers; unlimited by default    |
| `maxQueuedPackets`            | Global pending-packet limit for the fault module, default 1024                                    |
| `maxQueuedBytes`              | Global pending-byte limit for the fault module, default 4 MiB                                     |

Example of directional loss; find the actual ID in the browser WebSocket URL's clientId field:

```bash
RA2_NET_FAULTS='{"seed":42,"fromClientId":"ACTUAL_CLIENT_ID","lossRate":0.03}' pnpm run dev
```

Handshakes, membership notifications, and heartbeats are unaffected. Matching datagrams pass existing relay rate limits before entering fault injection. Full queues or estimated waits over 300 seconds cause counted drops. Connection departure or service shutdown cancels pending messages; reused addresses must not deliver old packets to new players. `datagramsRouted` increments only when outbound sending actually succeeds, not on entry to a delay queue, and does not mean the guest consumed the packet.

A fixed seed guarantees identical random decisions only for identical input order. Concurrent arrival ordering, actual timing, and game execution still vary; entire real matches are not deterministically reproduced.

## Tests and boundaries

```bash
pnpm exec vitest run packages/relay/tests/relayFaults.test.ts packages/relay/tests/gameRelay.test.ts tests/basic/ra2NetworkTransport.test.ts packages/relay/tests/relayWire.test.ts tests/basic/ra2PeerDiscovery.test.ts tests/basic/ra2Winsock.test.ts
```

Coverage includes configuration validation, fixed seeds, directional isolation, ordered delay, bandwidth, blackhole recovery, packet/byte limits, departure cleanup, and real WS handshakes/directional drops. These asset-free tests are included in `pnpm run check`.

The module simulates **datagram-forwarding faults**. Dropping datagrams already at the relay differs from underlying TCP loss, which causes retransmission and head-of-line blocking. Real TCP impairment still requires netem or similar injection in isolated network namespaces/dedicated proxies. Game results under `lossRate` cannot establish conclusions about TCP packet loss. Unaffected heartbeats also mean this module does not verify actual half-open connection detection.

Minimum public-match validation includes normal real RA2/YR two-client startup, delay/jitter/loss/rate limiting, actual TCP impairment, background tabs, and long matches, recording whether both clients continue executing new commands. Transport disconnection still ends the connection, with no ACK/recovery window. Fault-test exits or stalls must be recorded, never hidden behind unlimited buffering or false “reconnected” reports.

## Real-game single-player fault regression

```bash
RA2_BROWSER_ORIGIN=https://127.0.0.1:15175 RA2_BROWSER_FAULT_SCENARIO=jitter pnpm run test:browser:network
```

Scenarios: `jitter` (100 ms ±80 ms), `stall500` (500 ms per forwarding operation), `loss` (3% application-datagram drops), and `blackhole2000` / `blackhole5000` (complete drops for 2/5 seconds). Tests enter real RA2 from the default page, redirecting only the connection destination to a dedicated test WebSocket relay. Read-only Worker probes observe both Houses without replacing executables or writing game memory. Requirements are the development server, its generated `node_modules/.vite/basic-ssl/_cert.pem`, local resources, and Chromium.

After both clients reach the battlefield, faults affect only the second browser player's downstream traffic. Both players then deploy their MCVs in sequence through native input. Tests verify matching state on both clients, no defeat, and open connections, then observe another 10 seconds. Outputs include both screenshots and `weak-network.json`. This is two-player short-match acceptance for a subset of shared state, not full simulation CRC or 8-player long-match validation. `RA2_BROWSER_GAME=yr` supports YR's two-command regression, using native box selection followed by deployment instead of RA2's fixed MCV click location.

`RA2_BROWSER_PLAYERS=8` selects an 8-player map automatically, verifies 8 native player slots, sends a deploy command for each player, and checks consistent state in every VM. Linux same-host multi-VM preflight conservatively estimates `1200 MiB × player count + 1024 MiB`. Insufficient available memory fails explicitly rather than masquerading as skip/pass. This estimate is not an actual peak bound; real 8-player acceptance still requires more memory or distributed hosts. `RA2_BROWSER_MAP_PLAYERS=8` only makes a two-player test use an 8-player map and cannot be called an 8-player match.

## RA2/YR LAN initial send intervals

The generic WS binary protocol, Worker port bridge, and Winsock adaptation serve both RA2 and YR. Executable compatibility hashes still isolate the games; mixed RA2/YR matches are unsupported. Fixed-address timing is independently validated for each version.

### Unresolved long-observation failures

Historical long observations encountered simulation stalls and renderer crashes alongside shared-host memory pressure. Existing records cannot attribute every symptom to OOM. These failures remain unresolved in isolated environments; passing short matches, resource preflight, or standalone relay tests cannot replace that investigation.

Revalidation must fix executable hashes and resource-manifest baselines, then run separate RA2/YR long-observation regressions with isolated resources and independent browsers/renderers. Record continued simulation-frame advancement, renderer crashes, process/host memory, and OOM events, retaining both failures and passes. Short-match entry points are `pnpm run test:browser:network` and `pnpm run test:browser:network:yr`; neither alone proves long-observation failures resolved.

### Startup negotiation periods

Native initialization sets RequestedFPS to 30. Average CPU-duration reports use guest event `0x21`; Timing negotiation uses `0x20`. RequestedFPS changes only after receiving Timing. Native code still checks the host, receive progress, and each player's reports, computing from actual average duration, room speed, and dynamic windows. Fixed frame counts cannot be converted into a complete convergence time.

Alongside four initial-send-interval sites, each game module validates two negotiation-period signatures:

- RA2: change `test cl,0x7f` at `0x623bcf` to `test cl,0x1f`, reducing CPU-report opportunities from every 128 simulation frames to 32. Change `test al,al` at `0x6240b7` to `test al,0x3f`, reducing Timing opportunities from every 256 frames to 64.
- YR: corresponding sites are `0x6476bf` and `0x647ba7`, using the same 128→32 and 256→64 changes.

These sites and initial-send signatures are protected by complete instruction signatures at every target. Any failed check prevents all writes. See [RA2 networkTiming.ts](../src/games/ra2/networkTiming.ts), [YR networkTiming.ts](../src/games/yr/networkTiming.ts), `tests/basic/ra2NetworkTiming.test.ts`, and `tests/basic/yrNetworkTiming.test.ts`.

### Version binding and verifiable evidence

`src/games/ra2/networkTiming.ts` targets the independently checked RA2 1.006 instruction layout.
After checking all four complete instruction signatures, it changes each mov immediate from 5 to 3:

```text
0x597ba6: B9 05 00 00 00 3B C6 89 0D 64 D5 A3 00
0x59c4ef: B8 05 00 00 00 89 15 18 0B A4 00 8B 15 AC D2 A3 00 3B D6 A3 64 D5 A3 00
0x5bde16: B8 05 00 00 00 3B CE A3 64 D5 A3 00
0x5bdfd0: B8 05 00 00 00 3B CF A3 64 D5 A3 00
```

`src/games/yr/networkTiming.ts` uses the independently checked YR 1.001 instruction layout.
After checking these signatures, it changes each immediate from 5 to 2:

```text
0x5b6546: B9 05 00 00 00 3B C6 89 0D 54 B5 A8 00
0x5baec5: B8 05 00 00 00 89 15 60 EB A8 00 8B 15 4C B2 A8 00 3B D6 A3 54 B5 A8 00
0x5dd2d8: B8 05 00 00 00 3B CE A3 54 B5 A8 00
0x5dd498: B8 05 00 00 00 3B CF A3 54 B5 A8 00
```

RA2/YR use separate modules and must never write each other's addresses. Installation occurs only when the multiplayer shim is enabled. A signature mismatch fails before any write, and repeated installation leaves no partial patch. Regressions are `tests/basic/ra2NetworkTiming.test.ts` and `tests/basic/yrNetworkTiming.test.ts`.

Both implementations use native Timing events, acknowledgments, retries, and dynamic MaxAhead windows without a custom event protocol. Interval/period changes do not alter the game clock, acknowledgment mechanisms, or window calculation. Shorter periods increase reporting/negotiation frequency; performance evaluation must observe simulation FPS, windows, command latency, and queue pressure together.

The 30 ms comparison uses `RA2_BROWSER_RELAY_DELAY_MS=15` to add 15 ms in each direction to the raw TCP byte stream between each browser and the selected relay, including WS handshakes, heartbeats, and data. This injects fixed additional RTT; final page RTT also includes local transmission and scheduling. It does not simulate TCP loss/retransmission. The proxy exists only in the test process and releases connections/timers at completion.

## Shared Worker send path

The built-in encoder creates an exclusive binary frame each time. For port connections supporting `sendOwned`, `RelayClient` hands it off directly, avoiding one full post-encoding copy. Guest reads, encoded-payload copying, and logical-byte copying for ordinary `send` remain. Custom codecs do not imply ownership and continue ordinary sending. This applies to RA2/YR without changing wire format or either game's synchronization algorithm.

Worker port ACKs reclaim port-queue capacity only. Before sending, the page separately checks actual WebSocket backlog plus the current frame against the limit. This prevents continuous port ACKs from creating an unbounded lower-level backlog on slow networks. Limit violations retain existing close/restart-match semantics, without automatic reconnect or old-command replay.

## LAN startup target

RA2/YR install separate guest stubs at four native LAN startup paths to initialize RequestedFPS from the current room speed. The fastest setting starts at 60 Hz, the next at 45 Hz, and other valid settings follow native integer conversion. Every original signature must pass before dynamic code allocation and CALL installation. Unknown executables remain unchanged.

Stubs preserve registers, flags, and stack and replay the original FrameSendRate setup. Another match in the same VM rereads the speed setting. FPS is not locked, and slow-client reports, CRC, acknowledgments, and Timing window transitions still run. This is an initial target, not a guarantee of sufficient host/network throughput. See [Game performance](GAME_PERFORMANCE.md) for measurement.

| Item              | RA2 1.006                                      | YR 1.001                                       |
| ----------------- | ---------------------------------------------- | ---------------------------------------------- |
| Session.GameSpeed | `0xA3D2C8`                                     | `0xA8B268`                                     |
| RequestedFPS      | `0xA3D568`                                     | `0xA8B558`                                     |
| Startup sites     | `0x597BA6`, `0x59C4EF`, `0x5BDE16`, `0x5BDFD0` | `0x5B6546`, `0x5BAEC5`, `0x5DD2D8`, `0x5DD498` |

Native speed-cap conversion is at RA2 `0x624153..0x624184` and YR `0x647C43..0x647C74`. Clients copy Session.GameSpeed to runtime GameSpeed only after the startup site, so stubs must read session settings instead of stale runtime values. The existing dynamic-code allocator provides exclusive stub storage, destroyed with the VM. `tests/basic/vm/lanStartupTiming.e2e.test.ts` verifies every setting, repeated calls, and register/flag/stack preservation. Two-VM initial targets, native slowdown, and actual FPS require separate acceptance; field values are not measured performance.

Generic bare-address protocol probing handles Node's native WebSocket emitting only `error` on TLS failure. Before opening, error or close can try the next candidate; old connections are unbound to isolate late events. Explicit WSS and already-open sessions never fall back. See real-socket and lifecycle regressions in `packages/relay/tests/relayClient.test.ts`. The Red Alert adapter's explicit host-based protocol selection above does not enable this generic probing fallback.
