# Review untrusted source without executing it

The preparation job uses read permissions and the GitHub API to collect source at exact commit SHAs. It never checks out the PR or runs its build scripts. Configuration comes from the base commit, not the PR head.

Before retrieving changed files or related imports, it checks immutable Git-tree modes. Symlinks, submodules, and symlink directories are rejected even when the Contents API would dereference a link and report its target as a regular file. Tree inspection is bounded and fails closed.

The inference job has no GitHub write permissions. It runs OpenCode in a non-root, read-only Docker container with a clean home, denied tools, no inherited credentials, no host sockets, and a read-only prompt attachment. Project configuration and instructions are supplied only as data, never as executable files. Shell, edits, web tools, MCP tools, and subagents are denied.

The engine container uses an internal Docker network. Only a narrow gateway container has external network access. The gateway accepts one inference endpoint, the explicitly free model ID, and at most two requests per run. It verifies published zero input and output prices before each request. It strips authorization credentials and never follows redirects. The engine receives no provider API key.

Docker internal networking blocks external routing but is not a separate virtual machine. The trusted OpenCode executable and its dependencies remain in the trusted computing base. Keep those dependencies patched. Do not add arbitrary shell tools or source execution to this environment.

The publisher runs in a fresh job. It revalidates model findings against the preparation bundle, verifies current PR head and base revisions, and publishes only bounded GitHub comments. It never executes model text. It sanitizes embedded images and mentions. PR comments cannot change model selection or invoke arbitrary commands.

GitHub cannot atomically compare the PR revision and publish a comment. A small revision race remains after the final check. Inline review creation binds the result to the reviewed commit. A newer run supersedes prior work.

Bot-authored markers support retry recovery. They are not cryptographic proof. Repository administrators and anyone who can modify trusted workflow code remain trusted.

Fork reviews require a maintainer command. The `pull_request_target` controller never executes fork code. Do not add PR checkout, dependency installation, or repository-provided OpenCode configuration to privileged jobs.

Prompt injection can still persuade a model to produce incorrect findings. Isolation limits authority, not reasoning errors. Human review remains necessary.

No paid credentials are forwarded to the engine or gateway. The runtime pins all reviewer and auxiliary sessions to the explicitly free model. If free pricing cannot be verified, inference stops. This is not a promise that a provider's free offering lasts forever.
