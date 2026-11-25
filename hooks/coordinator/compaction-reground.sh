#!/bin/sh

antigravity_mode=0
if [ "${1-}" = "--antigravity" ]; then
  antigravity_mode=1
fi

finish_silent() {
  if [ "$antigravity_mode" -eq 1 ]; then
    printf '{}\n'
  fi
  exit 0
}

if [ "$antigravity_mode" -eq 1 ]; then
  state_dir=
  if [ -n "${COORDINATION_STATE_DIR-}" ]; then
    [ "${#COORDINATION_STATE_DIR}" -le 256 ] || finish_silent
    case "$COORDINATION_STATE_DIR" in
      *[[:cntrl:]]*) finish_silent ;;
      /*) state_dir=$COORDINATION_STATE_DIR ;;
      *) finish_silent ;;
    esac
  else
    case "${XDG_STATE_HOME-}" in
      /*) state_dir="$XDG_STATE_HOME/my-agent-dojo/agent-coordination" ;;
    esac
    if [ -z "$state_dir" ]; then
      case "${HOME-}" in
        /*) state_dir="$HOME/.local/state/my-agent-dojo/agent-coordination" ;;
        *) finish_silent ;;
      esac
    fi
  fi

  roster_dir="$state_dir/coordinator-roster"
  [ -d "$roster_dir" ] || finish_silent

  if [ -n "${ANTIGRAVITY_CONVERSATION_ID-}" ]; then
    [ "${#ANTIGRAVITY_CONVERSATION_ID}" -le 128 ] || finish_silent
    case "$ANTIGRAVITY_CONVERSATION_ID" in
      *[!A-Za-z0-9_-]*) finish_silent ;;
    esac
    roster_entry="$roster_dir/$ANTIGRAVITY_CONVERSATION_ID"
    if [ ! -f "$roster_entry" ] || [ -L "$roster_entry" ]; then
      finish_silent
    fi
  fi
fi

case $0 in
*/*) script_dir=${0%/*} ;;
*) script_dir=. ;;
esac

CDPATH= cd -- "$script_dir" >/dev/null 2>&1 || finish_silent

bun_executable=$(command -v bun 2>/dev/null) || finish_silent

if [ "$antigravity_mode" -eq 1 ]; then
  reground=$("$bun_executable" --no-env-file ./dist/compaction-reground.mjs --antigravity 2>/dev/null) || finish_silent
else
  reground=$("$bun_executable" --no-env-file ./dist/compaction-reground.mjs 2>/dev/null) || finish_silent
fi

[ -n "$reground" ] || finish_silent

printf '%s\n' "$reground"
