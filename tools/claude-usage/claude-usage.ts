#!/usr/bin/env bun

/**
 * claude-usage
 * Fetch claude.ai session and weekly usage limits headlessly.
 *
 * Credentials stored in macOS Keychain:
 *   service:  claude-usage
 *   account:  session-key   → sessionKey cookie value
 *   account:  org-id        → organization UUID
 *
 * Setup: claude-usage setup
 * Usage: claude-usage [--json] [--cache]
 */

import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { buildHelp, die, outputJson, parse, resolveProjectHome } from '../cli.ts';

// ─── Runtime paths ────────────────────────────────────────────────────────────

const PROJECT_HOME = resolveProjectHome();
const RUNTIME_DIR = join(PROJECT_HOME, 'runtime', 'claude-usage');
const STORAGE_STATE_PATH = join(RUNTIME_DIR, 'browser-state.json');
const CACHE_PATH = join(RUNTIME_DIR, 'cache.json');
const STORAGE_STATE_TTL_MS = 90 * 60 * 1000; // 90 minutes

// ─── Types ────────────────────────────────────────────────────────────────────

interface UsageBucket {
  utilization: number;
  resets_at: string;
}

interface UsageResponse {
  five_hour: UsageBucket | null;
  seven_day: UsageBucket | null;
  seven_day_sonnet: UsageBucket | null;
  seven_day_opus: UsageBucket | null;
  seven_day_oauth_apps: UsageBucket | null;
  seven_day_cowork: UsageBucket | null;
  [key: string]: unknown;
}

// ─── Keychain helpers ─────────────────────────────────────────────────────────

function keychainGet(account: string): string | null {
  try {
    return execFileSync(
      'security',
      ['find-generic-password', '-a', account, '-s', 'claude-usage', '-w'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim();
  } catch {
    return null;
  }
}

function keychainSet(account: string, value: string): void {
  try {
    execFileSync('security', ['delete-generic-password', '-a', account, '-s', 'claude-usage'], {
      stdio: 'ignore',
    });
  } catch {}
  execFileSync('security', [
    'add-generic-password',
    '-a',
    account,
    '-s',
    'claude-usage',
    '-w',
    value,
  ]);
}

// ─── Cache helpers ────────────────────────────────────────────────────────────

function writeCache(data: UsageResponse): void {
  mkdirSync(RUNTIME_DIR, { recursive: true });
  const payload = {
    fetched_at: new Date().toISOString(),
    five_hour: data.five_hour ?? null,
    seven_day: data.seven_day ?? null,
    seven_day_sonnet: data.seven_day_sonnet ?? null,
    error: null,
    stale: false,
    last_error: null,
    last_error_at: null,
  };
  const tmp = `${CACHE_PATH}.tmp`;
  writeFileSync(tmp, JSON.stringify(payload, null, 2));
  renameSync(tmp, CACHE_PATH);
}

function writeCacheError(error: string): void {
  mkdirSync(RUNTIME_DIR, { recursive: true });

  const isTransient = error === 'fetch_error';

  // On transient errors, preserve last known-good cache data
  if (isTransient && existsSync(CACHE_PATH)) {
    try {
      const existing = JSON.parse(readFileSync(CACHE_PATH, 'utf8'));
      // Only preserve if existing cache has actual usage data (not a previous bare error)
      if (existing.five_hour || existing.seven_day) {
        const payload = {
          fetched_at: existing.fetched_at,
          five_hour: existing.five_hour ?? null,
          seven_day: existing.seven_day ?? null,
          seven_day_sonnet: existing.seven_day_sonnet ?? null,
          error: null,
          stale: true,
          last_error: error,
          last_error_at: new Date().toISOString(),
        };
        const tmp = `${CACHE_PATH}.tmp`;
        writeFileSync(tmp, JSON.stringify(payload, null, 2));
        renameSync(tmp, CACHE_PATH);
        return;
      }
    } catch {
      // Existing cache unreadable — fall through to full overwrite
    }
  }

  // Credential errors or no prior good data — full overwrite
  const payload = {
    fetched_at: new Date().toISOString(),
    error,
    error_detail: 'Run: claude-usage setup',
  };
  const tmp = `${CACHE_PATH}.tmp`;
  writeFileSync(tmp, JSON.stringify(payload, null, 2));
  renameSync(tmp, CACHE_PATH);
}

// ─── Fetch usage via headless Chromium ────────────────────────────────────────

async function fetchUsage(orgId: string, sessionKey: string): Promise<UsageResponse> {
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
  });

  // Load storage state if fresh (skips Cloudflare warm-up)
  let storageStateOpts: { storageState?: string } = {};
  if (existsSync(STORAGE_STATE_PATH)) {
    const age = Date.now() - statSync(STORAGE_STATE_PATH).mtimeMs;
    if (age < STORAGE_STATE_TTL_MS) {
      storageStateOpts = { storageState: STORAGE_STATE_PATH };
    }
  }

  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36',
    ...storageStateOpts,
  });

  // Mask navigator.webdriver to reduce Cloudflare detection
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });

  const page = await context.newPage();

  try {
    // Only hit claude.ai warm-up page when storage state is missing or stale
    if (!storageStateOpts.storageState) {
      await page.goto('https://claude.ai', {
        waitUntil: 'domcontentloaded',
        timeout: 30000,
      });
    }

    // Inject sessionKey into the cleared context
    await context.addCookies([
      {
        name: 'sessionKey',
        value: sessionKey,
        domain: '.claude.ai',
        path: '/',
        secure: true,
        httpOnly: true,
        sameSite: 'Lax',
      },
      {
        name: 'lastActiveOrg',
        value: orgId,
        domain: '.claude.ai',
        path: '/',
        secure: true,
        sameSite: 'Lax',
      },
    ]);

    // Navigate directly to usage API
    const response = await page.goto(`https://claude.ai/api/organizations/${orgId}/usage`, {
      waitUntil: 'networkidle',
      timeout: 30000,
    });

    if (!response) throw new Error('No response from usage API');

    const status = response.status();
    const rawText = await page.evaluate(
      () => document.querySelector('pre')?.textContent ?? document.body.innerText,
    );

    if (status !== 200) {
      throw new Error(`HTTP ${status}: ${rawText?.substring(0, 200)}`);
    }

    const data = JSON.parse(rawText ?? '{}') as UsageResponse;

    // Persist storage state for next run (skip warm-up)
    mkdirSync(RUNTIME_DIR, { recursive: true });
    await context.storageState({ path: STORAGE_STATE_PATH });
    chmodSync(STORAGE_STATE_PATH, 0o600); // contains session cookies — owner-only

    return data;
  } finally {
    await browser.close();
  }
}

// ─── Display ──────────────────────────────────────────────────────────────────

function bar(pct: number, width = 28): string {
  const filled = Math.round((pct / 100) * width);
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

function timeUntil(iso: string): string {
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return 'now';
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  if (h >= 24) return `${Math.floor(h / 24)}d ${h % 24}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function displayUsage(data: UsageResponse): void {
  const rows: Array<{ label: string; bucket: UsageBucket }> = [];

  if (data.five_hour) rows.push({ label: 'Current session (5h)', bucket: data.five_hour });
  if (data.seven_day) rows.push({ label: 'All models (7d)', bucket: data.seven_day });
  if (data.seven_day_sonnet)
    rows.push({ label: 'Sonnet only (7d)', bucket: data.seven_day_sonnet });
  if (data.seven_day_opus) rows.push({ label: 'Opus only (7d)', bucket: data.seven_day_opus });

  const now = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
  console.log(`\nclaude.ai usage — ${now}\n`);

  for (const { label, bucket } of rows) {
    const pct = Math.round(bucket.utilization);
    const reset = timeUntil(bucket.resets_at);
    console.log(`  ${label}`);
    console.log(`  [${bar(pct)}] ${pct}%  resets in ${reset}`);
    console.log();
  }
}

// ─── Setup ────────────────────────────────────────────────────────────────────

async function setup(): Promise<void> {
  console.log('\nclaude-usage setup\n');
  console.log('1. Open https://claude.ai/settings/usage in your browser');
  console.log('2. Open DevTools → Network → reload the page');
  console.log('3. Find the request to /api/organizations/.../usage');
  console.log('4. From Application → Cookies → claude.ai, copy:\n');

  const sessionKey = prompt('   sessionKey cookie value: ')?.trim();
  const orgId = prompt('   Organization ID (from the URL path): ')?.trim();

  if (!sessionKey || !orgId) {
    die('Aborted — both values required.');
  }

  keychainSet('session-key', sessionKey);
  keychainSet('org-id', orgId);

  // Clear stale browser state so next run does full warm-up with new session
  if (existsSync(STORAGE_STATE_PATH)) {
    rmSync(STORAGE_STATE_PATH);
    console.log('  Cleared stale browser state.');
  }

  console.log('\n✓ Credentials stored in macOS Keychain under service "claude-usage"');
  console.log('  sessionKey expires in ~30 days — re-run setup to refresh.\n');
}

// ─── Main ─────────────────────────────────────────────────────────────────────

const { values, positionals } = parse({
  options: {
    cache: { type: 'boolean', default: false },
  },
  allowPositionals: true,
});

const VERSION = '1.1.0';

if (values.version) {
  console.log(VERSION);
  process.exit(0);
}

if (values.help) {
  console.log(
    buildHelp({
      name: 'claude-usage',
      version: VERSION,
      description: 'Fetch claude.ai session and weekly usage limits',
      usage: 'claude-usage [--json] [--cache]\n  claude-usage setup\n  claude-usage --help',
      commands: [
        {
          name: '(default)',
          description: 'Display usage progress bars for all active limit buckets',
        },
        {
          name: 'setup',
          description: 'Interactively store sessionKey and orgId in macOS Keychain',
        },
      ],
      options: [
        { flags: '--json', description: 'Print raw API response as JSON (for scripting)' },
        {
          flags: '--cache',
          description:
            'Write usage snapshot to runtime/claude-usage/cache.json (for statusline poller)',
        },
      ],
      examples: [
        { command: 'claude-usage', description: 'Check usage (human-readable)' },
        { command: 'claude-usage --json', description: 'Raw JSON output' },
        { command: 'claude-usage --cache', description: 'Write cache file (used by poller)' },
        {
          command: 'claude-usage setup',
          description: 'First-time setup or refresh expired session',
        },
      ],
      sections: [
        {
          title: 'CREDENTIALS',
          content:
            '  Stored in macOS Keychain under service "claude-usage":\n' +
            '    session-key   claude.ai sessionKey cookie (~30-day validity)\n' +
            '    org-id        claude.ai organization UUID\n\n' +
            "  Run 'claude-usage setup' when credentials are missing or expired.",
        },
        {
          title: 'CACHE FILE',
          content:
            '  Written to: runtime/claude-usage/cache.json\n' +
            '  Read by:    your statusline script\n' +
            '  Updated by: claude-usage-poller LaunchAgent (every ~10 min)',
        },
      ],
    }),
  );
  process.exit(0);
}

if (positionals[0] === 'setup') {
  await setup();
  process.exit(0);
}

const sessionKey = keychainGet('session-key');
const orgId = keychainGet('org-id');

if (!sessionKey || !orgId) {
  if (values.cache) {
    writeCacheError('no_credentials');
  }
  die('No credentials found. Run: claude-usage setup');
}

const cacheMode = values.cache as boolean;

try {
  const data = await fetchUsage(orgId, sessionKey);

  if (cacheMode) {
    writeCache(data);
    console.log(`Cached to ${CACHE_PATH}`);
  } else if (values.json) {
    outputJson(data);
  } else {
    displayUsage(data);
  }
} catch (err: unknown) {
  const msg = err instanceof Error ? err.message : String(err);
  const isExpired = msg.includes('account_session_invalid') || msg.includes('HTTP 403');

  if (cacheMode) {
    writeCacheError(isExpired ? 'session_expired' : 'fetch_error');
    console.error(
      isExpired
        ? '[SESSION EXPIRED] Run: claude-usage setup\n' +
            'Steps: open https://claude.ai/settings/usage → DevTools → Application\n' +
            '       → Cookies → claude.ai → copy sessionKey value'
        : `[FETCH ERROR] ${msg}`,
    );
    process.exit(1);
  } else if (isExpired) {
    die('Session expired. Run: claude-usage setup');
  } else {
    die(msg);
  }
}
