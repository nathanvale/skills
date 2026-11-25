# Repository commands

Use the existing repository CLI at `src/cli.ts`. Add commands through `src/commands.ts`.
Keep domain implementation in separate files and preserve one public application CLI.

Check command: `bun run check`
Build portable skill CLIs: `bun run build:skills`
Smoke: `bun run start -- --help`
Source packet: `https://github.com/nathanvale/skills`
Template source: `80a63a7b244d3fd87c5b63dea45cdda6d0f5de0c`

## Kernel skills (authoring, debugging, observability, and CLI proof)

`agent-cli-kernel` ships two full skills inside `node_modules/agent-cli-kernel/skills/`, pointed to from `.agents/skills/` (verified by `tests/pointer-skills.test.ts`):

- **Authoring commands & stations:** read [`.agents/skills/agent-cli-kernel/SKILL.md`](.agents/skills/agent-cli-kernel/SKILL.md) -> `node_modules/agent-cli-kernel/skills/agent-cli-kernel/SKILL.md` before changing `src/cli.ts`, `src/commands.ts`, or `src/skill-clis/*.ts`.
- **Debugging, diagnosing, observability, and end-to-end CLI proof:** read [`.agents/skills/verify-cli/SKILL.md`](.agents/skills/verify-cli/SKILL.md) -> `node_modules/agent-cli-kernel/skills/verify-cli/SKILL.md` before claiming any CLI change works or when troubleshooting a failing run. Run the external verifier against both the front-door CLI and any portable skill bundle:
  - `bun node_modules/agent-cli-kernel/skills/verify-cli/verify.ts ready src/cli.ts`
  - `bun node_modules/agent-cli-kernel/skills/verify-cli/verify.ts sweep src/cli.ts`
  - `bun node_modules/agent-cli-kernel/skills/verify-cli/verify.ts ready skills/engineering/hello-world/dist/cli.mjs`
  - `bun node_modules/agent-cli-kernel/skills/verify-cli/verify.ts sweep skills/engineering/hello-world/dist/cli.mjs`

## Skills layout

Skills live in bucket folders under `skills/`:

- `engineering/`: daily engineering and repository hardening skills (promoted)
- `experimental/`: skills that load but are not yet stable
- `productivity/`: daily workflow skills (promoted)
- `in-progress/`: beta skills (not promoted)

Every skill in `engineering/`, `experimental/`, or `productivity/` must appear in `.claude-plugin/plugin.json`, `plugin.json`, `README.md`, and its bucket `README.md`.

Skill-home placement and typed-only markers follow `agent-engineering` ADR 0003 (`docs/adr/0003-where-a-skill-lives.md`).

## Portable kernel skill CLIs

Skills that ship an executable `agent-cli-kernel` CLI follow one of two layouts, both covered by `kernelLint`, `tsc`, `bun test`, `fallow`, and `bun run build:skills` (outputting a zero-dependency bundle to `skills/<bucket>/<skill>/dist/cli.mjs`):

- **Single-file stateless skill CLI:** keeps its contract in `src/skill-clis/<skill>.ts`, registers on the stateless front-door CLI in `src/commands.ts`, and builds with `kind: "contract"` (the default) in `scripts/build-skill-clis.ts`.
- **Multi-module or stateful standalone skill CLI (uses `state` or `programs` add-ons):** keeps its modules under `src/<skill>/` (placing pure domain rules in `src/<skill>/<area>/rules.ts`), exports a `{ contract, setup }` runtime factory from `src/<skill>/cli.ts` listed in `.fallowrc.json` `"entry"`, builds with `kind: "runtime-factory"` in `scripts/build-skill-clis.ts`, and stays off the stateless front-door `src/commands.ts`. Verify standalone bundles directly with `verify-cli` (`ready`, `sweep`, and `drive`).

## Comments

Lint refuses a comment in code, so say it in a name, a type or a test title.
A comment that opens with `Platform:` or `Interface:` makes a claim that a reviewer checks. It is not a way to keep a comment.

The lint rule files in `config/` are the template's. Change a lint rule in the template, not here.
