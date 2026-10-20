# Generic WS binary protocol

One WS/WSS connection carries both control and game data. Standalone service paths may be `/room-name`. No WebSocket subprotocol or extra negotiation is required. Each WS binary message contains exactly one frame; client/server must use the same protocol version.

## Encoding

All integers are unsigned and big-endian. The common header is a single message-type byte `TT`. WebSocket preserves message boundaries: even if transport frames split, the receive API delivers complete messages. Do not parse by TCP read boundaries.

`str` is `uint16 UTF-8 byte length + UTF-8 bytes` with strict UTF-8 validation; `hash` is a 32-byte SHA-256. `metadata` / `data` occupy remaining message bytes without an extra length. Other messages prohibit trailing bytes.

| TT  | Message    | Fields after the common header, in order      |
| --- | ---------- | --------------------------------------------- |
| 01  | hello      | room:str, hash:32 bytes, nonce:str, metadata  |
| 02  | welcome    | peer:str, addr:u32, epoch:u32                 |
| 03  | peer-join  | peer:str, addr:u32, hash:32 bytes, metadata   |
| 04  | peer-leave | peer:str, addr:u32                            |
| 05  | datagram   | src:u32, dest:u32, sport:u16, dport:u16, data |
| 06  | ping       | n:u32, at:u64                                 |
| 07  | pong       | n:u32, at:u64                                 |
| 08  | room-close | epoch:u32, reason:str                         |

Game datagrams have a fixed **13-byte header**, without JSON:

```text
Offset 0       1       5       9       11      13
       05      src     dest    sport   dport   Raw data…
Bytes  1       4       4       2       2
```

Example: src=1, dest=2, sport=3, dport=4, payload AA:
`05 00 00 00 01 00 00 00 02 00 03 00 04 AA`.

WebSocket framing overhead is additional. The JavaScript API retains exe (a 64-character lowercase hexadecimal hash) and n/a field names; codecs convert them without transmitting names. at permits only integers from 0 to 2^53−1 to avoid JavaScript precision loss.

## Rooms and limits

The decoded URL path determines the room and overrides hello.room; clients still send a valid hello.room field. All paths use the same room-name rules. Names must be nonempty single segments without control characters or dot segments. Root-path / upgrades are rejected. Application clients add /ra2 to pathless addresses; generic clients use their room option or /default. Explicit paths always take priority. Paths are not authentication secrets; room authentication is not provided.

Send hello within 5 seconds of connecting. The server sends welcome, then peer-join for existing members, and notifies other members of the newcomer. Room members must share a compatibility hash. The server neither reads game files nor interprets metadata.

room is nonempty, at most 64 UTF-16 code units, and excludes whitespace and ? & # /. nonce is nonempty and at most 32. URL `clientId` and protocol `peer` follow the same rules: nonempty, at most 128 ASCII characters, allowing only `A-Z`, `a-z`, `0-9`, `.`, `_`, and `-`. `reason` is nonempty and at most 128 UTF-16 code units. metadata is at most 64 bytes. Complete frames are capped at 128 KiB; data is 1–65507 bytes. Rooms allow at most 20 members; default send-backlog limit is 4 MiB.

addr/src/dest are network-order IPv4 numbers, not actual endpoints. The server overwrites src with the connection's virtual address and unicasts within the room by dest. 255.255.255.255 and 10.247.255.255 broadcast to other members. Closing connections produces peer-leave. WS is reliable/ordered, without automatic reconnect, match resumption, or unordered transport. WS ping/pong checks liveness every 15 seconds; application ping/pong measures RTT. The service limits both packet and byte rates.

## Deployment

See [README.md](README.md) for startup, Docker, and client examples. Only one TCP port is required. CLI options are `--host` (default 0.0.0.0), `--port` (15176), `--max-connections` (2048), `--delay-ms` (0–60000 ms per game-datagram forwarding operation, disabled by default), `--faults` (optional JSON), and `--help`. Standalone service reads CLI options only, not environment variables.

The Red Alert page's `parseRa2RelayUrl` chooses one WS/WSS protocol by host, whether the input omits a scheme or provides a complete URL, with no failure fallback. Generic `RelayClient` may try WSS then WS for bare addresses; explicit protocols do not fall back, and established sessions never reconnect automatically. Each protocol connection/handshake defaults to a 10-second timeout.

`--delay-ms` leaves heartbeats unchanged, so page RTT excludes injection; bidirectional datagrams add about twice the configured value. It reuses ordered bounded fault queues, does not simulate TCP retransmission, and cannot coexist with faults.delayMs. GET /healthz returns JSON health information outside the WS wire protocol. SIGUSR2 drains; SIGTERM/SIGINT stop the service.

The server includes no authentication, static pages, game resources, or arbitrary-destination proxy. Plain WS needs no certificate. HTTPS-to-private-WS access remains subject to browser mixed-content/local-network policies; deployers can terminate WSS TLS at a reverse proxy.
