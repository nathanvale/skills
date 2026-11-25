---
name: test-runner
description: "Run Bun tests: pass/fail gates, coverage, repair of failures in files you are editing, and triage of broader suite failures. Also proves and benchmarks the runner itself."
role: quality-gate
---

# Test Runner

Agent Runner for Bun test context.

## Status

- Use for Bun pass/fail, coverage, failure repair, triage, and benchmark evidence.
- Use compact mode for routine Bun test gates.
- Use repair mode for hot-context failures in files already being edited.
- Use triage mode for cold-context failures from broader suites or unopened files.
- Use detail lookup when a repair or triage packet lacks enough context.
- Keep lint, format, and type gates on MCP runners.
- Treat Agent Runner as the default Bun test path.

## Owner

- Skill prose: `SKILL.md` in this skill directory.
- Bundled runner CLI and shell preflight: `dist/test-runner.sh` and `dist/test-runner.js`.
- Bundled benchmark harness and fixtures: `dist/test-runner.benchmark.js` and `dist/fixtures/`.
- Runner source, tests, and bundle rebuilds: the maintainer's private source.
- Evidence output: `${XDG_STATE_HOME:-~/.local/state}/test-runner/benchmark-output/`.

## Commands

- Set `SKILL_DIR` to this loaded skill directory. Inspect runner usage with `"$SKILL_DIR/dist/test-runner.sh" --help`.
- Inspect benchmark usage with `bun --no-install "$SKILL_DIR/dist/test-runner.benchmark.js" --help`.
- Prove no-MCP Bun adoption: `bun --no-install "$SKILL_DIR/dist/test-runner.benchmark.js" --no-mcp-baseline --local-runner "$SKILL_DIR/dist/test-runner.sh" --mode fixed-gate --gate-preset bun-no-mcp`.

## Verification

- Verify the published bundle with `"$SKILL_DIR/dist/test-runner.sh" --help` and the fixed-gate benchmark before changing runner guidance.
- Maintain runner source code, typechecks, unit tests, and bundle rebuilds in the maintainer's private source.

## Safety

- Pass test-target args only after the runner separator (`--`).
- Keep generated evidence under the runtime-state output path unless deliberately promoted.
- Keep generated detail under `${XDG_STATE_HOME:-~/.local/state}/test-runner/runner-output/` unless deliberately promoted.
- Keep flags, output schemas, parser states, and exit tables in the CLI help rather than duplicating them here.
- Use script help and fixtures for deterministic behavior.

## Next Safe Action

- Run compact mode for a routine Bun test gate; pass coverage args after `--`.
