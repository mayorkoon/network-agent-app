/**
 * csv-parser.js
 * Parses two CSV formats:
 *
 * FORMAT A — Custom export (your format):
 *   Name, Location, Title, LinkedIn URL, Email, Company,
 *   Connected Date, Source, Last Enriched, Relationship Status
 *
 * FORMAT B — LinkedIn official export:
 *   First Name, Last Name, URL, Email Address, Company,
 *   Position, Connected On
 *
 * Auto-detects which format based on headers.
 */

import fs from 'fs';
import { parse } from 'csv-parse/sync';

export function parseLinkedInCSV(csvPath) {
  const content = fs.readFileSync(csvPath, 'utf-8');
  const lines = content.split('\n');

  // Find the real header row — skip any junk lines at top
  let headerIndex = 0;
  for (let i = 0; i < Math.min(lines.length, 6); i++) {
    const line = lines[i];
    if (
      line.includes('First Name') ||
      line.includes('Last Name')  ||
      line.includes('Name')       ||
      line.includes('LinkedIn URL')
    ) {
      headerIndex = i;
      break;
    }
  }

  const records = parse(lines.slice(headerIndex).join('\n'), {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    relax_column_count: true,
  });

  if (!records.length) return [];

  // Detect format by checking first record's keys
  const keys = Object.keys(records[0]);
  const isLinkedInOfficial = keys.includes('First Name') || keys.includes('Last Name');

  return records
    .map(row => {
      let name, title, company, email, linkedin_url, connected_date;

      if (isLinkedInOfficial) {
        // FORMAT B — LinkedIn official export
        const firstName = row['First Name'] || '';
        const lastName  = row['Last Name']  || '';
        name         = [firstName, lastName].filter(Boolean).join(' ').trim() || null;
        title        = row['Position']      || row['Title']        || null;
        company      = row['Company']       || null;
        email        = row['Email Address'] || row['Email']        || null;
        linkedin_url = row['URL']           || row['LinkedIn URL'] || null;

        const raw = row['Connected On'] || row['Connected Date'] || '';
        connected_date = parseDate(raw);

      } else {
        // FORMAT A — your custom format
        name         = row['Name']         || row['Full Name']    || null;
        title        = row['Title']        || row['Position']     || null;
        company      = row['Company']      || null;
        email        = row['Email']        || row['Email Address']|| null;
        linkedin_url = row['LinkedIn URL'] || row['URL']          || null;

        const raw = row['Connected Date'] || row['Connected On'] || '';
        connected_date = parseDate(raw);
      }

      return {
        name:           name?.trim() || null,
        title:          title?.trim() || null,
        company:        company?.trim() || null,
        email:          email?.trim() || null,
        linkedin_url:   linkedin_url?.trim() || null,
        connected_date,
        _source:        row['Source'] || 'CSV',
      };
    })
    .filter(r => r.name);
}

function parseDate(raw) {
  if (!raw || !raw.trim()) return null;
  try {
    const d = new Date(raw.trim());
    if (!isNaN(d.getTime())) return d.toISOString().split('T')[0];
  } catch {}
  return null;
}

export function deduplicateProfiles(profiles) {
  const seen = new Map();
  for (const p of profiles) {
    const key = p.linkedin_url || p.name?.toLowerCase().trim();
    if (!key) continue;
    if (!seen.has(key)) {
      seen.set(key, p);
    } else {
      const existing = seen.get(key);
      for (const [k, v] of Object.entries(p)) {
        if (!existing[k] && v) existing[k] = v;
      }
    }
  }
  return [...seen.values()];
}
