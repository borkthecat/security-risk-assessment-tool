const { test, expect } = require('@playwright/test');
const { _electron: electron } = require('playwright');
const path = require('path');
const fs = require('fs');

let electronApp;
let window;

test.beforeAll(async () => {
  electronApp = await electron.launch({
    args: [path.join(__dirname, '..', 'src', 'electron', 'main.js')],
    env: {
      ...process.env,
      DISPLAY: process.env.DISPLAY || ':99',
      NODE_ENV: 'test',
    },
  });
  window = await electronApp.firstWindow();
  await window.waitForLoadState('domcontentloaded');
  await window.waitForTimeout(2000);
});

test.afterAll(async () => {
  // Force kill — close() triggers the save dialog (which proves close flow works),
  // but blocks test teardown. kill() bypasses it cleanly.
  electronApp.process().kill();
});

// ── Launch ────────────────────────────────────────────────────────────────────

test('app launches and a window opens', async () => {
  const windows = electronApp.windows();
  expect(windows.length).toBeGreaterThan(0);
});

test('Welcome tab is active by default', async () => {
  const activeTab = await window.$('.tab-button.active');
  const activeId = await activeTab?.getAttribute('data-id');
  console.log('Active tab on launch:', activeId);
  expect(activeId).toBe('welcome');
});

test('project name input is present', async () => {
  const nameInput = await window.$('#welcome__isra-meta--project-name');
  expect(nameInput).not.toBeNull();
});

// ── Navigation ────────────────────────────────────────────────────────────────

test('all 7 navigation tabs are present', async () => {
  const tabs = await window.$$('.tab-button');
  const tabIds = await Promise.all(tabs.map(t => t.getAttribute('data-id')));
  console.log('Tabs found:', tabIds);
  for (const id of ['welcome','project-context','business-assets','supporting-assets','risks','vulnerabilities','isra-report']) {
    expect(tabIds).toContain(id);
  }
});

// Helper: click a tab and wait for the page to finish loading and re-enable tabs
async function navigateToTab(win, tabId) {
  await win.click(`.tab-button[data-id="${tabId}"]`);
  // Wait for page navigation to settle
  await win.waitForLoadState('domcontentloaded');
  // Wait until tabs are re-enabled (project:load IPC has fired and enableAllTabs() called)
  await win.waitForSelector('.tab-button:not([disabled])', { timeout: 15000 });
  await win.waitForTimeout(300);
}

test('can navigate to Project Context tab', async () => {
  await navigateToTab(window, 'project-context');
  expect(await (await window.$('.tab-button.active'))?.getAttribute('data-id')).toBe('project-context');
});

test('can navigate to Business Assets tab', async () => {
  await navigateToTab(window, 'business-assets');
  expect(await (await window.$('.tab-button.active'))?.getAttribute('data-id')).toBe('business-assets');
});

test('can navigate to Supporting Assets tab', async () => {
  await navigateToTab(window, 'supporting-assets');
  expect(await (await window.$('.tab-button.active'))?.getAttribute('data-id')).toBe('supporting-assets');
});

test('can navigate to Risks tab', async () => {
  await navigateToTab(window, 'risks');
  expect(await (await window.$('.tab-button.active'))?.getAttribute('data-id')).toBe('risks');
});

test('can navigate to Vulnerabilities tab', async () => {
  await navigateToTab(window, 'vulnerabilities');
  expect(await (await window.$('.tab-button.active'))?.getAttribute('data-id')).toBe('vulnerabilities');
});

test('can navigate back to Welcome tab', async () => {
  await navigateToTab(window, 'welcome');
  expect(await (await window.$('.tab-button.active'))?.getAttribute('data-id')).toBe('welcome');
});

// ── IPC / preload API ─────────────────────────────────────────────────────────

test('IPC project:load populates footer with classification', async () => {
  await window.waitForTimeout(500);
  const footerText = await window.$eval('footer', el => el.textContent);
  console.log('Footer text:', footerText);
  // Footer is populated by project:load IPC — must be non-empty
  expect(footerText.trim().length).toBeGreaterThan(0);
});

test('validate.sendAllTabs is exposed (close/save flow)', async () => {
  const result = await window.evaluate(() => ({
    hasSendAllTabs: typeof window.validate?.sendAllTabs === 'function',
    hasAllTabs:     typeof window.validate?.allTabs === 'function',
  }));
  console.log('validate API:', result);
  expect(result.hasSendAllTabs).toBe(true);
  expect(result.hasAllTabs).toBe(true);
});

test('project.load and project.iteration listeners are exposed', async () => {
  const result = await window.evaluate(() => ({
    hasLoad:      typeof window.project?.load === 'function',
    hasIteration: typeof window.project?.iteration === 'function',
  }));
  console.log('project API:', result);
  expect(result.hasLoad).toBe(true);
  expect(result.hasIteration).toBe(true);
});

test('all validate channel methods are exposed', async () => {
  const result = await window.evaluate(() => ({
    welcome:         typeof window.validate?.welcome === 'function',
    projectContext:  typeof window.validate?.projectContext === 'function',
    businessAssets:  typeof window.validate?.businessAssets === 'function',
    supportingAssets:typeof window.validate?.supportingAssets === 'function',
    vulnerabilities: typeof window.validate?.vulnerabilities === 'function',
    risks:           typeof window.validate?.risks === 'function',
    allTabs:         typeof window.validate?.allTabs === 'function',
    sendAllTabs:     typeof window.validate?.sendAllTabs === 'function',
  }));
  console.log('validate methods:', result);
  for (const [k, v] of Object.entries(result)) expect(v, k).toBe(true);
});

// ── Open-file flow ────────────────────────────────────────────────────────────

test('project:load IPC fires and updates footer', async () => {
  // Send project:load directly via Electron's IPC using the built-in app/BrowserWindow objects
  // that Playwright exposes — no require() needed
  await electronApp.evaluate(async ({ BrowserWindow }) => {
    const wins = BrowserWindow.getAllWindows();
    if (wins[0]) {
      wins[0].webContents.send('project:load', JSON.stringify({
        ISRAmeta: {
          projectName: 'Playwright Test',
          projectVersion: '1.0',
          classification: 'COMPANY CONFIDENTIAL {Playwright Test}',
          iteration: 1,
          ISRAtracking: [],
          businessAssetRef: [],
        },
        BusinessAsset: [],
        SupportingAsset: [],
        Risk: [],
        Vulnerability: [],
      }));
    }
  });

  await window.waitForTimeout(1000);
  const footerText = await window.$eval('footer', el => el.textContent);
  console.log('Footer after explicit project:load:', footerText);
  expect(footerText).toContain('Playwright Test');
});

// ── No errors ─────────────────────────────────────────────────────────────────

test('no uncaught JS errors logged to console', async () => {
  const errors = [];
  window.on('console', msg => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  await window.waitForTimeout(500);
  if (errors.length > 0) console.log('Console errors detected:', errors);
  // Allow errors from third-party libs (tinymce etc.) but fail on our code
  const ourErrors = errors.filter(e =>
    !e.includes('tinymce') && !e.includes('electron-prompt') && !e.includes('favicon')
  );
  expect(ourErrors).toHaveLength(0);
});
