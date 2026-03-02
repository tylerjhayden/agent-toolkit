# claude-usage

Fetches real-time claude.ai session and weekly usage limits using headless Playwright to bypass Cloudflare TLS fingerprinting, then displays progress bars per model tier. Includes a background poller that keeps a cache file fresh for the statusline.

> **macOS only.** Requires macOS Keychain (`security` CLI), BSD `date -j`, and LaunchAgent (`launchd`). Not compatible with Linux.

## What It Does

- **Session usage:** 5-hour rolling window utilization and reset time
- **Weekly usage:** 7-day aggregate across all models, Sonnet, and Opus tiers
- **Human display:** Progress bars with percentage and countdown to reset
- **JSON output:** Raw API response for scripting or inspection
- **Cache mode:** Writes structured JSON to `runtime/claude-usage/cache.json` for statusline
- **Background poller:** LaunchAgent fires every 2 min (session-aware + adaptive), updates cache automatically

## CLI Commands

```bash
# First-time setup — prompts for sessionKey and orgId, stores in Keychain
claude-usage setup

# Check usage (human-readable progress bars)
claude-usage

# Raw JSON output (full API response)
claude-usage --json

# Write cache file (used by poller / statusline)
claude-usage --cache
```

**Output example:**
```
claude.ai usage — 10:42 AM

  Current session (5h)
  [████████████░░░░░░░░░░░░░░░░] 43%  resets in 2h 17m

  All models (7d)
  [████████░░░░░░░░░░░░░░░░░░░░] 28%  resets in 4d 6h

  Sonnet only (7d)
  [█████░░░░░░░░░░░░░░░░░░░░░░░] 19%  resets in 4d 6h
```

## Cache Schema

The poller writes `runtime/claude-usage/cache.json` in one of three states:

**Fresh** — successful fetch, data is current:
```json
{
  "fetched_at": "2026-03-02T18:30:00.000Z",
  "five_hour": { "utilization": 43.2, "resets_at": "2026-03-02T23:30:00Z" },
  "seven_day": { "utilization": 28.1, "resets_at": "2026-03-06T18:00:00Z" },
  "seven_day_sonnet": { "utilization": 19.0, "resets_at": "2026-03-06T18:00:00Z" },
  "error": null,
  "stale": false,
  "last_error": null,
  "last_error_at": null
}
```

**Stale** — transient error, last known-good data preserved:
```json
{
  "fetched_at": "2026-03-02T18:30:00.000Z",
  "five_hour": { "utilization": 43.2, "resets_at": "2026-03-02T23:30:00Z" },
  "seven_day": { "utilization": 28.1, "resets_at": "2026-03-06T18:00:00Z" },
  "seven_day_sonnet": { "utilization": 19.0, "resets_at": "2026-03-06T18:00:00Z" },
  "error": null,
  "stale": true,
  "last_error": "fetch_error",
  "last_error_at": "2026-03-02T18:42:00.000Z"
}
```

**Error** — credential failure, no usable data:
```json
{
  "fetched_at": "2026-03-02T18:42:00.000Z",
  "error": "session_expired",
  "error_detail": "Run: claude-usage setup"
}
```

Key fields for consumers:
- `stale` — if `true`, data is from a previous successful fetch; display with a staleness indicator
- `last_error_at` — timestamp of last failed attempt (used by poller for error backoff)
- `error` — if non-null, credentials need attention; show a warning

## Statusline Example

Minimal snippet for reading `cache.json` in a statusline script:

```bash
CACHE="<path-to-project>/runtime/claude-usage/cache.json"

if [ -f "$CACHE" ]; then
  error=$(jq -r '.error // empty' "$CACHE" 2>/dev/null)
  stale=$(jq -r '.stale // empty' "$CACHE" 2>/dev/null)
  pct=$(jq -r '.five_hour.utilization // empty' "$CACHE" 2>/dev/null)

  if [ -n "$error" ] && [ "$error" != "null" ]; then
    printf "Session: expired"
  elif [ -n "$pct" ]; then
    pct_int=$(printf "%.0f" "$pct")
    prefix=""
    [ "$stale" = "true" ] && prefix="~"
    printf "Session: %s%s%%" "$prefix" "$pct_int"
  fi
fi
```

## Limitations

1. **macOS only.** Depends on macOS Keychain, BSD `date -j`, and `launchd`. No Linux or Windows support.

2. **Unofficial API.** Reads from `claude.ai/api/organizations/<org-id>/usage`, which is undocumented and may change without notice. If the API shape changes, the tool will need updating.

3. **sessionKey expires in ~30 days.** When it does, `claude-usage setup` must be re-run to refresh Keychain credentials.

4. **Cloudflare dependency.** The first cold fetch hits `claude.ai` to acquire Cloudflare clearance. This takes 5-10 seconds. Subsequent fetches within 90 minutes use cached browser state and skip the warm-up (~2-4 seconds).

5. **Org-scoped only.** Fetches usage for the stored `org-id`. Multi-org setups require re-running setup.

## Data Locations

| Operation | Path | Description |
|-----------|------|-------------|
| Reads | macOS Keychain `claude-usage/session-key` | claude.ai `sessionKey` cookie (~30-day validity) |
| Reads | macOS Keychain `claude-usage/org-id` | claude.ai organization UUID |
| Writes | macOS Keychain `claude-usage/session-key` | Stored during `claude-usage setup` |
| Writes | macOS Keychain `claude-usage/org-id` | Stored during `claude-usage setup` |
| Writes | `runtime/claude-usage/browser-state.json` | Playwright storage state (Cloudflare clearance, 90-min TTL) |
| Writes | `runtime/claude-usage/cache.json` | Latest usage snapshot for statusline |
| Reads | `runtime/claude-usage/cache.json` | Read by your statusline script |
| Logs | `logs/claude-usage-poller.log` | Poller operational log (started, OK, ERROR) |
| Logs | `logs/claude-usage-poller-error.log` | stderr from claude-usage in poller mode |

Runtime files (`browser-state.json`, `cache.json`) are never committed to git.

## Background Poller

The poller script exits in <100ms when Claude Code isn't running. When active, it fetches based on utilization:

- **< 80% utilization** → fetch every ~10 min (cache freshness gate)
- **≥ 80% utilization** → fetch every ~2 min (high-urgency mode)
- **Session window expired** → immediate force-fetch regardless of cache age
- **Error state** → 10-min minimum backoff (prevents 429 cascades during transient failures)

### Setup with LaunchAgent

1. Copy the template plist to your LaunchAgents directory:
   ```bash
   cp <path-to-project>/.claude/tools/claude-usage/com.myproject.claude-usage-poller.plist \
      ~/Library/LaunchAgents/
   ```

2. Edit the plist — replace these placeholders:
   - `<your-project-label>` → your reverse-DNS label (e.g., `com.myproject`)
   - `<path-to-project>` → absolute path to your project root (e.g., `~/my-project`)

3. Load the agent:
   ```bash
   launchctl load ~/Library/LaunchAgents/com.myproject.claude-usage-poller.plist

   # Manually trigger a poll
   launchctl start <your-project-label>.claude-usage-poller

   # Watch the log
   tail -f <path-to-project>/logs/claude-usage-poller.log

   # Unload (disable)
   launchctl unload ~/Library/LaunchAgents/com.myproject.claude-usage-poller.plist
   ```

## Error Recovery — Session Expiry (~30-day cycle)

When `sessionKey` expires, the signal chain surfaces it at every level:

1. **Poller error log** (`logs/claude-usage-poller-error.log`):
   ```
   [SESSION EXPIRED] Run: claude-usage setup
   Steps: open https://claude.ai/settings/usage → DevTools → Application
          → Cookies → claude.ai → copy sessionKey value
   ```
2. **Cache file** contains `"error": "session_expired"`
3. **Status bar** shows `| Session: expired`
4. **Fix**: `claude-usage setup` — re-stores fresh sessionKey in Keychain and clears stale browser state

## Architecture Notes

**Cloudflare TLS bypass:** claude.ai's API returns 403 when called directly with `fetch` or `curl` due to Cloudflare's TLS fingerprint detection. The tool uses headless Playwright/Chromium to first hit `claude.ai` (acquiring a clearance cookie), then injects the `sessionKey` cookie and navigates to the usage API.

**Browser state persistence:** After each successful fetch, `context.storageState()` saves all cookies, localStorage, and sessionStorage to `runtime/claude-usage/browser-state.json`. Subsequent fetches within 90 minutes load this state and skip the warm-up page, cutting fetch time from ~8-10s to ~2-4s.

**Atomic cache writes:** `--cache` mode writes to `.cache.json.tmp` then renames atomically, preventing partial reads by the statusline.

**Stale-while-revalidate:** On transient errors (`fetch_error`), the cache preserves the last successful data with `stale: true` and records `last_error_at`. Consumers see slightly stale data instead of nothing. The poller uses `last_error_at` for error-aware backoff to prevent retry storms.

**Credential security:** Credentials are stored via macOS `security` CLI (`add-generic-password`) and retrieved with `find-generic-password -w`. They never touch the filesystem.

**sessionKey lifecycle:** The `sessionKey` cookie is a long-lived session token (~30-day validity). When it expires, the API returns `account_session_invalid` — the tool detects this, writes an error JSON to cache, and prompts to re-run setup.
