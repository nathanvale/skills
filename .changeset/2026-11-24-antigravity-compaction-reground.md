---
"skills": minor
---

Added a root hooks.json Antigravity PreInvocation hook (coordinator-compaction-reground) that shares the coordinator roster, state folder, shell wrapper, and reground wording with Claude Code. For rostered Antigravity conversations, it incrementally scans transcriptPath for new DONE CHECKPOINT steps, injects one coordinator reground message per compaction, and tracks progress in <state folder>/compaction-cursors/<conversationId> while keeping non-rostered turns on a shell-only fast path.

Action: Install or update the plugin in Antigravity and register coordinator conversations under <state folder>/coordinator-roster using ANTIGRAVITY_CONVERSATION_ID as shown in the README's Hooks section. The hook needs bun on PATH.
