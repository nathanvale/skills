---
"skills": patch
---

Fixed the coordinator reground note so a coordinator that gets a message mid-reground finishes rereading its rules and unit state before acting on it, and so the super-coordinator folder is told to write its state in STATE.md instead of messaging itself.
