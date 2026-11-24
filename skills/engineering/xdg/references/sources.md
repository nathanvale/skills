# XDG Base Directory Specification sources and platform notes

Reference backing [`../SKILL.md`](../SKILL.md).

## Primary sources

- **XDG Base Directory Specification v0.8 (freedesktop.org):** <https://specifications.freedesktop.org/basedir/latest/>
  Authoritative definition of `$XDG_CONFIG_HOME`, `$XDG_DATA_HOME`, `$XDG_STATE_HOME`, `$XDG_CACHE_HOME`, `$XDG_RUNTIME_DIR`, `$XDG_DATA_DIRS`, `$XDG_CONFIG_DIRS`, `$HOME/.local/bin`, absolute-path validation, and `0700` directory creation.
- **ArchWiki XDG Base Directory:** <https://wiki.archlinux.org/title/XDG_Base_Directory>
  Practical ecosystem reference for environment defaults, user-level overrides, and migrating legacy `$HOME/.<app>` dotfiles into XDG base directories.
- **Python `platformdirs` (`unix.py`):** <https://platformdirs.readthedocs.io/en/latest/_modules/platformdirs/unix.html>
  Reference Unix implementation demonstrating XDG v0.8 environment resolution, empty and relative path fallback, `user_state_dir`, `user_log_dir`, and `user_runtime_dir` handling.
- **Rust `directories-rs`:** <https://github.com/dirs-dev/directories-rs>
  Cross-platform directory library showing how XDG maps on Linux and BSD compared with native OS conventions on macOS (`~/Library`) and Windows (Known Folders).
- **Dot-prefix anti-pattern (`github/copilot-cli#1750`):** <https://github.com/github/copilot-cli/issues/1750>
  Concrete example showing why placing a dot-prefixed subdirectory inside `$XDG_CONFIG_HOME` violates XDG naming conventions.

## Search paths and resolution rules (v0.8)

- `$XDG_DATA_DIRS` defaults to `/usr/local/share/:/usr/share/`. `$XDG_CONFIG_DIRS` defaults to `/etc/xdg`. Both hold colon-separated absolute paths ordered from highest to lowest precedence.
- Reject any relative path in `$XDG_*_HOME`, `$XDG_RUNTIME_DIR`, or inside a colon-separated `$XDG_*_DIRS` list. Fall back to the spec default when a variable is unset, empty, or relative.
- When writing a file whose destination directory does not exist, create the directory with mode `0700`. When the directory already exists, keep its existing permissions unchanged. Handle creation or write failures cleanly.

## `$XDG_RUNTIME_DIR` constraints

- Owned by the effective user, with Unix mode `0700` and no group or other access.
- Bound to the user's login session: created on login, removed on full logout, and located on a local filesystem that supports Unix domain sockets, named pipes, and file locks.
- Has no `$HOME` fallback in v0.8. When unset or invalid, warn the user and fall back to a replacement directory with mode `0700` owned by the user.

## Cross-platform CLI choice

- Libraries such as `directories-rs` and `platformdirs` default to Apple Standard Directories (`~/Library/Application Support`, `~/Library/Caches`) on macOS and Known Folders on Windows while using XDG on Linux and BSD.
- Developer CLIs that share dotfiles across Linux and macOS often target XDG base directories explicitly on both platforms. Pick one convention per tool and document it clearly rather than mixing `~/Library` and `$XDG_*` paths inside the same tool.

## Subdirectory naming

- Inside an XDG base directory, the base directory already keeps `$HOME` free of clutter. Name the subdirectory `<app>` or `<suite>/<component>` in lowercase without a leading dot.
- Placing `.app` inside `$XDG_CONFIG_HOME` creates redundant hidden paths such as `~/.config/.app/` (see `github/copilot-cli#1750`).
