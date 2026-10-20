# Local AI control

The browser runs the original game. A loopback server routes JSON requests from a CLI to one browser channel, then the session forwards them through the same VM interface in Worker and main-thread modes. No browser debugger or second local game process is required.

The contract exposes player-level observations and actions so an agent can play through the normal game rules. Observations must not disclose hidden world state, and actions must retain native prerequisites, production queues, pathfinding, placement and combat resolution. A successful transport or queue receipt is not proof of a successful game action.

## Distribute the control skill

The complete CLI, `serve` router, client helpers and agent launcher live in
[ra2-battle-control](../.agents/skills/ra2-battle-control/SKILL.md). Copy that entire
folder, including `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `scripts/`
and `LICENSE`, without `node_modules/`. No game repository or executable is needed
to install or start the CLI/server. The browser game and its resources run separately.

```bash
pnpm --dir "$RA2_CONTROL_SKILL" install --frozen-lockfile
pnpm --dir "$RA2_CONTROL_SKILL" ra2ctl serve --origin "$RA2_BROWSER_ORIGIN"
pnpm --dir "$RA2_CONTROL_SKILL" ra2ctl --channel alpha observe
```

Set the two variables to the installed skill folder and exact game-page origin.
The repository's `pnpm ra2ctl` and `pnpm ra2agent` aliases invoke the same skill-owned
scripts. `ra2agent` uses its own skill as the working directory and optionally reads
an adjacent `ra2-strategy/SKILL.md`; that strategy skill is not required for the CLI
or server. Copy the strategy skill alongside it when its guidance is desired.

The skill is the `@ra2vm/control` workspace package. Browser code imports only its
Node-free `protocol` entry, while game policies consume its serializable `contracts`.
Both sides share one protocol source; the skill has no imports from project `src/`.
Root installs use the root lockfile; standalone distribution uses the skill's lockfile.
Keep both consistent when its dependencies change.

## Connect

Install the workspace dependencies with `pnpm install --frozen-lockfile`. Start the development page and control server in separate terminals:

```bash
pnpm run dev
pnpm ra2ctl serve
```

The control server listens on `127.0.0.1:15180`. Its default browser origins are `https://localhost:15174` and `https://127.0.0.1:15174`. If Vite prints another origin, pass its exact value with `pnpm ra2ctl serve --origin "$RA2_BROWSER_ORIGIN"`. Repeated `--origin` options allow multiple known page origins. The server never binds a public interface. An HTTPS deployment connecting to loopback additionally depends on the browser's local-network permissions; the development browser regression explicitly grants local network access.

On the resource picker or game page, open **Connect AI**, enter a channel such as `alpha`, and connect. Channel names contain 1–64 ASCII letters, digits, underscores, or hyphens. Each channel has one browser owner; duplicate registration fails. Disconnect the first page before reusing its channel.

```bash
pnpm ra2ctl channels
pnpm ra2ctl --channel alpha capabilities
pnpm ra2ctl --channel alpha observe
pnpm ra2ctl --channel alpha catalog
```

The game page shows an **AI orders** overlay after the first command. Its collapsed summary shows the latest order; expand it for the last 50 orders, including action, type/unit/target, destination, time and receipt state. Reads such as `observe` are not journaled. Pending receipts are checked every 500 ms for up to 30 attempts, even when the CLI does not poll; disconnect cancels polling and marks unresolved outcomes unknown. Quick-start VM replacement keeps the connection and journal; closing or reloading the page clears them. Entries remain in page memory only, and a queued receipt never claims that the order has completed.

These commands print JSON. Failed requests exit nonzero. `--port` overrides the server/CLI port for isolated tooling; the page currently connects to the default port.

## Dedicated gameplay agent

Start the web page and `pnpm ra2ctl serve` separately, load game resources, and connect the page to a channel. Install and authenticate either Codex CLI or Claude Code using its own normal setup. Then start one agent terminal:

```bash
pnpm ra2agent --agent codex --channel 1
pnpm ra2agent --agent claude --channel 1
# Explicitly allow starting a match when no battle is running:
pnpm ra2agent --agent codex --channel 1 --quick-start
# Inspect the executable, arguments and complete prompt without a model or server:
pnpm ra2agent --agent claude --channel 1 --dry-run
```

Use one of these launch commands, not both for the same channel. The launcher performs a read-only `ui.status` preflight and passes the maintained skill, strategy and battle-control texts directly to the selected CLI. It keeps that CLI's interactive terminal, authentication and permission policy. Use its terminal to interrupt or steer the agent; no server is started or stopped by this script. Exiting the agent propagates its exit status; it is not automatically restarted. The script does not grant sandbox/network access or bypass approvals: the CLI must allow the local `pnpm ra2ctl` commands under the user's normal configuration.

`--port` selects the loopback control server and `--model` passes an explicit model to the selected CLI; otherwise its configured model is retained. The default joins an existing battle and never replaces it. `--quick-start` permits one native start when no battle is running, not a restart loop. A prompt establishes the gameplay policy, not a security sandbox or a guarantee that the model will win or remain active indefinitely.

## Page state and quick start

For normal agent play, `pnpm ra2ctl --channel alpha start` handles page and command IDs and refuses to replace an active battlefield. Use `pnpm ra2ctl --channel alpha wait-ready` afterward; submission does not mean loading has finished. The raw API below remains available for explicitly authorized replacement and protocol diagnosis.

`wait-ready` polls page readiness and returns `{event: "battle-ready", observation}` at the first readable battlefield. It never starts, replaces or pauses a game and never submits gameplay orders. Optional `timeoutMs` (1..300000, default 180000) and `intervalMs` (250..10000, default 250) bound the wait. Runtime failure, disconnection, an active-battle observation error and timeout fail explicitly. A startup harness can finish agent preflight in the native menu, wait for this read-only call to begin, then click Start; the agent receives the first observation without spending the opening on capability discovery.

The same channel is available before a VM starts. Resource import still uses the web page's normal picker; the API does not download assets or grant filesystem access.

```bash
pnpm ra2ctl --channel alpha ui.status
# Use pageId from ui.status. Replacing a running VM discards its unsaved match.
pnpm ra2ctl --channel alpha ui.quickStart --params '{"commandId":"start-1","expectedPageId":"PAGE","replaceSession":true}'
pnpm ra2ctl --channel alpha ui.status
```

`ui.status` reports the page generation (`pageId`), page phase, `hasResources`, `hasRuntime`, `starting`, startup `failure`, and available application actions. With a VM, `runtime` includes its phase, native menu title (`page`), control support, and `battlefield.ready`; a ready battlefield also includes its session ID and frame. An empty native title alone is not proof of a ready battlefield. After `battlefield.ready` becomes true, obtain a fresh `observe` before commanding units.

On native menu and score pages, `runtime.controls` returns visible control content (`id`, `className`, `text`, and list `items`). Query `ui.status` after battle ends; this read does not require an active battlefield and monitor end events include it in their status. Hidden controls and controls beneath hidden ancestors are excluded. `text` retains the native template string (often a resource key). RA2/YR Static controls also expose `displayText` when the original game supplies a UTF-16 label through its registered control-message protocol. This includes score-page player names, losses, kills, built counts, scores, scenario and elapsed-time labels. An absent `displayText` means no readable update was captured; an empty string is a native clear, and `"0"` is a real zero. Hidden controls remain excluded. Other custom surface-drawn text and score graphics are not captured. Empty content or a score-page title does not establish a winner. `runtime.battleResult` separately reports a retained native result (`sessionId`, `frame`, local `player`, `outcome`, and `source: "native-game-loop"`), or `null` before native completion/when unsupported. Outcomes are `victory`, `defeat`, or `unknown`; no winner is inferred from score text. The result survives House teardown and native menus, and is cleared when the next native battle starts or the VM is replaced.

`ui.quickStart` reuses the already selected, completely loaded resources and the existing one-shot native skirmish startup hook. It retains the channel, journal, native option validation and scenario loading. It uses native INI/default settings; map, country, opponent and difficulty configuration and individual native menu-button actions are not exposed yet. Starting is rejected during incomplete resource extraction, without resources, with a stale page ID, or while another start is in progress. Replacing an existing VM requires the explicit `replaceSession: true` field. A submitted receipt means the restart was accepted, not that the match loaded successfully; poll `ui.status` for phase/failure and battlefield readiness.

Command IDs deduplicate exact retry payloads across VM replacements, up to 100 application starts per page lifetime. Reusing an ID with a different payload fails. Page closure cancels deferred launch work; ordinary battle commands still require their own current native session ID. Server and CLI only forward methods and need no restart for page API updates. A running VM must be recreated to load changed native control code.

## Exit the current battle

```bash
pnpm ra2ctl --channel alpha exit-battle
pnpm ra2ctl --channel alpha ui.status
# The same operation is available through ordinary command helpers:
pnpm ra2ctl --channel alpha act --params '{"action":"exit-battle"}'
```

`exit-battle` requests native departure from the current battle without restarting the VM, unloading resources, closing the browser connection or stopping the control server. It requires a ready battlefield and accepts no unit, target, cell or production parameters. The CLI binds the session and fresh observed frame and polls the same command receipt. Calling it again after leaving the battlefield fails instead of starting or replacing a game. Use it only when leaving the current match is intended; it is not a pause or save operation.

The native game decides the next page. Original skirmish validation returns to `GUI:SkirmishGame` with the same application `pageId`. A `submitted` receipt means the native exit event was queued, not that the page transition has finished; query `ui.status` to confirm departure. Native menus and score pages allow read-only `commandStatus` queries after battlefield teardown, while new battle commands remain rejected there. Receipts are retained only for the controller's session and are invalidated on VM replacement/disposal or an observed native session change. No victory, defeat or surrender outcome is inferred from departure. Campaign and network departure behavior require separate acceptance.

The raw action is `command` with `action: "exit-battle"` and the ordinary `sessionId`, `observedFrame` and `commandId` fields. Identical IDs deduplicate normally; transport uncertainty must be resolved with the original receipt, never by replaying a new exit. `start` still recreates the VM: native menu navigation to start another battle without replacement is not part of this action.

## Observe and command

The repository [strategy skill](../.agents/skills/ra2-strategy/SKILL.md) and [battle-control skill](../.agents/skills/ra2-battle-control/SKILL.md) separate strategy (objectives, priorities and remembered intelligence) from battle control (player operations, bounded monitoring and effect confirmation). Both run through one command writer; this is not a pair of competing camera loops.

Autonomous agent play requires the model to choose production, placement, scouting and combat actions from current player-visible observations. Skills do not invoke fixed-strategy executors or multi-building waits. Immediate sequential batches execute decisions already made; read-only monitoring and recording do not make tactical decisions. Existing scripted baselines in `.agents/skills/ra2-battle-control/scripts/strategies/` are historical comparison tools and do not establish pure-agent performance.

Routine CLI output is compact: it unwraps the transport envelope and omits session/command UUIDs and redundant world/screen coordinates. Entity IDs and observation frames remain. A short `session` label allows the agent to detect match replacement without carrying the full UUID. Pass `--raw` for the original response envelope and full diagnostic fields. The public HTTP contract remains unchanged.

Repeated `entities` and `sidebar` records use `{columns, rows, extra?}` when that representation is shorter. Each row contains values in `columns` order; optional `extra[i]` adds fields specific to row `i`. Row order and all remaining field values are preserved, including absent versus null fields. Small or heterogeneous lists can remain ordinary arrays. This applies to nested observations too. For example, `{"columns":["id","health"],"rows":[["tank-a",300],["tank-b",200]],"extra":[{}, {"selected":true}]}` represents two objects, with `selected` present only on the second. Consumers needing the original object-array schema should use `--raw`.

`act`, `look`, `order-group`, `place-building`, `build-plan` and `batch` bind the current session automatically when `sessionId` is omitted. Each command still refreshes its frame and generates an idempotency ID internally. Explicit session binding is supported for long-lived clients. An ambiguous write error retains its receipt ID for diagnosis; it is never automatically replayed.

`batch` accepts 1..32 immediate orders and submits them sequentially in one session. Malformed envelopes are rejected before any operation, with a compact example of the accepted `action` and `unit` shape; choose actual visible IDs and cells when correcting them. By default it stops at the first rejection, session change or uncertain outcome, returns the completed prefix count and zero-based failed index (`--raw` includes individual receipts), and exits nonzero. Camera orders settle before continuing. A confirmed rejection returns `next: reobserve`; an unresolved transport/session outcome returns `next: inspect`. A delivered game error is confirmed as unsubmitted only after the same-session receipt lookup returns `unknown`; the write is never replayed. It does not wait for production completion or make a transaction: place completed buildings in a later call and never replay an entire partial batch.

For orders the caller explicitly declares independent, `onRejected: "continue"` proceeds after a confirmed native `rejected` receipt. It never continues on transport uncertainty, session replacement or other failure states. The result lists rejected indices/errors and accepted orders; accepted indices need not form a prefix. A fully attempted list containing rejections returns `completed-with-rejections` and exits nonzero; an uncertain later order returns `interrupted` with prior rejections preserved. Default `stop` behavior and placement `afterOrders` remain unchanged. Never use continuation for dependencies such as power selection followed by targeting.

Delivered game errors use HTTP 422 (older servers used a 200 error envelope). The client checks their same-session receipt before classifying rejection. HTTP 409 disconnects and HTTP 504 timeouts remain uncertain regardless of their error text; neither is automatically retried.

`build-plan` executes a caller-authored sequence of 1–8 building steps, each with `type` and 1–12 candidate `cells`. Unlike an immediate batch, it waits for production and confirmed placement before starting the next prerequisite. Existing production of the requested type is resumed without submitting another purchase. `durationMs` bounds production waiting and starting subsequent steps (default 120000, range 1000–300000); an in-flight native command or placement keeps its own bounded confirmation window. Expiry returns `state: "waiting"` with the current `index`; errors return `interrupted`. Both retain the completed prefix (`--raw` gives individual building IDs). Inspect current production and resume only the unfinished suffix. A timeout never cancels production or retries an uncertain write. The plan shares the sole command writer with combat and camera control; use short plans after assigning guards/scouts, rather than concurrent writers. This helper chooses neither building types nor sites.

```bash
pnpm ra2ctl --channel alpha build-plan --params '{"durationMs":60000,"steps":[{"type":"GAPOWR","cells":[{"x":72,"y":118}]},{"type":"GAREFN","cells":[{"x":74,"y":120}]}]}'
```

```bash
pnpm ra2ctl --channel alpha batch --params '{"orders":[{"action":"produce","type":"E1"},{"action":"produce","type":"MTNK"},{"action":"move","unit":"VISIBLE_UNIT","cell":{"x":42,"y":18}}]}'
```

The CLI also provides client-side workflows over the same public API:

```bash
pnpm ra2ctl --channel alpha monitor --params '{"durationMs":30000,"intervalMs":1000}'
pnpm ra2ctl --channel alpha look --params '{"cell":{"x":42,"y":18}}'
pnpm ra2ctl --channel alpha act --params '{"action":"produce","type":"GAPOWR"}'
pnpm ra2ctl --channel alpha order-group --params '{"action":"attack-move","units":["UNIT_A","UNIT_B"],"cell":{"x":42,"y":18}}'
pnpm ra2ctl --channel alpha place-building --params '{"type":"GAPOWR","cells":[{"x":42,"y":18},{"x":44,"y":20}]}'
```

### Current-view images

`pnpm ra2ctl --channel alpha screenshot` requests the next presented game frame and saves a local image, returning its path and dimensions without base64 in CLI output. `--output NEW_IMAGE_PATH` chooses a new file; existing files are rejected. Open the file with an image viewer. `--raw` still returns file metadata for this helper. The underlying `ui.screenshot` request requires `expectedPageId` from `ui.status`; unavailable presentation, timeout, disposal and page replacement fail explicitly. `ui.status.actions` advertises availability.

The image uses pixels already passed to presentation, including native shroud, terrain and disguises. It does not query hidden objects, move the camera or reveal a Mirage tank's true type. Separate host cursors, web overlays and GPU-only postprocessing are not included. The longest edge is at most 1600 pixels; source dimensions are included. PNG is preferred, with bounded JPEG fallback to retain the existing 1 MiB transport limit. `presentation` identifies the local presentation sequence, not a native simulation frame or an atomic match with a separate `observe` call. Captures are on demand, not a background recording or tactical process.

### Monitoring and sequential operations

`monitor` emits JSONL observation deltas without moving the camera. Optional `stopOn: ["production-ready", "support-ready", "damage", "contact"]` returns at the first selected condition, with a current `observation`; an already ready product, ready local support power, or visible non-owned entity triggers immediately. `contact` is not an alliance/hostility classification. Without `stopOn`, the requested duration is preserved. Normal duration completion includes the last sampled `observation` with its frame, sidebar and viewport, so the caller can decide without an extra read. It is a sample, not a guarantee that the world has remained unchanged since that frame. Session replacement and battle-end events do not include this duration result. `leftView` means lost visibility, not death. It stops at the duration limit, session replacement or native completion/non-battle state. End events forward the native `battleResult` as `result` and its `outcome`, including when monitoring begins on the score page. Missing native evidence remains `unknown`; a replaced page or mismatched result session produces `session-changed` instead of attributing another match's result. It never infers victory from a page name. `act` observes a fresh frame, preserves the caller's expected session and polls one native receipt. An ambiguous timeout is not replayed automatically.

`look` moves the camera and returns an observation after the viewport stays stable and native simulation advances by two frames. The native camera receipt can precede the object's visibility refresh, so an immediate `observe` after a raw camera order may temporarily omit objects in the new view. Use `look` when alternating production and combat views. It fails after five seconds without a settled view rather than treating a paused/contended camera as an empty battlefield. The placement helper uses this same path.

`order-group` validates 1–64 distinct living owned units in the current view and submits one native multi-selection intent. The same actions also accept `units` instead of `unit` through `act` or a batch order; `repair` and `sell` remain single-building actions. The game thread rechecks every pointer, identity, owner and liveness before selection, invokes original selection methods, and verifies exact selected membership before one original mouse/hotkey handler. The browser journal shows the requested unit count in one entry. Capabilities expose `group.maxUnits` and `group.selection`.

Group preflight rejection emits `group-rejected` with no submitted orders, unavailable requested IDs, an unavailable target when applicable, and the current public `observation`. Reconcile that view before choosing survivors. After submission, one receipt belongs to the whole intent; there are no per-unit receipts or completed prefixes. `group-interrupted` reports `rejected` with `next: reobserve` for confirmed rejection, or `unknown` with `next: inspect` for uncertainty. Never replay an uncertain intent. Native selection and cursor rules can reject an order, and queue acceptance does not prove every member can perform it or has completed it. Verify effects in subsequent observations. Already-issued missions can continue off-screen; a camera change alone is not a reason to replace them.

`place-building` accepts 1–12 caller-selected candidate cells for an already completed building. It explicitly moves the camera, submits native placement and verifies a new living owned building near that site together with product consumption. It stops on camera/session changes, stalled simulation or unconfirmed consumption instead of repeating uncertain orders. The helper does not expose a standalone terrain-legality query. Placement now runs the native red/green preview before clicking; the helper tries another supplied candidate only after a confirmed rejection or a confirmed unconsumed attempt, never after an ambiguous timeout. Failed attempts include `visibleOverlaps` when the requested type has known dimensions; these are intersections with visible entity bounding boxes, not exhaustive blockers or a legality oracle. Successful `building-confirmed` and final `placement-exhausted` events include the latest observation so the caller can decide without another read. Exhausted candidates require a new decision about terrain, blockers or build reach. Keep it under the same command writer as camera/combat orders; independent readers may monitor concurrently.

Optional `afterOrders` supplies a caller-authored immediate batch that runs only after `building-confirmed`, in the same session. For example, add `"afterOrders":[{"action":"produce","type":"GAPILE"}]` when placing a completed power plant and you have decided to build barracks next. This avoids another agent round trip; it does not choose purchases or wait for future production. Use a short list of already decided orders. The envelope is validated before placement; each action still passes native checks at execution. `placement-followup` reports submitted receipts or the interrupted prefix using the same fields as `batch`. An interrupted follow-up exits nonzero even though the building is already placed: never replay the placement or completed orders. A session change or read failure before the batch can leave only `building-confirmed`; inspect before continuing.

Product consumption can precede the building's visibility refresh. The helper continues read-only observation for up to five seconds after consumption in that case; it never submits another placement after seeing consumption. If the building remains unobserved, the result is still uncertain and requires inspection. For an unconsumed submission, the helper waits for 60 simulation frames before trying another supplied candidate, with a 30-second overall confirmation limit and a five-second no-frame-progress limit. This accommodates slow advancing main-thread execution without changing game clocks or converting a timeout into a rejection.

`capabilities` returns the supported action names. Mismatched loaded instruction signatures return `supported: false`; normal game startup remains available.

`observe` returns:

- `sessionId`, native logic `frame`, and local `player` index.
- `perspective: "viewport"` and `viewport: {x, y, width, height}`: the native camera origin and battlefield bounds. There is no omniscient fallback.
- `cash`: the native House cash balance, excluding the additional value of stored ore.
- `entities`: live, non-limbo objects with positive native health whose projected anchor is inside the current camera and whose native object/cell visibility permits observation. Dying objects awaiting native cleanup are omitted. Entries include unique ID, type ID, owner, position in leptons, cell coordinates and viewport-relative `screen` coordinates. Exact `health` and numeric native `mission` are supplied only for owned objects. Off-screen, shrouded, fogged and undetected cloaked objects are omitted. Foreign disguised objects are conservatively omitted to avoid disclosing their true identity.
- `sidebarTab`: the currently selected native Q/W/E/R category (0/1/2/3).
- `sidebar`: native buildable cameos, their tab, displayed progress, factory association and pending state. These are observations of the original sidebar, not a second UI.
- `production`: active local factory products identified through their real sidebar cameo (not speculative object-layout reads), progress out of 54 native stages, funding hold (`onHold`) and native suspension (`suspended`) states. Manual pause is a suspension, not a funding hold. This is not a complete future production-queue listing.

Reads run between CPU slices and copy values into ordinary objects; they do not transfer guest memory. The reported frame labels the sample, not a promise that every object has completed that frame's update. `catalog` lists only types currently represented by native sidebar cameos. Presence does not guarantee sufficient funds or valid placement.

The raw protocol uses a fresh observation. Use `observe --raw` to obtain the full session ID for diagnostics; routine play should use `act` or `batch`. Replace the illustrative session/frame/unit values below:

```bash
pnpm ra2ctl --channel alpha command --params '{"sessionId":"SESSION","observedFrame":100,"commandId":"move-1","action":"move","unit":"UNIT","cell":{"x":42,"y":18}}'
pnpm ra2ctl --channel alpha commandStatus --params '{"sessionId":"SESSION","commandId":"move-1"}'
```

`produce` trains units as well as constructing buildings. For example, after a barracks is available, use `action: "produce", type: "E1"`; after a war factory and its prerequisites are available, use `type: "MTNK"`. Use the current sidebar to find available types rather than assuming a catalog entry can be built. Units leave their native factory automatically: do not send `place` for infantry, vehicles or aircraft. Confirm a new owned entity ID appears in `observe`, then use that ID for movement or combat. Buildings still need `place` after production completes.

Raw `command` requests require `sessionId`, `observedFrame`, and a unique `commandId`; the higher-level CLI helpers supply these automatically. Unit and target IDs are strings scoped to that session. Commands older than 300 logic frames are rejected; this uses native simulation frames, not a modified game clock.

| Action                               | Additional fields                                          |
| ------------------------------------ | ---------------------------------------------------------- |
| `camera`                             | `cell: {x, y}` or currently visible `unit`                 |
| `move`, `attack-move`                | `unit`, `cell: {x, y}`                                     |
| `attack`                             | `unit`, `target`                                           |
| `stop`, `guard`, `deploy`, `scatter` | `unit`                                                     |
| `repair`, `sell`                     | `unit` identifying an owned building                       |
| `produce`, `suspend`, `cancel`       | `type` from the catalog, optional `naval: true`            |
| `place`                              | completed building `type`, `cell: {x, y}`                  |
| `select-power`                       | `type` from local `supportPowers`; select its native cameo |
| `target-power`                       | selected power `type`, `cell: {x, y}`                      |
| `exit-battle`                        | none; exit the current battle through its native handler   |

`produce`, `suspend` and `cancel` resolve a real native sidebar cameo, call the original `SidebarClass::SetTab` for its Q/W/E/R category, then invoke the original button action handler. The category switch updates native buttons and redraw state; the selected category is observable as `sidebarTab`. Types no longer present in the sidebar are rejected. Native production checks, factory/category selection, pending flags and progress clocks run together. The type itself determines naval production for these actions; the optional `naval` parameter does not override native policy. A funding shortage retains the original game behavior (including stalled production), rather than requiring the full price up front. Cancelling an active product performs the normal suspend-then-cancel sequence, waiting for native suspension before the second action.

Unit commands act on the local player's currently visible objects. Attack targets must also be visible at execution-request time; stale or guessed hidden IDs cannot bypass observation filtering. `camera` pans using the native tactical-position function and never reveals shroud. Focus by unit ID requires current visibility; use a remembered cell coordinate to return to an earlier view. Attack uses the native target-action resolver: ordinary clicks on owned objects are not force-fire. The API does not synthesize a Ctrl modifier or bypass that refusal. Unit orders first select the visible owned object through the native selection handler. Move/attack/attack-move use the original cell/object click handlers; stop/deploy/scatter/guard use the player command handlers used by their hotkeys. `guard` therefore means native G/area guard (mission 11), rather than assigning idle guard (mission 5). Repair and sell enter the native cursor mode and use the tactical release handler. Placement clicks the completed cameo, runs the native foundation preview/proximity/occupancy checks, and clicks the map on a subsequent native iteration. Invalid previews produce `rejected` without submitting a placement event. Placement coordinates identify the foundation origin; the adapter translates it into the native cursor anchor using the original foundation offset. A submitted placement can be rejected by the game for an occupied or otherwise invalid foundation; the caller must observe the resulting world before concluding that construction succeeded.

The response states have deliberately narrow meanings:

- `pending`: written to the private command mailbox, awaiting the game thread.
- `submitted`: the original game accepted the event into OutList, or the native camera call completed. This is not proof that an attack hit, a building was placed, or production completed.
- `rejected`: the cameo changed before execution or the native sidebar handler emitted no event. This does not imply every UI side effect was undone.
- `queue-full`: the native outgoing queue rejected the event.
- `expired`: the frame or player context changed before submission.
- `unknown`: no receipt exists for that ID in the current session.

There is one in-flight mailbox slot. Observe or poll its receipt before sending another command. Repeating the same `commandId` and identical parameters returns the existing receipt without another native event. Reusing an ID with different parameters fails. Receipts are bounded to 4096 commands per VM session; reaching the limit fails explicitly rather than evicting deduplication history. HTTP request IDs are independently rewritten by the router to correlate concurrent clients.

Disconnected channels fail immediately. Timed-out requests report an unknown execution outcome: they may already have entered the game, so query the same command ID rather than blindly creating a new command. The router does not replay commands after reconnect. Page/session destruction closes the connection and discards pending control state. Native frame rollback or local-House replacement rotates the game session ID. Arbitrary save/load transitions that restore the same House address and a later frame are not yet a proven session-boundary detector; reconnecting alone does not create a new game session.

Visibility projects native height levels onto the fog grid before checking reveal and visibility bytes. Odd levels can occupy either adjacent diagonal visibility cell. Physical cell coordinates remain the basis for local cloak sensors. The original RA2 shroud routine at `0x568140` reads its height divisor at `0xa6fc30`; YR's corresponding routine at `0x586360` reads `0xabde88`. Both use neighbor direction 3 for the odd-level second cell. These addresses belong to their game profiles; an invalid height divisor fails observation closed. Screen bounds, native object visibility, disguise and cloak checks still apply.

## Implementation boundaries

| Module                                      | Responsibility                                                   |
| ------------------------------------------- | ---------------------------------------------------------------- |
| `.agents/skills/ra2-battle-control/scripts/protocol.ts`          | Game-independent request envelope, channel and size limits       |
| `.agents/skills/ra2-battle-control/scripts/server.ts`               | Loopback HTTP/WebSocket routing, browser-origin checks, timeouts |
| `.agents/skills/ra2-battle-control/scripts/ra2ctl.mts`                | CLI server and JSON client                                       |
| `src/platform/browser/controlConnection.ts` | Explicit browser connection and bounded request forwarding       |
| `src/app/session/controlSession.ts`         | Connection ownership and invalidation on session replacement     |
| `src/adapter/`                              | VM-shell interface and Worker request/reply transport            |
| `src/games/{ra2,yr}/control.ts`             | Independently validated executable profiles                      |
| `src/games/shared/nativeControl.ts`         | RA2/YR observation decoding and native command mailbox           |
| `src/games/shared/nativePlayerControl.ts`   | Native selection, hotkey, tactical click and placement dispatch  |
| `src/games/shared/nativeSidebarControl.ts`  | Original sidebar action dispatch and version-specific ABI        |
| `src/games/shared/nativeViewport.ts`        | Native player visibility, projection and camera dispatch         |

The multiplayer relay remains a generic datagram router and does not import these controls. The generic VM contains no game addresses. Ordinary connection UI stays in the single React tree; battlefield samples are requested on demand and never stored in React state.

The control hook preserves registers, flags and stack state. Production, suspension and cancellation use the original tab switch and `SelectClass::Action`, with a native-constructed private selector bound to an existing cameo. Its relative index is recomputed from the current native top row. The game thread rechecks cameo identity and count before invoking the handler. Camera orders call the signature-checked native floor-height and tactical-position functions. `nativePlayerControl.ts` invokes native selection, hotkey command and click handlers, including the two-stage building preview/click path. No control command constructs an EventClass or calls AddEvent directly; the original player handlers own event creation and queueing. Native execution rechecks object identity, life and ownership, and checks mailbox player/session age. It does not edit live queue counters, object positions, health, funds or mission fields.

## Native compatibility evidence

Profiles define independently checked instruction evidence. Every loaded hook/entry signature must match before any code is installed. Unmatched layouts do not fall back to fixed addresses.

External layout references: Phobos-developers YRpp revision `8468aab5eab6c2057532ed095e36f639a37564fc`, source paths `EventClass.h`, `TargetClass.h`, `QueueClass.h`, `AbstractClass.h`, `ObjectClass.h`, `TechnoClass.h`, `FootClass.h`, `HouseClass.h`, `FactoryClass.h`, and the four object/type class headers. Ares-Developers YRpp revision `61d0887eb6040cfb36af16d592e9770ceae4dfb2`, `NetworkEvents.h` and `GeneralDefinitions.h`, provides an additional event-layout reference. No external headers or game binaries are bundled.

The RA2 profile was independently checked against native constructors rather than copying YR offsets:

| Evidence                      | RA2 1.006  | YR 1.001   |
| ----------------------------- | ---------- | ---------- |
| Unit constructor              | `0x6FA400` | `0x7353C0` |
| Infantry constructor          | `0x4FF640` | `0x517A50` |
| Aircraft constructor          | `0x413A40` | `0x413D20` |
| Building constructor          | `0x438CE0` | `0x43B740` |
| House index initialization    | `0x4E18D8` | `0x4F54B8` |
| House cash increment          | `0x4E5440` | `0x4F9950` |
| MegaMission event constructor | `0x4B6170` | `0x4C6860` |
| Native outgoing event append  | `0x62E670` | `0x6521C0` |
| End-of-logic-iteration hook   | `0x5406AC` | `0x55DEA9` |

MegaMission stores source target at event offset 7, mission at 12, attack target at 14 and destination at 19. Object targets use native unique ID plus RTTI 52; cell targets use `x + 1000*y` plus RTTI 11. Production uses type-category RTTI (`UnitType=40`, `InfantryType=16`, `AircraftType=3`, `BuildingType=7`) and the loaded type-array index, matching actual sidebar entries. Instance-category RTTI can start hidden production but does not match the sidebar item when linking its factory. Factory progress and object offsets differ between RA2 and YR and are separately configured.

### Sidebar entry evidence

RA2 `SelectClass` constructor/action are `0x6809A0`/`0x6809F0`; YR uses `0x6AACB0`/`0x6AAD00`. RA2 Action takes flags and a key pointer (`ret 8`); YR additionally takes modifiers (`ret 12`). Both are thiscall. The native type lookup and production-event constructor in the action path operate on the real cameo's type/index, while the same path initializes pending/display-clock state. Constructor and action signatures are checked alongside the mailbox hook before installation.

RA2 strips begin at `0x833A20` with stride `0xE64`; YR strips begin at `0x880D2C` with stride `0xF94`. Cameo strides are `0x30`/`0x34`. Both have factory pointer at cameo `+0x0C`, pending state at `+0x10` and display progress at `+0x14`. Native factory suspension is at RA2 `+0x6C` / YR `+0x70`, distinct from funding hold at `+0x58` / `+0x5C`. Evidence includes each executable's sidebar constructor/action instructions and Phobos YRpp `SidebarClass.h`, `GadgetClass.h`, `FactoryClass.h` and `GeneralDefinitions.h` at the revision above.

### Player operation evidence

RA2 `SidebarClass::SetTab` is `0x67D990` (instance `0x8324E0`, active index `+0x4ED8`); YR uses `0x6A7590` (instance `0x87F7E8`, active index `+0x539C`). Both are thiscall with one index argument and `ret 4`; they unregister the old strip buttons, activate the new tab, register its buttons and request redraw. The requested tab comes from the native strip index (`+0x34` / `+0x38`), not a hardcoded unit classification.

The following entries were checked in the original RA2 1.006 and YR 1.001 executables. Native player command wrappers (`DeployObject`, `StopObject`, `GuardObject`, `ScatterObject`) resolve to these handlers. Guard passes mission `0x0B` through the original clicked-mission path.

| Player operation         | RA2        | YR         |
| ------------------------ | ---------- | ---------- |
| Unselect all             | `0x482BC0` | `0x48DC90` |
| Techno selection         | `0x6C91C0` | `0x6FBFA0` |
| Stop                     | `0x6F5BC0` | `0x730EA0` |
| Guard                    | `0x6F5B10` | `0x730D60` |
| Deploy                   | `0x6F5940` | `0x730AF0` |
| Scatter                  | `0x6F5D10` | `0x730FE0` |
| Set repair mode          | `0x49CA20` | `0x4AC8C0` |
| Set sell mode            | `0x49C7C0` | `0x4AC660` |
| Tactical left release    | `0x49BB20` | `0x4AB9B0` |
| Foundation cursor update | `0x4994D0` | `0x4A91B0` |

Selection uses virtual slot `0x140` in RA2 and `0x14C` in YR. Movement, attack and attack-move call the original cursor decision and tactical left-release handlers with native terrain and shroud state. The original selected-list dispatcher then calls each object's MouseOver decision before its click handler; the controller does not supply fixed movement/attack cursor actions. RA2 uses MouseOver cell/object slots `0x6C/0x70` followed by click slots `0x134/0x138`; YR uses `0x70/0x74` followed by `0x140/0x144`. Repair/sell modes take one integer (0 off, 1 on, -1 toggle). The foundation cursor update takes an output cell and requested cursor cell (`ret 8`), updates both proximity and occupation validity, and retains native terrain adjustment. It is distinct from `SetActiveFoundation`, whose argument is a foundation array, not a cursor cell. Tactical left release takes coordinate pointer, cell pointer, object, Action and flags (`ret 20`). References include the executable vtables and YRpp `CommandClass.h`, `DisplayClass.h`, `MouseClass.h`, `SidebarClass.h` and `ObjectClass.h` at the revision above.

### Native multi-selection evidence

RA2 1.006 `TechnoClass::Select` at `0x6C91C0` calls base selection at `0x5D2E70`; YR 1.001 independently uses `0x6FBFA0` and `0x5F4520`. Their selected vectors/counts are `0xA40C64/0xA40C70` and `0xA8ECBC/0xA8ECC8`. Selection may clear incompatible members and can return true even after failing to grow its vector. The controller therefore checks the exact requested count and membership, not just each boolean return; mismatch clears selection and prevents the intent. It never writes the native selection vector directly.

The private control allocation is 8192 bytes, with player code at offset 2304 and a bounded 64-entry pointer/identity table at offset 7168. The table is published before the mailbox becomes ready, belongs to that controller lifetime, and contains only objects resolved from the current public view. Single-unit calls retain their existing payload layout. Original tactical left release reaches the selected-list dispatch at `0x49E870` in RA2 and `0x4AE750` in YR, including per-object MouseOver checks. These addresses describe the original call chain; the controller calls the public player handlers, not the private dispatcher.

### Native battle exit evidence

RA2 1.006 uses the no-argument exit-event routine at `0x6236B0`; its confirmed in-game exit path calls it at `0x481A48`. YR 1.001 independently uses `0x6471A0`. Both routines return acceptance in AL, choose the original exit/network-departure event (`0x13` or `0x27`) from native session state and append through their own native queue logic. The control profile validates the loaded entry signature before enabling the action. The game-thread mailbox checks session age, local House identity and queue capacity, calls this routine once, and reports its boolean result. It neither fabricates EventClass data nor writes quit, defeat or menu-state globals.

`tests/basic/vm/playerControl.e2e.test.ts` executes the exit dispatch in v86 for both profiles, covering AL semantics, full queues and balanced stacks without unit selection. `tests/real-game/exitBattle.test.ts` requires original battles to return to native setup while retaining a single VM and readable receipts. `pnpm run test:browser:exit-battle` tests the CLI, connection and journal in RA2/YR Worker/main modes, using an ephemeral test router and independent channels.

### Player-view and camera evidence

Native tactical pointers are RA2 `0x83996C` / YR `0x887324`; viewport origins are at tactical `+0xB0/+0xB4`. ViewBounds are `0x839630` / `0x886FA0`. Native selectable projection (`0x6AA510` / `0x6D9EF0`) uses 60-by-30 isometric cells, 256 leptons per cell and the native height scale. The anchor test is conservative at sprite edges; it does not claim pixel-perfect sprite occlusion.

Native cell vectors are `0x832618` / `0x87F924`, indexed by `x + 512*y`. Shroud checks (`0x568140` / `0x586360`) use cell `+0x12C & 8`; visibility/fog bytes at `+0x120/+0x121` must both be 255. Object visibility offsets are `+0x85/+0x99`, disguise `+0x170/+0x1D8`, cloak state `+0x1B8/+0x220`. Cloaked opponents additionally require the local house's cell sensor count at `+0x7C`. References include the YRpp revisions above, `TacticalClass.h`, `CellClass.h`, `ObjectClass.h`, `TechnoClass.h` and `Surface.h`, checked against both original executables and real-game observations.

The native MapClass instance is RA2 `0x8324E0` / YR `0x87F7E8`; the cell vector sits at instance `+0x138` / `+0x13C`, respectively, as confirmed by `0x548070` / `0x5657A0`. The floor-height entry overwrites ECX internally, so successful camera movement alone cannot validate the MapClass receiver.

Camera dispatch calls native floor height (`0x55A280` / `0x578080`) followed by tactical position (`0x6A66B0` / `0x6D6070`), both thiscall with one coordinate-pointer argument and `ret 4`. It changes the view without writing world visibility. Private code/mailbox storage is 4096 bytes. Asset-free v86 execution verifies both ABI variants and balanced stack cleanup.

## Verification

```bash
pnpm run check
pnpm exec vitest run tests/real-game/control.test.ts tests/real-game/controlVisibility.test.ts --maxWorkers=1
pnpm run test:browser:control
```

The first command includes asset-free router, session, and actual x86 mailbox regressions. Real-game tests require local original resources and fail when missing. The real-game regression also requires factory-linked sidebar progress, rejection without charges before a construction yard or missing prerequisites, training new infantry and successive tanks and moving them, manual suspension, cancellation from both active and suspended production, and clearing of the native cameo. The browser entry requires the development server, an available default control port, and Chromium. Set `RA2_CONTROL_EXTERNAL_SERVER=1` to reuse an already running local control server; the test owns only its separate browser channels in this mode. It exercises the CLI through the visible connection UI in both execution modes and both games, observing real MCV deployment, native sidebar production progress, cancellation and visible command receipts/errors without injecting guest mouse or keyboard commands. It writes temporary browser screenshots for visual inspection. The visibility regression uses a read-only native oracle to prove hidden enemy IDs are omitted and rejected, camera movement leaves shroud unchanged, and returning the camera restores visible owned units. Browser coverage includes camera changes, off-screen ID rejection, actual attack-move displacement and friendly-target refusal. Full-match multiplayer reliability, arbitrary executable variants and real cloaked/disguised combat scenarios require separate acceptance; cloak/disguise filtering has asset-free policy tests for both game profiles, including local-house sensor isolation, cloak transitions, ownership changes and the independent camera/shroud/disguise gates.

`attack-move` first invokes the original attack-move mode command (RA2 `0x6F6570`, YR `0x731AF0`), then the native cell-click handler, and clears that mode through the original function (RA2 `0x6F6660`, YR `0x731BE0`). This enables native MegaMission 29; the engine records that mission while routing movement through its ordinary Move mission. Real-game regressions verify displacement toward a nearby reachable cell in both games. A submitted receipt still does not establish reachability or command completion: confirm actual positions and target health through fresh visible observations.

### Multiplayer and concealed-unit regression entry points

See [AI control in native multiplayer](TESTING.md#ai-control-in-native-multiplayer) for the two-page CLI regression and optional original-unit concealment scenarios. Both players use independent channels; the game relay remains separate from the loopback control server. Deployment acceptance compares actual native state across peers, while camera and observation checks stay local. A test-only read oracle may inspect hidden objects to establish negative assertions, but those objects must never enter public observations or command target resolution.

The concealed-unit test setup samples terrain only after native shroud/fog and viewport checks. It uses cell `LandType` at `+0xEC` (`Water=2`), corroborated by native comparisons at RA2 `0x440BBD` / YR `0x444300` and the YRpp `CellClass.h` / `GeneralDefinitions.h` references above. Candidate foundations and scout destinations remain subject to original placement and pathfinding. This test-only terrain sampler is not an additional public observation endpoint.

### Native score-page text evidence

RA2 1.006 sends UTF-16 score labels through `SendMessageA` message `0x4B2` at `0x5AAF64` (title), `0x5AAF7B` (scenario), `0x5AB06E` (elapsed time), and `0x5AB154` through `0x5AB2AF` (player rows). Its Static subclass handles this message at `0x5EF381`, copies the UTF-16 buffer at `0x5EF406`–`0x5EF41B`, and clears it for a null pointer. YR 1.001 independently sends the same message at `0x5C9C34`, `0x5C9C4B`, `0x5C9D40` and its following row loop. Each game's shim profile registers the protocol; the generic shim contains no game addresses or score-control IDs and does not replace native dispatch. Copied labels have a 4096-code-unit bound and are discarded with their windows.

The multiplayer score table's first two rows use control IDs `[1041, 1049, 1699, 1701, 1702]` and `[1042, 1050, 1700, 1703, 1704]`, respectively, in name/kills/losses/built/score order (confirmed against the native dialog templates). Title, scenario and elapsed time use 1684, 1746 and 1002. These are displayed statistics, not a local-player identity or victory flag. Do not infer the winner from row order or score.

`pnpm exec vitest run tests/real-game/scorePage.test.ts --maxWorkers=1` starts original RA2/YR battles in isolated test VMs, leaves their starting armies under native control and waits for the opponent to end the battle normally. It requires populated native score text and a retained same-session `defeat` through `ui.status`; a timeout, missing assets or an empty template fails. It does not replace an existing browser match. Original-game victory scenarios require separate validation; the asset-free x86 regression covers both outcome branches. Already-running VMs must be recreated to install result observation hooks; past outcomes cannot be reconstructed from old score text.

### Native battle-result evidence

RA2 1.006 sets the local win global `0xA35DB1` at `0x4E4369` after comparing House ESI with the local player at `0x4E435C`; its local loss branch at `0x4E4479` sets `0xA40C78` at `0x4E4486`. YR 1.001 independently uses the comparisons at `0x4F8685` / `0x4F87A5` and globals `0xA83D49` / `0xA8ECD0`. These are the original logic-loop completion flags, not the earlier House win/lose timers or score ranking.

`games/shared/nativeBattleResult.ts` observes the native terminal branch at RA2 `0x5406CB` / YR `0x55DEC8`, before player objects are released. Per-game control profiles validate the two outcome branches, the terminal dispatch and displaced instruction before installing either hook. Trampolines preserve registers, flags and native instructions and write only private observation storage; they do not set game outcome flags or alter defeat checks. Neither flag (for example an ordinary quit), contradictory flags or noncanonical values produce `unknown`. Normal logic iterations reset the record and advance its generation for a subsequent battle; native frame rollback and local-player replacement also invalidate the previous session. No host polling cadence is needed to retain completion.

`tests/basic/vm/battleResult.e2e.test.ts` executes both profiles' trampolines in v86, checking victory, defeat, unknown, contradictory flags, ABI preservation and reset without intervening host reads. Native-control, VM-core and CLI tests cover teardown-safe reads, session isolation, compact/raw output and status/observe races. `tests/real-game/exitBattle.test.ts` additionally requires native quit to remain `unknown` rather than manufacturing a loss.

### Building footprint observations

Available building cameos and visible owned buildings include `foundation: {width, height}`. These are public type dimensions: the rectangle begins at the entity/placement cell and extends along positive cell axes. They exclude bibs and do not encode terrain, proximity, ownership, occupation or build legality. Missing dimensions remain unknown. No extra entities or map cells are exposed.

RA2 1.006 `GetFoundationWidth` at `0x458930` reads the type index at `+0xC78` and width table `0x7CFC70`; the non-bib height path at `0x458969` uses `0x7CFCC8`. YR 1.001 uses `0x45EC90` / `0x45ECC9`, index `+0xEF0`, and tables `0x8192B8` / `0x819310`, consistent with Phobos YRpp `BuildingTypeClass.h` at the revision above. Both tables contain 22 entries. The profiles validate the independently inspected instruction signatures before enabling control; out-of-range indices or invalid dimensions are omitted.

### Native support powers

The control profile exposes local-house sidebar powers through `supportPowers` and the current native targeting mode through `targetingPower`. `select-power` accepts a sidebar type; `target-power` accepts the selected type and a map cell. Selection uses the native Special cameo handler, and targeting uses native cursor legality and map release handlers. Availability is limited to actual local sidebar entries; no opponent cooldowns are exposed.

Asset-free tests cover charged/held/charge-drain readiness, invalid indexes, and v86 terrain/shroud argument forwarding with balanced stacks. Independent original-game support scenarios verify natural American paradrop recharge, early rejection, native selection and targeting, restarted cooldown, and eight new GIs. `pnpm run test:browser:support` checks the CLI/channel path, native sidebar category and visible command journal in RA2/YR Worker/main modes. Paradrop coverage does not establish multi-stage or non-targeted power behavior, or full-match win rates.

Cell shroud queries use RA2 `0x47CB50` and YR `0x487950`, independently signature-checked against the original executables. Each builds the cell-center coordinate with native terrain height and delegates to the map shroud query. The targeting trampoline queries terrain and shroud on the game thread rather than substituting an unshrouded constant. References: YRpp `CellClass.h`, `DisplayClass.h`, and the corresponding original executable entries.

`monitor.stopOn` accepts `support-ready` to return the current observation when a local sidebar power is ready. Ordinary monitor deltas also include local support readiness and targeting mode when the game provides them. Monitoring never selects a power or chooses its target.
