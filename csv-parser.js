/**
 * csv-parser.js
 * Parses LinkedIn's official Connections CSV export.
 *
 * To export: LinkedIn → Settings → Data Privacy → Get a copy of your data
 *            → Connections → Request archive → download connections.csv
 *
 * LinkedIn CSV columns:
 *   First Name, Last Name, URL, Email Address, Company, Position, Connected On
 */

import fs from 'fs';
import { parse } from 'csv-parse/sync';

export function parseLinkedInCSV(csvPath) {
  const content = fs.readFileSync(csvPath, 'utf-8');
  const lines = content.split('\n');

  // LinkedIn adds 2–3 junk header lines before the real column headers
  let headerIndex = 0;
  for (let i = 0; i < Math.min(lines.length, 6); i++) {
    if (lines[i].includes('First Name') || lines[i].includes('Last Name')) {
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

  return records
    .map(row => {
      const firstName = row['First Name'] || '';
      const lastName  = row['Last Name']  || '';
      const name = [firstName, lastName].filter(Boolean).join(' ').trim();

      const connectedOn = row['Connected On'] || '';
      let connectedDate = null;
      try {
        const d = new Date(connectedOn);
        if (!isNaN(d)) connectedDate = d.toISOString().split('T')[0];
      } catch {}

      return {
        name:           name || null,
        title:          row['Position']      || null,
        company:        row['Company']       || null,
        email:          row['Email Address'] || null,
        linkedin_url:   row['URL']           || null,
        connected_date: connectedDate,
        _source: 'CSV',
      };
    })
    .filter(r => r.name);
}

export function deduplicateProfiles(profiles) {
  const seen = new Map();
  for (const p of profiles) {
    const key = p.linkedin_url || p.name?.toLowerCase().trim();
    if (!key) continue;
    if (!seen.has(key)) {
      seen.set(key, p);
    } else {
      // Merge — keep richest version of each field
      const existing = seen.get(key);
      for (const [k, v] of Object.entries(p)) {
        if (!existing[k] && v) existing[k] = v;
      }
    }
  }
  return [...seen.values()];
}
