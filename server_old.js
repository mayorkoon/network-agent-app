/**
 * server.js — LinkedIn Network Intelligence Agent
 * Start: node server.js  |  Open: http://localhost:3000
 */

import 'dotenv/config';
import express from 'express';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = parseInt(process.env.PORT || '3000', 10);
app.use(express.json());

// ─── Multer lazy loader ───────────────────────────────────────────────────────
async function getUpload() {
  try {
    const multer = (await import('multer')).default;
    return multer({ dest: '/tmp/net-agent-uploads/' });
  } catch {
    return null;
  }
}

// ─── SSE helper ───────────────────────────────────────────────────────────────
function sse(res) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
  return {
    log:      (message, level = 'info')  => send({ type: 'log', message, level }),
    progress: (current, total, label='') => send({ type: 'progress', current, total, label, pct: total > 0 ? Math.round(current/total*100) : 0 }),
    done:     (summary)                  => { send({ type: 'done', ...summary }); res.end(); },
    error:    (message)                  => { send({ type: 'error', message }); res.end(); },
  };
}

// Add this near the top of server.js, before Gmail is used
const TOKEN_PATH = path.join(process.cwd(), '.token-gmail.json');
if (!fs.existsSync(TOKEN_PATH) && process.env.GMAIL_TOKEN_JSON) {
  fs.writeFileSync(TOKEN_PATH, process.env.GMAIL_TOKEN_JSON);
  console.log('✅ Gmail token restored from env');
}

// ─── Status ───────────────────────────────────────────────────────────────────
app.get('/api/status', (req, res) => {
  const tokenPath = path.join(process.cwd(), '.token-gmail.json');
  const waDir = process.env.WHATSAPP_EXPORTS_DIR || './whatsapp-exports';
  let waHasTxt = false;
  try { waHasTxt = fs.existsSync(waDir) && fs.readdirSync(waDir).some(f => f.endsWith('.txt')); } catch {}
  res.json({
    gmail:    { configured: !!(process.env.GMAIL_CLIENT_ID && process.env.GMAIL_CLIENT_SECRET), authorized: fs.existsSync(tokenPath) },
    airtable: { configured: !!(process.env.AIRTABLE_API_KEY && process.env.AIRTABLE_BASE_ID) },
    linkedin: { configured: !!(process.env.LINKEDIN_SESSION_COOKIE?.trim()) },
    whatsapp: { configured: waHasTxt },
    twitter:  { configured: !!(process.env.TWITTER_API_KEY?.trim()) },
  });
});

// ─── Stats ────────────────────────────────────────────────────────────────────
app.get('/api/stats', async (req, res) => {
  if (!process.env.AIRTABLE_API_KEY)
    return res.json({ total: 0, breakdown: {}, flagged: 0, unconfigured: true });
  try {
    const Airtable = (await import('airtable')).default;
    Airtable.configure({ apiKey: process.env.AIRTABLE_API_KEY });
    const table = new Airtable().base(process.env.AIRTABLE_BASE_ID)(process.env.AIRTABLE_TABLE_NAME || 'Contacts');
    const breakdown = { Hot: 0, Warm: 0, Cold: 0, Dormant: 0, Unscored: 0 };
    let total = 0, flagged = 0;
    await table.select({ fields: ['Relationship Status', 'Flag for Re-engagement'] })
      .eachPage((records, next) => {
        for (const r of records) {
          total++;
          const s = r.fields['Relationship Status'];
          if (s && breakdown[s] !== undefined) breakdown[s]++; else breakdown.Unscored++;
          if (r.fields['Flag for Re-engagement']) flagged++;
        }
        next();
      });
    res.json({ total, breakdown, flagged });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Dormant ──────────────────────────────────────────────────────────────────
app.get('/api/dormant', async (req, res) => {
  if (!process.env.AIRTABLE_API_KEY) return res.status(400).json({ error: 'Airtable not configured' });
  try {
    const Airtable = (await import('airtable')).default;
    Airtable.configure({ apiKey: process.env.AIRTABLE_API_KEY });
    const table = new Airtable().base(process.env.AIRTABLE_BASE_ID)(process.env.AIRTABLE_TABLE_NAME || 'Contacts');
    const contacts = [];
    await table.select({
      filterByFormula: `{Flag for Re-engagement} = TRUE()`,
      fields: ['Name', 'Title', 'Company', 'Relationship Status', 'Days Since Contact', 'Last Contact Date'],
      sort: [{ field: 'Days Since Contact', direction: 'desc' }],
      maxRecords: 300,
    }).eachPage((records, next) => {
      for (const r of records) contacts.push({
        name:     r.fields['Name'] || '?',
        title:    r.fields['Title'] || '',
        company:  r.fields['Company'] || '',
        status:   r.fields['Relationship Status'] || 'Unknown',
        daysSince:r.fields['Days Since Contact'] ?? null,
        lastDate: r.fields['Last Contact Date'] || null,
      });
      next();
    });
    res.json({ contacts });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Import ───────────────────────────────────────────────────────────────────
app.post('/api/import', async (req, res) => {
  const stream = sse(res);
  const upload = await getUpload();
  if (!upload) return stream.error('multer not installed. Run: npm install');

  upload.single('csv')(req, res, async (err) => {
    if (err) return stream.error('Upload error: ' + err.message);
    if (!req.file) return stream.error('No CSV file received.');

    try {
      stream.log('📋 Parsing LinkedIn CSV...');
      const { parseLinkedInCSV, deduplicateProfiles } = await import('./csv-parser.js');
      const raw = parseLinkedInCSV(req.file.path);
      const profiles = deduplicateProfiles(raw);
      stream.log(`✓ ${raw.length} rows → ${profiles.length} unique contacts`, 'success');

      if (!process.env.AIRTABLE_API_KEY) {
        fs.unlink(req.file.path, () => {});
        return stream.error('Airtable not configured — set AIRTABLE_API_KEY in .env');
      }

      stream.log('☁️  Syncing to Airtable...');
      const { bulkUpsertProfiles } = await import('./airtable-sync.js');
      let lastPct = -1;
      const totals = await bulkUpsertProfiles(profiles, {
        onProgress: ({ index, total, result }) => {
          stream.progress(index, total, result.name || '');
          const pct = Math.floor(index / total * 100);
          if (pct % 10 === 0 && pct !== lastPct) {
            lastPct = pct;
            stream.log(`  ${pct}% — ${result.name || '?'} (${result.action})`);
          }
          if (result.action === 'error') stream.log(`  ⚠️ ${result.name}: ${result.error}`, 'warn');
        },
      });

      fs.unlink(req.file.path, () => {});
      stream.log(`✅ ${totals.created} created, ${totals.updated} updated, ${totals.skipped} skipped`, 'success');
      stream.done({ created: totals.created, updated: totals.updated, skipped: totals.skipped, errors: totals.errors.length, total: profiles.length });
    } catch (err) {
      fs.unlink(req.file?.path, () => {});
      stream.error(err.message);
    }
  });
});

// ─── Score ────────────────────────────────────────────────────────────────────
app.post('/api/score', async (req, res) => {
  const stream = sse(res);
  const rebuild = req.body?.rebuild === true;

  try {
    if (!process.env.AIRTABLE_API_KEY) return stream.error('Airtable not configured');

    stream.log('📥 Loading contacts from Airtable...');
    const { loadAllContacts, bulkWriteScores } = await import('./airtable-sync.js');
    const contacts = await loadAllContacts();
    if (!contacts.length) return stream.error('No contacts in Airtable. Import a CSV first.');

    stream.log(`📊 Scoring ${contacts.length} contacts...`);
    if (!process.env.GMAIL_CLIENT_ID) stream.log('⚠️  Gmail not configured — Gmail scores will be 0', 'warn');
    else if (!fs.existsSync('.token-gmail.json')) stream.log('⚠️  Gmail not authorized — visit /oauth/start', 'warn');

    const { scoreAllContacts } = await import('./scorer-engine.js');
    let lastPct = -1;
    const scores = await scoreAllContacts(contacts, {
      forceRebuildIndex: rebuild,
      onProgress: ({ index, total, result }) => {
        stream.progress(index, total, result.name);
        const pct = Math.floor(index / total * 100);
        if (pct % 5 === 0 && pct !== lastPct) {
          lastPct = pct;
          stream.log(`  [${index}/${total}] ${result.name} — ${result.status} ${result.compositeScore}/100`);
        }
      },
    });

    stream.log(`☁️  Writing scores to Airtable...`);
    let wPct = -1;
    const wr = await bulkWriteScores(scores, {
      onProgress: ({ index, total }) => {
        stream.progress(index, total, 'Writing scores');
        const pct = Math.floor(index / total * 100);
        if (pct % 20 === 0 && pct !== wPct) { wPct = pct; stream.log(`  Airtable: ${pct}%`); }
      },
    });

    const bd = scores.reduce((a, s) => { a[s.status] = (a[s.status] || 0) + 1; return a; }, {});
    const flagged = scores.filter(s => s.flagForReengagement).length;
    stream.log(`✅ 🔥${bd.Hot||0} Hot  ☀️${bd.Warm||0} Warm  ❄️${bd.Cold||0} Cold  💤${bd.Dormant||0} Dormant  🚩${flagged} flagged`, 'success');
    stream.done({ total: scores.length, breakdown: bd, flagged, airtableUpdated: wr.updated });
  } catch (err) { stream.error(err.stack || err.message); }
});

// ─── Enrich ───────────────────────────────────────────────────────────────────
app.post('/api/enrich', async (req, res) => {
  const stream = sse(res);
  const limit = parseInt(req.body?.limit) || parseInt(process.env.LINKEDIN_BATCH_LIMIT || '40');

  try {
    if (!process.env.LINKEDIN_SESSION_COOKIE?.trim()) return stream.error('LINKEDIN_SESSION_COOKIE not set in .env');
    if (!process.env.AIRTABLE_API_KEY) return stream.error('Airtable not configured');

    stream.log('🔍 Loading Warm + Hot contacts...');
    const { loadContactsByStatus } = await import('./airtable-sync.js');
    const contacts = await loadContactsByStatus(['Hot', 'Warm']);
    if (!contacts.length) return stream.error('No Warm/Hot contacts. Run Score Network first.');

    const toEnrich = contacts.slice(0, limit);
    stream.log(`🌐 Enriching ${toEnrich.length} contacts (~${Math.ceil(toEnrich.length * 5.5 / 60)} min)...`);
    stream.log('⚠️  Playwright will open a browser. Do not close it.', 'warn');

    const { enrichContacts } = await import('./scorers/linkedin.js');
    const results = await enrichContacts(toEnrich, {
      limit,
      onProgress: ({ index, total, contact, result }) => {
        stream.progress(index, total, contact.name);
        if (result.error)         stream.log(`  ⚠️  ${contact.name}: ${result.error}`, 'warn');
        else if (result.messageCount > 0) stream.log(`  💬 ${contact.name}: ${result.messageCount} msgs, ${result.daysSince??'?'}d ago`, 'success');
        else                              stream.log(`  ○  ${contact.name}: no messages`);
      },
    });

    const enriched = results.filter(r => !r.error && r.messageCount > 0).length;
    stream.log(`✅ ${enriched}/${results.length} had LinkedIn messages`, 'success');
    stream.done({ total: results.length, enriched, noMessages: results.length - enriched });
  } catch (err) { stream.error(err.stack || err.message); }
});

// ─── Gmail OAuth ──────────────────────────────────────────────────────────────
app.get('/oauth/start', async (req, res) => {
  if (!process.env.GMAIL_CLIENT_ID) return res.status(400).send('Set GMAIL_CLIENT_ID in .env first');
  try {
    const { google } = await import('googleapis');
    //const auth = new google.auth.OAuth2(process.env.GMAIL_CLIENT_ID, process.env.GMAIL_CLIENT_SECRET, `http://localhost:${PORT}/oauth/callback`);
    const auth = new google.auth.OAuth2(process.env.GMAIL_CLIENT_ID, process.env.GMAIL_CLIENT_SECRET, process.env.GMAIL_REDIRECT_URI);
    res.redirect(auth.generateAuthUrl({ access_type: 'offline', scope: ['https://www.googleapis.com/auth/gmail.readonly'], prompt: 'consent' }));
  } catch (err) { res.status(500).send(err.message); }
});

app.get('/oauth/callback', async (req, res) => {
  const { code, error } = req.query;
  if (error) return res.status(400).send('OAuth error: ' + error);
  if (!code)  return res.status(400).send('No code received');
  try {
    const { google } = await import('googleapis');
    //const auth = new google.auth.OAuth2(process.env.GMAIL_CLIENT_ID, process.env.GMAIL_CLIENT_SECRET, `http://localhost:${PORT}/oauth/callback`);
    const auth = new google.auth.OAuth2(process.env.GMAIL_CLIENT_ID, process.env.GMAIL_CLIENT_SECRET, process.env.GMAIL_REDIRECT_URI);
    const { tokens } = await auth.getToken(code);
    fs.writeFileSync(path.join(process.cwd(), '.token-gmail.json'), JSON.stringify(tokens, null, 2));
    res.send(`<html><body style="font-family:monospace;background:#07080d;color:#22d3a3;display:flex;align-items:center;justify-content:center;height:100vh;margin:0"><div style="text-align:center"><div style="font-size:48px;margin-bottom:16px">✅</div><div style="font-size:18px">Gmail authorized. Close this tab.</div><script>setTimeout(()=>window.close(),2000)<\/script></div></body></html>`);
  } catch (err) { res.status(500).send('Token exchange failed: ' + err.message); }
});

// ─── Dashboard UI ─────────────────────────────────────────────────────────────
const BATCH = process.env.LINKEDIN_BATCH_LIMIT || '40';
app.get('/', (_req, res) => { res.setHeader('Content-Type','text/html'); res.send(buildHTML(BATCH)); });

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n╔═══════════════════════════════════════╗`);
  console.log(`║  Network Intelligence Agent  v3.0    ║`);
  console.log(`╚═══════════════════════════════════════╝`);
  console.log(`\n  🌐  http://localhost:${PORT}`);
  console.log(`  🔐  Gmail auth:  http://localhost:${PORT}/oauth/start\n`);
  const checks = [
    ['AIRTABLE_API_KEY',         process.env.AIRTABLE_API_KEY],
    ['AIRTABLE_BASE_ID',         process.env.AIRTABLE_BASE_ID],
    ['GMAIL_CLIENT_ID',          process.env.GMAIL_CLIENT_ID],
    ['LINKEDIN_SESSION_COOKIE',  process.env.LINKEDIN_SESSION_COOKIE],
  ];
  for (const [k, v] of checks) console.log(`  ${v ? '✓' : '✗ (not set)'}  ${k}`);
  console.log('');
});

// ─── HTML ─────────────────────────────────────────────────────────────────────
function buildHTML(batchLimit) { return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Network Intelligence</title>
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:ital,wght@0,400;0,500;1,400&family=Syne:wght@400;600;700;800&display=swap" rel="stylesheet">
<style>
:root{--bg:#07080d;--s1:#0d0f1a;--s2:#111420;--b1:#1a1d2e;--b2:#242840;--ac:#4f6ef7;--acg:rgba(79,110,247,.3);--gr:#22d3a3;--ye:#f0b429;--re:#f43f5e;--tx:#dde4f0;--mu:#5a6480;--sans:'Syne',sans-serif;--mono:'IBM Plex Mono',monospace}
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
body{background:var(--bg);color:var(--tx);font-family:var(--sans);min-height:100vh}
body::before{content:'';position:fixed;inset:0;pointer-events:none;z-index:0;background-image:linear-gradient(rgba(79,110,247,.022) 1px,transparent 1px),linear-gradient(90deg,rgba(79,110,247,.022) 1px,transparent 1px);background-size:48px 48px}
.app{position:relative;z-index:1;max-width:1060px;margin:0 auto;padding:34px 18px 80px}
header{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;flex-wrap:wrap;margin-bottom:36px}
.brand h1{font-size:21px;font-weight:800;background:linear-gradient(120deg,#fff 0%,#8fa4ff 100%);-webkit-background-clip:text;-webkit-text-fill-color:transparent}
.brand p{font-family:var(--mono);font-size:11px;color:var(--mu);margin-top:3px}
.pills{display:flex;gap:7px;flex-wrap:wrap;align-items:center}
.pill{display:flex;align-items:center;gap:5px;background:var(--s1);border:1px solid var(--b1);border-radius:20px;padding:4px 10px;font-size:10px;font-family:var(--mono);color:var(--mu);text-transform:uppercase;letter-spacing:.5px}
.dot{width:6px;height:6px;border-radius:50%;background:var(--b2);transition:background .3s}
.dot.ok{background:var(--gr);box-shadow:0 0 5px var(--gr)}.dot.warn{background:var(--ye)}.dot.off{background:var(--mu)}
.stats{display:grid;grid-template-columns:repeat(6,1fr);gap:10px;margin-bottom:28px}
@media(max-width:680px){.stats{grid-template-columns:repeat(3,1fr)}}
@media(max-width:400px){.stats{grid-template-columns:repeat(2,1fr)}}
.sc{background:var(--s1);border:1px solid var(--b1);border-radius:10px;padding:14px 10px;position:relative;overflow:hidden}
.sc::before{content:'';position:absolute;top:0;left:0;right:0;height:2px}
.sc.total::before{background:linear-gradient(90deg,var(--ac),#818cf8)}.sc.hot::before{background:linear-gradient(90deg,#f97316,#ef4444)}.sc.warm::before{background:linear-gradient(90deg,#f0b429,#fcd34d)}.sc.cold::before{background:linear-gradient(90deg,#38bdf8,#7dd3fc)}.sc.dormant::before{background:linear-gradient(90deg,#475569,#64748b)}.sc.flagged::before{background:linear-gradient(90deg,var(--re),#fb7185)}
.sc-i{font-size:14px;margin-bottom:5px}.sc-n{font-size:26px;font-weight:800;font-family:var(--mono);color:#fff;line-height:1}.sc-l{font-size:10px;color:var(--mu);text-transform:uppercase;letter-spacing:.7px;margin-top:4px}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:22px}
@media(max-width:600px){.grid{grid-template-columns:1fr}}
.card{background:var(--s1);border:1px solid var(--b1);border-radius:13px;padding:20px;transition:border-color .2s}
.card:hover{border-color:var(--b2)}
.ch{display:flex;align-items:center;gap:9px;margin-bottom:8px}
.ci{width:34px;height:34px;border-radius:8px;display:flex;align-items:center;justify-content:center;font-size:15px;flex-shrink:0}
.ci-b{background:rgba(79,110,247,.15)}.ci-g{background:rgba(34,211,163,.12)}.ci-p{background:rgba(139,92,246,.15)}.ci-o{background:rgba(240,180,41,.12)}
.ct{font-size:14px;font-weight:700}.cd{font-size:11px;color:var(--mu);line-height:1.55;margin-bottom:13px}
.drop{border:1px dashed var(--b2);border-radius:8px;padding:13px;text-align:center;cursor:pointer;transition:all .2s;margin-bottom:11px}
.drop:hover,.drop.over{border-color:var(--ac);background:rgba(79,110,247,.04)}
.drop p{font-size:11px;color:var(--mu);font-family:var(--mono)}.drop .pk{color:var(--gr)}
.row{display:flex;gap:7px;align-items:center;flex-wrap:wrap}
.btn{display:inline-flex;align-items:center;gap:6px;padding:8px 16px;border-radius:7px;font-size:12px;font-weight:700;font-family:var(--sans);cursor:pointer;border:none;transition:all .15s;white-space:nowrap}
.btn:disabled{opacity:.4;cursor:not-allowed}
.btn-p{background:var(--ac);color:#fff}.btn-p:hover:not(:disabled){background:#6378f8;transform:translateY(-1px);box-shadow:0 4px 14px var(--acg)}
.btn-g{background:var(--s2);color:var(--tx);border:1px solid var(--b1)}.btn-g:hover:not(:disabled){border-color:var(--b2)}
.tog{display:flex;align-items:center;gap:6px;cursor:pointer;user-select:none}
.tt{width:28px;height:16px;background:var(--b1);border-radius:8px;position:relative;transition:background .2s;flex-shrink:0}
.tt::after{content:'';position:absolute;width:10px;height:10px;background:#fff;border-radius:50%;top:3px;left:3px;transition:transform .2s}
.tt.on{background:var(--ac)}.tt.on::after{transform:translateX(12px)}
.tog span{font-size:10px;color:var(--mu);font-family:var(--mono)}
.pw{margin-top:9px;display:none}.pw.show{display:block}
.pm{display:flex;justify-content:space-between;font-size:10px;color:var(--mu);font-family:var(--mono);margin-bottom:5px}
.pb{height:3px;background:var(--b1);border-radius:3px;overflow:hidden}
.pf{height:100%;background:linear-gradient(90deg,var(--ac),#818cf8);border-radius:3px;transition:width .22s;width:0%}
.bn{margin-top:9px;padding:9px 12px;border-radius:7px;font-size:11px;font-family:var(--mono);display:none}
.bn.ok{background:rgba(34,211,163,.08);border:1px solid rgba(34,211,163,.2);color:var(--gr)}
.bn.er{background:rgba(244,63,94,.08);border:1px solid rgba(244,63,94,.2);color:var(--re)}
.an{background:rgba(79,110,247,.07);border:1px solid rgba(79,110,247,.18);border-radius:8px;padding:9px 13px;font-size:11px;display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:11px}
.an p{color:var(--mu)}.an a{color:var(--ac);font-weight:700;text-decoration:none}.an a:hover{text-decoration:underline}
.console{background:var(--s1);border:1px solid var(--b1);border-radius:13px;overflow:hidden;margin-bottom:26px}
.ch2{display:flex;align-items:center;justify-content:space-between;padding:10px 16px;border-bottom:1px solid var(--b1);background:var(--s2)}
.cdots{display:flex;gap:5px}.cdots i{display:block;width:9px;height:9px;border-radius:50%}
.cdots i:nth-child(1){background:#ef4444}.cdots i:nth-child(2){background:#f0b429}.cdots i:nth-child(3){background:#22c55e}
.ctitle{font-size:10px;font-family:var(--mono);color:var(--mu);text-transform:uppercase;letter-spacing:.8px}
.cbody{height:250px;overflow-y:auto;padding:12px 16px;font-family:var(--mono);font-size:11px;line-height:1.8}
.cbody::-webkit-scrollbar{width:3px}.cbody::-webkit-scrollbar-thumb{background:var(--b2);border-radius:2px}
.ll{display:flex;gap:9px}.ll .ts{color:#2a3040;flex-shrink:0;font-size:10px;line-height:1.8}
.ll.info .msg{color:#68789a}.ll.success .msg{color:var(--gr)}.ll.warn .msg{color:var(--ye)}.ll.error .msg{color:var(--re)}
.ce{color:#2a3040;font-size:11px;font-style:italic}
.dts{display:none}.dth{display:flex;align-items:center;justify-content:space-between;margin-bottom:11px}
.dtt{font-size:13px;font-weight:700;display:flex;align-items:center;gap:8px}
.badge{background:rgba(244,63,94,.15);color:var(--re);padding:2px 8px;border-radius:9px;font-size:10px;font-family:var(--mono)}
.tw{background:var(--s1);border:1px solid var(--b1);border-radius:13px;overflow:hidden}
table{width:100%;border-collapse:collapse;font-size:12px}
thead th{text-align:left;padding:8px 12px;font-size:10px;text-transform:uppercase;letter-spacing:.6px;color:var(--mu);border-bottom:1px solid var(--b1);font-weight:500}
tbody tr{border-bottom:1px solid var(--b1);transition:background .1s}
tbody tr:last-child{border-bottom:none}
tbody tr:hover{background:rgba(255,255,255,.018)}
td{padding:8px 12px}
td.tn{font-weight:600;color:#fff}
td.tn small{display:block;font-size:10px;color:var(--mu);font-weight:400;margin-top:1px}
td.tc{color:var(--mu)}td.td{font-family:var(--mono)}
td.ts span{padding:2px 8px;border-radius:8px;font-size:10px;font-family:var(--mono)}
.cold{background:rgba(56,189,248,.1);color:#38bdf8}.dormant{background:rgba(71,85,105,.2);color:#94a3b8}
.warm{background:rgba(240,180,41,.1);color:var(--ye)}.hot{background:rgba(249,115,22,.1);color:#f97316}
.spin{display:inline-block;width:10px;height:10px;border:2px solid rgba(255,255,255,.2);border-top-color:#fff;border-radius:50%;animation:spin .5s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
</style>
</head>
<body>
<div class="app">

<header>
  <div class="brand">
    <h1>Network Intelligence</h1>
    <p>// linkedin relationship scoring agent  v3.0</p>
  </div>
  <div class="pills">
    <div class="pill"><div class="dot" id="d-airtable"></div>Airtable</div>
    <div class="pill"><div class="dot" id="d-gmail"></div>Gmail</div>
    <div class="pill"><div class="dot" id="d-linkedin"></div>LinkedIn</div>
    <div class="pill"><div class="dot" id="d-whatsapp"></div>WhatsApp</div>
    <div class="pill"><div class="dot" id="d-twitter"></div>Twitter</div>
  </div>
</header>

<div class="stats">
  <div class="sc total">  <div class="sc-i">🌐</div><div class="sc-n" id="s-total">—</div>  <div class="sc-l">Contacts</div></div>
  <div class="sc hot">    <div class="sc-i">🔥</div><div class="sc-n" id="s-hot">—</div>    <div class="sc-l">Hot</div></div>
  <div class="sc warm">   <div class="sc-i">☀️</div><div class="sc-n" id="s-warm">—</div>   <div class="sc-l">Warm</div></div>
  <div class="sc cold">   <div class="sc-i">❄️</div><div class="sc-n" id="s-cold">—</div>   <div class="sc-l">Cold</div></div>
  <div class="sc dormant"><div class="sc-i">💤</div><div class="sc-n" id="s-dormant">—</div><div class="sc-l">Dormant</div></div>
  <div class="sc flagged"><div class="sc-i">🚩</div><div class="sc-n" id="s-flagged">—</div><div class="sc-l">Re-engage</div></div>
</div>

<div class="grid">

  <div class="card">
    <div class="ch"><div class="ci ci-b">📋</div><div class="ct">Import Connections</div></div>
    <p class="cd">Upload your LinkedIn CSV export. Creates or updates contact records in Airtable.</p>
    <div class="drop" id="dz" onclick="document.getElementById('fi').click()">
      <p id="dl">Drop connections.csv here or click to browse</p>
      <input type="file" id="fi" accept=".csv" style="display:none" onchange="onFile(this)">
    </div>
    <div class="row">
      <button class="btn btn-p" id="importBtn" onclick="doImport()" disabled>Import CSV</button>
    </div>
    <div class="pw" id="importPw">
      <div class="pm"><span id="importLbl">Importing...</span><span id="importPct">0%</span></div>
      <div class="pb"><div class="pf" id="importBar"></div></div>
    </div>
    <div class="bn" id="importBn"></div>
  </div>

  <div class="card">
    <div class="ch"><div class="ci ci-g">📊</div><div class="ct">Score Network</div></div>
    <p class="cd">Scores all contacts via Gmail sent-mail index, WhatsApp exports & Twitter. Writes 0–100 scores to Airtable.</p>
    <div class="an" id="gmailNote" style="display:none">
      <p>Gmail not authorized</p>
      <a href="/oauth/start" target="_blank">Authorize Gmail →</a>
    </div>
    <div class="row">
      <button class="btn btn-p" id="scoreBtn" onclick="doScore()">Score All</button>
      <label class="tog" onclick="togRebuild()">
        <div class="tt" id="rebuildTt"></div>
        <span>Rebuild Gmail index</span>
      </label>
    </div>
    <div class="pw" id="scorePw">
      <div class="pm"><span id="scoreLbl">Scoring...</span><span id="scorePct">0%</span></div>
      <div class="pb"><div class="pf" id="scoreBar"></div></div>
    </div>
    <div class="bn" id="scoreBn"></div>
  </div>

  <div class="card">
    <div class="ch"><div class="ci ci-p">💬</div><div class="ct">Enrich via LinkedIn</div></div>
    <p class="cd">Playwright scrapes LinkedIn message history for Warm + Hot contacts. Run weekly — max ${batchLimit} contacts/run.</p>
    <div class="row">
      <button class="btn btn-p" id="enrichBtn" onclick="doEnrich()">Enrich LinkedIn</button>
      <span style="font-size:10px;color:var(--mu);font-family:var(--mono)">limit: ${batchLimit}/run</span>
    </div>
    <div class="pw" id="enrichPw">
      <div class="pm"><span id="enrichLbl">Enriching...</span><span id="enrichPct">0%</span></div>
      <div class="pb"><div class="pf" id="enrichBar"></div></div>
    </div>
    <div class="bn" id="enrichBn"></div>
  </div>

  <div class="card">
    <div class="ch"><div class="ci ci-o">🚩</div><div class="ct">Re-engagement List</div></div>
    <p class="cd">Contacts flagged for re-engagement — dormant relationships or no contact in 90+ days.</p>
    <div class="row">
      <button class="btn btn-p" onclick="loadDormant()">Load List</button>
      <button class="btn btn-g" onclick="refreshStats()">↻ Refresh</button>
    </div>
  </div>

</div>

<div class="console">
  <div class="ch2">
    <div class="cdots"><i></i><i></i><i></i></div>
    <div class="ctitle">activity log</div>
    <button class="btn btn-g" style="padding:3px 10px;font-size:10px" onclick="clearLog()">Clear</button>
  </div>
  <div class="cbody" id="log"><div class="ce">No activity yet...</div></div>
</div>

<div class="dts" id="dts">
  <div class="dth">
    <div class="dtt">🚩 Re-engagement List <span class="badge" id="dtBadge">0</span></div>
  </div>
  <div class="tw">
    <table>
      <thead><tr><th>Name</th><th>Company</th><th>Status</th><th>Days Since</th><th>Last Contact</th></tr></thead>
      <tbody id="dtBody"></tbody>
    </table>
  </div>
</div>

</div>
<script>
let csvFile=null,rebuild=false,logEmpty=true;
(async()=>{await loadStatus();await refreshStats();})();
async function loadStatus(){
  try{
    const s=await fetch('/api/status').then(r=>r.json());
    dot('airtable',s.airtable.configured?'ok':'off');
    dot('gmail',s.gmail.authorized?'ok':s.gmail.configured?'warn':'off');
    dot('linkedin',s.linkedin.configured?'ok':'off');
    dot('whatsapp',s.whatsapp.configured?'ok':'off');
    dot('twitter',s.twitter.configured?'ok':'off');
    if(s.gmail.configured&&!s.gmail.authorized)document.getElementById('gmailNote').style.display='flex';
  }catch(e){lg('Status check failed: '+e.message,'warn');}
}
function dot(k,c){const el=document.getElementById('d-'+k);if(el)el.className='dot '+c;}
async function refreshStats(){
  try{
    const s=await fetch('/api/stats').then(r=>r.json());
    if(s.error)return;
    document.getElementById('s-total').textContent=s.total??'—';
    document.getElementById('s-hot').textContent=s.breakdown?.Hot??'—';
    document.getElementById('s-warm').textContent=s.breakdown?.Warm??'—';
    document.getElementById('s-cold').textContent=s.breakdown?.Cold??'—';
    document.getElementById('s-dormant').textContent=s.breakdown?.Dormant??'—';
    document.getElementById('s-flagged').textContent=s.flagged??'—';
  }catch{}
}
const dz=document.getElementById('dz');
dz.addEventListener('dragover',e=>{e.preventDefault();dz.classList.add('over');});
dz.addEventListener('dragleave',()=>dz.classList.remove('over'));
dz.addEventListener('drop',e=>{e.preventDefault();dz.classList.remove('over');const f=e.dataTransfer.files[0];if(f?.name.endsWith('.csv'))setFile(f);});
function onFile(inp){if(inp.files[0])setFile(inp.files[0]);}
function setFile(f){csvFile=f;document.getElementById('dl').innerHTML='<span class="pk">📎 '+esc(f.name)+'</span>';document.getElementById('importBtn').disabled=false;}
function togRebuild(){rebuild=!rebuild;document.getElementById('rebuildTt').classList.toggle('on',rebuild);}
function lg(msg,lvl='info'){
  const el=document.getElementById('log');
  if(logEmpty){el.innerHTML='';logEmpty=false;}
  const ts=new Date().toLocaleTimeString('en',{hour12:false});
  const d=document.createElement('div');d.className='ll '+lvl;
  d.innerHTML='<span class="ts">'+ts+'</span><span class="msg">'+esc(msg)+'</span>';
  el.appendChild(d);el.scrollTop=el.scrollHeight;
}
function clearLog(){document.getElementById('log').innerHTML='<div class="ce">No activity yet...</div>';logEmpty=true;}
function esc(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}
function sp(id,pct,lbl){
  document.getElementById(id+'Pw').classList.add('show');
  document.getElementById(id+'Bar').style.width=pct+'%';
  document.getElementById(id+'Pct').textContent=pct+'%';
  if(lbl!==undefined)document.getElementById(id+'Lbl').textContent=lbl;
}
function cp(id){document.getElementById(id+'Pw').classList.remove('show');document.getElementById(id+'Bar').style.width='0%';document.getElementById(id+'Pct').textContent='0%';}
function bn(id,msg,type='ok'){const el=document.getElementById(id+'Bn');el.textContent=msg;el.className='bn '+type;el.style.display='block';setTimeout(()=>el.style.display='none',12000);}
function runSSE(url,opts,pid,onDone){
  return new Promise((res,rej)=>{
    fetch(url,opts).then(r=>{
      if(!r.ok){r.text().then(t=>rej(new Error(t)));return;}
      const reader=r.body.getReader(),dec=new TextDecoder();
      let buf='';
      function pump(){
        reader.read().then(({done,value})=>{
          if(done){res();return;}
          buf+=dec.decode(value,{stream:true});
          const parts=buf.split('\\n\\n');buf=parts.pop();
          for(const p of parts){
            if(!p.trim().startsWith('data:'))continue;
            try{
              const ev=JSON.parse(p.replace(/^data:\\s*/,''));
              if(ev.type==='log')lg(ev.message,ev.level||'info');
              else if(ev.type==='progress')sp(pid,ev.pct,ev.label);
              else if(ev.type==='done'){cp(pid);if(onDone)onDone(ev);res(ev);}
              else if(ev.type==='error'){cp(pid);lg('❌ '+ev.message,'error');rej(new Error(ev.message));}
            }catch{}
          }
          pump();
        }).catch(rej);
      }
      pump();
    }).catch(rej);
  });
}
async function doImport(){
  if(!csvFile)return;
  const btn=document.getElementById('importBtn');
  btn.disabled=true;btn.innerHTML='<span class="spin"></span> Importing...';
  lg('📋 Importing: '+csvFile.name);
  const fd=new FormData();fd.append('csv',csvFile);
  try{
    await runSSE('/api/import',{method:'POST',body:fd},'import',ev=>{
      bn('import','✓ '+ev.created+' created  '+ev.updated+' updated  '+ev.skipped+' skipped');
      refreshStats();
    });
  }catch(e){lg('Import failed: '+e.message,'error');bn('import','✗ '+e.message,'er');}
  btn.disabled=false;btn.textContent='Import CSV';
}
async function doScore(){
  const btn=document.getElementById('scoreBtn');
  btn.disabled=true;btn.innerHTML='<span class="spin"></span> Scoring...';
  lg('📊 Starting network score...');
  try{
    await runSSE('/api/score',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({rebuild})},'score',ev=>{
      const bd=ev.breakdown||{};
      bn('score','✓ 🔥'+(bd.Hot||0)+'  ☀️'+(bd.Warm||0)+'  ❄️'+(bd.Cold||0)+'  💤'+(bd.Dormant||0)+'  🚩'+ev.flagged+' flagged');
      refreshStats();loadStatus();
    });
  }catch(e){lg('Scoring failed: '+e.message,'error');bn('score','✗ '+e.message,'er');}
  btn.disabled=false;btn.textContent='Score All';
}
async function doEnrich(){
  const btn=document.getElementById('enrichBtn');
  btn.disabled=true;btn.innerHTML='<span class="spin"></span> Enriching...';
  lg('💬 Starting LinkedIn enrichment...');
  try{
    await runSSE('/api/enrich',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'},'enrich',ev=>{
      bn('enrich','✓ '+ev.enriched+'/'+ev.total+' contacts had LinkedIn messages');
    });
  }catch(e){lg('Enrichment failed: '+e.message,'error');bn('enrich','✗ '+e.message,'er');}
  btn.disabled=false;btn.textContent='Enrich LinkedIn';
}
async function loadDormant(){
  lg('🚩 Loading re-engagement list...');
  try{
    const {contacts,error}=await fetch('/api/dormant').then(r=>r.json());
    if(error){lg('❌ '+error,'error');return;}
    document.getElementById('dts').style.display='block';
    document.getElementById('dtBadge').textContent=contacts.length;
    const tb=document.getElementById('dtBody');tb.innerHTML='';
    if(!contacts.length){
      tb.innerHTML='<tr><td colspan="5" style="text-align:center;color:var(--mu);padding:22px">No contacts flagged — great work!</td></tr>';
      lg('✅ No contacts need re-engagement','success');return;
    }
    for(const c of contacts){
      const sc=(c.status||'').toLowerCase();
      const tr=document.createElement('tr');
      tr.innerHTML='<td class="tn">'+esc(c.name)+(c.title?'<small>'+esc(c.title)+'</small>':'')+'</td>'+
        '<td class="tc">'+esc(c.company||'—')+'</td>'+
        '<td class="ts"><span class="'+sc+'">'+esc(c.status||'?')+'</span></td>'+
        '<td class="td">'+(c.daysSince!=null?c.daysSince+'d':'never')+'</td>'+
        '<td class="td">'+esc(c.lastDate||'—')+'</td>';
      tb.appendChild(tr);
    }
    lg('✅ '+contacts.length+' contacts flagged for re-engagement','success');
    document.getElementById('dts').scrollIntoView({behavior:'smooth',block:'start'});
  }catch(e){lg('❌ '+e.message,'error');}
}
</script>
</body>
</html>`;}
