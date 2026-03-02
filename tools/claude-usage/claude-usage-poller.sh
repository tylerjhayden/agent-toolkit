#!/bin/bash
# Claude usage background poller — called by launchd every 2 minutes.
# Exits early (< 100ms) if no Claude session is active or cache is fresh enough.
# Only runs full Playwright fetch when needed.
#
# Gate logic:
#   1. Skip entirely if Claude Code is not running
#   2. Skip if cache is fresh relative to current utilization:
#      - utilization < 80%  → skip if cache < 600s old (10-min effective interval)
#      - utilization ≥ 80%  → skip if cache < 120s old  (2-min effective interval)
#   3. Force fetch if session reset is overdue (resets_at in the past)
#
# Error surface:
#   logs/claude-usage-poller.log       — operational log (started, OK, ERROR)
#   logs/claude-usage-poller-error.log — stderr from claude-usage
#   runtime/claude-usage/cache.json    — last known state (or error JSON)

set -euo pipefail

PROJECT_HOME="${PROJECT_HOME:-$HOME/my-project}"
SCRIPT="$PROJECT_HOME/.claude/tools/claude-usage/claude-usage.ts"
LOG="$PROJECT_HOME/logs/claude-usage-poller.log"
BUN="${HOME}/.bun/bin/bun"
CACHE="$PROJECT_HOME/runtime/claude-usage/cache.json"

log() { echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $*" >> "$LOG"; }
# NOTE: Replace 'my-project' and 'com.myproject' with your own project name throughout this file.

# Gate 1: Skip if no active Claude Code session
if ! pgrep -xq "claude" 2>/dev/null; then
  exit 0
fi

# Gate 2: Read cache and check if a fetch is actually needed
FETCH_NEEDED=true
if [ -f "$CACHE" ]; then
  utilization=$(jq -r '.five_hour.utilization // 0' "$CACHE" 2>/dev/null)
  utilization_int=$(printf "%.0f" "$utilization" 2>/dev/null || echo 0)
  fetched_at=$(jq -r '.fetched_at // empty' "$CACHE" 2>/dev/null)

  if [ -n "$fetched_at" ]; then
    fetched_epoch=$(TZ=UTC date -j -f "%Y-%m-%dT%H:%M:%S" "${fetched_at%%.*}" +%s 2>/dev/null || echo 0)
    now_epoch=$(date +%s)
    age_sec=$(( now_epoch - fetched_epoch ))

    # Gate 2a: Session reset detection — if resets_at is in the past, force fetch.
    # Self-correcting: once fetched, new resets_at is ~5h out and won't trigger again.
    resets_at=$(jq -r '.five_hour.resets_at // empty' "$CACHE" 2>/dev/null)
    session_reset=false
    if [ -n "$resets_at" ]; then
      reset_epoch=$(TZ=UTC date -j -f "%Y-%m-%dT%H:%M:%S" "${resets_at%%.*}" +%s 2>/dev/null || echo 0)
      [ "$reset_epoch" -le "$now_epoch" ] && session_reset=true
    fi

    # Gate 2c: Error backoff — if cache is stale (transient error), enforce 10-min minimum
    # Uses last_error_at (fresh on each failure) instead of fetched_at (preserved from last success)
    cache_stale=$(jq -r '.stale // false' "$CACHE" 2>/dev/null)
    if [ "$cache_stale" = "true" ]; then
      last_error_at=$(jq -r '.last_error_at // empty' "$CACHE" 2>/dev/null)
      if [ -n "$last_error_at" ]; then
        error_epoch=$(TZ=UTC date -j -f "%Y-%m-%dT%H:%M:%S" "${last_error_at%%.*}" +%s 2>/dev/null || echo 0)
        error_age=$(( now_epoch - error_epoch ))
        [ "$error_age" -lt 600 ] && FETCH_NEEDED=false
      fi
    fi

    if [ "$session_reset" = "false" ] && [ "$FETCH_NEEDED" = "true" ]; then
      # Gate 2b: Age-based throttle (only when no reset pending and not already gated)
      if [ "$utilization_int" -ge 80 ]; then
        # High usage: only fetch if cache older than 2 minutes
        [ "$age_sec" -lt 120 ] && FETCH_NEEDED=false
      else
        # Normal: only fetch if cache older than 10 minutes
        [ "$age_sec" -lt 600 ] && FETCH_NEEDED=false
      fi
    fi
    # If session_reset=true: FETCH_NEEDED stays true regardless of cache age
  fi
fi

[ "$FETCH_NEEDED" = "false" ] && exit 0

# Gate 3: Run the actual fetch
log "Polling claude.ai usage (${utilization_int:-?}% utilization)..."

if "$BUN" "$SCRIPT" --cache 2>>"$PROJECT_HOME/logs/claude-usage-poller-error.log"; then
  log "OK"
else
  exit_code=$?
  log "ERROR: claude-usage exited $exit_code — check claude-usage-poller-error.log"
fi
