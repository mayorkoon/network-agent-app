/**
 * scorers/linkedin.js
 * Playwright-based LinkedIn message scraper — TARGETED ENRICHMENT ONLY.
 *
 * At 5,000+ connections, scraping everyone's messages is:
 *   - Too slow  (~4+ hours)
 *   - Too risky (LinkedIn bot detection triggers at ~100–200 actions/session)
 *
 * This module is designed for SELECTIVE enrichment:
 *   - Only runs on contacts pre-identified as Warm/Hot from Gmail+WhatsApp
 *   - Or on an explicit list you pass via --names flag
 *   - Capped at LINKEDIN_BATCH_LIMIT per run (default: 40)
 *   - 3.5s delay between lookups (human-like pacing)
 *
 * Session cookie approach (recommended over password):
 *   1. Log into linkedin.com in Chrome
 *   2. DevTools → Application → Cookies → linkedin.com → li_at → copy Value
 *   3. Set LINKEDIN_SESSION_COOKIE in .env
 *   Expires every ~2 weeks — re-copy when you see "session expired" in logs.
 */

import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';

const CACHE_PATH = path.join(process.cwd(), '.linkedin-cache.json');

function sleep(ms) { return new Promise(r => setTimeout(r, ms + Math.random() * 1000)); }

// ─── Session management ───────────────────────────────────────────────────────

async function buildContext(browser) {
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 900 },
    locale: 'en-US',
  });

  const cookie = process.env.LINKEDIN_SESSION_COOKIE;
  if (!cookie) {
    throw new Error(
      'Set LINKEDIN_SESSION_COOKIE in .env\n' +
      'Get it from: Chrome → linkedin.com → DevTools → Application → Cookies → li_at'
    );
  }

  await context.addCookies([{
    name: 'li_at', value: cookie,
    domain: '.linkedin.com', path: '/', httpOnly: true, secure: true,
  }]);

  return context;
}

async function verifySession(page) {
  await page.goto('https://www.linkedin.com/feed/', { waitUntil: 'domcontentloaded', timeout: 20000 });
  await sleep(1500);

  // Check for session validity indicators
  const isLoggedIn = await page.locator('.global-nav__me, [data-test-id="nav-settings__account-menu"]').count() > 0;
  if (!isLoggedIn) {
    throw new Error(
      'LinkedIn session expired or invalid.\n' +
      'Re-copy li_at cookie from Chrome DevTools and update LINKEDIN_SESSION_COOKIE in .env'
    );
  }
}

// ─── Message scraping ─────────────────────────────────────────────────────────

async function scrapeMessagesForContact(page, contactName) {
  try {
    await page.goto('https://www.linkedin.com/messaging/', {
      waitUntil: 'domcontentloaded', timeout: 15000,
    });
    await sleep(2000);

    // Find and use the message search input
    const searchInput = page.locator('input[placeholder*="Search"], [data-test-id*="search-input"]').first();
    if (!(await searchInput.count())) {
      return { found: false, reason: 'search input not found' };
    }

    await searchInput.click();
    await sleep(500);
    await searchInput.fill(contactName);
    await sleep(2500); // Wait for search results to render

    // Check for matching conversation
    const convItems = page.locator('[data-test-id="conversation-list-item"], .msg-conversation-listitem__link');
    const convCount = await convItems.count();

    if (convCount === 0) {
      return { found: false, messageCount: 0, latestDate: null };
    }

    // Click first result
    await convItems.first().click();
    await sleep(2000);

    // Count messages in thread
    const msgItems = page.locator('.msg-s-event-listitem, [data-test-id="message-event"]');
    const messageCount = await msgItems.count();

    // Get date of most recent message
    let latestDate = null;
    if (messageCount > 0) {
      const lastMsg = msgItems.last();
      const timeEl = lastMsg.locator('time').first();
      if (await timeEl.count() > 0) {
        const datetime = await timeEl.getAttribute('datetime');
        const innerText = await timeEl.innerText().catch(() => null);
        const dateStr = datetime || innerText;
        if (dateStr) {
          try { latestDate = new Date(dateStr); } catch {}
        }
      }
    }

    // Clear search input for next query
    await searchInput.clear().catch(() => {});

    return {
      found: true,
      messageCount,
      latestDate: latestDate && !isNaN(latestDate) ? latestDate : null,
    };
  } catch (err) {
    return { found: false, error: err.message };
  }
}

// ─── Cache (avoids re-scraping recently checked contacts) ────────────────────

function loadCache() {
  if (!fs.existsSync(CACHE_PATH)) return {};
  try {
    return JSON.parse(fs.readFileSync(CACHE_PATH, 'utf-8'));
  } catch { return {}; }
}

function saveCache(cache) {
  fs.writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2));
}

function cacheIsFresh(entry, maxAgeDays = 7) {
  if (!entry?.cachedAt) return false;
  const ageMs = Date.now() - new Date(entry.cachedAt).getTime();
  return ageMs < maxAgeDays * 864e5;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Enrich a targeted list of contacts with LinkedIn message data.
 * Designed for 40–100 contacts per run, not the full network.
 *
 * @param {Array} contacts - Array of {name, email} objects
 * @param {Object} options
 * @param {number} options.limit - Max contacts to scrape this run (default: LINKEDIN_BATCH_LIMIT)
 * @param {Function} options.onProgress - Progress callback
 * @returns {Array} Scored contacts
 */
export async function enrichContacts(contacts, { limit, onProgress } = {}) {
  const batchLimit = limit ?? parseInt(process.env.LINKEDIN_BATCH_LIMIT || '40');
  const delayMs = parseInt(process.env.LINKEDIN_DELAY_MS || '3500');

  const cache = loadCache();

  // Filter out recently cached contacts and apply batch limit
  const toScrape = contacts
    .filter(c => c.name && !cacheIsFresh(cache[c.name?.toLowerCase()]))
    .slice(0, batchLimit);

  if (toScrape.length === 0) {
    console.log('  📋 LinkedIn: all contacts are recently cached — skipping scrape');
    // Return cached results
    return contacts.map(c => {
      const cached = cache[c.name?.toLowerCase()];
      return cached ? { name: c.name, email: c.email, ...cached.data } : null;
    }).filter(Boolean);
  }

  const estimatedMinutes = Math.ceil((toScrape.length * (delayMs + 2500)) / 60000);
  console.log(`\n  🌐 LinkedIn: scraping ${toScrape.length} contacts (~${estimatedMinutes} min) ...`);
  console.log(`     Skipping ${contacts.length - toScrape.length} with fresh cache`);

  let browser, context;
  try {
    browser = await chromium.launch({ headless: true });
    context = await buildContext(browser);
    const page = await context.newPage();
    await verifySession(page);
    console.log('  ✅ LinkedIn session valid\n');

    const results = [];

    for (let i = 0; i < toScrape.length; i++) {
      const contact = toScrape[i];
      const raw = await scrapeMessagesForContact(page, contact.name);

      const daysSince = raw.latestDate
        ? Math.floor((Date.now() - raw.latestDate.getTime()) / 864e5)
        : null;

      const ninety = Date.now() - 90 * 864e5;

      const result = {
        platform: 'linkedin',
        threadCount: raw.found ? 1 : 0,
        messageCount: raw.messageCount || 0,
        recentThreadCount: (raw.latestDate && raw.latestDate.getTime() > ninety) ? 1 : 0,
        latestDate: raw.latestDate || null,
        daysSince,
        error: raw.error || null,
      };

      // Cache this result
      cache[contact.name.toLowerCase()] = { data: result, cachedAt: new Date().toISOString() };

      results.push({ name: contact.name, email: contact.email, ...result });

      if (onProgress) onProgress({ index: i + 1, total: toScrape.length, contact, result });

      if (i < toScrape.length - 1) await sleep(delayMs);
    }

    saveCache(cache);
    return results;
  } finally {
    await context?.close().catch(() => {});
    await browser?.close().catch(() => {});
  }
}

/**
 * Score a single contact — used by scorer-engine for targeted lookups
 */
export async function scoreContact(contact) {
  const results = await enrichContacts([contact], { limit: 1 });
  return results[0] || null;
}
