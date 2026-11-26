# cv-tailor: left out of the first spec

Each item names the sign that brings it back.

- **Finding roles on job boards.** Out of scope by the maintainer's word. Back when the maintainer asks for search, saved searches or filtering; it needs its own design because a board's contract-type filter can drop silently.
- **Bundle rules beyond today's repository rule.** The spec follows `bun run build:skills` (a zero-dependency `dist/cli.mjs` targeting Bun). Back when the plugin-bundling research lands a general rule (for example a Node target, or no Bun on the user's machine).
- **A page-image command.** The skill calls `pdftoppm` directly for the page-one skim. Back when a run needs the image path in a kernel result, or `pdftoppm` options drift between runs.
- **Byte-identical PDF.** LibreOffice stamps a creation date and producer. Back when a reviewer needs PDF bytes, not PDF text, to match; the route is a post-pass that fixes the metadata, or a pinned LibreOffice with a fixed date.
- **A parser upload or third-party ATS test.** Sends personal data off the machine. Back only with the user's explicit approval per upload.
- **Blind tests run by the CLI.** The CLI prepares inputs (text, piles); subagents stay in the skill's steps. Back when a host offers a subagent call the CLI can make and the four tests need repeat runs without an agent.
- **A results template command** (`results.md` tables, claims trace). Back when two or more runs show the agent drifting from the delivery shape.
- **A suite-wide config variable** (`NATHANVALE_SKILLS_CONFIG_HOME`). Back when a second skill in the suite needs a settings file, if open choice 4 keeps the per-tool variable.
- **Windows support.** Untested; program lookup and the LibreOffice profile URL assume a POSIX path. Back when a user reports a Windows run.
