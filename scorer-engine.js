/**
 * scorer-engine.js — ES Module
 * Exports: scoreAllContacts(contacts, { forceRebuildIndex, onProgress })
 * Each contact must have: { id, name, email, linkedinUrl, company, title }
 * Returns: array of score objects with .id preserved for bulkWriteScores
 */

const WEIGHTS = { gmail: 40, whatsapp: 30, linkedin: 20, twitter: 10 };

const THRESHOLDS = { hot: 80, warm: 55, cold: 30 };

function classify(score) {
  if (score >= THRESHOLDS.hot)  return 'Hot';
  if (score >= THRESHOLDS.warm) return 'Warm';
  if (score >= THRESHOLDS.cold) return 'Cold';
  return 'Dormant';
}

// ─── Lazy-load scorers (all optional) ────────────────────────────────────────
async function tryImport(path) {
  try { return await import(path); } catch { return null; }
}

// ─── scoreAllContacts ─────────────────────────────────────────────────────────
// Signature matches exactly what server.js calls:
//   scoreAllContacts(contacts, { forceRebuildIndex, onProgress })
export async function scoreAllContacts(contacts, { forceRebuildIndex = false, onProgress } = {}) {
  const gmailMod    = await tryImport('./scorers/gmail.js');
  const whatsappMod = await tryImport('./scorers/whatsapp.js');
  const linkedinMod = await tryImport('./scorers/linkedin.js');
  const twitterMod  = await tryImport('./scorers/twitter.js');

  // Build Gmail index once up front
  let gmailIndex = null;
  if (gmailMod && process.env.GMAIL_CLIENT_ID) {
    try {
      console.log('[scorer] Building Gmail index...');
      gmailIndex = await gmailMod.buildIndex({ rebuild: forceRebuildIndex });
      console.log(`[scorer] Gmail index ready — ${Object.keys(gmailIndex).length} addresses`);
    } catch (err) {
      console.warn('[scorer] Gmail index failed:', err.message);
    }
  }

  const results = [];

  for (let i = 0; i < contacts.length; i++) {
    const contact = contacts[i];

    // Run all platform scorers in parallel
    const [gmailRes, waRes, liRes, twRes] = await Promise.allSettled([
      gmailIndex && gmailMod    ? gmailMod.scoreContact(contact, gmailIndex)    : Promise.resolve(null),
      whatsappMod               ? whatsappMod.scoreContact(contact)              : Promise.resolve(null),
      linkedinMod               ? linkedinMod.scoreContact(contact)              : Promise.resolve(null),
      twitterMod                ? twitterMod.scoreContact(contact)               : Promise.resolve(null),
    ]);

    const gmail    = gmailRes.status    === 'fulfilled' ? gmailRes.value    : null;
    const whatsapp = waRes.status       === 'fulfilled' ? waRes.value       : null;
    const linkedin = liRes.status       === 'fulfilled' ? liRes.value       : null;
    const twitter  = twRes.status       === 'fulfilled' ? twRes.value       : null;

    // Weighted composite — only count platforms that returned a score
    let totalWeight = 0, weightedSum = 0;
    const activePlatforms = [];

    const add = (result, platform) => {
      if (result && result.score != null) {
        weightedSum  += result.score * WEIGHTS[platform];
        totalWeight  += WEIGHTS[platform];
        if (result.score > 0) activePlatforms.push(platform);
      }
    };
    add(gmail,    'gmail');
    add(whatsapp, 'whatsapp');
    add(linkedin, 'linkedin');
    add(twitter,  'twitter');

    const compositeScore = totalWeight > 0 ? Math.round(weightedSum / totalWeight) : 0;
    const status         = classify(compositeScore);
    const flagForReengagement = status === 'Dormant' || status === 'Cold';

    // Latest contact date across all platforms
    const dates = [gmail?.lastDate, whatsapp?.lastDate, linkedin?.lastDate, twitter?.lastDate]
      .filter(Boolean).map(d => new Date(d)).filter(d => !isNaN(d));
    const lastContactDate  = dates.length ? new Date(Math.max(...dates)).toISOString().split('T')[0] : null;
    const daysSinceContact = lastContactDate
      ? Math.floor((Date.now() - new Date(lastContactDate)) / 86400000)
      : 999;

    const scoreObj = {
      // Preserve Airtable record ID from the contact — required by bulkWriteScores
      id:                  contact.id,
      name:                contact.name,
      compositeScore,
      score:               compositeScore,   // alias for compatibility
      status,
      flagForReengagement,
      activePlatforms,
      lastContactDate,
      daysSinceContact,
      gmail,
      whatsapp,
      linkedin,
      twitter,
    };

    results.push(scoreObj);

    if (onProgress) {
      onProgress({ index: i + 1, total: contacts.length, result: scoreObj });
    }
  }

  return results;
}
