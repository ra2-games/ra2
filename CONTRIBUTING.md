# Contributing

Internal development and contributions target `dev`, which is not pushed to GitHub. External contributors should branch from `main` and open PRs against `main`. Read [Architecture](docs/ARCHITECTURE.md) and [Repository rules](AGENTS.md) first.

## Local verification

```bash
pnpm install --frozen-lockfile
pnpm run check
```

Ordinary code contributions require no game files. UI changes additionally need browser UI regressions; ABI, patch, and multiplayer changes require relevant real-game tests. Identify unverified scope when assets are unavailable. See [Testing](docs/TESTING.md) for complete entry points. Do not upload games, screenshots, private resource addresses, model weights, or local caches.

## Commits and review

### Manual GitHub synchronization

Run [Sync main to GitHub](.github/workflows/sync-github.yml) manually on the internal repository. The destination is fixed to `ra2-games/ra2`. The source is always the internal `main` branch, regardless of the branch selected to run the workflow; only destination `main` is pushed. The default push rejects divergent history. Enable `force` only when destination history should be overwritten; destination branch protection still applies.

Configure the internal repository secret `X_GITHUB_TOKEN` with write access to the destination repository, including permission to update workflow files. Source checkout uses the runner's normal repository credentials. This workflow does not push `dev`, other branches, or tags. Runner availability, token permissions, and a successful remote synchronization must be verified on the hosting service.

The push step logs the resolved `force` value. Dispatch inputs are read from the event context with a fallback to the inputs context for compatible runners. A missing or invalid value fails before pushing instead of silently selecting a normal push.

### Contribution review

Keep each change focused on a reviewable problem, describing its trigger, resulting behavior, and actual test results. Bug fixes need regressions; performance changes need same-scene comparisons. Skips, retries, and historical passes do not count as current passes.

Update maintained documentation with interface/command changes. Write comments and maintained documentation in English; Chinese commit descriptions are preferred. Identifiers follow existing module conventions. The default README is English with a linked Chinese version; keep their player instructions consistent.

Public PR asset-free CI uses ephemeral isolated runners. Private game resources are used only for regression after maintainer review and merge into dev/main. Workflow-file existence does not establish remote runner configuration; inspect actual job results.

Confirm that original contributions can be provided under GPL-3.0-or-later. Preserve original copyrights/licenses for third-party changes and add attribution to [Third-party content](docs/THIRD_PARTY.md). Do not invent authorization for others' code.
