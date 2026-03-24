/**
 * airtable-sync.js
 * Airtable operations — upsert profiles and write relationship scores.
 */

import Airtable from 'airtable';

let _table = null;
const DELAY_MS = 220; // stay under Airtable's 5 req/sec limit

function getTable() {
  if (_table) return _table;
  Airtable.configure({ apiKey: process.env.AIRTABLE_API_KEY });
  _table = new Airtable()
    .base(process.env.AIRTABLE_BASE_ID)(process.env.AIRTABLE_TABLE_NAME || 'Contacts');
  return _table;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── Field mappers ────────────────────────────────────────────────────────────

function profileToFields(p) {
  const f = {};
  if (p.name)           f['Name']           = p.name;
  if (p.title)          f['Title']          = p.title;
  if (p.company)        f['Company']        = p.company;
  if (p.location)       f['Location']       = p.location;
  if (p.linkedin_url)   f['LinkedIn URL']   = p.linkedin_url;
  if (p.email)          f['Email']          = p.email;
  if (p.connected_date) f['Connected Date'] = p.connected_date;
  f['Source']        = p._source || 'CSV';
  f['Last Enriched'] = new Date().toISOString().split('T')[0];
  return f;
}

function scoreToFields(s) {
  const f = {};
  if (s.compositeScore   != null) f['Relationship Score']       = s.compositeScore;
  if (s.status)                   f['Relationship Status']      = s.status;
  if (s.latestContactDate)        f['Last Contact Date']        = s.latestContactDate;
  if (s.daysSinceContact != null) f['Days Since Contact']       = s.daysSinceContact;
  if (s.flagForReengagement != null) f['Flag for Re-engagement'] = s.flagForReengagement;
  if (s.activePlatforms?.length)  f['Active Platforms']         = s.activePlatforms.join(', ');

  const bd = s.platformBreakdown || {};

  if (bd.gmail) {
    if (bd.gmail.interactionCount != null) f['Gmail Thread Count'] = bd.gmail.interactionCount;
    if (bd.gmail.latestDate) f['Gmail Last Email'] = new Date(bd.gmail.latestDate).toISOString().split('T')[0];
  }
  if (bd.whatsapp) {
    if (bd.whatsapp.interactionCount != null) f['WhatsApp Message Count'] = bd.whatsapp.interactionCount;
    if (bd.whatsapp.latestDate) f['WhatsApp Last Message'] = new Date(bd.whatsapp.latestDate).toISOString().split('T')[0];
  }
  if (bd.linkedin) {
    if (bd.linkedin.interactionCount != null) f['LinkedIn Message Count'] = bd.linkedin.interactionCount;
    if (bd.linkedin.latestDate) f['LinkedIn Last Message'] = new Date(bd.linkedin.latestDate).toISOString().split('T')[0];
  }
  if (bd.twitter) {
    if (bd.twitter.interactionCount != null) f['Twitter Interaction Count'] = bd.twitter.interactionCount;
  }

  return f;
}

// ─── Record lookup ────────────────────────────────────────────────────────────

async function findRecord(name, email, linkedinUrl) {
  const conditions = [];
  if (linkedinUrl) conditions.push(`{LinkedIn URL} = "${linkedinUrl}"`);
  if (email)       conditions.push(`{Email} = "${email}"`);
  if (name)        conditions.push(`{Name} = "${name}"`);
  if (!conditions.length) return null;

  const formula = conditions.length > 1 ? `OR(${conditions.join(', ')})` : conditions[0];
  const records = await getTable().select({ filterByFormula: formula, maxRecords: 1 }).firstPage();
  return records[0] || null;
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function upsertProfile(profile) {
  const table = getTable();
  const fields = profileToFields(profile);
  if (!fields['Name']) return { action: 'skipped' };

  try {
    const existing = await findRecord(fields['Name'], fields['Email'], fields['LinkedIn URL']);
    if (existing) {
      const updates = Object.fromEntries(Object.entries(fields).filter(([, v]) => v != null && v !== ''));
      await table.update(existing.id, updates);
      return { action: 'updated', name: fields['Name'] };
    }
    await table.create(fields);
    return { action: 'created', name: fields['Name'] };
  } catch (err) {
    return { action: 'error', name: fields['Name'], error: err.message };
  }
}

export async function bulkUpsertProfiles(profiles, { onProgress } = {}) {
  const totals = { created: 0, updated: 0, skipped: 0, errors: [] };
  for (let i = 0; i < profiles.length; i++) {
    const r = await upsertProfile(profiles[i]);
    if (r.action === 'created')  totals.created++;
    else if (r.action === 'updated') totals.updated++;
    else if (r.action === 'skipped') totals.skipped++;
    else totals.errors.push(r);
    if (onProgress) onProgress({ index: i + 1, total: profiles.length, result: r });
    if (i < profiles.length - 1) await sleep(DELAY_MS);
  }
  return totals;
}

export async function writeScore(score) {
  const fields = scoreToFields(score);
  try {
    const existing = await findRecord(score.name, score.email, null);
    if (!existing) return { action: 'not_found', name: score.name };
    await getTable().update(existing.id, fields);
    await sleep(DELAY_MS);
    return { action: 'updated', name: score.name };
  } catch (err) {
    return { action: 'error', name: score.name, error: err.message };
  }
}

export async function bulkWriteScores(scores, { onProgress } = {}) {
  const totals = { updated: 0, notFound: 0, errors: [] };
  for (let i = 0; i < scores.length; i++) {
    const r = await writeScore(scores[i]);
    if (r.action === 'updated')   totals.updated++;
    else if (r.action === 'not_found') totals.notFound++;
    else totals.errors.push(r);
    if (onProgress) onProgress({ index: i + 1, total: scores.length, result: r });
  }
  return totals;
}

export async function loadAllContacts() {
  const contacts = [];
  await getTable()
    .select({ fields: ['Name', 'Email', 'LinkedIn URL'] })
    .eachPage((records, next) => {
      for (const r of records) {
        contacts.push({
          name:         r.fields['Name']         || null,
          email:        r.fields['Email']        || null,
          linkedin_url: r.fields['LinkedIn URL'] || null,
        });
      }
      next();
    });
  return contacts;
}

/**
 * Load contacts filtered by relationship status (for targeted LinkedIn enrichment)
 */
export async function loadContactsByStatus(statuses = ['Hot', 'Warm']) {
  const contacts = [];
  const formula = `OR(${statuses.map(s => `{Relationship Status} = "${s}"`).join(', ')})`;

  await getTable()
    .select({ fields: ['Name', 'Email', 'LinkedIn URL', 'Relationship Status'], filterByFormula: formula })
    .eachPage((records, next) => {
      for (const r of records) {
        contacts.push({
          name:         r.fields['Name']                  || null,
          email:        r.fields['Email']                 || null,
          linkedin_url: r.fields['LinkedIn URL']          || null,
          status:       r.fields['Relationship Status']   || null,
        });
      }
      next();
    });

  return contacts;
}
