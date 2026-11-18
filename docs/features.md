# Reviewer feature status

This project targets CodeRabbit-style review behavior. It does not claim full product parity or equivalent finding quality.

| Capability | Implementation status |
| --- | --- |
| One shared implementation for selected repositories | Reusable workflow and SHA-pinned runtime action |
| Automatic PR review | Same-repository PR events |
| Fork PR review | Maintainer command required; source remains data |
| Free inference | OpenCode DeepSeek V4.1 Flash Free only; no paid fallback |
| PR summaries and file walkthroughs | One updatable summary |
| Inline findings | Exact evidence and changed-line anchor validation |
| Surrounding source context | Full selected changed files and up to five bounded relative imports |
| Suggested fixes | Single-line replacement suggestions only |
| Duplicate prevention | Finding and event markers with interrupted-publication recovery |
| Incremental behavior | Skip completely reviewed unchanged revisions; changed revisions use the bounded whole diff |
| Dependency-aware change-only analysis | Not implemented |
| Conversation commands | Review, full, summary, ask, pause, resume, help |
| Native thread answers | Replies to inline review-thread questions |
| Stale revision protection | Head, base, and open-state checks before writes; reviews bind to commit SHA |
| Private repositories | Base-branch acknowledgement required; included Actions allowances apply |
| Multi-repository onboarding | Explicit, preview-first installation PRs with conflict protection |
| Automatic resolution of old findings | Not implemented; historical findings remain until human resolution |
| Test execution and automatic commits | Deliberately disabled |
| Linked-issue requirement checking | Planned |
| Static-analysis adapters and dependency scanning | Planned |
| Architecture diagrams and hosted dashboard | Not implemented |

## Keep free limits explicit

Free models have external quotas and can be withdrawn. Exhausted or unverified free access blocks the review. It never changes to a paid model. Standard public-repository Actions runners are free. Private repository usage, artifact storage, and GitHub API requests have separate limits.

## Install without overwriting existing work

The onboarding command defaults to a dry run and requires a full lowercase reviewer commit SHA. Apply creates a separate branch and an installation PR. A matching default-branch workflow is unchanged. Conflicting files or unrelated onboarding-branch edits are not overwritten.

The caller grants `contents: read` and `pull-requests: write`. It does not inherit secrets, check out PR code, or request `issues: write`.

`examples/caller.yml` has an all-zero placeholder. Replace it through the onboarding command before installation. See `verification.md` for tests that actually ran and remaining live-verification gaps.
