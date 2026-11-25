---
name: xdg
description: XDG Base Directory v0.8 rules for CLI config, data, state, cache, and runtime directories. Use when placing tool files under $XDG_*_HOME or $XDG_RUNTIME_DIR, naming app or suite subdirectories, creating 0700 directories, or resolving XDG env vars and relative paths.
disable-model-invocation: true
---

# XDG base directories

Apply these XDG Base Directory Specification v0.8 rules when choosing, resolving, or auditing local CLI and tool paths.

## Directory roles

| Variable | Default | Stores |
| --- | --- | --- |
| `$XDG_CONFIG_HOME` | `$HOME/.config` | User-edited configuration files. |
| `$XDG_DATA_HOME` | `$HOME/.local/share` | Durable, portable app data worth backing up. |
| `$XDG_STATE_HOME` | `$HOME/.local/state` | Machine-local state that persists across restarts: logs, history, recent files, active views. |
| `$XDG_CACHE_HOME` | `$HOME/.cache` | Non-essential regenerable cache safe to delete at any time. |
| `$XDG_RUNTIME_DIR` | Session-managed, no `$HOME` default | Transient session sockets, pipes, and locks removed at logout; owned by the user with mode `0700`. |

## Path resolution

- Require absolute paths in every `$XDG_*` variable. Treat an unset, empty, or relative value as invalid, ignore it, and fall back to the default.
- When `$XDG_RUNTIME_DIR` is unset or invalid, emit a warning and fall back to a user-owned `0700` replacement directory instead of writing into `$XDG_STATE_HOME` or a shared temporary directory.
- Keep user executables in `$HOME/.local/bin`.

## Directory creation and naming

- Create missing destination directories with mode `0700`. Leave permissions unchanged on any directory that already exists.
- Namespace each tool under a lowercase, non-dotted subdirectory: `<base>/<app>/` for a standalone CLI, or `<base>/<suite>/<component>/` for a multi-tool suite.
- Use plain directory names inside XDG base directories, such as `$XDG_CONFIG_HOME/myapp/`, without a leading dot.

## Sources and platform notes

Load [references/sources.md](references/sources.md) when you need search-path variables (`$XDG_DATA_DIRS`, `$XDG_CONFIG_DIRS`), cross-platform library differences (`platformdirs`, `directories-rs`), or the primary specification citations.
