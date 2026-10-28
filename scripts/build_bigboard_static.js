// One-time builder for the big board's static inputs:
//   data/bigboard-geo.json       county outlines (SVG paths) for NC, VA, GA
//   data/bigboard-baseline.json  2024 presidential result by county (the "vs 2024" baseline)
// plus the county-name <-> FIPS <-> feed-id mapping the live poller uses.
//
// Needs (dev only, not at runtime): npm i us-atlas@3.0.1 topojson-client@3.1.0 d3-geo@3.1.1
//   NODE_PATH=<dir with those> node scripts/build_bigboard_static.js
//
// Baselines come from each state's own official 2024 results feed.

const fs = require('fs');
const path = require('path');
const topo = require('topojson-client');
const d3 = require('d3-geo');

const DATA_DIR = path.join(__dirname, '..', 'data');
const UA = 'ElectionRookWorks/1.0 (https://election.rook.works; https://github.com/JJHerrmann/election-wallpaper)';
const atlas = require(require.resolve('us-atlas/counties-10m.json'));

const STATES = {
  NC: { fips: '37', name: 'North Carolina' },
  VA: { fips: '51', name: 'Virginia' },
  GA: { fips: '13', name: 'Georgia' },
};

async function getJson(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return JSON.parse((await res.text()).replace(/^﻿/, ''));
}
async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); }
  }));
  return out;
}
const en = (a) => (Array.isArray(a) ? (a.find((x) => x.languageId === 'en') || a[0] || {}).text : a) || '';
const norm = (s) => String(s).toLowerCase().replace(/[^a-z]/g, '');

function countiesFor(st) {
  const fc = topo.feature(atlas, atlas.objects.counties);
  return fc.features.filter((f) => f.id.startsWith(STATES[st].fips));
}

// ---- geometry
function buildGeo() {
  const out = {};
  for (const st of Object.keys(STATES)) {
    const feats = countiesFor(st);
    const W = 960, H = st === 'VA' ? 440 : st === 'NC' ? 380 : 620;
    const proj = d3.geoMercator().fitSize([W, H], { type: 'FeatureCollection', features: feats });
    const gp = d3.geoPath(proj).digits(1);
    out[st] = {
      name: STATES[st].name,
      viewBox: `0 0 ${W} ${H}`,
      counties: feats.map((f) => {
        const [cx, cy] = gp.centroid(f);
        return { fips: f.id, name: f.properties.name, d: gp(f), cx: Math.round(cx), cy: Math.round(cy) };
      }).sort((a, b) => a.fips.localeCompare(b.fips)),
    };
  }
  return out;
}

// ---- feed ids for each county (what the live poller requests)
function ncFeedId(fips) { return String((parseInt(fips.slice(2), 10) + 1) / 2); } // NC county ids: alphabetical 1-100 = FIPS 001..199 odd
function gaSlug(name) { return `${name.toLowerCase().replace(/[^a-z]+/g, '-').replace(/^-|-$/g, '')}-county-ga`; }

async function vaLocalityMap(geoVA) {
  // VA's API names localities "ACCOMACK COUNTY" / "RICHMOND CITY". Census FIPS for
  // independent cities are 51510+; counties are below 51200.
  const j = await getJson('https://enr.elections.virginia.gov/results/public/api/jurisdictions/Virginia');
  const map = {};
  for (const loc of j.childLocalities || []) {
    const raw = en(loc.name).trim();
    const isCity = / CITY$/i.test(raw) && !/ COUNTY$/i.test(raw);
    const base = raw.replace(/ (COUNTY|CITY)$/i, '');
    const hit = geoVA.counties.find((c) => norm(c.name) === norm(base) && (isCity ? +c.fips.slice(2) >= 510 : +c.fips.slice(2) < 510));
    if (hit) map[hit.fips] = { shortName: loc.shortName, feedName: raw };
  }
  return map;
}

// ---- 2024 baselines
async function ncBaseline(geo) {
  const out = {};
  await pool(geo.counties, 8, async (c) => {
    const rows = await getJson(`https://er.ncsbe.gov/enr/20241105/data/results_${ncFeedId(c.fips)}.txt`);
    const pres = rows.filter((r) => /^US PRESIDENT/.test(r.cnm));
    if (String(pres[0] && pres[0].cid) !== ncFeedId(c.fips)) throw new Error(`NC county id mismatch for ${c.name}`);
    const v = (p) => pres.filter((r) => r.pty === p).reduce((s, r) => s + (+r.vct || 0), 0);
    out[c.fips] = { d: v('DEM'), r: v('REP'), total: pres.reduce((s, r) => s + (+r.vct || 0), 0) };
  });
  return out;
}
async function evBaseline(host, electionId, geo, idFor) {
  const out = {};
  await pool(geo.counties, 6, async (c) => {
    const id = idFor(c);
    if (!id) return;
    const d = await getJson(`${host}/results/public/api/elections/${encodeURIComponent(id)}/${electionId}/data`);
    const it = (d.ballotItems || []).find((b) => /president/i.test(en(b.name)));
    if (!it) throw new Error(`no presidential contest for ${c.name}`);
    const opts = it.summaryResults.ballotOptions;
    const pv = (re) => opts.filter((o) => re.test(en(o.name)) || re.test(String((o.party && o.party.abbreviation) || ''))).reduce((s, o) => s + o.voteCount, 0);
    out[c.fips] = { d: pv(/harris|^dem/i), r: pv(/trump|^rep/i), total: opts.reduce((s, o) => s + o.voteCount, 0) };
  });
  return out;
}

async function main() {
  const geo = buildGeo();
  const vaMap = await vaLocalityMap(geo.VA);
  const feedIds = {
    NC: Object.fromEntries(geo.NC.counties.map((c) => [c.fips, ncFeedId(c.fips)])),
    VA: Object.fromEntries(Object.entries(vaMap).map(([f, v]) => [f, v.shortName])),
    GA: Object.fromEntries(geo.GA.counties.map((c) => [c.fips, gaSlug(c.name)])),
  };
  for (const st of Object.keys(STATES)) {
    const missing = geo[st].counties.filter((c) => !feedIds[st][c.fips]).map((c) => c.name);
    console.log(st, 'counties', geo[st].counties.length, 'mapped', Object.keys(feedIds[st]).length, missing.length ? 'MISSING ' + missing.join(', ') : '');
    for (const c of geo[st].counties) c.feedId = feedIds[st][c.fips] || null;
  }

  const baseline = {
    note: '2024 presidential result by county from each state\'s official results feed. d = Harris, r = Trump, total = all presidential votes.',
    NC: await ncBaseline(geo.NC),
    VA: await evBaseline('https://enr.elections.virginia.gov', '2024NovemberGeneral', geo.VA, (c) => feedIds.VA[c.fips]),
    GA: await evBaseline('https://results.sos.ga.gov', '2024NovGen', geo.GA, (c) => feedIds.GA[c.fips]),
  };
  for (const st of Object.keys(STATES)) {
    const b = Object.values(baseline[st]);
    const D = b.reduce((s, x) => s + x.d, 0), R = b.reduce((s, x) => s + x.r, 0), T = b.reduce((s, x) => s + x.total, 0);
    console.log(st, 'baseline counties', b.length, `Harris ${D} (${(100 * D / T).toFixed(2)}%)  Trump ${R} (${(100 * R / T).toFixed(2)}%)  total ${T}`);
  }

  fs.writeFileSync(path.join(DATA_DIR, 'bigboard-geo.json'), JSON.stringify(geo));
  fs.writeFileSync(path.join(DATA_DIR, 'bigboard-baseline.json'), JSON.stringify(baseline));
  console.log('geo bytes', fs.statSync(path.join(DATA_DIR, 'bigboard-geo.json')).size);
}

main().catch((e) => { console.error(e); process.exit(1); });
