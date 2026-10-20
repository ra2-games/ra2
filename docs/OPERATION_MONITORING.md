# Operation monitoring

PostHog receives issue reports only. Normal button operations remain in a bounded in-memory history and are attached to a report when an application issue occurs. Browser entry points live in `src/platform/browser/operationMonitoring.ts` and `src/main.ts`; VM input probes remain independent of the analytics SDK.

## Configuration

Set both values in a root `.env.local` or `.env`, then restart Vite. Production values must be present when building the application.

| Variable             | Value                                                                                     |
| -------------------- | ----------------------------------------------------------------------------------------- |
| `VITE_POSTHOG_TOKEN` | The browser project write token from PostHog project setup; do not use a personal API key |
| `VITE_POSTHOG_HOST`  | The HTTPS ingestion host from the same project's setup snippet                            |

Monitoring stays disabled if either value is missing or the host is not HTTPS. Browser project write tokens are included in frontend bundles; personal API keys must never be configured here.

## Issue reports and local context

| Event         | Data                                                                                                                                                                                                                                        |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ra2vm_issue` | Category (`react`, `startup`, `runtime`, `uncaught`, or `unhandled_rejection`), error name, redacted message/stack, application version/revision, game, phase, execution mode and safe shell title when available, plus `recent_operations` |

There are no standalone button or canvas events. `recent_operations` contains at most 20 fixed-button operations from the previous five minutes, sorted by original input time. Each entry has an action (`button` or `guest_button`), timestamp and schema-approved properties. DOM buttons retain a stable action key, ID or structural fallback key. Confirmed native buttons retain safe control title/ID, class, logical coordinates, canvas dimensions, mouse button, pointer device, game, phase and safe shell title. The history is never persisted and is cleared on session replacement/destruction or monitor shutdown.

`app_version` comes from package.json; Vite embeds the current Git revision as `app_revision` when starting/building. Revision is `unknown` when Git metadata is unavailable. Uncommitted changes are not separately identified. Production reports identify the built frontend, not the original guest executable.

Messages are limited to 512 characters; stacks retain at most 12 frames and 2,048 characters. Runtime status failures currently supply a detail string, so their original JavaScript stack is unavailable. Arbitrary thrown objects are not serialized. Identical sanitized diagnostics for the same game are suppressed for 60 seconds, and at most five issues are accepted per minute. At most five reports wait in memory for SDK initialization. These bounds intentionally omit excess reports during an error storm.

Canvas input is correlated with the VM probe by original message coordinates and mouse-button message. Only the native `button` class is eligible, with a positive control ID or safe `GUI:` title. Dialogs (`#32770`), static labels, sliders, lists, battlefield clicks, and unknown targets do not produce canvas events. A title alone never establishes that a window is a button. Buttons implemented entirely as custom graphics without native button metadata need additional explicit identification before they can be monitored.

The click timestamp is saved before the asynchronous probe and retained in local history. Failed or stale-session probes produce no history entry. Worker requests reject on timeout or destruction. A probe still pending when an issue is reported cannot appear in that report. Startup issues are reported as startup; execution mode is recorded after the current shell is acquired, before its startup runs, so startup failures retain Worker/main-thread identity. Factory failures before a shell exists have no confirmed mode. Late shells from invalidated sessions cannot overwrite this context. Runtime-status issue reporting starts only after successful startup and input installation.

## Privacy and identity

Only issue events and schema-approved fields are uploaded; nested operation properties are filtered again at the upload boundary. No arbitrary guest/DOM text or files are collected. Error text redaction removes recognized URLs, absolute paths (including spaces), resource/data filenames (including Chinese names), emails, quoted values, credential/player-name assignments and long token-like strings. Paths and filenames may consume adjacent diagnostic prose to avoid exposing partial private values. Chrome/V8 and Firefox stack frames are parsed separately from message text, preserving the first Firefox frame and avoiding email redaction of `function@source` syntax. Only application-relative script locations and line/column numbers survive; unknown or private locations become `[source]`. This frame filtering also runs at the upload boundary. Pattern-based redaction cannot recognize every possible sensitive value in free-form errors; avoid placing user data in error messages. PostHog uses anonymous browser and session IDs with session-storage persistence.

Autocapture, page views, session recording, and feature flags are disabled. No canvas pixels are uploaded. Project-side IP enrichment may still add IP-derived location; enable the project's client-IP discard setting if that data is unwanted.

## Verification

See [Testing](TESTING.md) for required checks. `pnpm run test:browser:monitoring` starts its own temporary Vite server, overrides analytics configuration, blocks game-program downloads, and intercepts analytics requests. It checks that normal operations produce no uploaded events, an issue includes local native/DOM button context and redacted diagnostics, duplicate reports are suppressed, and global errors and unhandled rejections are reported. Dialogs, labels, sliders and unknown targets are omitted. It uses the real SDK but no original game resources or live PostHog project. Unit tests cover history bounds/expiry, upload filtering, rate limits and lifecycle cleanup.

For a manual check, click a startup-page button and confirm that no operation event is uploaded. Enter a locally supplied game and click a native menu button. On a subsequent application issue, inspect `ra2vm_issue` diagnostics and `recent_operations`; battlefield and dialog-background clicks should be absent. Asset-free checks do not establish complete coverage of original RA2/YR controls or live receiver delivery. Browser process crashes, closed pages and network failures cannot guarantee report delivery.
