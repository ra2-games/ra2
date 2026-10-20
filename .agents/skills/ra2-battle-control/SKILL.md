---
name: ra2-battle-control
description: Execute and monitor RA2/YR player operations through a ra2ctl channel, including native group orders, camera changes, production and confirmed building placement. Use for controlling a match or carrying out explicit orders.
---

# RA2 battle control

This folder includes the complete CLI, loopback server and client helpers. It can be copied or installed independently of the game repository. Use Node.js and the pnpm version declared in `package.json`; install this folder's dependencies once:

```bash
cd "$RA2_CONTROL_SKILL"
pnpm install --frozen-lockfile
pnpm ra2ctl serve --origin "$RA2_BROWSER_ORIGIN"
```

`RA2_CONTROL_SKILL` is the absolute path to this skill folder; `RA2_BROWSER_ORIGIN` is the exact game-page origin. The default origin is the local development page if `--origin` is omitted. The game page and original game resources are supplied separately. Connect the page to the loopback server using its **Connect AI** control, then use the user's channel. Keep one writer per channel. Strategy chooses objectives; this skill executes and verifies effects.

Run the examples below from this skill folder, or use `pnpm --dir "$RA2_CONTROL_SKILL" ra2ctl ...` from any working directory. The repository's `pnpm ra2ctl` command remains an alias for this same CLI. `pnpm ra2agent --channel NAME` launches an installed Codex/Claude CLI using this skill, optionally adding `ra2-strategy` guidance when that skill is installed alongside it. The launcher does not start the server or download games.

```bash
pnpm ra2ctl --channel 1 observe
pnpm ra2ctl --channel 1 act --params '{"action":"produce","type":"GAPOWR"}'
pnpm ra2ctl --channel 1 batch --params '{"onRejected":"continue","orders":[{"action":"produce","type":"E1"},{"action":"attack-move","units":["VISIBLE_A","VISIBLE_B"],"cell":{"x":80,"y":90}}]}'
pnpm ra2ctl --channel 1 look --params '{"cell":{"x":80,"y":90}}'
pnpm ra2ctl --channel 1 order-group --params '{"action":"attack","units":["VISIBLE_A","VISIBLE_B"],"target":"VISIBLE_TARGET"}'
pnpm ra2ctl --channel 1 monitor --params '{"durationMs":5000,"intervalMs":500,"stopOn":["production-ready","damage","contact"]}'
```

## Recover before changing tasks

Before submitting a batch, choose its failure boundary: independent purchases/defense use explicit `"onRejected":"continue"`; dependent select-power/target-power pairs use the default stopping mode. Do not put urgent independent orders behind fragile IDs in a stopping batch.

Read every result: `completed` is acceptance, not effect. If `remaining` is nonzero, name the unattempted intents in your next decision and reissue those still needed from the current view before optional scouting. Do not replay accepted orders. A successful purchase does not resolve a skipped retreat or defense.

Use `"onRejected":"continue"` for independently chosen purchases, deployments and movement that remain appropriate after another order is rejected. Put fragile targeting/repairs last when using the default stopping batch. Keep dependent support-power pairs and placement follow-ups stopping on failure. A fresh target rejection calls for reacquisition or a revised visible intent, not repeated use of the same stale ID. On uncertainty (`next: inspect`), stop new writes and follow [recovery](references/recovery.md).

A rejected multi-unit order executed for **none** of its members. Continuation runs other orders; it does not remove stale members or retry that group. For an essential defense/retreat, use this recovery sequence before another task:

1. Use the returned current observation, or `observe` immediately if the rejection returned only a receipt. Do not wait for production to finish.
2. Choose the currently visible owned survivors yourself. If A/B/C was rejected and the fresh view contains only A/C, issue the still-needed intent to A/C; do not replay A/B/C or infer B died.
3. If a specific attack target vanished, choose a suitable visible target or a reachable attack-move/retreat cell from that view. Repeatedly chasing the same target ID leaves the defenders without orders.
4. Read the new receipt and briefly observe the effect. A successful independent purchase does not mean the failed defense recovered.

Cancel/sell/repair can also fail when production or buildings disappear. Place essential independent movement before those fragile orders, or explicitly continue independent orders. A deploy toggle followed by movement of the same infantry is not automatically independent.

## Start and observe

Read skills and capabilities during menu preflight when the harness permits it. `wait-ready` waits read-only and returns the first battlefield observation: use it directly. It never starts or replaces a match. With `exec_command`, give this read-only startup wait `yield_time_ms: 10000` rather than returning after one second. If it still returns a process `session_id`, collect it immediately with `write_stdin` before unrelated work; the battle may already be advancing. This host process ID is distinct from the game session label. After a long handoff delay, refresh the view before choosing an order. When authorized to start yourself, use `start`, then `wait-ready`; `start` refuses to replace an active battle. Use `ui.status` when readiness is unclear.

Routine commands bind the current session, refresh frames and manage receipts automatically. Do not copy UUIDs into each call. Compact output omits protocol IDs and redundant coordinates; use it directly, without ad hoc `jq` pipelines that can hide receipts or fail on command-runner output. Use `--raw` only for diagnosis. Preserve the CLI schema across long matches: `--params`, string `unit` or `units`, and `cell`; do not substitute `--json`, `ids` or `actorIds`. After a syntax error, reread the relevant example instead of guessing another parameter name. A changed short `session` label means match replacement: stop and replan. Visible entity IDs remain necessary.

`entities` and `sidebar` may be compact tables: `columns` names each position in every `rows` entry; optional `extra[i]` adds fields for row `i`. Read each row as one object and retain its actual ID. For example, columns `["id","type","health"]` with row `["a","MTNK",200]` means tank `a` has 200 health. Missing fields remain unknown. Small lists can remain object arrays. This is the same complete visible roster, not a delta requiring earlier views.

When an order returns only a receipt, finish the same tool invocation with one read-only `observe` for an immediate decision, or a short `monitor` when deliberately waiting for an event. Prefer `observe` for routine receipt handoff: it returns one full view, whereas even a short monitor can emit an initial full roster and repeat it in the final view. Do not spend a model round trip merely deciding to observe. For example, issue MCV deployment, then observe; inspect both outputs and choose power only after the yard/sidebar appears. Apply the same handoff to production batches and essential movement. Run the read after a rejected write too; do not gate it with shell `&&`. This is one chosen action/batch followed by one read, not a loop, conditional gameplay script or permission to pre-submit dependent purchases. On uncertain writes, use the view for diagnosis and follow recovery before writing again.

`observe` sees only the current camera. `look` moves it and returns a settled view without revealing shroud. Use returned observations directly rather than immediately observing again. `monitor` is read-only and never pans; choose damage/contact/production-ready triggers to return at a decision point, including an already completed product. On normal duration expiry, use the final sampled `observation`, including its sidebar, rather than issuing a redundant `observe`; reconcile its frame with later receipts. Valid `stopOn` values are `production-ready`, `support-ready`, `damage` and `contact`; native end is detected automatically, so do not invent a `match-ended` trigger. During an active raid, include `damage` in short monitor waits; `stopOn: []` deliberately waits through damage. `contact` means non-owned, not proven hostile. Only target currently visible IDs; `leftView` is not death. Existing native missions can continue off-screen.

Use `screenshot` when a decision needs visual terrain, disguise, minimap or native result evidence. Open the returned local `path` with the image-viewing tool; its receipt is not seeing the image. Reuse that image as a baseline when useful; a separate baseline capture is not an opening prerequisite. After a long image/tool delay, refresh the current observation before using old unit IDs or assuming the base is still safe. `--output NEW_PATH` refuses overwrites. Images show the current presented game view without camera movement or hidden identities; host overlays/cursor and GPU-only effects are omitted, and image pixels are not map cells.

## Issue orders with clear failure boundaries

Unit actions accept one `unit` or 1–64 distinct visible owned `units`, including inside a batch. `order-group` adds roster diagnostics before the same single native intent. The game selects the group, verifies exact membership, and invokes one original mouse/hotkey handler. One unavailable member rejects the group; nothing is silently dropped. A `group-rejected` event includes unavailable IDs and the current observation, with no submission. Choose survivors from that view. One group has one receipt, not per-unit completion or a completed prefix. Observe whether its members actually move, fire or deploy.

`attack.target` is a visible object; this is ordinary attack, not force-fire. `repair` and `sell` require one building `unit`. `guard` uses area guard at the current position; an extra `cell` does not relocate it. To defend elsewhere, move, verify arrival, then guard. Immediate move→guard can cancel movement. `deploy` toggles: track deployed GIs rather than deploying the same roster repeatedly. Repair clicks start or stop repair; check the wrench/health instead of spamming clicks.

Prefer batches of 2–8 already-decided immediate orders (maximum 32). Default batches stop at the first failure. `completed` counts accepted orders, `failed` is the zero-based stopping index, and `remaining` counts unattempted later orders. Raw output retains receipts. Never replay a whole partial batch. Camera orders settle before continuing; production submission is not completion, so dependent placement belongs in a later call.

For mutually independent orders, add `"onRejected":"continue"`: a vanished attack target then need not block a separately chosen deployment or purchase. Every later order must remain appropriate if an earlier one fails. `rejected` lists failed indices; accepted orders need not form a prefix. `completed-with-rejections` exits nonzero even though later orders ran. Uncertainty, session changes and other failure states still interrupt. Do not use continuation for dependent power steps or placement follow-ups. Otherwise put fragile targeting/repairs after essential purchases or in a separate call.

For either group or batch interruption, `next: reobserve` means confirmed rejection; reconcile accepted/rejected orders and choose from a fresh view. `next: inspect` means uncertainty: stop new writes and inspect the original receipt in the same session, never infer non-execution from timeout. Read [recovery](references/recovery.md) for repeated rejection, lingering placement state or unresolved outcomes.

## Produce and place

Choose `produce.type` from the current `sidebar`, not a remembered roster: prerequisites can disappear and RA2/YR differ. Native production switches Q/W/E/R tabs (`sidebarTab` 0/1/2/3). Units emerge automatically; only buildings use placement.

Reserve the complete `foundation.width/height` from the sidebar: origin `(x,y)` covers `x..x+width-1`, `y..y+height-1`. Avoid visible units, building footprints and factory exits. Unknown dimensions stay unknown. Footprints do not establish terrain legality, bib clearance or build reach; the original game decides.

When the observed product is complete, choose a few clear plausible sites:

```bash
pnpm ra2ctl --channel 1 place-building --params '{"type":"GAPOWR","cells":[{"x":72,"y":118},{"x":74,"y":120}],"afterOrders":[{"action":"produce","type":"GAPILE"}]}'
```

The helper tries at most 12 supplied sites through native cameo activation, foundation preview and click. Only `building-confirmed` establishes success. Its observation includes the new sidebar: use it without a redundant observe. Failed attempts may include `visibleOverlaps`; these are hints, not exhaustive blockers. `placement-exhausted` includes the latest view. Change layout or clear an observed blocker before retrying; never sweep hundreds of cells. Keep unconfirmed prerequisites marked blocked. There is no terrain/`canBuild` oracle.

Optional `afterOrders` executes your immediate batch only after confirmed placement in the same session. Use it for purchases unlocked by that building. Keep urgent defense/retreat outside this dependency: issue it before placement, because any placement failure skips every follow-up. The helper neither chooses purchases nor waits for future production. The envelope is checked before placement and actions still pass native checks. `placement-followup` reports submitted receipts or an interrupted prefix, with nonzero exit on failure. The building remains placed: do not replay placement or accepted orders. Session/read failure can leave only `building-confirmed`; inspect before writing again. Follow a receipt-only placement follow-up with a short read in the same tool invocation when its fresh state is needed.

Start production, continue combat/scouting while it progresses, then place when ready. Do not use multi-building `build-plan` waits, policy scripts or background bots in agent evaluation.

## Support powers and completion

When capabilities offer `select-power`/`target-power`, use the local `supportPowers` type and readiness. Powers are not production items. A targeted power needs selection then targeting with the same type and a chosen cell; use a default stopping batch containing that pair, separate from unrelated fragile movement orders. Verify cooldown and delivery afterward—selection is not release. American paradrop is validated; do not generalize that to multi-stage powers. `support-ready` is an optional monitor trigger and never chooses a target.

Continue act/monitor cycles until cancellation or native end. Stop on replacement, disconnect or an unresolved failure after applicable recovery. Do not restart as recovery. Preserve native result evidence; a score-page ID or unknown result is not victory. Never bypass player checks or inspect guest memory.
