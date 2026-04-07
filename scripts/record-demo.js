#!/usr/bin/env node
// Record a demo GIF of AgentPulse dashboard with aggressive content masking
const puppeteer = require('puppeteer');
const GIFEncoder = require('gif-encoder-2');
const { PNG } = require('pngjs');
const fs = require('fs');
const path = require('path');

const WIDTH = 1200;
const HEIGHT = 750;
const FRAME_DELAY = 1500; // ms between frames in GIF

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

  }, FAKE_TITLES);
}

async function captureFrames() {
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', `--window-size=${WIDTH},${HEIGHT}`]
  });

  const page = await browser.newPage();
  await page.setViewport({ width: WIDTH, height: HEIGHT });

  const baseUrl = 'http://localhost:3456';
  const delay = ms => new Promise(r => setTimeout(r, ms));
  const frames = [];
  const framesDir = path.join(__dirname, '..', 'demo-frames');
  if (!fs.existsSync(framesDir)) fs.mkdirSync(framesDir);

  // Frame 1: Sessions list — wait extra long to avoid loading state
  console.log('Frame 1: Sessions list...');
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
  await delay(8000); // longer wait to ensure sessions fully load (no "Loading..." state)
  await maskSensitiveContent(page);
  const f1 = path.join(framesDir, 'frame-01.png');
  await page.screenshot({ path: f1 });
  frames.push(f1);

  // Frame 2: Hold on sessions list for readability
  console.log('Frame 2: Sessions list (hold)...');
  frames.push(f1);

  // Frame 3: Click first session -> Activity Event Log
  console.log('Frame 3: Session detail (Activity - Event Log)...');
  const sessionCard = await page.$('.session-card');
  if (sessionCard) {
    await sessionCard.click();
    await delay(3000);
    await page.evaluate(() => {
      setTab('activity');
      setActivityView('table');
    });
    await delay(2000);
  }
  await maskSensitiveContent(page);
  const f3 = path.join(framesDir, 'frame-03.png');
  await page.screenshot({ path: f3 });
  frames.push(f3);

  // Frame 4: Hold on event log
  console.log('Frame 4: Event Log (hold)...');
  frames.push(f3);

  // Frame 5: Switch to Agents tab
  console.log('Frame 5: Agents tab...');
  await page.evaluate(() => { setTab('agents'); });
  await delay(2000);
  await maskSensitiveContent(page);
  const f5 = path.join(framesDir, 'frame-05.png');
  await page.screenshot({ path: f5 });
  frames.push(f5);

  // Frame 6: Hold on agents
  console.log('Frame 6: Agents (hold)...');
  frames.push(f5);

  // Frame 7: Switch to Settings & Config — wait for full load
  console.log('Frame 7: Settings & Config...');
  await page.evaluate(() => { switchTopTab('config'); });
  await delay(5000); // longer wait for all settings sections to render
  await maskSensitiveContent(page);
  const f7 = path.join(framesDir, 'frame-07.png');
  await page.screenshot({ path: f7 });
  frames.push(f7);

  // Frame 8: Expand Global Settings
  console.log('Frame 8: Global Settings expanded...');
  await page.evaluate(() => { toggleSettingsSection('cfg-global-settings'); });
  await delay(2000);
  await maskSensitiveContent(page);
  const f8 = path.join(framesDir, 'frame-08.png');
  await page.screenshot({ path: f8 });
  frames.push(f8);

  // Frame 9: Back to sessions (loop point)
  console.log('Frame 9: Back to sessions...');
  await page.evaluate(() => { switchTopTab('sessions'); });
  await delay(4000);
  await maskSensitiveContent(page);
  const f9 = path.join(framesDir, 'frame-09.png');
  await page.screenshot({ path: f9 });
  frames.push(f9);

  await browser.close();
  return frames;
}

async function framesToGif(framePaths, outputPath) {
  console.log(`\nEncoding ${framePaths.length} frames to GIF...`);

  const encoder = new GIFEncoder(WIDTH, HEIGHT, 'neuquant', true);
  encoder.setDelay(FRAME_DELAY);
  encoder.setRepeat(0); // loop forever
  encoder.setQuality(10);

  const writeStream = fs.createWriteStream(outputPath);

  return new Promise((resolve, reject) => {
    encoder.createReadStream().pipe(writeStream);

    writeStream.on('finish', () => {
      const stat = fs.statSync(outputPath);
      console.log(`\nGIF saved: ${outputPath} (${(stat.size / 1024 / 1024).toFixed(1)} MB)`);
      resolve();
    });

    writeStream.on('error', reject);

    encoder.start();

    for (let i = 0; i < framePaths.length; i++) {
      const pngData = fs.readFileSync(framePaths[i]);
      const png = PNG.sync.read(pngData);
      encoder.addFrame(png.data);
      console.log(`  Added frame ${i + 1}/${framePaths.length}`);
    }

    encoder.finish();
  });
}

(async () => {
  try {
    const frames = await captureFrames();
    const outputPath = path.join(__dirname, '..', 'demo.gif');
    await framesToGif(frames, outputPath);
    console.log('Done!');
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  }
})();
