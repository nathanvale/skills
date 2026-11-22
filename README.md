# `nathanvale/skills`

Reusable agent skills built on `bun-typescript-template` and `agent-cli-kernel`.

- **`src/` front-door CLI:** one repo-root `agent-cli-kernel` application CLI (`src/cli.ts`) for listing, validating, and running skill commands.
- **Nested `skills/` buckets:** Matt Pocock-style category folders (`skills/engineering/`, `skills/productivity/`, `skills/in-progress/`) with `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`, and root `plugin.json`.
- **Portable kernel-backed skills:** skills that need deterministic execution keep their TypeScript source under `src/skill-clis/` and ship a zero-`node_modules`, cross-platform `dist/cli.mjs` bundle built with `bun run build:skills`.

## Quick start

```sh
bun install --frozen-lockfile
bun run start -- --help
bun run start -- list
bun run start -- validate
bun run start -- greet World
bun run check
```

## Installation

### Claude Code

```sh
claude plugin marketplace add nathanvale/skills
claude plugin install nathanvale-skills@nathanvale
```

### Codex

```sh
codex plugin marketplace add nathanvale/skills
codex plugin add nathanvale-skills@nathanvale
```

### Any other agent (`skills.sh`)

```sh
npx skills@latest add nathanvale/skills
```

## Skills

### Engineering

**User-invoked**

- **[hello-world](./skills/engineering/hello-world/SKILL.md)**: Portable reference skill backed by a bundled `agent-cli-kernel` CLI (`dist/cli.mjs`) that runs with zero `node_modules`.
- **[weekly-hardening](./skills/engineering/weekly-hardening/SKILL.md)**: Weekly 7-day determinism pass turning recent mistakes, CI flakes, suppressions, and loop friction into verified structural gates.

### Productivity

None yet.

## Adding a skill with a portable kernel CLI

1. Put the skill's `agent-cli-kernel` command and contract in `src/skill-clis/<skill>.ts` and export the command into `src/commands.ts` so the front-door CLI exposes it too.
2. Add the skill spec to `SKILL_CLIS` in `scripts/build-skill-clis.ts` and run `bun run build:skills` to emit `skills/<bucket>/<skill>/dist/cli.mjs`.
3. Add `skills/<bucket>/<skill>/SKILL.md`, register promoted skills in `.claude-plugin/plugin.json` and `plugin.json`, and run `bun run check`.
