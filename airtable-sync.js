/**
 * airtable-sync.js — ES Module
 * Exports exactly what server.js expects:
 *   bulkUpsertProfiles, loadAllContacts, bulkWriteScores,
 *   loadContactsByStatus, getDormantContacts
 */

import Airtable from 'airtable';

const TABLE_NAME = process.env.AIRTABLE_TABLE_NAME || 'Contacts';

function getTable() {
  const base = new Airtable({ apiKey: process.env.AIRTABLE_API_KEY }).base(process.env.AIRTABLE_BASE_ID);
  return base(TABLE_NAME);
}

function normKey(name) {
  return (name || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

// ─── bulkUpsertProfiles ───────────────────────────────────────────────────────
// Called by server.js /api/import
export async function bulkUpsertProfiles(profiles, { onProgress } = {}) {
  const table  = getTable();
  const result = { created: 0, updated: 0, skipped: 0, errors: [] };

  // Build name→recordId map of what already exists
  const existing = {};
  await table.select({ fields: ['Name'] }).eachPage((records, next) => {
    records.forEach(r => { existing[normKey(r.fields['Name'])] = r.id; });
    next();
  });

  const BATCH = 10;
  for (let i = 0; i < profiles.length; i += BATCH) {
    const batch    = profiles.slice(i, i + BATCH);
    const toCreate = [];
    const toUpdate = [];

    for (const p of batch) {
      const fields = {
        'Name':           p.name          || '',
        'Title':          p.title         || '',
        'Company':        p.company       || '',
        'Location':       p.location      || '',
        'LinkedIn URL':   p.linkedinUrl   || '',
        'Email':          p.email         || '',
        'Connected Date': p.connectedDate || '',
        'Source':         p.source        || 'CSV Import',
        'Last Enriched':  new Date().toISOString().split('T')[0],
      };
      // Remove empty strings so Airtable date/URL fields don't error
      Object.keys(fields).forEach(k => { if (fields[k] === '') delete fields[k]; });

      const key = normKey(p.name);
      if (existing[key]) {
        toUpdate.push({ id: existing[key], fields });
      } else {
        toCreate.push({ fields });
      }
    }

    try {
      if (toCreate.length) {
        const created = await table.create(toCreate);
        result.created += created.length;
        created.forEach(r => {
          existing[normKey(r.fields['Name'])] = r.id;
          if (onProgress) onProgress({
            index:  result.created + result.updated,
            total:  profiles.length,
            result: { name: r.fields['Name'], action: 'created' },
          });
        });
      }
      if (toUpdate.length) {
        await table.update(toUpdate);
        result.updated += toUpdate.length;
        toUpdate.forEach(u => {
          if (onProgress) onProgress({
            index:  result.created + result.updated,
            total:  profiles.length,
            result: { name: u.fields['Name'] || '', action: 'updated' },
          });
        });
      }
    } catch (err) {
      console.error('[airtable] upsert batch error:', err.message);
      result.errors.push(err.message);
      batch.forEach(p => {
        if (onProgress) onProgress({
          index:  result.created + result.updated + result.errors.length,
          total:  profiles.length,
          result: { name: p.name, action: 'error', error: err.message },
        });
      });
    }
  }

  return result;
}

// ─── loadAllContacts ──────────────────────────────────────────────────────────
// Called by server.js /api/score — MUST return .id on each contact
export async function loadAllContacts() {
  const table    = getTable();
  const contacts = [];

  await table.select({
    fields: ['Name', 'Email', 'LinkedIn URL', 'Company', 'Title'],
  }).eachPage((records, next) => {
    records.forEach(r => {
      contacts.push({
        id:          r.id,                            // Airtable record ID — critical for bulkWriteScores
        name:        r.fields['Name']         || '',
        email:       r.fields['Email']        || '',
        linkedinUrl: r.fields['LinkedIn URL'] || '',
        company:     r.fields['Company']      || '',
        title:       r.fields['Title']        || '',
      });
    });
    next();
  });

  console.log(`[airtable] loadAllContacts: ${contacts.length} records`);
  return contacts;
}

// ─── bulkWriteScores ──────────────────────────────────────────────────────────
// Called by server.js /api/score with (scores, { onProgress })
// Writes directly by Airtable record ID — no fragile name lookup
export async function bulkWriteScores(scores, { onProgress } = {}) {
  const table  = getTable();
  const result = { updated: 0, errors: [] };

  const BATCH = 10;
  for (let i = 0; i < scores.length; i += BATCH) {
    const batch   = scores.slice(i, i + BATCH);
    const updates = [];

    for (const s of batch) {
      if (!s.id) {
        console.warn(`[airtable] bulkWriteScores: no record ID for "${s.name}" — skipping`);
        continue;
      }

      const fields = {
        'Relationship Score':        Math.round(s.compositeScore ?? s.score ?? 0),
        'Relationship Status':       s.status || 'Dormant',
        'Flag for Re-engagement':    s.flagForReengagement === true,
        'Active Platforms':          (s.activePlatforms || []).join(', '),
        'Gmail Thread Count':        s.gmail?.threadCount           ?? 0,
        'WhatsApp Message Count':    s.whatsapp?.messageCount       ?? 0,
        'LinkedIn Message Count':    s.linkedin?.messageCount       ?? 0,
        'Twitter Interaction Count': s.twitter?.interactionCount    ?? 0,
        'Days Since Contact':        s.daysSinceContact             ?? 999,
      };

      // Only set date fields when there's an actual value
      if (s.lastContactDate)    fields['Last Contact Date']      = s.lastContactDate;
      if (s.gmail?.lastDate)    fields['Gmail Last Email']        = s.gmail.lastDate;
      if (s.whatsapp?.lastDate) fields['WhatsApp Last Message']   = s.whatsapp.lastDate;
      if (s.linkedin?.lastDate) fields['LinkedIn Last Message']   = s.linkedin.lastDate;

      updates.push({ id: s.id, fields });
    }

    try {
      if (updates.length) {
        await table.update(updates);
        result.updated += updates.length;
      }
    } catch (err) {
      console.error('[airtable] bulkWriteScores batch error:', err.message);
      result.errors.push(err.message);
    }

    if (onProgress) {
      onProgress({ index: Math.min(i + BATCH, scores.length), total: scores.length });
    }
  }

  return result;
}

// ─── loadContactsByStatus ─────────────────────────────────────────────────────
export async function loadContactsByStatus(statuses = ['Hot', 'Warm'], limit = 40) {
  const table    = getTable();
  const contacts = [];

  const formula = statuses.length === 1
    ? `{Relationship Status} = '${statuses[0]}'`
    : `OR(${statuses.map(s => `{Relationship Status} = '${s}'`).join(', ')})`;

  await table.select({ filterByFormula: formula, maxRecords: limit }).eachPage((records, next) => {
    records.forEach(r => {
      contacts.push({
        id:          r.id,
        name:        r.fields['Name']               || '',
        email:       r.fields['Email']              || '',
        linkedinUrl: r.fields['LinkedIn URL']       || '',
        company:     r.fields['Company']            || '',
        title:       r.fields['Title']              || '',
        score:       r.fields['Relationship Score'] || 0,
      });
    });
    next();
  });

  return contacts;
}

// ─── getDormantContacts ───────────────────────────────────────────────────────
export async function getDormantContacts(limit = 100) {
  const table    = getTable();
  const contacts = [];

  await table.select({
    filterByFormula: `OR({Flag for Re-engagement} = TRUE(), {Relationship Status} = 'Dormant')`,
    sort:            [{ field: 'Days Since Contact', direction: 'desc' }],
    maxRecords:      limit,
    fields:          ['Name', 'Title', 'Company', 'Relationship Status', 'Days Since Contact', 'Last Contact Date', 'Relationship Score', 'LinkedIn URL'],
  }).eachPage((records, next) => {
    records.forEach(r => {
      contacts.push({
        name:             r.fields['Name']                || '',
        company:          r.fields['Company']             || '',
        title:            r.fields['Title']               || '',
        status:           r.fields['Relationship Status'] || 'Unknown',
        daysSinceContact: r.fields['Days Since Contact']  ?? 999,
        lastContactDate:  r.fields['Last Contact Date']   || '',
        score:            r.fields['Relationship Score']  || 0,
        linkedinUrl:      r.fields['LinkedIn URL']        || '',
      });
    });
    next();
  });

  return contacts;
}
