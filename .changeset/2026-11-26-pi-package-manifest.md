---
"skills": patch
---

Add a `pi` package manifest to `package.json` listing promoted skills, validate `package.json` `pi.skills` in `skills validate` (`missing-manifest` when absent, `invalid-manifest` on mismatch), and refuse non-boolean-true `disable-model-invocation` values as `typed-drift`.
