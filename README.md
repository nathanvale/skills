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

**Model-invoked**

- **[xdg](./skills/engineering/xdg/SKILL.md)**: XDG Base Directory v0.8 rules for CLI config, data, state, cache, and runtime directories.

### Productivity

None yet.

## Hooks

### Coordinator reground (Claude Code)

After a coordinator session's context is compacted, this `SessionStart` hook puts a short reground note back into that session's context. The note tells the coordinator to reread its standing orders and its unit state in the state folder before any gated act. The hook stays silent for every session that is not on the coordinator roster, and for subagents.

The hook reads one state folder:

- `COORDINATION_STATE_DIR`, when it is set to an absolute path of at most 256 characters with no control characters. A relative, longer, or control-character value makes the hook stay silent.
- Otherwise, `$XDG_STATE_HOME/my-agent-dojo/agent-coordination`, when `XDG_STATE_HOME` is an absolute path.
- Otherwise, `$HOME/.local/state/my-agent-dojo/agent-coordination`.

The roster is the `coordinator-roster` folder inside the state folder. Each roster entry is a file named by a session id. Its first line is the coordinator's folder name in the state folder: lowercase letters, digits, and hyphens, up to 64 characters. Any other first line gets a note without the folder name.

Claude Code passes its own environment to the hook. Set `COORDINATION_STATE_DIR` in the environment that Claude Code starts with, not in a project's `.env` file.

To register a coordinator, run these commands from its own shell. Replace `example-coordinator` with its folder name:

```sh
roster="${COORDINATION_STATE_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/my-agent-dojo/agent-coordination}/coordinator-roster"
mkdir -p "$roster" && printf '%s\n' example-coordinator > "$roster/${CLAUDE_CODE_SESSION_ID:?}"
```

To remove it, run:

```sh
roster="${COORDINATION_STATE_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/my-agent-dojo/agent-coordination}/coordinator-roster"
rm "$roster/${CLAUDE_CODE_SESSION_ID:?}"
```

The hook needs `bun` on `PATH`. Without it, the hook does nothing. The hook looks up `bun` from inside the plugin's own folder, so a `bun` in the session's project folder never runs.

## Adding a skill with a portable kernel CLI

1. Put the skill's `agent-cli-kernel` command and contract in `src/skill-clis/<skill>.ts` and export the command into `src/commands.ts` so the front-door CLI exposes it too.
2. Add the skill spec to `SKILL_CLIS` in `scripts/build-skill-clis.ts` and run `bun run build:skills` to emit `skills/<bucket>/<skill>/dist/cli.mjs`.
3. Add `skills/<bucket>/<skill>/SKILL.md`, register promoted skills in `.claude-plugin/plugin.json` and `plugin.json`, and run `bun run check`.
