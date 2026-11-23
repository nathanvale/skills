# Skills plugin

The `nathanvale/skills` plugin ships agent skills and Claude Code hooks. This glossary names the ideas behind its hooks.

## Language

**Coordinator reground**:
The short note the plugin puts back into a registered coordinator session's context after compaction. It tells the coordinator what to reread and confirm before any gated act. See the README's [Hooks](./README.md#hooks) section.
_Avoid_: Compaction reminder, context restore

**State folder**:
The one folder that holds the coordinators' shared state: their standing orders, each coordinator's own folder, and the coordinator roster. See the README's [Hooks](./README.md#hooks) section.
_Avoid_: State dir, coordination folder

**Coordinator roster**:
The list, kept in the state folder, of sessions registered as coordinators. Each entry names one session and that coordinator's folder. See the README's [Hooks](./README.md#hooks) section.
_Avoid_: Registry, allowlist
