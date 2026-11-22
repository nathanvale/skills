# Weekly hardening checklists

Read only the section matching your active branch.

## Lint-shape checklist

Before opening a PR that adds or edits an AST lint rule, test and prove every applicable shape:

- **Import & loader forms:** named imports, renamed imports (`as`), default imports, namespace imports (`* as`), sub-namespaces (such as `fs.promises` and `import { promises } from "node:fs"`), destructuring (`const { fn } = mod`, `{ default: mod }`), `require(...)`, and `await import(...)` (including template-literal specifiers).
- **Dynamic property & string folding:** computed keys using string literals, template literals, and immutable `const` identifiers (`const method = "spawn"; Bun[method](...)`); static concatenation (`+`), interpolated templates, `const` string bindings, and `path.posix.normalize` for path rules.
- **Negative controls:** true outer-import shadowing, shadowed `const` arguments, locally defined `require`, and legitimate non-matching calls.
- **Exact assertions:** assert the complete diagnostic (including `Repair:`) rather than a loose substring match.
- **Multi-owner parity & clean history:** update every lint owner copy identically, plant one fault per owner, and record pre-existing hits (`eslint --suppress-rule` or equivalent) in the same commit that enables the rule. If merging `main` introduces new hits that would make a merge commit fail per-commit checks, land the rule on a fresh branch off `origin/main`.
- **Complexity & size discipline:** prefer dispatch tables over long `if` chains so helper functions stay below complexity and file-size thresholds.

## Comment-protection checklist

Scope comment cleanup to non-protected files touched in the 7-day window (or an explicitly approved audit scope). Classify every comment before deleting:

- **Keep:**
  - `Platform:` runtime, OS, or tool constraints (including non-obvious test constraints like Darwin `ARG_MAX` or timer clamping).
  - `Interface:` public behavioral contracts types cannot express (rejection error types, synchronous non-blocking guarantees, at-most-once side effects, non-isolation caveats).
  - `SAFETY:` invariants and linter/tool directives (`eslint-`, `@ts-`, `biome-ignore`, `fallow-ignore`).
  - `Accepted decision` citations, ticket/ruling-date references (`MAG-*`, `CMD-*`, `@deprecated` notes), and unresolved provisional questions for the owner.
- **Delete or replace with code:** comments that restate surrounding code, stale review/probe tags, and commented-out code. When removing an explanatory comment, extract a self-naming helper or named constant that carries the full reason.
- **Planted-fault anchor check:** run patch placement (`place()` / `git apply --check`) across all fault records after deleting comments, and replant any patch whose surrounding context shifted.

## Formal-verification ROI gate

Add or wire a formal model into CI only when **all four** conditions hold:

1. **Real state-space witness:** a bug from the last 7 days (or an unresolved recurring class) involved concurrency, retries, ordering, or a multi-step state machine.
2. **Red proof:** the model reproduces the past bug and fails **red** on the broken design.
3. **Refactor resilience:** the check avoids brittle line-level code pointers that rot on routine refactors overnight.
4. **Bounded upkeep:** CI runtime and maintenance cost stay smaller than the cost of the bug class prevented, and the model's scope limit (e.g. checking a hand-written design model rather than the implementation code directly) is stated plainly.

If any condition fails, reject or close the formal-model candidate, log the verdict, and step down the **ladder** to a deterministic in-process or end-to-end test.

## Scheduled run contract

When invoked on a weekly schedule (such as `/schedule`):

- Default to `--dry-run` (ranked 7-day witness table + ratchet health report, zero PRs) until the repository owner opts into `--ship` (0 to 3 ready PRs).
- On a **quiet week** (zero qualifying active leaks), open 0 PRs and report current suppression count, CI flake rate, and shard balance.
- Write the boundary note, backtest results, and handback table to the run's scratch directory so the human can review asynchronously.
- Stop before merging PRs, touching protected paths, or exceeding configured model budget caps.
