/**
 * scorers/twitter.js
 * Twitter/X relationship scorer — ready to activate when you get API access.
 *
 * Status: INACTIVE until TWITTER_API_KEY is set in .env
 * Returns null silently if keys are missing (won't affect other platform scores).
 *
 * To activate:
 *   1. developer.twitter.com → sign up / log in
 *   2. Create a project + app
 *   3. Upgrade to Basic tier ($100/mo) — required for DM read access
 *   4. Keys and Tokens → generate all five values
 *   5. Paste into .env
 *
 * What it tracks:
 *   - Direct messages (sent + received)
 *   - @mentions / replies between you and the contact
 *
 * Note: For best matching, add a "Twitter Handle" field to your Airtable
 * contacts (e.g. "@username"). Without it, the scorer falls back to searching
 * by name, which is less accurate.
 */

import { TwitterApi } from 'twitter-api-v2';

let _client = null;
let _me = null;

function getClient() {
  if (_client) return _client;
  if (!process.env.TWITTER_API_KEY?.trim()) return null; // Not configured

  _client = new TwitterApi({
    appKey:      process.env.TWITTER_API_KEY,
    appSecret:   process.env.TWITTER_API_SECRET,
    accessToken: process.env.TWITTER_ACCESS_TOKEN,
    accessSecret: process.env.TWITTER_ACCESS_SECRET,
  });
  return _client;
}

async function getMe() {
  if (_me) return _me;
  const client = getClient();
  if (!client) return null;
  _me = await client.v2.me();
  return _me;
}

async function resolveUsername(client, contact) {
  // Prefer stored handle
  const handle = contact.twitter_handle?.replace('@', '').trim();
  if (handle) return handle;

  // Fall back to name search (rate-limited — use sparingly)
  try {
    const res = await client.v2.searchUsers(contact.name, { max_results: 5 });
    if (res.data?.length) return res.data[0].username;
  } catch {}

  return null;
}

export async function scoreContact(contact) {
  const client = getClient();
  if (!client) return null; // Keys not configured — skip silently

  try {
    const username = await resolveUsername(client, contact);
    if (!username) return { platform: 'twitter', error: 'Could not resolve username', threadCount: 0 };

    const me = await getMe();

    // DM history (requires Basic tier)
    let dmDates = [];
    try {
      const user = await client.v2.userByUsername(username, { 'user.fields': ['id'] });
      if (user.data) {
        const dmConvId = `${me.data.id}-${user.data.id}`;
        const dms = await client.v2.listDmEvents({
          dm_conversation_id: dmConvId,
          max_results: 100,
          'dm_event.fields': ['created_at'],
        });
        dmDates = (dms.data?.data || []).map(e => new Date(e.created_at));
      }
    } catch {}

    // @mention / reply history
    let mentionDates = [];
    try {
      const q = `(from:${username} to:${me.data.username}) OR (from:${me.data.username} to:${username})`;
      const tweets = await client.v2.search(q, {
        max_results: 100,
        'tweet.fields': ['created_at'],
      });
      mentionDates = (tweets.data?.data || []).map(t => new Date(t.created_at));
    } catch {}

    const allDates = [...dmDates, ...mentionDates].sort((a, b) => b - a);
    const latestDate = allDates[0] || null;
    const ninety = new Date(Date.now() - 90 * 864e5);
    const recentCount = allDates.filter(d => d > ninety).length;

    return {
      platform: 'twitter',
      threadCount: allDates.length,
      dmCount: dmDates.length,
      mentionCount: mentionDates.length,
      recentThreadCount: recentCount,
      latestDate,
      daysSince: latestDate ? Math.floor((Date.now() - latestDate.getTime()) / 864e5) : null,
      resolvedUsername: username,
    };
  } catch (err) {
    return { platform: 'twitter', error: err.message, threadCount: 0 };
  }
}
