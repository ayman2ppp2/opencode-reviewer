# Build a free OpenCode reviewer for GitHub repositories

Status: proposed implementation plan. No reviewer code exists yet.

Execution amendment. The user selected OpenCode's own free models and authorized GitHub access through `gh`. The implementation uses the pinned OpenCode V2 CLI rather than the embedded SDK. Its clean-environment CLI and gateway routing were verified directly. Gemini is no longer a setup prerequisite. `opencode/deepseek-v4.1-flash-free` is the only allowed inference model. Free availability is checked before requests. See `verification.md` for execution evidence and remaining limitations.

## 1. Define the outcome and limits

Build one reusable reviewer that participating repositories run through GitHub Actions. Target CodeRabbit-style capabilities through separately verified milestones. Do not claim equivalent review quality or complete product parity.

- [ ] Keep hosting, inference, storage, and required tooling within free offerings.
- [ ] Require no credit card, paid subscription, or temporary promotional credits.
- [ ] Stop on exhausted quotas. Never switch to a paid model or enable billing.
- [ ] Keep a small caller workflow in each participating repository.
- [ ] Keep reviewer implementation, security fixes, and releases in one central project.
- [ ] Support public repositories first. Allow private repositories only after an explicit provider data-sharing acknowledgement.
- [ ] Never merge, approve, push fixes, or execute PR code automatically.

Actions jobs start on events. There is no continuously running server. Included private-repository Actions usage and model quotas remain finite. No implementation can guarantee unlimited free reviews across all repositories.

## 2. Establish the project and execution record

- [ ] Create a new standalone project at `/home/ayman/projects/opencode-reviewer`, after checking the directory again for existing work.
- [ ] Do not publish a repository, install workflows elsewhere, or upload source code during local implementation.
- [ ] Use TypeScript for the orchestration and domain contracts. Use the runtime required by the selected, pinned OpenCode V2 SDK release.
- [ ] Pin dependencies and actions. Avoid downloads from floating branches during review runs.
- [ ] Add `docs/implementation-plan.md`, `docs/security.md`, and a decision log.
- [ ] Record which tests ran, their exact commands, and outstanding blockers after each milestone.

Apply the Sequence work into verifiable units principle. Complete and check each milestone before building dependent behavior. Apply the Prove it works principle. Distinguish fixture success, live authentication, live publication, and actual finding quality.

## 3. Resolve integration prerequisites before promising operation

- [ ] Confirm the published OpenCode V2 SDK version, runtime requirements, license, session API, model selection, cancellation, and output extraction through a minimal local smoke test.
- [ ] Test whether repository configuration, instructions, plugins, MCP, automatic titles, or compaction can trigger unexpected work or inference.
- [ ] Verify that restrictive managed configuration takes effect before any untrusted content is read.
- [ ] Select a Gemini model currently available on the free tier and supported by the pinned OpenCode runtime.
- [ ] Keep the model identifier configurable within a maintained allowlist. Do not silently substitute another model.
- [ ] Require a user-supplied API key for a project without paid billing. Never create or activate a paid account.
- [ ] Test a bounded authenticated request locally and later from a standard GitHub-hosted runner.
- [ ] Record the account's actual quotas and regional eligibility. Do not copy fixed quota assumptions into code.
- [ ] Explain the provider's free-tier data-use terms before transmitting private source.

Gate: without free credentials, continue fixture-based implementation but report live inference as blocked. Listing free pricing does not prove the user's account can call that model. Software cannot reliably infer billing-account status from an API key alone.

## 4. Choose the workflow architecture

Use a central reusable workflow backed by a versioned reviewer runtime. Each repository references an immutable release commit.

The intended event flow is:

1. A trusted caller receives a PR or authorized command event.
2. A preparation job validates the event and retrieves immutable source data.
3. An isolated OpenCode job produces structured proposals without GitHub write credentials.
4. A fresh publisher job validates and posts a bounded review.

- [ ] Trigger PR review for opened, reopened, synchronized, and ready-for-review PRs.
- [ ] Skip draft PRs by default.
- [ ] Offer manual dispatch with a validated PR number.
- [ ] Later add `issue_comment` and review-thread events for authorized commands.
- [ ] Declare explicit job permissions. Do not use `secrets: inherit`.
- [ ] Use per-repository, per-PR concurrency and recheck immutable revisions before publication.
- [ ] Prove reusable-workflow secret passing and caller permissions in a disposable repository.

Use `pull_request_target` only for trusted controller code and source-as-data review. Never check out and execute PR code in that privileged context. Initially require maintainer authorization before spending model quota on fork PRs.

Retain `pull_request` plus `workflow_run` as a fallback if the first architecture cannot enforce its boundaries. That alternative requires strict originating-run validation and more artifact provenance checks. It is not the default.

## 5. Define domain contracts before adding behavior

- [ ] Define `ReviewRequest` with repository identity, PR number, base SHA, head SHA, trigger identity, trusted configuration version, and limits.
- [ ] Define `SourceBundle` with immutable blobs, parsed diff ranges, content hashes, and omitted-file reasons.
- [ ] Define `ReviewPlan` with selected files, related context, requested checks, and explicit coverage gaps.
- [ ] Define `ReviewProposal` with defect claim, consequence, severity, source citations, and an optional suggestion.
- [ ] Define `ValidatedFinding` with verified citations, allowed anchors, a stable fingerprint, and a publication disposition.
- [ ] Define `ReviewState` with schema version, reviewed revisions, completed coverage, finding mappings, dismissals, and processed event IDs.
- [ ] Define `PublishPlan` with bounded create, update, and reply operations tied to the expected head.
- [ ] Define terminal outcomes `complete`, `partial`, `blocked`, `failed`, and `superseded`.

Only the publisher receives write credentials. The engine proposes findings. It cannot choose arbitrary GitHub destinations or execute publishing requests.

## 6. Implement trusted source acquisition

- [ ] Retrieve PR metadata and paginate changed-file results through GitHub APIs.
- [ ] Fetch source at explicit SHAs rather than mutable branch names.
- [ ] Parse added and deleted diff ranges, renames, missing patches, and binary-file indicators.
- [ ] Distinguish merge-base review context from the current target branch and invalidate state when the comparison changes.
- [ ] Fetch selected surrounding functions, imports, and nearby tests within a strict byte budget.
- [ ] Reject path traversal, symlink escape, oversized blobs, malformed paths, and unexpected encodings.
- [ ] Do not run package scripts, Git hooks, submodules, build tools, language servers, or repository tests.
- [ ] Exclude generated files, vendored dependencies, lockfiles, binaries, and common secret-bearing paths by default.
- [ ] Report omissions. Never represent a truncated review as full coverage.

Acceptance: fixtures cover pagination, renames, deletions, truncated patches, huge files, unusual filenames, symlinks, and missing permissions.

## 7. Isolate the OpenCode engine

- [ ] Start OpenCode with a clean home and a trusted working directory, not inside an untrusted checkout.
- [ ] Build the source bundle as data. Do not copy executable project configuration into discovery locations.
- [ ] Prevent loading PR-controlled `opencode.json`, `.opencode`, plugins, skills, instructions, and MCP servers.
- [ ] Deny shell execution, source mutation, arbitrary web access, subagents, and interactive questions.
- [ ] Mount bounded source data read-only. Give the process no Docker socket, host secrets, or GitHub token.
- [ ] Separate provider credentials from model-visible tools through a narrow inference proxy if required by the chosen runtime.
- [ ] Restrict network access to the provider path needed for inference. Do not treat prompts or OpenCode permissions alone as network isolation.
- [ ] Bound inference calls, auxiliary calls, tool rounds, retries, output size, execution time, and context size.
- [ ] Cancel the session on deadline. Verify the engine and proxy processes terminate.
- [ ] Return structured output and execution accounting through a fixed channel.

Gate: do not enable fork reviews or pass provider credentials into the review environment until isolation tests pass. If SDK isolation cannot be demonstrated, keep the feature disabled rather than weakening the boundary.

## 8. Validate findings and publish the first useful review

- [ ] Validate output against a strict schema and reject unknown operation types.
- [ ] Verify paths, blob SHAs, line ranges, and quoted source against the trusted source bundle.
- [ ] Require an actionable defect explanation and a concrete consequence. Avoid style-only comments by default.
- [ ] Keep citation validity separate from semantic correctness. A real line does not prove the claimed bug exists.
- [ ] Use one bounded semantic validation pass when the budget allows. Do not label that pass as proof.
- [ ] Sanitize mentions, links, embedded images, and oversized Markdown.
- [ ] Publish one updatable summary and a limited number of inline comments.
- [ ] Publish a `COMMENT` review, never automatic approval or a merge-blocking verdict.
- [ ] Move findings without valid inline anchors to the summary or discard invalid proposals with a recorded reason.
- [ ] Re-fetch PR state immediately before publishing. Discard results for changed heads or comparison bases.
- [ ] Record partial API failure explicitly and reconcile created objects before retrying.

Acceptance: one seeded defect produces a correctly anchored comment. A clean fixture produces no invented finding. Invalid output, quota exhaustion, and unavailable files never produce a misleading clean-review result.

## 9. Add incremental state and retry-safe publication

- [ ] Store compact, versioned state in the bot-owned summary comment.
- [ ] Accept state only from the configured bot identity and matching repository and PR.
- [ ] Keep state within comment size limits. Reconstruct conservatively after corruption, deletion, or schema changes.
- [ ] Put stable operation markers on comments so retries discover work completed before a crash.
- [ ] Match findings using defect category, symbol context, and normalized source evidence. Do not rely on line numbers or wording alone.
- [ ] Re-review changes since the last completed checkpoint and invalidate dependent context conservatively.
- [ ] Preserve human dismissals. Never assume an omitted finding has been fixed.
- [ ] Mark a finding resolved only after explicit source-based re-evaluation or maintainer action.
- [ ] Advance the checkpoint only for completed coverage after publication reconciliation.
- [ ] Use artifacts only for short-lived transport and optional diagnostics, not as the sole durable state.

Acceptance: repeated delivery does not multiply comments. Crash-after-post recovery, force-pushes, base movement, comment deletion, and simultaneous events preserve honest coverage and avoid stale publication.

## 10. Add suggestions and conversation commands

- [ ] Validate that a suggestion replaces a permitted contiguous range at the reviewed revision.
- [ ] Check that the original text matches and the replacement applies. Do not claim that applicability proves correctness.
- [ ] Do not automatically commit suggestions or run suggested commands.
- [ ] Add exact commands for review, full review, summary refresh, and help.
- [ ] Check the actor's current repository permission before expensive requests or state changes.
- [ ] Retrieve real thread context for replies and bind answers to immutable source.
- [ ] Deduplicate by event ID and comment ID. Ignore bot loops and unsupported commands.
- [ ] Cap replies and calls per event. Report throttling rather than launching unbounded jobs.
- [ ] Add pause and resume through persisted bot state only after trusted workflows can enforce them consistently.

Acceptance: unauthorized comments do not invoke the model. Duplicate commands produce one response. A question in an existing finding thread receives a context-specific reply without starting another review loop.

## 11. Add repository configuration and onboarding

- [ ] Read a schema-validated `.opencode-reviewer.yml` from the trusted default branch.
- [ ] Support include and exclude paths, review language, severity threshold, draft handling, permitted commands, and conservative limits.
- [ ] Permit review guidance as text only. Do not allow configuration to run code or enable tools.
- [ ] Generate a minimal caller workflow pinned to a central project commit.
- [ ] Build an onboarding CLI that inspects and previews changes by default.
- [ ] Require an explicit apply operation for each selected set of repositories.
- [ ] Preserve existing workflows and user edits. Report conflicts rather than overwriting.
- [ ] Make repeat onboarding a no-op when the requested configuration is already installed.
- [ ] Add bulk repository discovery, exclusions, and dry-run reporting.
- [ ] Report secret availability without printing secret values.
- [ ] Distinguish installed, configured, provider-verified, and live-review-verified status.

All repositories means all repositories the user selects and can administer. It does not remove per-repository installation, Actions policy restrictions, or secret-distribution requirements.

## 12. Expand toward CodeRabbit-style capabilities

Implement these only after the secure review path and incremental state pass their tests:

- [ ] File-by-file walkthroughs and release-note summaries.
- [ ] Linked-issue and acceptance-criteria context with access checks.
- [ ] Broader cross-file reasoning within free context and request limits.
- [ ] Explicit test-coverage observations and missing-test suggestions.
- [ ] Optional static-analysis results from isolated, credential-free jobs.
- [ ] Dependency and security findings with traceable evidence.
- [ ] Architecture diagrams generated as text and rendered safely.
- [ ] Maintainer-controlled feedback and finding dismissal rules.
- [ ] A versioned feature matrix with supported, partial, planned, and unsupported states.

Do not include a hosted dashboard, automatic fixes, unlimited inference, guaranteed language coverage, or guaranteed commercial-product accuracy in the initial release.

## 13. Use this proposed module layout

```text
.github/workflows/review.yml
.github/workflows/ci.yml
action.yml
src/domain/
src/config/
src/github/
src/source/
src/engine/
src/validation/
src/state/
src/publish/
src/cli/
tests/unit/
tests/integration/
tests/fixtures/
examples/
docs/
```

Keep modules small and tied to the contracts above. Do not create a framework or database service for this project. Package the runner only after the runtime smoke test settles its requirements. Container support is packaging, not a requirement to buy hosting.

## 14. Verify in ten observable scenarios

Run deterministic tests first. Then use a disposable GitHub repository for the real Actions path.

1. Open a PR with a seeded bug. Verify the workflow, summary, and exact inline anchor.
2. Open a clean PR. Verify zero fabricated findings and an explicit coverage statement.
3. Push a fix. Verify incremental review and justified finding-status updates.
4. Repeat the same event. Verify stable summary and no duplicate inline findings.
5. Push while inference is running. Verify old output is marked superseded and not published as current.
6. Simulate malformed output and provider rate limits. Verify blocked or partial status, bounded retries, and no paid fallback.
7. Submit prompt injection and malicious project configuration. Verify no execution, credential disclosure, or arbitrary outbound request.
8. Open a fork PR. Verify maintainer authorization and separation of inference from publishing authority.
9. Exercise authorized and unauthorized conversation commands. Verify permission checks and loop prevention.
10. Run onboarding twice and retry publication after an injected crash. Verify no overwritten workflows and no duplicated published operations.

Record run URLs, reviewed SHAs, API object IDs, sanitized logs, and actual model-call counts. Inspect GitHub's real state after each test. Fixtures alone do not prove live behavior.

Use provisional budgets of a 15-minute job timeout, six inference calls, ten inline findings, and bounded source bytes per review. These are design limits, not measured performance or verified free-tier capacity. Lower them to fit the selected account. Add deterministic tests that fail when any budget can be bypassed. Measure wall time, memory, requests, and source coverage during live verification before changing defaults.

## 15. Deliver in this order

1. M1. Create contracts, schemas, fixtures, CI, and the local dry-run command.
2. M2. Prove pinned OpenCode integration and free-provider access. Record any credential blocker.
3. M3. Complete source acquisition, engine isolation, and adversarial boundary tests.
4. M4. Deliver manual and automatic summaries plus validated inline findings.
5. M5. Deliver incremental review, deduplication, stale-head protection, and retry recovery.
6. M6. Deliver suggestions and authorized conversations.
7. M7. Deliver idempotent onboarding for selected repositories and release documentation.
8. M8. Expand the tested feature matrix toward CodeRabbit-style parity.

Each milestone depends on the previous milestone's relevant checks. Independent fixture and acquisition work may proceed while free-provider credentials are unavailable. No milestone is declared live-verified without its real run evidence.

## 16. Keep these release gates explicit

- [ ] Review the implementation independently for trust-boundary failures and stale-state behavior.
- [ ] Run type checks, lint, unit tests, integration fixtures, workflow validation, and isolation probes.
- [ ] Verify a real free-provider request and a real GitHub review through Actions.
- [ ] Verify action and runtime pins, artifact bounds, redaction, and credential separation.
- [ ] Document free-tier data-use terms and account setup without enabling billing.
- [ ] Report unsupported cases, quota constraints, and any unverified fork behavior.
- [ ] Ask before publishing the project, installing workflows across repositories, or sharing private source with a model provider.

Plan completion does not mean implementation completion. The live integration requires a chosen GitHub owner, a disposable test repository, and a free-tier provider credential supplied through a secret mechanism.

## Appendix A. Evidence and remaining uncertainty

The plan compares a reusable trusted controller against a direct per-repository action and a two-workflow untrusted-to-privileged pipeline. Independent planning reviews favored a central reusable workflow with deterministic publication. Both reviews inherited the session model. Model diversity was not established.

No runtime prototype or live provider call has been performed. OpenCode isolation, SDK compatibility, account-specific provider access, and fork permissions remain tests to run, not proven facts.

## Appendix B. Alternatives rejected

- Reject a permanently running server because the user has no free, card-free host selected.
- Reject GitHub Models because current GitHub documentation says the service retired on July 30, 2026.
- Reject executing repository code in privileged jobs because source changes can steal secrets.
- Reject a model with direct publishing tools because output validation must precede all writes.
- Reject artifacts as the only persistent state because retention and run visibility complicate recovery.
- Reject paid fallback providers, promotional credits, and automatic billing activation.

## Appendix C. Risks

- Free model offerings and quotas change. Keep integration explicit and fail closed on unavailable models.
- Free-tier provider terms may permit product improvement using submitted content. Require acknowledgement before private-code transmission.
- Prompt injection can produce false findings even when execution is isolated. Do not equate isolation with review accuracy.
- GitHub does not offer a transaction across comment writes. Reconcile operation markers after failures.
- Per-PR concurrency does not serialize all repositories sharing one provider key. Quota errors must stop cleanly. A later central scheduler would require new infrastructure and is out of scope.
- API and SDK documentation does not prove a published package behaves identically. Pin and smoke-test the installed artifact.
- Reviews of very large repositories may be partial. Report coverage rather than hiding omissions.

## Appendix D. Documentation checked during planning

- https://opencode.ai/docs/build/sdk
- https://opencode.ai/docs/cli
- https://opencode.ai/docs/config
- https://opencode.ai/docs/permissions
- https://docs.github.com/en/github-models/use-github-models/prototyping-with-ai-models
- https://docs.github.com/en/billing/concepts/product-billing/github-actions
- https://ai.google.dev/gemini-api/docs/pricing
