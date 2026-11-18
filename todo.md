# Implementation checklist

- [x] Read the plan and verify the requested free model identifier in documentation.
- [x] M1. Define contracts, fixtures, and local verification. All 80 tests pass.
- [ ] M2. Successful real free-model inference is blocked by upstream free availability. Actual CLI and isolated routing pass against a local fixture. Real local requests return HTTP 429. No paid fallback.
- [x] M3. Implement source acquisition and read-only engine isolation, including immutable Git-tree symlink guards.
- [x] M4. Implement workflow orchestration and deterministic publishing. Real Actions jobs and deterministic inline publication pass.
- [x] M5. Implement deduplication, state, and stale-head rejection. Dependency-aware change-only analysis remains outside this release.
- [x] M6. Implement single-line suggestions and authorized conversation commands. Offline permission and thread-destination tests pass.
- [x] M7. Implement preview-first repository onboarding and documentation. No unrelated repositories installed.
- [x] Run independent security review and resolve accepted findings. Retry, question-mode suppression, and symlink findings have regression tests.
- [x] Update deployed runtime pins to security-fixed revision `71c8d2a3a7b8353f6345ac16dc4f8e6572a7dcb7`. All jobs passed in Actions run `44269613623`; the bot correctly reports exhausted free quota.

M8 remains an expansion roadmap. Do not claim commercial product parity.
