/**
 * scorers/whatsapp.js
 * Parses exported WhatsApp chat .txt files.
 *
 * How to export:
 *   Mobile → open chat → ⋮ → More → Export chat → Without media
 *   Save .txt files to the directory set in WHATSAPP_EXPORTS_DIR
 *
 * File naming: include the contact's name anywhere in the filename.
 *   "WhatsApp Chat with Sarah Kim.txt"  ✅
 *   "Chat with Mike Johnson.txt"        ✅
 *   "sarah_kim.txt"                     ✅ (matched by first name)
 *
 * WhatsApp date formats vary by region and OS:
 *   iOS:     [1/15/2024, 2:30:45 PM] Name: message
 *   Android: 1/15/24, 14:30 - Name: message
 *   EU:      15.01.2024, 14:30 - Name: message
 */

import fs from 'fs';
import path from 'path';

// All known WhatsApp export date patterns
const MESSAGE_PATTERNS = [
  // iOS: [MM/DD/YYYY, H:MM:SS AM/PM] Name: text
  /^\[(\d{1,2}\/\d{1,2}\/\d{4}),\s*\d{1,2}:\d{2}(?::\d{2})?(?:\s*[AP]M)?\]\s+(.+?):\s/,
  // Android US: MM/DD/YY, HH:MM - Name: text
  /^(\d{1,2}\/\d{1,2}\/\d{2,4}),\s*\d{1,2}:\d{2}\s*[-–]\s+(.+?):\s/,
  // EU/Android: DD.MM.YYYY, HH:MM - Name: text
  /^(\d{1,2}\.\d{1,2}\.\d{4}),\s*\d{1,2}:\d{2}(?::\d{2})?\s*[-–]\s+(.+?):\s/,
  // ISO-ish: YYYY-MM-DD, HH:MM - Name: text
  /^(\d{4}-\d{2}-\d{2}),\s*\d{1,2}:\d{2}\s*[-–]\s+(.+?):\s/,
];

// System messages to ignore
const SYSTEM_PATTERNS = [
  /end-to-end encrypted/i,
  /messages to this (group|chat) are/i,
  /changed the subject/i,
  /added .+ to the group/i,
  /left the group/i,
  /You were added/i,
];

function isSystemMessage(sender) {
  return SYSTEM_PATTERNS.some(p => p.test(sender));
}

function parseFile(filePath) {
  const content = fs.readFileSync(filePath, 'utf-8');
  const messages = [];

  for (const line of content.split('\n')) {
    for (const pattern of MESSAGE_PATTERNS) {
      const match = line.match(pattern);
      if (match) {
        if (isSystemMessage(match[2])) break;
        try {
          const date = new Date(match[1]);
          if (!isNaN(date.getTime())) {
            messages.push({ date, sender: match[2].trim() });
          }
        } catch {}
        break;
      }
    }
  }
  return messages;
}

function contactNameFromFilename(filename) {
  const base = path.basename(filename, path.extname(filename));
  // Strip common prefixes
  return base
    .replace(/^WhatsApp Chat with /i, '')
    .replace(/^Chat with /i, '')
    .replace(/^Chat de WhatsApp con /i, '')
    .replace(/^WhatsApp-Chat mit /i, '')
    .replace(/[_-]/g, ' ')
    .trim();
}

// Cache: loaded once per process run
let _cache = null;

function loadExports() {
  if (_cache) return _cache;

  const dir = process.env.WHATSAPP_EXPORTS_DIR || './whatsapp-exports';
  _cache = new Map(); // normalizedName → { messages, filename }

  if (!fs.existsSync(dir)) return _cache;

  for (const file of fs.readdirSync(dir)) {
    if (!file.match(/\.(txt|TXT)$/)) continue;
    const fullPath = path.join(dir, file);
    try {
      const contactName = contactNameFromFilename(file);
      const messages = parseFile(fullPath);
      if (messages.length > 0) {
        _cache.set(contactName.toLowerCase(), { contactName, messages, filename: file });
      }
    } catch {}
  }

  return _cache;
}

function findExport(contactName) {
  const exports = loadExports();
  if (!exports.size) return null;

  const target = contactName.toLowerCase().trim();

  // 1. Exact match
  if (exports.has(target)) return exports.get(target);

  // 2. Substring match (either direction)
  for (const [key, data] of exports) {
    if (target.includes(key) || key.includes(target)) return data;
  }

  // 3. First + last name partial (handles middle names, short names)
  const targetParts = target.split(' ').filter(p => p.length > 2);
  for (const [key, data] of exports) {
    const keyParts = key.split(' ').filter(p => p.length > 2);
    const overlap = targetParts.filter(p => keyParts.includes(p));
    if (overlap.length >= Math.min(2, targetParts.length)) return data;
  }

  return null;
}

export async function scoreContact(contact) {
  if (!contact.name) return null;

  const exports = loadExports();
  if (!exports.size) return null; // Directory empty or missing — skip silently

  const exportData = findExport(contact.name);

  if (!exportData) {
    return { platform: 'whatsapp', threadCount: 0, recentThreadCount: 0, latestDate: null, daysSince: null };
  }

  const messages = [...exportData.messages].sort((a, b) => b.date - a.date);
  const latestDate = messages[0]?.date || null;
  const ninety = Date.now() - 90 * 864e5;
  const recentCount = messages.filter(m => m.date.getTime() > ninety).length;

  return {
    platform: 'whatsapp',
    threadCount: messages.length,
    recentThreadCount: recentCount,
    latestDate,
    daysSince: latestDate ? Math.floor((Date.now() - latestDate.getTime()) / 864e5) : null,
    matchedFile: exportData.filename,
  };
}
