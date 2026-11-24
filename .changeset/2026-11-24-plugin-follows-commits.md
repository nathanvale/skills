---
"skills": minor
---

Removed the fixed version from the Claude Code plugin manifest, so Claude Code now uses the commit as the plugin version and every merged change reaches installs on the next update; a test now fails if either Claude plugin manifest gains a version.

Action: Run `claude plugin marketplace update nathanvale`, then `claude plugin update nathanvale-skills@nathanvale`.
