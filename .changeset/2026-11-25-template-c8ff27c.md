---
"skills": patch
---

Upgraded template 80a63a7 to f5f5ea7 (through c8ff27c) and moved the kernel Pin from a006774 to 5eb8f29. Brings `check:recorded-health-sizes`, the single test-run folder (`scripts/test-run.ts` and the `bunfig.toml` preload), the hosted growth step that fails without a base commit, and the test run's leftover check that ignores Bun's own `bun-node` folder and other users' entries.
