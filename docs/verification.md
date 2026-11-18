# Verify the reviewer

## Evidence recorded during implementation

- `bun run check` passed typechecking and all 80 tests, including symlink exclusion and interrupted-publication regressions.
- `bun run verify:isolation` exercised the actual pinned OpenCode CLI inside the read-only non-root container against a local inference fixture.
- The isolation probe observed UID 1000, no inherited `GH_TOKEN`, a read-only application directory, and no external routing from the engine network.
- A real containerized request reached the explicitly free OpenCode model and returned a free-quota error. No paid fallback occurred.
- `/tmp/opencode/actionlint` validated the workflow files locally.
- Initial GitHub CI passed at https://github.com/ayman2ppp2/opencode-reviewer/actions/runs/44266681827.
- The three-job Actions pipeline completed at https://github.com/ayman2ppp2/opencode-reviewer/actions/runs/44267720629. The bot posted a blocked review, not a successful AI analysis.
- `bun scripts/verify-publisher.ts --publish` posted a clearly labelled deterministic fixture through the actual publisher. Its second identical call returned `duplicate`.
- The real inline anchor and single-line suggestion are visible at https://github.com/ayman2ppp2/opencode-reviewer/pull/1#discussion_r4611151178. This finding was fixture data, not model output.
- The deterministic summary and persisted checkpoint are visible at https://github.com/ayman2ppp2/opencode-reviewer/pull/1#issuecomment-6973473774.
- Independent security verification confirmed changed-file and import-context symlink rejection against immutable Git-tree modes. It also checked parent symlinks, submodules, truncated trees, path traversal, caching, and request bounds.

The local inference fixture proves CLI integration and routing. It does not prove review quality or free-provider availability.

Successful real-model analysis remains blocked by free access availability. No paid provider or account credit was used. The quota is an external prerequisite, not a passing implementation test.

## Repeat local verification

```sh
bun install --frozen-lockfile
bun run check
bun run reviewer build
bun run verify:isolation
```

The pinned Docker build runtime is Bun 1.3.10. The checked-in lockfile is compatible with that version. OpenCode CLI is pinned to 2.3.0. Upgrading the runtime requires repeating the real CLI and isolation probes.

## Repeat live verification

Use a disposable public repository and its standard GitHub-hosted runners. Install the pinned caller workflow. Open a PR containing a known defect. Inspect the preparation, inference, and publication jobs and the actual GitHub comments.

Test a clean PR, a repeated event, a fix commit, a force-push during inference, unauthorized commands, a question in a review thread, and pause/resume. Inspect current GitHub state after each operation. Do not equate a successful job with a correct model finding.

No third-party repository has been onboarded during implementation. Any live test PRs in this project are validation fixtures and must not be merged as application changes.
