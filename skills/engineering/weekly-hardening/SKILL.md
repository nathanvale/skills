---
name: weekly-hardening
description: Weekly 7-day determinism pass turning recent mistakes, CI flakes, suppressions, and loop friction into verified structural gates (0 to 3 PRs, or a dry-run report).
disable-model-invocation: true
---

# Weekly hardening

Turn recurring mistakes from the last 7 days into checks that make them impossible to repeat. Ship 0 to 3 small, verified PRs per run, each targeting an **active leak** proved **red** on a real **witness**.

Load [references/checklists.md](references/checklists.md) when a run enters a branch: lint rules, comment cleanup, formal verification, or scheduled unattended runs.

## Step 0: Lock boundaries

Discover the repository's rules, active traffic, and review route from its own files before mining:

1. Read `AGENTS.md`, `CODING_STANDARDS.md`, PR workflow docs, and any repo-local hardening skill (such as `repo-gardener`) when present.
2. Record **protected paths** (frozen, qualified, or countersigned files), **shared choke-point files** (standards tables, suppression lists, timing maps, lint configs), and **active open PRs** with their changed files (`gh pr list --state open --json number,title,files`).
3. Record the **cross-model review route**, model budget caps, and merge authority (default: hand back ready PRs; the human or authorized coordinator merges).
4. Confirm the main checkout stays untouched; do all edits in dedicated worktrees off `origin/main`.

**Done when:** one short boundary note lists protected paths, open-PR file collisions, shared choke-point files, and the review route.

## Step 1: Mine the 7-day delta

Collect concrete **witnesses** from the last 7 days (`--since="7 days ago"`):

1. **Git history:** bug-fix, revert, and follow-up commits (`git log --since="7 days ago" --oneline`).
2. **PR review threads:** comments on merged and open PRs from the last 7 days that caught real defects or repeated nit classes.
3. **CI and flakes:** failed workflow runs, reruns, timeouts, and test-shard skew from the last 7 days.
4. **Ratchet drift:** new suppressions (lint suppression files, ignore directives, `@ts-expect-error`, skipped tests), new `Single witness` or `Review only` rows, and stale fault patches.
5. **Loop friction:** slow hooks, timing-out scripts, or environment traps hit during the week.

Group findings by root failure class. When a class has only one witness inside the 7-day window, check older history and any `Single witness` list to see if this week's witness is a repeat occurrence. Every candidate requires at least one concrete commit SHA, PR review thread URL, or CI run URL as its **witness**.

**Done when:** every failure class from the last 7 days is listed in a table with its witness links, recurrence count, overlapping open PRs, and candidate **ladder** rung.

## Step 2: Backtest, rank, and cut (0 to 3 units)

Select the highest **ladder** rung that closes each **active leak** with low upkeep:

1. **Architecture / shared helper** — make the wrong call path uncallable.
2. **Types / schemas** — make the invalid state unrepresentable.
3. **Lint rule with an actionable `Repair:` message** — refuse the bad shape statically (load [Lint-shape checklist](references/checklists.md#lint-shape-checklist)).
4. **Parity test, planted fault, or timing ratchet** — prove the invariant goes **red** when mutated.
5. **Formal model** — only for concurrency, retry, or state-machine witnesses that pass all four gates in [Formal-verification ROI gate](references/checklists.md#formal-verification-roi-gate).

Apply four filters before opening any worktree:

- **Active-leak filter:** keep classes that still admit new mistakes today; defer janitorial sweeps of legacy debt already blocked by an existing gate.
- **Boundary filter:** skip protected paths unless a live bug justifies re-qualification; park candidates whose files overlap an active open PR.
- **Backtest filter:** run a fast probe script on top lint or sweep candidates against historical witnesses and current `HEAD`; keep only candidates with high witness recall and low false-positive noise.
- **File-disjoint plan:** keep parallel branches **file-disjoint**; sequence any two units that edit the same shared choke-point file (standards table, suppressions, timings, or lint configs), or limit the batch to 1 unit per choke-point file.

Pick **0 to 3** units (plus an optional 7-day comment cleanup using [Comment-protection checklist](references/checklists.md#comment-protection-checklist) when prose drift appeared). On a **quiet week** (zero qualifying active leaks) or in dry-run mode, stop here and report the ranked table and ratchet health.

**Done when:** 0 to 3 units are selected with their backtest results, target rungs, witnesses, and merge order (or a quiet-week / dry-run report ends the run cleanly).

## Step 3: Build, prove red, and verify per unit

Create one fresh worktree off `origin/main` per unit. For each unit:

1. **Prove red:** add a witness test or planted fault that fails on the unfixed behavior (or passes only when the new guard is removed).
2. **Implement the smallest fix** at the chosen rung, including a concrete `Repair:` message on every new refusal or lint rule. Update any repo-local standards table or glossary through its owner skill (`repo-gardener` when present).
3. **Verify locally and sequentially:** run unit tests, fault replay, lint, typecheck, format, file-size, complexity/dead-code audit, and per-commit checks (`check:commits origin/main` when present). Run heavy verification suites one worktree at a time so host load stays flat.
4. **Self-review before opening:** run a two-axis standards and spec review on the branch diff; fix every P0 and P1 finding, and note P2/P3 follow-ups for the PR body.

**Done when:** every commit on the branch passes locally at its own head, the witness proof went **red** then **green**, and protected paths show an empty diff.

## Step 4: Ship, cross-model review, and hand back

1. **Push cleanly:** keep hooks active (set SSH keepalive when pre-push hooks run long). Bring branches current with a clean merge or a fresh branch off `origin/main` so every commit stays green at its own head. Open each PR ready for review (max 3), stating **Why** (citing 7-day witnesses), **What changed**, **Verification**, and **Parked follow-ups (P2/P3)**.
2. **Run cross-model review:** send each PR to an independent reviewer on a different model family using the budget-approved route from Step 0. Size timeouts to the diff (allow 600s+ for multi-file lint or standards diffs). When merging `main` into an already-reviewed PR, skip re-review on clean merges and review only the hand-resolved files on conflict merges.
3. **Triage findings:** fix P0 and P1 findings; park P2/P3 notes in the PR body and resolve answered Minor threads.
4. **Verify hosted CI directly:** watch required checks from the driver until every required check passes at the exact reviewed head (treat any offline reviewer's CI check as unproved until observed directly).
5. **Hand back:** leave merging to the human or authorized coordinator. For scheduled runs, follow [Scheduled run contract](references/checklists.md#scheduled-run-contract).

**Done when:** every shipped PR is `CLEAN` with green hosted checks at the exact reviewed head, 0 open review threads, 0 P0/P1 findings, and a concise handback table (PR number, head SHA, witness closed, merge order, parked P2s, and deferred candidates for next week).
