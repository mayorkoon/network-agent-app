#!/usr/bin/env node
/**
 * agent.js — LinkedIn Network Intelligence Agent v3
 *
 * Designed for 5,000+ connection networks with a tiered scoring approach:
 *
 *   TIER 1 — Fast passive scoring (run daily/weekly on full network)
 *     node agent.js import <csv>        Import LinkedIn CSV → Airtable
 *     node agent.js score               Score all contacts (Gmail + WhatsApp + Twitter)
 *     node agent.js score --rebuild     Force rebuild Gmail index
 *
 *   TIER 2 — Targeted LinkedIn enrichment (run weekly, Warm/Hot contacts only)
 *     node agent.js enrich-linkedin     Scrape LinkedIn messages for top contacts
 *     node agent.js enrich-linkedin --limit 20   Override batch size
 *
 *   UTILITIES
 *     node agent.js dormant             List contacts flagged for re-engagement
 *     node agent.js auth-gmail          One-time Gmail OAuth setup
 *     node agent.js stats               Summary of your network relationship health
 */

import 'dotenv/config';
import chalk from 'chalk';
import fs from 'fs';

import { parseLinkedInCSV, deduplicateProfiles } from './csv-parser.js';
import {
  bulkUpsertProfiles,
  bulkWriteScores,
  loadAllContacts,
  loadContactsByStatus,
} from './airtable-sync.js';
import { scoreAllContacts, formatScore } from './scorer-engine.js';
import { startAuthFlow as gmailAuthFlow } from './scorers/gmail.js';
import { enrichContacts as linkedinEnrich } from './scorers/linkedin.js';

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function validateEnv(keys) {
  const missing = keys.filter(k => !process.env[k]?.trim());
  if (missing.length) {
    console.error(chalk.red(`\n❌ Missing .env variables: ${missing.join(', ')}`));
    console.error(chalk.gray('  Copy .env.example to .env and fill in the values.\n'));
    process.exit(1);
  }
}

function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const [key, val] = argv[i].slice(2).split('=');
      flags[key] = val ?? argv[i + 1] ?? true;
      if (val === undefined && argv[i + 1] && !argv[i + 1].startsWith('--')) i++;
    } else {
      positional.push(argv[i]);
    }
  }
  return { flags, positional };
}

// ─── Commands ─────────────────────────────────────────────────────────────────

async function cmdImport(csvPath) {
  validateEnv(['AIRTABLE_API_KEY', 'AIRTABLE_BASE_ID']);

  if (!csvPath || !fs.existsSync(csvPath)) {
    console.error(chalk.red(`\n❌ File not found: ${csvPath}`));
    console.error(chalk.gray('  Usage: node agent.js import ./connections.csv'));
    process.exit(1);
  }

  console.log(chalk.cyan(`\n📋 Importing: ${csvPath}`));
  const raw = parseLinkedInCSV(csvPath);
  const profiles = deduplicateProfiles(raw);
  console.log(chalk.gray(`   ${raw.length} rows parsed → ${profiles.length} unique contacts\n`));

  const totals = await bulkUpsertProfiles(profiles, {
    onProgress: ({ index, total, result }) => {
      if (index % 50 === 0 || index === total || result.action === 'error') {
        const icon = { created: '🆕', updated: '🔄', skipped: '⏭️', error: '❌' }[result.action];
        process.stdout.write(`\r   ${icon} ${index}/${total} — ${result.name || '?'}`);
      }
    },
  });

  process.stdout.write('\n');
  console.log(chalk.green(`\n✅ Import complete:`));
  console.log(`   🆕 Created: ${totals.created}`);
  console.log(`   🔄 Updated: ${totals.updated}`);
  console.log(`   ⏭️  Skipped: ${totals.skipped}`);
  if (totals.errors.length) console.log(chalk.red(`   ❌ Errors:  ${totals.errors.length}`));
}

async function cmdScore({ rebuild = false } = {}) {
  validateEnv(['AIRTABLE_API_KEY', 'AIRTABLE_BASE_ID']);

  console.log(chalk.cyan('\n📥 Loading contacts from Airtable...'));
  const contacts = await loadAllContacts();
  console.log(chalk.gray(`   ${contacts.length} contacts loaded`));

  if (!contacts.length) {
    console.log(chalk.yellow('\n⚠️  No contacts found. Run import first:'));
    console.log(chalk.gray('   node agent.js import ./connections.csv'));
    return;
  }

  console.log(chalk.cyan('\n🔍 Scoring all contacts (Tier 1: Gmail + WhatsApp + Twitter)...'));
  if (rebuild) console.log(chalk.yellow('   ⚡ Forcing Gmail index rebuild'));

  const scores = await scoreAllContacts(contacts, {
    forceRebuildIndex: rebuild,
    onProgress: ({ index, total, result }) => {
      if (index % 100 === 0 || index === total) {
        process.stdout.write(`\r   Progress: ${index}/${total} contacts scored...`);
      }
    },
  });
  process.stdout.write('\n');

  console.log(chalk.cyan(`\n☁️  Writing ${scores.length} scores to Airtable...`));
  const writeResults = await bulkWriteScores(scores, {
    onProgress: ({ index, total }) => {
      if (index % 100 === 0 || index === total) {
        process.stdout.write(`\r   Writing: ${index}/${total}...`);
      }
    },
  });
  process.stdout.write('\n');

  printScoreSummary(scores, writeResults);
}

async function cmdEnrichLinkedIn({ limit } = {}) {
  validateEnv(['AIRTABLE_API_KEY', 'AIRTABLE_BASE_ID', 'LINKEDIN_SESSION_COOKIE']);

  const batchLimit = limit ?? parseInt(process.env.LINKEDIN_BATCH_LIMIT || '40');

  console.log(chalk.cyan('\n🔍 Loading Warm + Hot contacts for LinkedIn enrichment...'));
  const contacts = await loadContactsByStatus(['Hot', 'Warm']);
  console.log(chalk.gray(`   ${contacts.length} Warm/Hot contacts found`));
  console.log(chalk.gray(`   Batch limit: ${batchLimit} per run (set LINKEDIN_BATCH_LIMIT to change)`));

  const estimatedMin = Math.ceil((Math.min(contacts.length, batchLimit) * 5500) / 60000);
  console.log(chalk.gray(`   Estimated time: ~${estimatedMin} minutes\n`));

  const linkedinScores = await linkedinEnrich(contacts, {
    limit: batchLimit,
    onProgress: ({ index, total, contact, result }) => {
      const icon = result.error ? '⚠️ ' : result.messageCount > 0 ? '💬' : '○';
      const msg = result.error ? result.error :
                  result.messageCount > 0 ? `${result.messageCount} messages, last: ${result.daysSince ?? '?'}d ago` :
                  'no messages found';
      console.log(`   ${icon} [${index}/${total}] ${contact.name} — ${msg}`);
    },
  });

  console.log(chalk.cyan(`\n☁️  Writing LinkedIn enrichment to Airtable...`));
  const writeResults = await bulkWriteScores(
    linkedinScores.map(s => ({
      name: s.name,
      email: s.email,
      platformBreakdown: { linkedin: s },
      // Partial update — only LinkedIn fields
      _linkedinOnly: true,
    })),
  );

  const enriched = linkedinScores.filter(s => s.messageCount > 0).length;
  console.log(chalk.green(`\n✅ LinkedIn enrichment complete:`));
  console.log(`   💬 Contacts with messages found: ${enriched} / ${linkedinScores.length}`);
  console.log(`   🔄 Airtable records updated: ${writeResults.updated}`);
}

async function cmdDormant() {
  validateEnv(['AIRTABLE_API_KEY', 'AIRTABLE_BASE_ID']);

  console.log(chalk.cyan('\n💤 Fetching contacts flagged for re-engagement from Airtable...'));

  // Load Airtable records with re-engagement flag
  const Airtable = (await import('airtable')).default;
  Airtable.configure({ apiKey: process.env.AIRTABLE_API_KEY });
  const table = new Airtable()
    .base(process.env.AIRTABLE_BASE_ID)(process.env.AIRTABLE_TABLE_NAME || 'Contacts');

  const flagged = [];
  await table.select({
    filterByFormula: `{Flag for Re-engagement} = TRUE()`,
    fields: ['Name', 'Title', 'Company', 'Relationship Status', 'Days Since Contact', 'Last Contact Date', 'Active Platforms'],
    sort: [{ field: 'Days Since Contact', direction: 'desc' }],
  }).eachPage((records, next) => {
    for (const r of records) {
      flagged.push({
        name:     r.fields['Name']             || '?',
        title:    r.fields['Title']            || '',
        company:  r.fields['Company']          || '',
        status:   r.fields['Relationship Status'] || 'Unknown',
        days:     r.fields['Days Since Contact'] ?? null,
        lastDate: r.fields['Last Contact Date'] || null,
        platforms: r.fields['Active Platforms'] || 'none',
      });
    }
    next();
  });

  if (!flagged.length) {
    console.log(chalk.green('\n✅ No contacts flagged for re-engagement!'));
    return;
  }

  console.log(chalk.yellow(`\n🚩 ${flagged.length} contacts to re-engage:\n`));
  console.log(chalk.gray('   ' + ['Name'.padEnd(32), 'Status'.padEnd(9), 'Days'.padStart(5), 'Last Contact', 'Company'].join('  ')));
  console.log(chalk.gray('   ' + '─'.repeat(80)));

  for (const c of flagged) {
    const days = c.days != null ? String(c.days).padStart(5) : '  n/a';
    const last = c.lastDate || '    never';
    const statusIcon = { Hot: '🔥', Warm: '☀️ ', Cold: '❄️ ', Dormant: '💤' }[c.status] ?? '?';
    console.log(`   ${statusIcon} ${c.name.padEnd(30)}  ${c.status.padEnd(9)}  ${days}  ${last}  ${c.company}`);
  }

  console.log(chalk.gray(`\n💡 Filter Airtable by "Flag for Re-engagement = checked" for the full view`));
}

async function cmdStats() {
  validateEnv(['AIRTABLE_API_KEY', 'AIRTABLE_BASE_ID']);

  console.log(chalk.cyan('\n📊 Network health stats...\n'));

  const Airtable = (await import('airtable')).default;
  Airtable.configure({ apiKey: process.env.AIRTABLE_API_KEY });
  const table = new Airtable()
    .base(process.env.AIRTABLE_BASE_ID)(process.env.AIRTABLE_TABLE_NAME || 'Contacts');

  const breakdown = { Hot: 0, Warm: 0, Cold: 0, Dormant: 0, Unscored: 0 };
  let total = 0, flagged = 0;

  await table.select({
    fields: ['Relationship Status', 'Flag for Re-engagement'],
  }).eachPage((records, next) => {
    for (const r of records) {
      total++;
      const status = r.fields['Relationship Status'];
      if (status && breakdown[status] !== undefined) breakdown[status]++;
      else breakdown.Unscored++;
      if (r.fields['Flag for Re-engagement']) flagged++;
    }
    next();
  });

  const scored = total - breakdown.Unscored;
  console.log(`   Total contacts:   ${total}`);
  console.log(`   Scored:           ${scored} (${Math.round(scored / total * 100)}%)`);
  console.log('');
  console.log(`   🔥 Hot:           ${breakdown.Hot}`);
  console.log(`   ☀️  Warm:          ${breakdown.Warm}`);
  console.log(`   ❄️  Cold:          ${breakdown.Cold}`);
  console.log(`   💤 Dormant:        ${breakdown.Dormant}`);
  console.log(`   ⬜ Unscored:       ${breakdown.Unscored}`);
  console.log('');
  console.log(`   🚩 Flagged for re-engagement: ${flagged}`);
}

// ─── Summary printers ─────────────────────────────────────────────────────────

function printScoreSummary(scores, writeResults) {
  const bd = scores.reduce((a, s) => { a[s.status] = (a[s.status] || 0) + 1; return a; }, {});
  const flaggedCount = scores.filter(s => s.flagForReengagement).length;

  console.log(chalk.green('\n✅ Scoring complete\n'));
  console.log('   Relationship breakdown:');
  if (bd.Hot)     console.log(`   🔥 Hot:      ${bd.Hot}`);
  if (bd.Warm)    console.log(`   ☀️  Warm:     ${bd.Warm}`);
  if (bd.Cold)    console.log(`   ❄️  Cold:     ${bd.Cold}`);
  if (bd.Dormant) console.log(`   💤 Dormant:  ${bd.Dormant}`);
  console.log(`\n   🚩 Flagged for re-engagement: ${flaggedCount}`);
  console.log(`\n   Airtable: ${writeResults.updated} updated, ${writeResults.notFound} not found`);
  if (writeResults.errors.length) {
    console.log(chalk.red(`   ❌ Write errors: ${writeResults.errors.length}`));
  }
  console.log(chalk.gray('\n   Next: node agent.js enrich-linkedin   (LinkedIn message enrichment)'));
  console.log(chalk.gray('         node agent.js dormant           (who to re-engage)'));
}

// ─── Help ─────────────────────────────────────────────────────────────────────

function printHelp() {
  console.log(`
${chalk.bold.cyan('LinkedIn Network Intelligence Agent')} ${chalk.gray('v3 — optimized for 5K+ networks')}
${'─'.repeat(55)}

${chalk.bold('TIER 1 — Passive scoring (full network, run weekly)')}
  ${chalk.cyan('node agent.js import <csv>')}           Import LinkedIn CSV export
  ${chalk.cyan('node agent.js score')}                  Score all contacts
  ${chalk.cyan('node agent.js score --rebuild')}        Force Gmail index rebuild

${chalk.bold('TIER 2 — LinkedIn enrichment (Warm/Hot only, run weekly)')}
  ${chalk.cyan('node agent.js enrich-linkedin')}        Scrape messages (default 40 contacts)
  ${chalk.cyan('node agent.js enrich-linkedin --limit 20')}

${chalk.bold('Utilities')}
  ${chalk.cyan('node agent.js dormant')}                List contacts to re-engage
  ${chalk.cyan('node agent.js stats')}                  Network health summary
  ${chalk.cyan('node agent.js auth-gmail')}             One-time Gmail OAuth setup

${chalk.bold('Platforms:')}
  ✅ Gmail         OAuth API — index built once, cached 24h
  ✅ WhatsApp      Manual .txt exports in ./whatsapp-exports/
  ✅ LinkedIn msgs Playwright — targets Warm/Hot contacts only
  ⏳ Twitter/X     Ready — add keys to .env when you have API access

${chalk.bold('Recommended schedule:')}
  Weekly:  node agent.js score
  Weekly:  node agent.js enrich-linkedin
  Monthly: node agent.js score --rebuild   (fresh Gmail index)
`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

const [,, command, ...rest] = process.argv;
const { flags, positional } = parseArgs(rest);

try {
  switch (command) {
    case 'import':
      await cmdImport(positional[0] || flags.file);
      break;
    case 'score':
      await cmdScore({ rebuild: flags.rebuild === true || flags.rebuild === 'true' });
      break;
    case 'enrich-linkedin':
      await cmdEnrichLinkedIn({ limit: flags.limit ? parseInt(flags.limit) : undefined });
      break;
    case 'dormant':
      await cmdDormant();
      break;
    case 'stats':
      await cmdStats();
      break;
    case 'auth-gmail':
      validateEnv(['GMAIL_CLIENT_ID', 'GMAIL_CLIENT_SECRET']);
      await gmailAuthFlow();
      break;
    default:
      printHelp();
  }
} catch (err) {
  console.error(chalk.red('\n❌ Error:'), err.message);
  if (process.env.DEBUG) console.error(err.stack);
  process.exit(1);
}
