// Polls free Google News RSS search for a handful of broad keyword queries that
// tend to correlate with a race actually changing (candidate exits, scandal,
// arrest, death). This is a heuristic, not a precise signal: broad queries will
// catch some noise, and a hit doesn't guarantee Wikipedia's ratings tables have
// caught up yet -- it just triggers an extra fetch_live_data.js run on the
// (cheap, harmless-if-wrong) chance that they have. The daily scheduled refresh
// remains the reliability backstop regardless of whether this catches anything.
//
// Run: node scripts/check_news_alerts.js
// State: data/.news_alert_state.json (per-query last-seen item GUIDs, so the
// same story doesn't re-trigger a refresh on every hourly check).

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const DATA_DIR = path.join(__dirname, '..', 'data');
const LOG_DIR = path.join(__dirname, '..', 'logs');
const STATE_PATH = path.join(DATA_DIR, '.news_alert_state.json');

const QUERIES = {
  'drops-out': '("drops out" OR "withdraws from" OR "suspends campaign") ("2026 election" OR "2026 midterm" OR "2026 senate" OR "2026 governor" OR "2026 house race")',
  'scandal': '(scandal OR controversy) ("2026 election" OR "2026 midterm" OR "2026 senate race" OR "2026 governor race" OR "2026 house race") candidate',
  'indicted': '(indicted OR arrested OR charged) (candidate OR congressman OR congresswoman OR senator OR governor) 2026 election',
  'dies': '("dies at" OR "passes away") (candidate OR congressman OR congresswoman OR senator OR governor) 2026 election',
};

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')); } catch (e) { return {}; }
}

function saveState(state) {
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

function parseRssItems(xml) {
  const items = [];
  const itemRe = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = itemRe.exec(xml))) {
    const block = m[1];
    const title = (block.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || '';
    const link = (block.match(/<link>([\s\S]*?)<\/link>/) || [])[1] || '';
    const guid = (block.match(/<guid[^>]*>([\s\S]*?)<\/guid>/) || [])[1] || link;
    const pubDate = (block.match(/<pubDate>([\s\S]*?)<\/pubDate>/) || [])[1] || '';
    items.push({ title: title.replace(/&amp;/g, '&').replace(/&#39;/g, "'"), link, guid, pubDate });
  }
  return items;
}

async function fetchQuery(query) {
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`News RSS fetch failed: HTTP ${res.status}`);
  const xml = await res.text();
  return parseRssItems(xml).slice(0, 15); // most recent ~15 results
}

async function main() {
  const state = loadState();
  const newHits = [];

  for (const [key, query] of Object.entries(QUERIES)) {
    let items;
    try {
      items = await fetchQuery(query);
    } catch (err) {
      console.error(`  [${key}] fetch failed:`, err.message);
      continue;
    }
    const seen = new Set(state[key] || []);
    const fresh = items.filter((it) => !seen.has(it.guid));
    if (fresh.length) {
      for (const it of fresh) newHits.push({ category: key, ...it });
    }
    state[key] = items.map((it) => it.guid); // remember everything currently in the feed
  }

  saveState(state);

  if (newHits.length) {
    console.log(`${newHits.length} new alert(s):`);
    for (const hit of newHits) {
      console.log(`  [${hit.category}] ${hit.title} (${hit.pubDate})`);
      console.log(`    ${hit.link}`);
    }
    console.log('Triggering data refresh...');
    try {
      execFileSync('node', [path.join(__dirname, 'fetch_live_data.js')], { stdio: 'inherit' });
    } catch (err) {
      console.error('Refresh failed:', err.message);
    }
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(
      path.join(LOG_DIR, 'alerts.log'),
      newHits.map((h) => `[${new Date().toISOString()}] [${h.category}] ${h.title} -- ${h.link}`).join('\n') + '\n',
    );
  } else {
    console.log('No new alerts.');
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
