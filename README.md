# RA2 VM

[English](README.md) | [简体中文](README.zh-CN.md)

![Status: Alpha](https://img.shields.io/badge/status-Alpha-orange)
[![Runtime: v86](https://img.shields.io/badge/runtime-v86-5c4ee5)](docs/ARCHITECTURE.md)
[![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white)](package.json)
[![pnpm](https://img.shields.io/badge/pnpm-F69220?logo=pnpm&logoColor=white)](package.json)
[![License: GPL-3.0-or-later](https://img.shields.io/badge/license-GPL--3.0--or--later-blue)](LICENSE)

Run the original x86 executables of **Red Alert 2** and **Yuri's Revenge** directly in your browser.
RA2 VM uses v86, custom firmware, and a Win32/DirectX compatibility layer without starting Windows.

_⚠️EA has not endorsed and does not support this product._

**Play online: [ra2.games](https://ra2.games)**

Currently in Alpha: local resource imports, RA2/YR selection, skirmish entry, saves, map packages,
and multiplayer through a WebSocket relay. Short two-player regressions do not establish
compatibility with every campaign, MOD, large multiplayer battle, or long internet match.

## Start playing

1. Open the online site and prepare game resources you legally own.
2. Choose **Select files…** to import an archive, or **Select folder…** to select a game directory.
   Include the original game executable in the bundle. The page checks required resources and lists missing files.
3. One complete version starts automatically. If both RA2 and YR are present, choose which to run.
4. In the original game, open **Single Player → Skirmish**, choose a map, factions, and computer opponents, then start.

The web interface automatically selects English or Simplified Chinese from your browser's preferred
languages when the page opens. Other languages fall back to English. Game text uses the language
of the imported resources.

To investigate slow gameplay, use **Performance diagnostics…** in the game toolbar, record for 20 seconds,
then copy the report. See [browser comparison reports](docs/GAME_PERFORMANCE.md#browser-comparison-reports).

## Play with friends

### 1. Deploy a relay

A relay forwards multiplayer traffic between browsers. One participant or server administrator
deploys it; all players then use the same reachable address and room path.

With this repository checked out on a server with Docker and Docker Compose, run from the repository root:

```bash
docker compose -f packages/relay/compose.yaml up -d --build
docker compose -f packages/relay/compose.yaml logs -f relay
```

The service listens on TCP **15176**, restarts automatically, and exposes `/healthz` for health checks.
Allow the required TCP port through the server's firewall. For a LAN, players connect to the server's
reachable private IP and mapped port. `0.0.0.0` is a listening address, not an address to give players.

For internet access through a public IP or domain, put the relay behind a TLS reverse proxy with a
valid certificate and WebSocket upgrade support. Forward the room path, such as `/ra2`, to the relay.
The game frontend uses **WSS** for public addresses and **WS** for private/loopback addresses.
Browser private-network permissions still apply. See [relay deployment](packages/relay/README.md)
for address selection, standalone distribution, and configuration.

For local development without Docker:

```bash
pnpm install --frozen-lockfile
pnpm run server:relay --host 0.0.0.0 --port 15176
```

To build a standalone server:

```bash
pnpm run build:relay
node packages/relay/dist/gameRelay.cjs --host 0.0.0.0 --port 15176
```

The static frontend build does not include a relay server. If your site already provides a same-origin
relay, players can use that service by leaving the relay address empty.

### 2. Connect and start a match

1. Everyone opens the online page and enables **Multiplayer before importing resources or starting the game**.
2. Enter the deployed relay's reachable host and port. The default room is `/ra2`; an optional path,
   such as `127.0.0.1:15176/friends` for same-machine testing, selects a different room.
   All players must use the same address and path. Leave the field empty only to use the site's default relay.
3. Import resources and start the same game version. Use matching MODs and maps; RA2 and YR cannot join each other's matches.
4. Open **Network** in the original game. Confirm that the page reports a connected relay and that other players appear in the native lobby.
5. The host creates a game and chooses the map and settings. Others join that room, wait for map verification,
   and confirm readiness. The host then starts the match.

If a friend or room is missing, check the multiplayer toggle, relay address, room path, and game version.
Settings are saved in the page URL, so you can share the configured URL. Stop the game before changing connection settings.
The member count represents other connections in the virtual LAN; relay RTT measures the round trip to the server, not opponent latency.
Interrupted matches cannot be resumed after a disconnect; start a new match. See [multiplayer limitations](docs/RA2_NETWORK_RELIABILITY.md).

## Development

Internal work uses `dev`, which is not pushed to GitHub. External contributions target `main`.
Use Node.js and the pnpm version specified in `package.json`; this project does not pin a Node version range.

```bash
pnpm install --frozen-lockfile
pnpm run dev
```

Open the HTTPS address printed in the terminal and select a local game directory or archive.
Supply the original `game.exe` (RA2) or `gamemd.exe` (YR) inside the game bundle. Import and cache restoration preserve that executable; the app does not download a replacement.
Game programs and assets are not included in this repository, and public tests do not require them.

```bash
pnpm run check          # Types, asset-free unit/synthetic VM tests, production build
pnpm run build          # Static frontend in dist/
pnpm run preview        # Preview the build
pnpm run server:relay:dev  # Watch mode; restarts disconnect existing clients
```

Locally owned resources can be placed in the ignored `game/ra2/` directory.
See the [testing guide](docs/TESTING.md). Your environment supplies Node and the initial pnpm installation;
CI reports the actual toolchain versions.

## Documentation and contributions

- [Architecture](docs/ARCHITECTURE.md): module boundaries, data flow, and ownership.
- [Contributing](CONTRIBUTING.md): development, validation, and PR requirements.
- [Testing](docs/TESTING.md): asset-free checks and real-game regressions.
- [Real-game CI](docs/REAL_GAME_CI.md): download secrets, hashes, and trusted runners.
- [Game performance](docs/GAME_PERFORMANCE.md): native logic FPS and multiplayer measurement.
- [Documentation index](docs/README.md): resources, UI, Workers, startup, and upscaling.
- [Relay protocol](packages/relay/RELAY_PROTOCOL.md): the standalone relay wire format.

## License

Original project code is **GPL-3.0-or-later**; see [LICENSE](LICENSE).
You may use, modify, and distribute it under GPL version 3 or any later version. The software comes without warranty.
Third-party code, dependencies, and game assets retain their own licenses and ownership.
See [third-party notices](docs/THIRD_PARTY.md).
