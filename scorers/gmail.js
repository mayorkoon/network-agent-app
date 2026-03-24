/**
 * scorers/gmail.js
 * Gmail relationship scorer — optimized for 5,000+ contact networks.
 *
 * Strategy for large networks:
 *   1. Build a SENT mail index first (one pass through your sent folder)
 *      This tells us everyone you've ever emailed — the strongest signal.
 *   2. For contacts with email addresses, check the index O(1) instead of
 *      making individual API calls per contact (avoids rate limits at scale).
 *   3. For contacts without email, we can't score them via Gmail (that's fine —
 *      WhatsApp + LinkedIn fill the gap).
 *
 * Gmail API quota: 250 units/second, 1B units/day.
 * threads.list costs 5 units. At 5K contacts × 2 calls = 50K units — well within limits.
 * But latency is the real constraint: ~200ms/call × 10K calls = 33 minutes.
 * The sent-index approach cuts this to a single paginated pass (~2–5 minutes for 5K emails).
 */

import { google } from 'googleapis';
import fs from 'fs';
import path from 'path';
import http from 'http';
import { URL } from 'url';

const TOKEN_PATH = path.join(process.cwd(), '.token-gmail.json');
const INDEX_PATH = path.join(process.cwd(), '.gmail-index.json');
const SCOPES = ['https://www.googleapis.com/auth/gmail.readonly'];

// ─── Auth ─────────────────────────────────────────────────────────────────────

function makeOAuthClient() {
  return new google.auth.OAuth2(
    process.env.GMAIL_CLIENT_ID,
    process.env.GMAIL_CLIENT_SECRET,
    process.env.GMAIL_REDIRECT_URI || 'http://localhost:3000/oauth/callback'
  );
}

export async function getAuthClient() {
  const auth = makeOAuthClient();
  if (!fs.existsSync(TOKEN_PATH)) {
    throw new Error('Gmail not authorized. Run: node agent.js auth-gmail');
  }
  const token = JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf-8'));
  auth.setCredentials(token);
  if (token.expiry_date && Date.now() > token.expiry_date - 60000) {
    const { credentials } = await auth.refreshAccessToken();
    fs.writeFileSync(TOKEN_PATH, JSON.stringify(credentials));
    auth.setCredentials(credentials);
  }
  return auth;
}

/**
 * startAuthFlow — used only by CLI (agent.js auth-gmail).
 * When running as web app, OAuth is handled by Express routes in server.js.
 */
export async function startAuthFlow(port = 3000) {
  const auth = makeOAuthClient();
  const url = auth.generateAuthUrl({ access_type: 'offline', scope: SCOPES, prompt: 'consent' });
  console.log('\n🔐 Gmail OAuth — open this URL in your browser:\n');
  console.log(url + '\n');

  return new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      const parsed = new URL(req.url, `http://localhost:${port}`);
      const code = parsed.searchParams.get('code');
      if (!code) { res.end('No code received.'); return; }
      try {
        const { tokens } = await auth.getToken(code);
        auth.setCredentials(tokens);
        fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens));
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<h2 style="font-family:sans-serif;padding:40px">✅ Gmail authorized! Close this tab.</h2>');
        server.close();
        console.log('✅ Gmail authorized — token saved to .token-gmail.json\n');
        resolve();
      } catch (err) {
        res.end('Error: ' + err.message);
        reject(err);
      }
    });
    // Use a different port for CLI auth to avoid conflicts
    const authPort = port === 3000 ? 3001 : port;
    server.listen(authPort, () => {
      console.log(`⏳ Waiting for OAuth callback on http://localhost:${authPort} ...\n`);
    });
  });
}

// ─── Sent-Mail Index ──────────────────────────────────────────────────────────
// The index maps email address → { count, latestDate, recentCount }
// Built once, cached to .gmail-index.json, refreshed if older than INDEX_MAX_AGE_HOURS

const INDEX_MAX_AGE_HOURS = 24;

function indexIsStale() {
  if (!fs.existsSync(INDEX_PATH)) return true;
  const stat = fs.statSync(INDEX_PATH);
  const ageHours = (Date.now() - stat.mtimeMs) / 3600000;
  return ageHours > INDEX_MAX_AGE_HOURS;
}

/**
 * Build or load the Gmail sent-mail index.
 * Returns Map<emailAddress(lower), { sentCount, latestDate, recentCount }>
 */
export async function buildOrLoadIndex(gmail, { forceRebuild = false, onProgress } = {}) {
  if (!forceRebuild && !indexIsStale()) {
    const raw = JSON.parse(fs.readFileSync(INDEX_PATH, 'utf-8'));
    // Rehydrate dates
    for (const v of Object.values(raw)) {
      if (v.latestDate) v.latestDate = new Date(v.latestDate);
    }
    const map = new Map(Object.entries(raw));
    console.log(`  📂 Gmail index loaded from cache (${map.size} contacts)`);
    return map;
  }

  console.log('  🔄 Building Gmail sent-mail index (this takes 2–5 min for 5K+ networks)...');

  const index = new Map(); // email → { sentCount, receivedCount, latestDate, recentCount }
  const ninety = new Date(Date.now() - 90 * 864e5);
  let pageToken = null;
  let totalMessages = 0;

  // Pass 1: Sent messages (strongest signal — you initiated contact)
  do {
    const params = { userId: 'me', labelIds: ['SENT'], maxResults: 500 };
    if (pageToken) params.pageToken = pageToken;

    const res = await gmail.users.messages.list(params);
    const messages = res.data.messages || [];
    pageToken = res.data.nextPageToken || null;

    for (const msg of messages) {
      // Fetch minimal metadata for each message
      const detail = await gmail.users.messages.get({
        userId: 'me', id: msg.id, format: 'metadata',
        metadataHeaders: ['To', 'Date'],
      });

      const headers = detail.data.payload?.headers || [];
      const toHeader = headers.find(h => h.name === 'To')?.value || '';
      const dateHeader = headers.find(h => h.name === 'Date')?.value;
      const msgDate = dateHeader ? new Date(dateHeader) : null;

      // Parse To: header (may contain multiple recipients)
      const emails = extractEmails(toHeader);
      for (const email of emails) {
        const key = email.toLowerCase();
        if (!index.has(key)) {
          index.set(key, { sentCount: 0, receivedCount: 0, latestDate: null, recentCount: 0 });
        }
        const entry = index.get(key);
        entry.sentCount++;
        if (msgDate) {
          if (!entry.latestDate || msgDate > entry.latestDate) entry.latestDate = msgDate;
          if (msgDate > ninety) entry.recentCount++;
        }
      }

      totalMessages++;
      if (onProgress && totalMessages % 100 === 0) {
        onProgress({ totalMessages, uniqueContacts: index.size });
      }

      // Throttle slightly to be kind to quota
      await sleep(20);
    }
  } while (pageToken);

  // Pass 2: Received messages (for contacts who emailed you but you didn't reply)
  pageToken = null;
  do {
    const params = { userId: 'me', labelIds: ['INBOX'], maxResults: 500 };
    if (pageToken) params.pageToken = pageToken;

    const res = await gmail.users.messages.list(params);
    const messages = res.data.messages || [];
    pageToken = res.data.nextPageToken || null;

    for (const msg of messages) {
      const detail = await gmail.users.messages.get({
        userId: 'me', id: msg.id, format: 'metadata',
        metadataHeaders: ['From', 'Date'],
      });

      const headers = detail.data.payload?.headers || [];
      const fromHeader = headers.find(h => h.name === 'From')?.value || '';
      const dateHeader = headers.find(h => h.name === 'Date')?.value;
      const msgDate = dateHeader ? new Date(dateHeader) : null;

      const emails = extractEmails(fromHeader);
      for (const email of emails) {
        const key = email.toLowerCase();
        if (!index.has(key)) {
          index.set(key, { sentCount: 0, receivedCount: 0, latestDate: null, recentCount: 0 });
        }
        const entry = index.get(key);
        entry.receivedCount++;
        if (msgDate) {
          if (!entry.latestDate || msgDate > entry.latestDate) entry.latestDate = msgDate;
          if (msgDate > ninety) entry.recentCount++;
        }
      }

      totalMessages++;
      await sleep(20);
    }
  } while (pageToken);

  // Serialize and cache
  const serializable = {};
  for (const [k, v] of index) {
    serializable[k] = { ...v, latestDate: v.latestDate?.toISOString() || null };
  }
  fs.writeFileSync(INDEX_PATH, JSON.stringify(serializable, null, 2));
  console.log(`  ✅ Gmail index built: ${index.size} unique contacts from ${totalMessages} messages`);

  return index;
}

// ─── Per-contact scoring (O(1) lookup after index is built) ───────────────────

/**
 * Score a single contact using the pre-built index.
 * This is instant — just a Map lookup.
 */
export function scoreContactFromIndex(contact, index) {
  if (!contact.email) return null;

  const key = contact.email.toLowerCase();
  const entry = index.get(key);

  if (!entry) {
    return {
      platform: 'gmail',
      threadCount: 0,
      recentThreadCount: 0,
      latestDate: null,
      daysSince: null,
    };
  }

  const totalCount = (entry.sentCount || 0) + (entry.receivedCount || 0);
  const daysSince = entry.latestDate
    ? Math.floor((Date.now() - entry.latestDate.getTime()) / 864e5)
    : null;

  return {
    platform: 'gmail',
    threadCount: totalCount,
    sentCount: entry.sentCount,
    receivedCount: entry.receivedCount,
    recentThreadCount: entry.recentCount || 0,
    latestDate: entry.latestDate,
    daysSince,
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function extractEmails(headerValue) {
  const emailRegex = /[\w.+-]+@[\w-]+\.[\w.]+/g;
  return [...new Set((headerValue.match(emailRegex) || []).map(e => e.toLowerCase()))];
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
