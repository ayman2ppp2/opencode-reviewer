# Reviewer scope

The intended deployment is one shared GitHub Actions reviewer in `ayman2ppp2/opencode-reviewer`, called by selected repositories. The only supported model is `opencode/deepseek-v4.1-flash-free`. There is no paid fallback. Free model availability and GitHub Actions quotas are external limits, not an unlimited-service guarantee.

## Onboarding implemented locally

- `renderCaller` requires a full, lowercase, 40-character commit SHA. It generates a reusable-workflow caller without repository secrets.
- `onboard` defaults to a dry run that returns the workflow without any GitHub API calls.
- Explicit apply creates a separate deterministic branch and a pull request through the GitHub API. It never writes directly to the default branch.
- Identical default-branch workflows are left unchanged. Different workflows are reported as conflicts rather than overwritten.
- Existing onboarding branches are reused only when safe. A branch with unrelated changes or conflicting content is not overwritten or proposed as an onboarding PR.
- The caller grants `contents: read` and `pull-requests: write`. It does not request `issues: write` or inherit secrets.

The caller handles pull request open, synchronize, reopen, and ready-for-review events through `pull_request_target`. Manual dispatch accepts a pull request number. Created issue comments on pull requests are forwarded to the central workflow for command authorization and routing. Inline review-comment events are not yet wired into this caller.

The central workflow must read the original GitHub event payload, authorize commands, and treat pull request contents as untrusted data. The caller does not check out or execute pull request code. The reusable workflow must preserve that boundary.

## Examples

`examples/caller.yml` contains an all-zero SHA placeholder, not an installable release reference. Replace it with a reviewed commit from the central repository before installing. `renderCaller` and onboarding generate the caller from the supplied SHA. Copy `examples/.opencode-reviewer.yml` to a repository root only when its defaults suit that repository.

## Deployment and verification limits

These files describe the local onboarding implementation and deployment contract. They do not assert that model execution, comment publication, command handling, or the central workflow have been verified against a live GitHub repository. No repository has been onboarded and no live review is claimed by this documentation. Other reviewer components require their own tests and a separately authorized live verification before deployment.
