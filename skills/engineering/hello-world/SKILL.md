---
name: hello-world
description: Portable reference skill backed by a bundled agent-cli-kernel CLI that runs with zero node_modules.
disable-model-invocation: true
---

# Hello world

Reference skill proving that a skill in this repository can ship a self-contained `agent-cli-kernel` CLI (`dist/cli.mjs`) that works from any working directory with only `bun`.

## Run the bundled CLI

Resolve `<skill-dir>` as the folder containing this `SKILL.md`, then run:

```sh
bun <skill-dir>/dist/cli.mjs greet World --json
bun <skill-dir>/dist/cli.mjs greet Nathan --loud --json
bun <skill-dir>/dist/cli.mjs --discover --json
```

**Done when:** the command exits `0` with a single Contract 3 JSON envelope on stdout and empty stderr (or exits `3` with `DOMAIN_HELLO_BLANK_NAME` on a blank name).
