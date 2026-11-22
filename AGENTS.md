# Repository commands

Use the existing repository CLI at `src/cli.ts`. Add commands through `src/commands.ts`.
Keep domain implementation in separate files and preserve one public application CLI.

Check command: `bun run check`
Build portable skill CLIs: `bun run build:skills`
Smoke: `bun run start -- --help`
Source packet: `https://github.com/nathanvale/skills`
Template source: `b8f4264dc50b1b673aa3edd0206f7bd9cb646182`

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
- `productivity/`: daily workflow skills (promoted)
- `in-progress/`: beta skills (not promoted)

Every skill in `engineering/` or `productivity/` must appear in `.claude-plugin/plugin.json`, `plugin.json`, `README.md`, and its bucket `README.md`.

## Portable kernel skill CLIs

Any skill that needs an executable `agent-cli-kernel` CLI keeps its typed TypeScript definition under `src/skill-clis/<skill>.ts` (covered by `kernelLint`, `tsc`, `bun test`, and `fallow`), registers its command on the front-door CLI in `src/commands.ts`, and compiles its zero-dependency portable bundle into `skills/<bucket>/<skill>/dist/cli.mjs` via `bun run build:skills`.

## Comments

Lint refuses a comment in code, so say it in a name, a type or a test title.
A comment that opens with `Platform:` or `Interface:` makes a claim that a reviewer checks. It is not a way to keep a comment.

The lint rule files in `config/` are the template's. Change a lint rule in the template, not here.
