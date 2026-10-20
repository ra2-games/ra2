---
name: ra2-strategy
description: Plan and adapt RA2/YR economy, scouting, defense and combat from player-visible observations. Use for autonomous match play and tactical decisions; use ra2-battle-control to execute orders.
---

# RA2 strategy

Choose decisions from the current battle and execute through ra2-battle-control. No gameplay scripts, fixed-policy executors, persistent command loops, multi-building build-plan waits, hidden information, or resource/clock changes. Keep one writer and camera; read-only recording is allowed.

## Make the next decision count

Commands arrive late. Keep a short note: **home threat; ready building; income; guard/scout/escort/siege; next objective**. Store useful visible IDs and last-seen cells with frames, not protocol UUIDs. Use the latest returned view and issue the next useful action promptly; elaborate planning while production is ready or buildings are dying spends the response window.

1. **Stop the immediate loss.** Put suitable visible defenders into firing range, or retreat an outmatched force. Reconcile rejected groups and unattempted batch tails before changing tasks. Repairs do not replace firing coverage.
2. **Finish essential production.** Place a ready prerequisite at a few considered clear sites; use confirmed-placement follow-ups for unlocked purchases. Keep urgent defense independent of placement success. Revise rejected sites or clear observed blockers instead of repeating them.
3. **Maintain the next force and objective.** Fund a short useful queue, then scout or advance while it builds. When nothing needs intervention, use a short read-only monitor. Let productive native missions continue offscreen.

Batch independently chosen immediate orders and finish receipt-only writes with a short read in the same tool invocation, as control describes. A batch is not permission to skip prerequisite confirmation. After a long handoff, refresh stale observations before choosing targets.

## Establish protected production before tech

Deploy immediately and confirm the yard. Prioritize power, barracks and refinery, then factory; choose legal sites from the current view and keep exits clear. Start the next affordable prerequisite in confirmed-placement follow-ups. A ready prerequisite takes priority over optional camera trips.

Against America, use the opening defense budget before radar or tech: reinforce starting GIs, build a pillbox covering the exposed refinery/production edge, and establish powered anti-air. Choose their order from visible threats and sidebar availability. A single Patriot under concentrated air attack may need repair and a second emplacement or empty IFV; first verify power and actual firing. Do not rebuild income repeatedly under surviving aircraft without restoring interception.

Keep starting tanks at home while a dog scouts. Check the yard, refinery and factory separately: which exposed side can an attacker fire from, and which defenders can reach that side? Place two supporting GI groups on different exposed sides, verify arrival, then deploy. Keep mobile armor on clear routes between those sides, not all behind one building or at a factory exit. Use an image when cells do not establish this geometry. Before leaving the camera, check ground and powered air coverage at each critical building; nearby unit counts are insufficient. Recheck after new construction or a raid changes the footprint. Guard acts at the current position and can cancel an unfinished move.

Against America, keep two or three additional dogs near exposed production flanks alongside the early GIs. These are home interceptors, separate from the scout. Position them before a raid, with clear routes around buildings; buying them after infantry deploy is late. On a visible landing, move nearby dogs toward the landing side before the paratroopers establish fire. Do not charge dogs across an established deployed-GI firing line; use supporting armor and infantry. Replace lost home dogs when income permits without delaying essential production.

On a visible landing, move nearby armor and undeployed infantry into contact before repairs or optional purchases. If buildings take fire while guards stay idle, correct their position immediately. Inspect the next view for attackers taking damage or disappearing while still in view; do not keep repeating repairs as a substitute. Dogs supplement this firing coverage, not replace it. Handle visible Tanya immediately. Aircraft interception does not guarantee that no paratroopers land.

Once protected income and factory are operating, add sustainable tank production and the economy to fund it. Radar and tech follow this foundation; a raid that removes it changes the next purchase back to defense or recovery. Do not wait indefinitely for an attack to prove coverage, but after observed contact require the immediate threat to be cleared before another scout trip.

## Scout toward a reachable objective

Send a dog along a plausible route from the home view while production runs. Once home has coverage, inspect arrival/contact, choose the next useful waypoint and return directly. Avoid following an idle scout through repeated empty views. With radar, inspect the actual minimap for warnings, then investigate with the camera; remembered contacts are not live data.

By the first assault-force stage, seek an enemy production edge and usable approach. Scout during reinforcement, rather than waiting for completed siege or buying a satellite merely to begin locating the opponent. If a route stalls, inspect terrain and choose another approach or replacement scout. Never copy coordinates from another game.

## Spend on a sustainable force

Queued purchases are commitments. When essential queues stall, suspend optional tech and reserve income for guards, repairs or a miner. Compare cash, queue progress and visible miner movement; low cash alone does not prove broken harvesting. Additional income needs reachable ore and a protected route. If the refinery is confirmed lost and cash cannot finish its replacement, idle miners cannot fund recovery. Inspect cancellable optional production and nonessential sellable buildings; choose native cancellations or sales only when the recovered cash can restore protected income without removing a required prerequisite. Verify proceeds and resume the essential queue. Do not keep waiting for deposits when no delivery building exists.

If a raid reaches production, move suitable defenders into its firing approach before optional tech or another camera trip. After losing a factory or refinery, change its location or protection before rebuilding. Recover yard, income and protected production before extending an attack. A large bank without production is not recovery. Read visible superweapon countdowns as deadlines before they reach zero. If the source is reachable, choose an attack that can arrive in time. Otherwise place new production farther apart within legal build reach, keep mobile forces away from the production cluster, and reserve recovery funds. Do not spend the last income on optional tech immediately before an expected strike. Repeated reconstruction alone cannot win.

Read [Allied air guidance](references/allied-air-assault.md) when choosing air against exposed Prism Tanks, naval bombardment or a blocked land route. Check visible anti-air before committing. Land guards cannot intercept ships; unseen ships are not confirmed destroyed.

## Attack with a surviving screen

Before departure, inspect home after the latest raid and explicitly separate **home armor** from **assault escorts**. Leave a mobile anti-armor reserve within supporting distance of exposed production, plus infantry/air coverage for landings. Pillboxes and scattered GIs do not replace that reserve. Judge coverage by defenders actually reaching and firing on attackers; idle tanks across the base are not protection. Replace missing home roles before adding escorts, and keep production funded. Then assemble armor with siege outside enemy fire. Confirm **escort arrival, surviving strength and a usable firing approach**; separate movement receipts do not prove a formation.

Stage armor, infantry support and siege at the same safe approach, then inspect their actual arrival and surviving strength. A shared destination does not establish a formation. Give tanks reachable lateral positions for a broad firing front before moving fragile siege behind them. Empty IFVs provide air coverage; they do not replace the tank screen against armor. Supporting paradrops must land before they can cover an advance. Attack an exposed structure from stand-off range and inspect firing and target removal before advancing deeper. Do not send both groups through a choke into the base or interrupt units already dealing useful damage.

If escorts vanish or hostile armor reaches siege, withdraw visible siege along the known approach while cover engages. Replace the screen before returning. After a failed assault, change strength, protection, route or target; feeding another isolated pair repeats the loss. Reacquire rejected targets instead of chasing stale IDs.

Once immediate defenders are handled, destroy yard and production that replace losses; divert for a reachable imminent superweapon when needed. After the core falls, search remembered structures and coast in distinct sectors with useful native movement continuing offscreen.

## Visibility and completion

Observe only the current viewport. Absence or `leftView` is not death. A new tree on previously observed unchanged terrain is a suspected Mirage Tank; newly revealed terrain is not evidence. Use screenshots to compare terrain, disguise or minimap warnings, and target only through native visible targeting. No invented force-fire or hidden IDs.

Continue until native end, replacement, disconnect or unresolved control failure after recovery. A score page or high kill count is not victory. Preserve settings, commands, frozen versions and original/1fps recordings for every reserved attempt, including failures. Evaluate consecutive unchanged-version cohorts, disclose tactical intervention, and never restart to hide a result.
