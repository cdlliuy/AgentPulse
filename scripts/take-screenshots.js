#!/usr/bin/env node
// Capture screenshots with aggressive masking of all confidential content
const puppeteer = require('puppeteer');
const path = require('path');

const WIDTH = 1400;
const HEIGHT = 900;

// Generic session titles to replace real ones
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

// Masking function injected into the page to redact ALL sensitive content
async function maskSensitiveContent(page) {
  await page.evaluate((fakeTitles) => {
    // 1. Mask ALL session titles — replace every title with a generic one
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

    // 4. Mask ALL event text content — replace everything to hide what user is working on
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
      const t = el.textContent;
      el.textContent = t
        .replace(/campaign[a-z]*/gi, 'my-service')
        .replace(/AdsApps?MT/g, 'MyProject')
        .replace(/[A-Z]:[\\/][^\s]*/gi, '~/project')
        .replace(/lying|youngim/gi, 'user')
        .replace(/@microsoft\.com/g, '@example.com')
        .replace(/Bing[_ ]?Ads/gi, 'MyCompany');
    });

    // 6. Mask agent descriptions and names
    document.querySelectorAll('.agent-name').forEach(el => {
      const t = el.textContent;
      el.textContent = t
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

    // 8. Mask settings code blocks — file paths, env vars, DB names
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

    // 12. Mask cron job prompts in the Cron tab
    document.querySelectorAll('.agent-card .agent-name, .agent-card .agent-type').forEach(el => {
      el.textContent = el.textContent
        .replace(/campaign[a-z]*/gi, 'my-service')
        .replace(/AdsApps?MT/g, 'MyProject')
        .replace(/feishu|飞书/gi, 'messaging')
        .replace(/lark-cli/g, 'notify-cli')
        .replace(/[A-Z]:[\\/][^\s]*/gi, '~/project')
        .replace(/lying|youngim/gi, 'user');
    });

  }, FAKE_TITLES);
}

(async () => {
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', `--window-size=${WIDTH},${HEIGHT}`]
  });

  const page = await browser.newPage();
  await page.setViewport({ width: WIDTH, height: HEIGHT });

  const baseUrl = 'http://localhost:3456';
  const delay = ms => new Promise(r => setTimeout(r, ms));

  // 1. Sessions overview list
  console.log('Screenshot 1: Sessions overview...');
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
  await delay(6000); // longer wait to ensure everything loads
  await maskSensitiveContent(page);
  await page.screenshot({ path: path.join(__dirname, '..', 'screenshot-sessions.png') });
  console.log('  -> screenshot-sessions.png');

  // 2. Session detail — click first session, then switch to Activity tab (Event Log)
  console.log('Screenshot 2: Session detail (Activity - Event Log)...');
  const sessionCard = await page.$('.session-card');
  if (sessionCard) {
    await sessionCard.click();
    await delay(3000);
    // Switch to Activity tab, Event Log view
    await page.evaluate(() => {
      setTab('activity');
      setActivityView('table');
    });
    await delay(2000);
  }
  await maskSensitiveContent(page);
  await page.screenshot({ path: path.join(__dirname, '..', 'screenshot-detail.png') });
  console.log('  -> screenshot-detail.png');

  // 3. Session detail — Agents tab
  console.log('Screenshot 3: Session detail (Agents)...');
  await page.evaluate(() => { setTab('agents'); });
  await delay(2000);
  await maskSensitiveContent(page);
  await page.screenshot({ path: path.join(__dirname, '..', 'screenshot-agents.png') });
  console.log('  -> screenshot-agents.png');

  // 4. Settings & Config — expand Global Settings
  console.log('Screenshot 4: Settings & Config (Global Settings expanded)...');
  await page.evaluate(() => { switchTopTab('config'); });
  await delay(5000); // longer wait for settings to fully load
  // Expand Global Settings section
  await page.evaluate(() => {
    toggleSettingsSection('cfg-global-settings');
  });
  await delay(2000);
  await maskSensitiveContent(page);
  await page.screenshot({ path: path.join(__dirname, '..', 'screenshot-settings.png') });
  console.log('  -> screenshot-settings.png');

  await browser.close();
  console.log('Done! 4 screenshots captured.');
})();
