/**
 * scorer-engine.js
 * Composite relationship scorer — tiered architecture for 5,000+ networks.
 *
 * ─── TIER 1: Passive scoring (all 5K+ contacts, fast) ───────────────────────
 *   Gmail   — built from sent-mail index (one pass, cached 24h)
 *   WhatsApp — instant lookup from pre-loaded export files
 *   Twitter  — instant if keys configured
 *
 * ─── TIER 2: Active enrichment (targeted, Warm/Hot contacts only) ────────────
 *   LinkedIn messages — Playwright scraping, 40 contacts/run max
 *                       Called separately via `node agent.js enrich-linkedin`
 *
 * Scoring weights:
 *   Platform       Max pts   Notes
 *   ────────────────────────────────────────────────────────────────
 *   Gmail          40        Highest weight — most reliable signal
 *   WhatsApp       30        Strong signal for personal contacts
 *   LinkedIn msgs  20        Professional signal (targeted only)
 *   Twitter/X      10        Weakest — most public interactions
 *   ────────────────────────────────────────────────────────────────
 *   TOTAL          100 pts (normalized if not all platforms available)
 *
 * Relationship Status:
 *   80–100  🔥 Hot     — active, frequent across platforms
 *   55–79   ☀️  Warm    — occasional contact, relationship alive
 *   30–54   ❄️  Cold    — infrequent, 60–180 days
 *   0–29    💤 Dormant — no meaningful contact
 *
 * Re-engagement flag: Dormant OR (Cold AND >90 days)
 */

// googleapis loaded dynamically inside scoreAllContacts so module loads
// cleanly before npm install completes.
import {
  getAuthClient,
  buildOrLoadIndex,
  scoreContactFromIndex,
} from './scorers/gmail.js';
import * as whatsappScorer from './scorers/whatsapp.js';
import * as twitterScorer  from './scorers/twitter.js';

const WEIGHTS = {
  gmail:    { max: 40, recency: 20, volume: 12, recent: 8 },
  whatsapp: { max: 30, recency: 14, volume: 10, recent: 6 },
  linkedin: { max: 20, recency: 10, volume: 5,  recent: 5 },
  twitter:  { max: 10, recency: 5,  volume: 3,  recent: 2 },
};

// ─── Platform scorer ──────────────────────────────────────────────────────────

function scorePlatform(data, weights) {
  if (!data || data.error || data.threadCount === 0) return 0;

  const { daysSince, threadCount = 0, recentThreadCount = 0, messageCount = 0 } = data;
  const total = threadCount + (messageCount || 0);
  let pts = 0;

  // Recency
  if (daysSince !== null) {
    if      (daysSince <=   7) pts += weights.recency;
    else if (daysSince <=  30) pts += weights.recency * 0.80;
    else if (daysSince <=  60) pts += weights.recency * 0.55;
    else if (daysSince <=  90) pts += weights.recency * 0.35;
    else if (daysSince <= 180) pts += weights.recency * 0.15;
  }

  // Volume
  if      (total >= 50) pts += weights.volume;
  else if (total >= 20) pts += weights.volume * 0.80;
  else if (total >= 10) pts += weights.volume * 0.60;
  else if (total >=  5) pts += weights.volume * 0.40;
  else if (total >=  2) pts += weights.volume * 0.20;
  else if (total >=  1) pts += weights.volume * 0.10;

  // Recent activity (90 days)
  if      (recentThreadCount >= 10) pts += weights.recent;
  else if (recentThreadCount >=  5) pts += weights.recent * 0.75;
  else if (recentThreadCount >=  3) pts += weights.recent * 0.50;
  else if (recentThreadCount >=  1) pts += weights.recent * 0.25;

  return pts;
}

function computeComposite(platformData) {
  let raw = 0;
  const availablePlatforms = [];
  const breakdown = {};

  for (const [platform, data] of Object.entries(platformData)) {
    if (!data || data.error) continue;
    const weights = WEIGHTS[platform];
    if (!weights) continue;

    const pts = scorePlatform(data, weights);
    raw += pts;
    availablePlatforms.push(platform);

    const total = (data.threadCount || 0) + (data.messageCount || 0);
    breakdown[platform] = {
      pts: Math.round(pts),
      maxPts: weights.max,
      interactionCount: total,
      recentCount: data.recentThreadCount || 0,
      latestDate: data.latestDate || null,
      daysSince: data.daysSince ?? null,
    };
  }

  // Normalize against available platforms only
  const maxPossible = availablePlatforms.reduce((s, p) => s + (WEIGHTS[p]?.max || 0), 0);
  const score = maxPossible > 0 ? Math.round((raw / maxPossible) * 100) : 0;

  return { score, availablePlatforms, breakdown };
}

function scoreToStatus(score) {
  if (score >= 80) return 'Hot';
  if (score >= 55) return 'Warm';
  if (score >= 30) return 'Cold';
  return 'Dormant';
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Score all contacts — TIER 1 (passive, fast, scales to 5K+).
 * Does NOT run LinkedIn scraping — call enrichLinkedIn() separately.
 *
 * @param {Array} contacts - [{name, email, ...}]
 * @param {Object} options
 * @param {Function} options.onProgress
 * @param {boolean} options.forceRebuildIndex - Force Gmail index rebuild
 */
export async function scoreAllContacts(contacts, { onProgress, forceRebuildIndex = false } = {}) {
  // Step 1: Build Gmail index (one pass, cached)
  let gmailIndex = null;
  try {
    const { google } = await import('googleapis');
    const auth = await getAuthClient();
    const gmail = google.gmail({ version: 'v1', auth });
    gmailIndex = await buildOrLoadIndex(gmail, {
      forceRebuild: forceRebuildIndex,
      onProgress: ({ totalMessages, uniqueContacts }) => {
        process.stdout.write(`\r  📧 Gmail index: ${totalMessages} messages, ${uniqueContacts} contacts...`);
      },
    });
    process.stdout.write('\n');
  } catch (err) {
    console.warn(`  ⚠️  Gmail unavailable: ${err.message}`);
  }

  console.log(`  📊 Scoring ${contacts.length} contacts...`);

  const results = [];

  for (let i = 0; i < contacts.length; i++) {
    const contact = contacts[i];

    // Gmail — O(1) index lookup
    const gmailData = gmailIndex ? scoreContactFromIndex(contact, gmailIndex) : null;

    // WhatsApp — instant file lookup
    const whatsappData = await whatsappScorer.scoreContact(contact);

    // Twitter — instant if configured
    const twitterData = await twitterScorer.scoreContact(contact);

    const platformData = {
      gmail:    gmailData,
      whatsapp: whatsappData,
      twitter:  twitterData,
      // linkedin: filled in later by enrichLinkedIn()
    };

    const { score, availablePlatforms, breakdown } = computeComposite(platformData);
    const status = scoreToStatus(score);

    // Overall latest contact date across platforms
    const allDates = Object.values(breakdown)
      .map(b => b.latestDate)
      .filter(Boolean)
      .map(d => new Date(d))
      .sort((a, b) => b - a);

    const latestContactDate = allDates[0] || null;
    const daysSinceContact  = latestContactDate
      ? Math.floor((Date.now() - latestContactDate.getTime()) / 864e5)
      : null;

    const result = {
      name: contact.name,
      email: contact.email,
      compositeScore: score,
      status,
      flagForReengagement:
        status === 'Dormant' || (status === 'Cold' && (daysSinceContact === null || daysSinceContact > 90)),
      latestContactDate: latestContactDate?.toISOString().split('T')[0] || null,
      daysSinceContact,
      activePlatforms: availablePlatforms,
      platformBreakdown: breakdown,
    };

    results.push(result);

    if (onProgress) onProgress({ index: i + 1, total: contacts.length, result });
  }

  return results;
}

/**
 * Apply LinkedIn enrichment scores to existing results (TIER 2).
 * Call after enrichLinkedIn() writes data to Airtable.
 * This re-computes composite scores for the enriched subset.
 */
export function applyLinkedInEnrichment(existingResult, linkedinData) {
  const platformData = {
    ...Object.fromEntries(
      Object.entries(existingResult.platformBreakdown).map(([p, b]) => [p, b])
    ),
    linkedin: linkedinData,
  };

  const { score, availablePlatforms, breakdown } = computeComposite(platformData);
  const status = scoreToStatus(score);

  return {
    ...existingResult,
    compositeScore: score,
    status,
    activePlatforms: availablePlatforms,
    platformBreakdown: breakdown,
  };
}

export function formatScore(result) {
  const icon = { Hot: '🔥', Warm: '☀️ ', Cold: '❄️ ', Dormant: '💤' }[result.status] ?? '?';
  const flag = result.flagForReengagement ? ' 🚩' : '';
  const days = result.daysSinceContact != null ? `${result.daysSinceContact}d` : 'never';
  const platforms = result.activePlatforms.join('+') || 'none';
  return `${icon} ${result.name.padEnd(30)} ${result.status.padEnd(8)} ${String(result.compositeScore).padStart(3)}/100  last:${days.padStart(6)}  [${platforms}]${flag}`;
}
