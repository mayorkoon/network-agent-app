# LinkedIn Network Intelligence Agent — Web App
Runs at http://localhost:3000

## Quick Start
```bash
npm install
cp .env.example .env   # fill in your keys
npm start              # → http://localhost:3000
# One-time Gmail auth: http://localhost:3000/oauth/start
```

## What it does
- **Import CSV**: Upload LinkedIn connections.csv → Airtable
- **Score Network**: Gmail index + WhatsApp + Twitter → composite score for all contacts
- **Enrich LinkedIn**: Playwright message scraping for Warm/Hot contacts (40/run)
- **Re-engagement List**: Who to reach out to

## Setup — minimum to get started
1. Airtable: create base "Network Intelligence", table "Contacts" (see below for fields)
2. Gmail: console.cloud.google.com → Gmail API → OAuth client → add http://localhost:3000/oauth/callback
3. Fill in .env, run npm start, visit /oauth/start to authorize Gmail
4. Export your LinkedIn connections CSV, upload via the Import panel

## Airtable Fields (create all in "Contacts" table)
Name, Title, Company, Location, LinkedIn URL, Email, Connected Date, Source, Last Enriched,
Relationship Score (Number), Relationship Status (Single select: Hot/Warm/Cold/Dormant),
Last Contact Date, Days Since Contact (Number), Flag for Re-engagement (Checkbox),
Active Platforms, Gmail Thread Count (Number), Gmail Last Email (Date),
WhatsApp Message Count (Number), WhatsApp Last Message (Date),
LinkedIn Message Count (Number), LinkedIn Last Message (Date),
Twitter Interaction Count (Number)

## LinkedIn Cookie
Chrome → linkedin.com → F12 → Application → Cookies → li_at → copy Value → LINKEDIN_SESSION_COOKIE

## WhatsApp
Export chats to ./whatsapp-exports/ as .txt files named with the contact's name.
