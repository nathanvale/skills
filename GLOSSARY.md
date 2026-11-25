# Skills plugin

The `nathanvale/skills` plugin ships agent skills and Claude Code and Antigravity hooks. This glossary names the ideas behind its catalog rules and hooks.

## Language

**Coordinator reground**:
The short note the plugin puts back into a registered coordinator session's context after compaction. It tells the coordinator what to reread and confirm before any gated act. See the README's [Hooks](./README.md#hooks) section.
_Avoid_: Compaction reminder, context restore

**State folder**:
The one folder that holds the coordinators' shared state: their standing orders, each coordinator's own folder, the coordinator roster, and compaction cursors. See the README's [Hooks](./README.md#hooks) section.
_Avoid_: State dir, coordination folder

**Coordinator roster**:
The list, kept in the state folder, of sessions registered as coordinators. Each entry names one session and that coordinator's folder. See the README's [Hooks](./README.md#hooks) section.
_Avoid_: Registry, allowlist

**Compaction cursor**:
The per-conversation JSON file under `<state folder>/compaction-cursors/<conversationId>` that stores the last handled `CHECKPOINT` step index, scanned byte offset, and `prefixSha256` continuity hash for an Antigravity transcript. The hook uses it to fire one coordinator reground per compaction and resets it when a transcript truncates or rewrites. See the README's [Hooks](./README.md#hooks) section.
_Avoid_: Checkpoint cache, transcript offset, scan state

**Typed drift**:
Validation rule `typed-drift`. A skill whose `SKILL.md` sets `disable-model-invocation: true` without an `agents/openai.yaml` that sets `policy.allow_implicit_invocation: false`, leaving Codex able to invoke it implicitly.
_Avoid_: Missing Codex policy

**Auto drift**:
Validation rule `auto-drift`. A skill whose `agents/openai.yaml` sets `policy.allow_implicit_invocation: false` while its `SKILL.md` lacks `disable-model-invocation: true`, leaving Claude Code and Antigravity able to invoke it implicitly.
_Avoid_: Reverse drift

**Stray skill**:
Validation rule `stray-skill`. A `SKILL.md` file under `skills/` that does not sit at `skills/<known-bucket>/<skill>/SKILL.md`.
_Avoid_: Orphan skill, misplaced skill

**Manifest drift**:
Validation rule `manifest-drift`. A mismatch between promoted skills under `skills/` and the `"skills"` array in `plugin.json` or `.claude-plugin/plugin.json`.
_Avoid_: Manifest desync

**Floating skill**:
Rule `floating-skill`. A `SKILL.md` file (or symlink to one) sitting in a user-level agent skills folder (`.claude/skills`, `.agents/skills`, `.codex/skills`, or `.gemini/config/skills`) outside a plugin or repository, excluding tool-owned app folders. See agent-engineering ADR 0003.
_Avoid_: Loose skill, unmanaged skill
