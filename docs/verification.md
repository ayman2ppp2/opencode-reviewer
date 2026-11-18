# Verify the reviewer

## Evidence recorded during implementation

- `bun run check` passed typechecking and all 86 tests. `python3 -B -m unittest discover -s device` passed all 25 relay tests. actionlint passed.
- `bun run verify:isolation` exercised the actual pinned OpenCode CLI inside the read-only non-root container against a local inference fixture.
- The isolation probe observed UID 1000, no inherited `GH_TOKEN`, a read-only application directory, and no external routing from the engine network.
- A real containerized request reached the explicitly free OpenCode model and returned a free-quota error. No paid fallback occurred.
- `/tmp/opencode/actionlint` validated the workflow files locally.
- Initial GitHub CI passed at https://github.com/ayman2ppp2/opencode-reviewer/actions/runs/44266681827.
- The three-job Actions pipeline completed at https://github.com/ayman2ppp2/opencode-reviewer/actions/runs/44267720629. The bot posted a blocked review, not a successful AI analysis.
- The security-fixed runtime at `71c8d2a3a7b8353f6345ac16dc4f8e6572a7dcb7` completed all three jobs at https://github.com/ayman2ppp2/opencode-reviewer/actions/runs/44269613623. All deployed jobs pin that revision.
- The bot's live summary explicitly reports `Free model quota exhausted; no paid fallback` at https://github.com/ayman2ppp2/opencode-reviewer/pull/1#issuecomment-6973304446. Failed attempts remain retryable and do not advance a successful checkpoint.
- `bun scripts/verify-publisher.ts --publish` posted a clearly labelled deterministic fixture through the actual publisher. Its second identical call returned `duplicate`.
- The real inline anchor and single-line suggestion are visible at https://github.com/ayman2ppp2/opencode-reviewer/pull/1#discussion_r4611151178. This finding was fixture data, not model output.
- The deterministic summary and persisted checkpoint are visible at https://github.com/ayman2ppp2/opencode-reviewer/pull/1#issuecomment-6973473774.
- `bun scripts/verify-publisher.ts --thread --publish` posted a clearly labelled native-thread reply at https://github.com/ayman2ppp2/opencode-reviewer/pull/1#discussion_r4611204728. Its second call returned `duplicate`.
- Independent security verification confirmed changed-file and import-context symlink rejection against immutable Git-tree modes. It also checked parent symlinks, submodules, truncated trees, path traversal, caching, and request bounds.
- A real Cloudflare Quick Tunnel started from `device/start.py --profile laptop` and produced a public URL. Through that URL, `/health` returned 403 without the key and 200 with it. `timeout -s INT` stopped the relay and both child processes.
- The buffered relay path was exercised with the real pinned OpenCode CLI against a local Python relay over HTTP. The gateway reconstructed SSE bytes from the versioned envelope. No provider call was made.

The local inference fixture proves CLI integration and routing. It does not prove review quality or free-provider availability.

Successful real-model analysis remains blocked by free access availability. No paid provider or account credit was used. The quota is an external prerequisite, not a passing implementation test.

## Repeat local verification

```sh
bun install --frozen-lockfile
bun run check
python3 -B -m unittest discover -s device -p 'test_*.py'
bun run reviewer build
bun run verify:isolation
```

To verify the device relay without model calls, see [device relay setup](device-relay.md). No real provider request is needed to test routing, authentication, or response reconstruction.

The pinned Docker build runtime is Bun 1.3.10. The checked-in lockfile is compatible with that version. OpenCode CLI is pinned to 2.3.0. Upgrading the runtime requires repeating the real CLI and isolation probes.

## Repeat live verification

Use a disposable public repository and its standard GitHub-hosted runners. Install the pinned caller workflow. Open a PR containing a known defect. Inspect the preparation, inference, and publication jobs and the actual GitHub comments.

Test a clean PR, a repeated event, a fix commit, a force-push during inference, unauthorized commands, a question in a review thread, and pause/resume. Inspect current GitHub state after each operation. Do not equate a successful job with a correct model finding.

No third-party repository has been onboarded during implementation. Any live test PRs in this project are validation fixtures and must not be merged as application changes.
