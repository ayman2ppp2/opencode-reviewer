# OpenCode reviewer

A reusable GitHub Actions PR reviewer using OpenCode's free DeepSeek V4.1 Flash model. No hosted server, provider API key, credit card, or paid fallback is required.

Free model availability and quotas can change. When free inference is unavailable, the reviewer reports a blocked review rather than using a paid model. OpenCode currently describes this model as a limited-time free offering.

## Run locally

Install Bun, Docker, and GitHub CLI. Authenticate `gh` with access to the target repository.

```sh
bun install --frozen-lockfile
bun run check
bun run reviewer build
bun run reviewer review --repo OWNER/REPOSITORY --pr 123
```

The last command previews the review. Add `--publish` to post it as your authenticated account. Source stays data. The reviewer does not check out or run PR code.

For private source, commit this acknowledgement to the PR's base branch first:

```yaml
# .opencode-reviewer.yml
allowPrivate: true
```

Read the current [OpenCode privacy terms](https://opencode.ai/docs/zen#privacy) before opting in. This model currently has a documented zero-retention policy, but availability and terms can change.

## Install across selected repositories

Use a full reviewer release commit SHA. Preview the generated caller first:

```sh
bun run reviewer onboard --repo OWNER/REPOSITORY --ref "$(git rev-parse HEAD)"
```

Add `--apply` to open an installation PR. Existing conflicting workflows are never overwritten. Repeat for each selected repository. An existing matching installation is a no-op.

The caller invokes `.github/workflows/review.yml` from the shared repository. That workflow uses a separately pinned runtime action. A private shared repository must allow action access from the participating repositories. Configure that access in its Actions settings. No token is embedded in a workflow.

Standard public-repository Actions runners are free. Private repositories consume their included allowance. Without a payment method, GitHub blocks additional compute after that allowance runs out. Keep artifact usage within included storage limits too.

## Request a review

Same-repository PRs run automatically. Drafts are skipped by default. Forks require an authorized maintainer command.

- `/opencode review` requests a review.
- `/opencode full` explicitly requests the full supplied diff.
- `/opencode summary` requests a summary and walkthrough without findings.
- `/opencode ask QUESTION` answers using current source and conversation context.
- `/opencode pause` pauses this PR's reviews.
- `/opencode resume` enables future reviews.
- `/opencode help` shows supported commands.

Only users with current write, maintain, or admin access can run commands. Ordinary comments do not trigger model calls. Answers to inline-thread questions reply in that thread. General PR questions receive a PR comment.

## Understand coverage

The reviewer validates source citations and inline anchors. It cannot prove a model's reasoning is correct. Reviews are advisory `COMMENT` reviews, never approvals or merge decisions.

Review state prevents duplicate findings and recovers after interrupted publication. A completely reviewed, unchanged revision and configuration skip another inference call unless you request a full review. Changed revisions use the bounded whole PR diff. Dependency-aware change-only analysis is not yet implemented. Previously posted findings remain historical unless a human resolves them.

Large files, binary files, missing patches, sensitive paths, and files over configured limits are omitted and reported. It does not run tests or claim that tests passed. Suggestions replace one source line and require human review.

## Route inference through your own device

If the free endpoint rejects GitHub's network, you can send model requests through a Linux laptop or an Android phone. A 429 may also be an account-wide quota, so this is an experiment rather than a guaranteed fix.

```sh
python3 device/start.py --profile laptop --repo OWNER/REPOSITORY --register
```

There is no automatic fallback. A quota error, timeout, or offline device blocks the review and never switches connection. See the [device relay guide](docs/device-relay.md).

See [security boundaries](docs/security.md), [feature status](docs/features.md), and [implementation plan](docs/implementation-plan.md).
