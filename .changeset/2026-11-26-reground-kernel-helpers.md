---
"skills": patch
---

Switch the compaction-reground hook to use the kernel's `xdgBaseFolder` and `readRootedFile` helpers (refusing linked folders, symbolic links, hard links, non-regular files, and over-limit reads on roster entries and cursor files) and bundle it as a zero-dependency module at `hooks/coordinator/dist/compaction-reground.mjs`.
