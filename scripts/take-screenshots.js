#!/usr/bin/env node
/**
 * take-screenshots.js — Screenshot tool for AgentPulse UI
 *
 * Two modes:
 *   - Default (dev-test): no masking, for local visual validation during development
 *   - With --mask: redacts sensitive content, for README / public documentation
 *
 * Requires: a running AgentPulse server (npm start) and puppeteer installed.
 *
 * Usage:
 *   node scripts/take-screenshots.js [options]
 *
 * Options:
 *   --view <name>     Capture specific view: sessions, detail, eventlog, agents, settings, all (default: all)
 *   --session <id>    Capture a specific session by ID (default: first available)
 *   --list            List all available sessions and exit
 *   --mask            Enable sensitive content masking (for public screenshots)
 *   --port <number>   Server port (default: 3456)
 *   --width <number>  Viewport width (default: 1400)
 *   --height <number> Viewport height (default: 900)
 *   --open            Open screenshots after capture (Windows only)
 *
 * Examples:
 *   npm run dev-test                          # all views, no masking
 *   npm run dev-test:eventlog                 # event log only, no masking
 *   npm run screenshots                       # all views, masked for README
 *   node scripts/take-screenshots.js --view detail --mask
 *   node scripts/take-screenshots.js --view eventlog --session abc123
 */

const puppeteer = require('puppeteer');
const path = require('path');
const http = require('http');

// ── CLI args ─────────────────────────────────────────────
const args = process.argv.slice(2);
function getArg(name, defaultVal) {
  const idx = args.indexOf('--' + name);
  if (idx === -1) return defaultVal;
  return args[idx + 1] || defaultVal;
}
const hasFlag = (name) => args.includes('--' + name);

const VIEW = getArg('view', 'all');
const MASK = hasFlag('mask');
const PORT = parseInt(getArg('port', '3456'), 10);
const WIDTH = parseInt(getArg('width', '1400'), 10);
const HEIGHT = parseInt(getArg('height', '900'), 10);
const SESSION_ID = getArg('session', '');
const OUT_DIR = path.join(__dirname, '..');
const LIST = hasFlag('list');
const OPEN = hasFlag('open');
const BASE = `http://localhost:${PORT}`;

// File prefix: devtest-* for dev, screenshot-* for masked/public
const PREFIX = MASK ? 'screenshot' : 'devtest';

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Masking ──────────────────────────────────────────────

const FAKE_TITLES = [
  'Implement user authentication',
  'Fix pagination bug in search',
  'Add dark mode support',
  'Refactor API error handling',
  'Update CI/CD pipeline config',
  'Optimize database queries',
  'Add unit tests for validators',
  'Migrate to new logging framework',
];

async function maskSensitiveContent(page) {
  await page.evaluate((fakeTitles) => {
    // 1. Mask ALL session titles
    document.querySelectorAll('.session-title').forEach((el, i) => {
      el.childNodes.forEach(node => {
        if (node.nodeType === 3 && node.textContent.trim()) {
          node.textContent = ' ' + fakeTitles[i % fakeTitles.length];
        }
      });
    });

    // 2. Mask session paths and project identifiers
    document.querySelectorAll('.session-meta span, .info-card .value').forEach(el => {
      const t = el.textContent;
      if (/[A-Z]:[\\/]|\/home\/|\/Users\/|~\//.test(t) || t.includes('AdsApps') || t.includes('campaign')) {
        el.textContent = t
          .replace(/[A-Z]:[\\/][^\s<]*/gi, '~/my-project')
          .replace(/\/home\/\w+\/[^\s<]*/g, '~/my-project')
          .replace(/campaign[a-z]*/gi, 'my-service');
      }
    });

    // 3. Mask project identifiers in info cards
    document.querySelectorAll('.info-card .value.small').forEach(el => {
      el.textContent = 'my-project';
    });

    // 4. Mask ALL event text content
    document.querySelectorAll('.event-text').forEach(el => {
      const t = el.textContent;
      el.textContent = t
        .replace(/campaign[a-z]*/gi, 'my-service')
        .replace(/AdsApps?MT/g, 'MyProject')
        .replace(/\bMT\b/g, 'Backend')
        .replace(/[A-Z]:[\\/][^\s]*/gi, '~/project')
        .replace(/lying|youngim/gi, 'user')
        .replace(/@microsoft\.com/g, '@example.com')
        .replace(/Bing[_ ]?Ads/gi, 'MyCompany')
        .replace(/feishu|飞书/gi, 'messaging')
        .replace(/lark-cli/g, 'notify-cli');
    });

    // 5. Mask workflow timeline content
    document.querySelectorAll('.wf-content').forEach(el => {
      el.textContent = el.textContent
        .replace(/campaign[a-z]*/gi, 'my-service')
        .replace(/AdsApps?MT/g, 'MyProject')
        .replace(/[A-Z]:[\\/][^\s]*/gi, '~/project')
        .replace(/lying|youngim/gi, 'user')
        .replace(/@microsoft\.com/g, '@example.com')
        .replace(/Bing[_ ]?Ads/gi, 'MyCompany');
    });

    // 6. Mask agent descriptions and names
    document.querySelectorAll('.agent-name').forEach(el => {
      el.textContent = el.textContent
        .replace(/campaign[a-z]*/gi, 'service')
        .replace(/AdsApps?MT/g, 'project')
        .replace(/feishu|飞书/gi, 'messaging')
        .replace(/lark-cli/g, 'notify-cli')
        .replace(/[A-Z]:[\\/][^\s]*/gi, '~/project');
    });

    // 7. Mask AI summary content — knowledge cards
    document.querySelectorAll('.knowledge-card').forEach(el => {
      el.querySelectorAll('div, span, p').forEach(inner => {
        if (inner.children.length === 0 || inner.classList.contains('settings-code')) {
          inner.textContent = inner.textContent
            .replace(/campaign[a-z]*/gi, 'my-service')
            .replace(/AdsApps?MT/g, 'MyProject')
            .replace(/[A-Z]:[\\/][^\s]*/gi, '~/project')
            .replace(/lying|youngim/gi, 'user')
            .replace(/@microsoft\.com/g, '@example.com')
            .replace(/Bing[_ ]?Ads/gi, 'MyCompany')
            .replace(/feishu|飞书/gi, 'messaging')
            .replace(/dashboard/gi, 'feature');
        }
      });
    });

    // 8. Mask settings code blocks
    document.querySelectorAll('.settings-code, .settings-body pre, .settings-body code').forEach(el => {
      el.innerHTML = el.innerHTML
        .replace(/campaign[a-z]*/gi, 'my-service')
        .replace(/AdsApps?MT/g, 'MyProject')
        .replace(/[A-Z]:[\\/][^\s<"']*/g, '~/project')
        .replace(/lying|youngim/gi, 'demo-user')
        .replace(/@microsoft\.com/g, '@example.com')
        .replace(/Bing[_ ]?Ads/gi, 'MyCompany')
        .replace(/feishu|飞书/gi, 'messaging')
        .replace(/lark-cli/g, 'notify-cli');
    });

    // 9. Mask CLAUDE.md content
    document.querySelectorAll('#cfg-global-claudemd .settings-code').forEach(el => {
      el.innerHTML = el.innerHTML
        .replace(/campaign[a-z]*/gi, 'my-service')
        .replace(/AdsApps?MT/g, 'MyProject')
        .replace(/Bing[_ ]?Ads/gi, 'MyCompany')
        .replace(/[A-Z]:[\\/][^\s<"']*/g, '~/project');
    });

    // 10. Mask rename input field
    const renameInput = document.querySelector('#rename-input');
    if (renameInput) {
      renameInput.value = 'Feature implementation session';
      renameInput.placeholder = 'Feature implementation session';
    }

    // 11. Mask suggested name / brief name displays
    document.querySelectorAll('[style*="font-weight:600"]').forEach(el => {
      const t = el.textContent;
      if (t.includes('campaign') || t.includes('Campaign') || t.includes('AdsApps') ||
          t.includes('Dashboard') || t.includes('dashboard') || t.includes('feishu') ||
          t.includes('Feishu')) {
        el.textContent = t
          .replace(/campaign[a-z]*/gi, 'service')
          .replace(/AdsApps?MT/g, 'project')
          .replace(/dashboard/gi, 'feature')
          .replace(/feishu|飞书/gi, 'messaging');
      }
    });

    // 12. Mask cron job prompts
    document.querySelectorAll('.agent-card .agent-name, .agent-card .agent-type').forEach(el => {
      el.textContent = el.textContent
        .replace(/campaign[a-z]*/gi, 'my-service')
        .replace(/AdsApps?MT/g, 'MyProject')
        .replace(/feishu|飞书/gi, 'messaging')
        .replace(/lark-cli/g, 'notify-cli')
        .replace(/[A-Z]:[\\/][^\s]*/gi, '~/project')
        .replace(/lying|youngim/gi, 'user');
    });

  }, fakeTitles);
}

// ── Server check ─────────────────────────────────────────

async function checkServer() {
  return new Promise((resolve) => {
    http.get(`${BASE}/api/sessions`, (res) => {
      res.resume();
      resolve(true);
    }).on('error', () => resolve(false));
  });
}

// ── List sessions ───────────────────────────────────────

async function listSessions() {
  return new Promise((resolve, reject) => {
    http.get(`${BASE}/api/sessions`, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve([]); }
      });
    }).on('error', reject);
  });
}

// ── Main ─────────────────────────────────────────────────

async function main() {
  if (!(await checkServer())) {
    console.error(`Error: AgentPulse server not running on port ${PORT}.`);
    console.error('Start it with: npm start');
    process.exit(1);
  }

  if (LIST) {
    const sessions = await listSessions();
    if (sessions.length === 0) {
      console.log('No sessions found.');
    } else {
      console.log(`\n  ${sessions.length} session(s) available:\n`);
      for (const s of sessions) {
        const status = s.isActive ? 'active' : 'idle';
        const name = s.customName || s.briefName || s.sessionDir || '(unnamed)';
        console.log(`  ${s.id}  [${status}]  ${name}`);
      }
      console.log(`\n  Usage: node scripts/take-screenshots.js --session <id> --view detail\n`);
    }
    return;
  }

  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', `--window-size=${WIDTH},${HEIGHT}`],
  });

  const page = await browser.newPage();
  await page.setViewport({ width: WIDTH, height: HEIGHT });

  const viewNames = VIEW === 'all'
    ? ['sessions', 'detail', 'eventlog', 'agents', 'settings']
    : [VIEW];

  const mode = MASK ? 'masked (public)' : 'unmasked (dev)';
  const sessionInfo = SESSION_ID ? ` [session: ${SESSION_ID}]` : '';
  console.log(`\nCapturing ${viewNames.length} view(s) — ${mode}${sessionInfo}\n`);

  // Helper: navigate into a session detail view
  async function enterSessionDetail() {
    if (SESSION_ID) {
      // URL-based navigation for specific session
      await page.goto(`${BASE}/#/session/${SESSION_ID}`, { waitUntil: 'domcontentloaded', timeout: 15000 });
      await delay(4000);
      return true;
    }
    // Click-based navigation for first available session
    await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await delay(4000);
    const card = await page.$('.session-card');
    if (!card) return false;
    await card.click();
    await delay(3000);
    return true;
  }

  const captured = [];
  let inSessionDetail = false;

  for (const name of viewNames) {
    const file = `${PREFIX}-${name}.png`;
    const filePath = path.join(OUT_DIR, file);

    switch (name) {
      case 'sessions': {
        console.log('  Capturing: Sessions List...');
        await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 15000 });
        await delay(6000);
        inSessionDetail = false;
        break;
      }

      case 'detail': {
        console.log('  Capturing: Session Detail (Activity)...');
        if (!inSessionDetail) {
          const ok = await enterSessionDetail();
          if (!ok) { console.error('  No sessions found — skipping detail view'); continue; }
          inSessionDetail = true;
        }
        await page.evaluate(() => {
          setTab('activity');
          setActivityView('timeline');
        });
        await delay(2000);
        break;
      }

      case 'eventlog': {
        console.log('  Capturing: Session Detail (Event Log)...');
        if (!inSessionDetail) {
          const ok = await enterSessionDetail();
          if (!ok) { console.error('  No sessions found — skipping eventlog view'); continue; }
          inSessionDetail = true;
        }
        await page.evaluate(() => {
          setTab('activity');
          setActivityView('table');
        });
        await delay(2000);
        break;
      }

      case 'agents': {
        console.log('  Capturing: Agents Tab...');
        if (!inSessionDetail) {
          const ok = await enterSessionDetail();
          if (!ok) { console.error('  No sessions found — skipping agents view'); continue; }
          inSessionDetail = true;
        }
        await page.evaluate(() => { setTab('agents'); });
        await delay(2000);
        break;
      }

      case 'settings': {
        console.log('  Capturing: Settings & Config...');
        // If we haven't navigated yet, go to base first
        if (!inSessionDetail && viewNames[0] === 'settings') {
          await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 15000 });
          await delay(4000);
        }
        await page.evaluate(() => { switchTopTab('config'); });
        await delay(5000);
        await page.evaluate(() => { toggleSettingsSection('cfg-global-settings'); });
        await delay(2000);
        inSessionDetail = false;
        break;
      }

      default:
        console.error(`  Unknown view: ${name}. Available: sessions, detail, eventlog, agents, settings, all`);
        continue;
    }

    if (MASK) await maskSensitiveContent(page);

    await page.screenshot({ path: filePath, fullPage: false });
    console.log(`  -> ${file}`);
    captured.push(filePath);
  }

  await browser.close();

  console.log(`\nDone! ${captured.length} screenshot(s) saved.\n`);

  if (OPEN && captured.length > 0 && process.platform === 'win32') {
    const { exec } = require('child_process');
    for (const f of captured) exec(`start "" "${f}"`);
  }
}

main().catch((e) => {
  console.error('Error:', e.message);
  process.exit(1);
});
