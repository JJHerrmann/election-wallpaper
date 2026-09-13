(function () {
  'use strict';

  const STATE_NAMES = {
    AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California',
    CO: 'Colorado', CT: 'Connecticut', DE: 'Delaware', DC: 'District of Columbia',
    FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois',
    IN: 'Indiana', IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana',
    ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota',
    MS: 'Mississippi', MO: 'Missouri', MT: 'Montana', NE: 'Nebraska', NV: 'Nevada',
    NH: 'New Hampshire', NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York',
    NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon',
    PA: 'Pennsylvania', RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota',
    TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont', VA: 'Virginia',
    WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming',
  };

  const MODES = ['president', 'senate', 'house', 'governor'];

  const state = {
    mode: 'senate',
    dataUrl: 'data/live-{mode}.json', // falls back to bundled sample-<mode>.json if missing/blank
    refreshMinutes: 360,
    theme: 'dark',
    compact: false,
    cache: {}, // mode -> normalized payload
    mapPaths: null,
    districtPaths: null,
    selectedState: null,
    granularity: 'state', // 'state' | 'district', tracks which layer is active
    trendHistory: {}, // mode -> full unsliced history array, so the window picker can re-slice without refetching
    trendWindow: 'all', // '7' | '30' | '90' | 'all', persisted per-viewer in localStorage
  };

  const els = {};

  function qs(id) { return document.getElementById(id); }

  function cacheEls() {
    els.map = qs('map');
    els.stateLayer = qs('state-layer');
    els.districtLayer = qs('district-layer');
    els.modeSwitcher = qs('mode-switcher');
    els.summaryControl = qs('summary-control');
    els.demBar = qs('seat-bar-dem');
    els.gopBar = qs('seat-bar-gop');
    els.demCount = qs('dem-count');
    els.gopCount = qs('gop-count');
    els.summaryConfidence = qs('summary-confidence');
    els.methodologyNote = qs('methodology-note');
    els.summarySource = qs('summary-source');
    els.lastUpdated = qs('last-updated');
    els.raceCard = qs('race-card');
    els.raceStateName = qs('race-state-name');
    els.raceStatusPill = qs('race-status-pill');
    els.raceMargin = qs('race-margin');
    els.racePolls = qs('race-polls');
    els.raceTrend = qs('race-trend');
    els.raceCardClose = qs('race-card-close');
    els.offlineBadge = qs('offline-badge');
    els.trendCard = qs('trend-card');
    els.trendChart = qs('trend-chart');
    els.trendDelta = qs('trend-delta');
    els.trendWindowPicker = qs('trend-window-picker');
    els.trendWindowBtns = [...els.trendWindowPicker.querySelectorAll('.trend-window-btn')];
    els.candidatesTable = qs('race-candidates-table');
    els.candidateCols = [...els.candidatesTable.querySelectorAll('.candidate-col')];
  }

  async function loadJson(url) {
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res.json();
  }

  async function loadMapPaths() {
    if (state.mapPaths) return state.mapPaths;
    const data = await loadJson('data/us-states-paths.json');
    state.mapPaths = data;
    return data;
  }

  function localCacheKey(mode) {
    return 'election-wallpaper-cache-' + mode;
  }

  async function loadModeData(mode, { forceRemote } = {}) {
    const remoteUrl = state.dataUrl
      ? state.dataUrl.replace(/\{mode\}/g, mode)
      : null;

    if (remoteUrl) {
      try {
        const data = await loadJson(remoteUrl);
        state.cache[mode] = data;
        try { localStorage.setItem(localCacheKey(mode), JSON.stringify(data)); } catch (e) {}
        setOffline(false);
        return data;
      } catch (err) {
        // fall through to cached/local
      }
    }

    // Try last-known-good cache from a previous successful remote fetch.
    try {
      const cached = localStorage.getItem(localCacheKey(mode));
      if (cached && remoteUrl) {
        setOffline(true);
        return JSON.parse(cached);
      }
    } catch (e) {}

    // Bundled static sample data (always available, no network required).
    const data = await loadJson(`data/sample-${mode}.json`);
    state.cache[mode] = data;
    setOffline(!!remoteUrl);
    return data;
  }

  function setOffline(isOffline) {
    els.offlineBadge.classList.toggle('hidden', !isOffline);
  }

  async function loadDistrictPaths() {
    if (state.districtPaths) return state.districtPaths;
    const data = await loadJson('data/us-districts-paths.json');
    state.districtPaths = data;
    return data;
  }

  function buildMap(mapData, districtData) {
    const ns = 'http://www.w3.org/2000/svg';
    els.map.setAttribute('viewBox', mapData.viewBox);
    for (const s of mapData.states) {
      const path = document.createElementNS(ns, 'path');
      path.setAttribute('d', s.d);
      path.setAttribute('class', 'state fill-no-race');
      path.dataset.state = s.id;
      path.addEventListener('mouseenter', () => { if (state.granularity === 'state') showRaceCard(s.id, false); });
      path.addEventListener('click', () => { if (state.granularity === 'state') showRaceCard(s.id, true); });
      els.stateLayer.appendChild(path);
    }
    for (const d of districtData.districts) {
      const path = document.createElementNS(ns, 'path');
      path.setAttribute('d', d.d);
      path.setAttribute('class', 'district fill-no-race');
      path.dataset.district = d.id;
      path.dataset.state = d.state;
      path.addEventListener('mouseenter', () => { if (state.granularity === 'district') showRaceCard(d.id, false); });
      path.addEventListener('click', () => { if (state.granularity === 'district') showRaceCard(d.id, true); });
      els.districtLayer.appendChild(path);
    }
  }

  function statusFillClass(status) {
    return 'fill-' + status;
  }

  function setGranularity(granularity) {
    state.granularity = granularity;
    els.districtLayer.classList.toggle('layer-hidden', granularity !== 'district');
    els.stateLayer.classList.toggle('outline-only', granularity === 'district');
  }

  function applyModeData(data) {
    const isDistrict = data.granularity === 'district';
    setGranularity(isDistrict ? 'district' : 'state');

    if (isDistrict) {
      const raceById = {};
      for (const r of data.races) raceById[r.id] = r;
      state.currentRaces = raceById;

      for (const el of els.districtLayer.querySelectorAll('.district')) {
        const race = raceById[el.dataset.district];
        let cls;
        if (!race || race.status === 'no-race') cls = 'fill-no-race';
        else if (race.competitive) cls = statusFillClass(race.status);
        else cls = 'fill-muted-' + (race.leaderParty || race.incumbentParty || 'd').toLowerCase();
        el.className.baseVal = 'district ' + cls + (el.classList.contains('selected') ? ' selected' : '');
      }
      // clear any stale per-state fills so the outline-only state layer looks clean
      for (const el of els.stateLayer.querySelectorAll('.state')) {
        el.className.baseVal = 'state' + (el.classList.contains('selected') ? ' selected' : '');
      }
    } else {
      const raceByState = {};
      for (const r of data.races) raceByState[r.state] = r;
      state.currentRaces = raceByState;

      for (const el of els.stateLayer.querySelectorAll('.state')) {
        const race = raceByState[el.dataset.state];
        const cls = race ? statusFillClass(race.status) : 'fill-no-race';
        el.className.baseVal = 'state ' + cls + (el.classList.contains('selected') ? ' selected' : '');
      }
    }

    const modeLabel = data.mode.charAt(0).toUpperCase() + data.mode.slice(1);
    els.summaryControl.textContent = `${modeLabel} · ${data.summary.control} control`;

    if (data.summary.demNet !== undefined) {
      // Net change vs. current incumbents (e.g. "D +1 / R -1"), bar shows projected
      // full-chamber balance rather than just the subset of rated races.
      const dem = data.summary.demSeatsProjected;
      const gop = data.summary.gopSeatsProjected;
      const total = Math.max(dem + gop, 1);
      els.demBar.style.width = (100 * dem / total) + '%';
      els.gopBar.style.width = (100 * gop / total) + '%';
      els.demCount.textContent = `D ${fmtNet(data.summary.demNet)}`;
      els.gopCount.textContent = `R ${fmtNet(data.summary.gopNet)}`;
    } else {
      const dem = data.summary.demSeats;
      const gop = data.summary.gopSeats;
      const total = Math.max(dem + gop, 1);
      els.demBar.style.width = (100 * dem / total) + '%';
      els.gopBar.style.width = (100 * gop / total) + '%';
      els.demCount.textContent = `D ${dem}`;
      els.gopCount.textContent = `R ${gop}`;
    }

    els.summaryConfidence.textContent = `${data.summary.confidence} — ${data.summary.unit}`;
    els.methodologyNote.classList.toggle('hidden', data.dataType !== 'rating');
    els.summarySource.textContent = data.source || '';

    const updated = new Date(data.updatedAt);
    els.lastUpdated.textContent = 'Last updated ' + updated.toLocaleString(undefined, {
      month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
    });

    refreshTrend(data.mode).catch(() => {});
  }

  function fmtNet(n) {
    if (n > 0) return `+${n}`;
    if (n < 0) return `${n}`;
    return '±0';
  }

  function fmtMargin(race) {
    if (race.margin == null) return '—';
    return `${race.leaderParty}+${race.margin.toFixed(1)}`;
  }

  function statusLabel(status) {
    return status.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  }

  function drawTrend(trend) {
    const ns = 'http://www.w3.org/2000/svg';
    els.raceTrend.innerHTML = '';
    if (!trend || trend.length < 2) return;

    const margins = trend.map((p) => p.margin);
    const min = Math.min(...margins, 0);
    const max = Math.max(...margins, 0);
    const range = Math.max(max - min, 1);
    const w = 240, h = 60, pad = 4;

    const zeroY = h - pad - ((0 - min) / range) * (h - pad * 2);
    const zeroLine = document.createElementNS(ns, 'line');
    zeroLine.setAttribute('x1', 0); zeroLine.setAttribute('x2', w);
    zeroLine.setAttribute('y1', zeroY); zeroLine.setAttribute('y2', zeroY);
    zeroLine.setAttribute('stroke', 'rgba(255,255,255,0.15)');
    zeroLine.setAttribute('stroke-dasharray', '3,3');
    els.raceTrend.appendChild(zeroLine);

    const pts = trend.map((p, i) => {
      const x = pad + (i / (trend.length - 1)) * (w - pad * 2);
      const y = h - pad - ((p.margin - min) / range) * (h - pad * 2);
      return [x, y];
    });

    const path = document.createElementNS(ns, 'path');
    const d = pts.map(([x, y], i) => (i === 0 ? 'M' : 'L') + x.toFixed(1) + ',' + y.toFixed(1)).join('');
    path.setAttribute('d', d);
    path.setAttribute('fill', 'none');
    const finalMargin = trend[trend.length - 1].margin;
    path.setAttribute('stroke', finalMargin >= 0 ? 'var(--dem)' : 'var(--gop)');
    path.setAttribute('stroke-width', '2');
    path.setAttribute('stroke-linecap', 'round');
    path.setAttribute('stroke-linejoin', 'round');
    els.raceTrend.appendChild(path);

    const lastPt = pts[pts.length - 1];
    const dot = document.createElementNS(ns, 'circle');
    dot.setAttribute('cx', lastPt[0]); dot.setAttribute('cy', lastPt[1]); dot.setAttribute('r', 3);
    dot.setAttribute('fill', finalMargin >= 0 ? 'var(--dem)' : 'var(--gop)');
    els.raceTrend.appendChild(dot);
  }

  function renderTrendChart(history) {
    const ns = 'http://www.w3.org/2000/svg';
    els.trendChart.innerHTML = '';
    const w = 200, h = 56, pad = 2;
    const maxAbs = Math.max(1, ...history.map((e) => Math.abs(e.netScore)));
    const barW = (w - pad * 2) / history.length;
    const zeroY = h / 2;

    const zeroLine = document.createElementNS(ns, 'line');
    zeroLine.setAttribute('x1', 0); zeroLine.setAttribute('x2', w);
    zeroLine.setAttribute('y1', zeroY); zeroLine.setAttribute('y2', zeroY);
    zeroLine.setAttribute('stroke', 'rgba(255,255,255,0.15)');
    zeroLine.setAttribute('stroke-dasharray', '3,3');
    els.trendChart.appendChild(zeroLine);

    history.forEach((entry, i) => {
      const barH = (Math.abs(entry.netScore) / maxAbs) * (h / 2 - 4);
      const rect = document.createElementNS(ns, 'rect');
      rect.setAttribute('x', pad + i * barW + barW * 0.15);
      rect.setAttribute('width', Math.max(barW * 0.7, 1));
      rect.setAttribute('y', entry.netScore >= 0 ? zeroY - barH : zeroY);
      rect.setAttribute('height', barH);
      rect.setAttribute('fill', entry.netScore >= 0 ? 'var(--dem)' : 'var(--gop)');
      els.trendChart.appendChild(rect);
    });

    const first = history[0], last = history[history.length - 1];
    const days = Math.round((new Date(last.date) - new Date(first.date)) / 86400000);
    els.trendDelta.textContent = `Now: ${last.label} · ${days}d ago: ${first.label}`;
  }

  function sliceHistoryByWindow(history, windowSetting) {
    if (windowSetting === 'all' || history.length < 2) return history;
    const windowDays = Number(windowSetting);
    const lastDate = new Date(history[history.length - 1].date);
    const cutoff = new Date(lastDate);
    cutoff.setDate(cutoff.getDate() - windowDays);
    return history.filter((e) => new Date(e.date) >= cutoff);
  }

  function setTrendWindow(windowSetting) {
    state.trendWindow = windowSetting;
    try { localStorage.setItem('election-wallpaper-trend-window', windowSetting); } catch (e) {}
    for (const btn of els.trendWindowBtns) btn.classList.toggle('active', btn.dataset.window === windowSetting);
    applyTrendWindow();
  }

  function applyTrendWindow() {
    const history = state.trendHistory[state.mode];
    if (!history || history.length < 2) { els.trendCard.classList.add('hidden'); return; }
    const sliced = sliceHistoryByWindow(history, state.trendWindow);
    if (sliced.length < 2) { els.trendCard.classList.add('hidden'); return; }
    renderTrendChart(sliced);
    els.trendCard.classList.remove('hidden');
  }

  function wireTrendWindowPicker() {
    els.trendWindowPicker.addEventListener('click', (e) => {
      const btn = e.target.closest('.trend-window-btn');
      if (!btn) return;
      setTrendWindow(btn.dataset.window);
    });
  }

  async function refreshTrend(mode) {
    if (mode === 'president') { els.trendCard.classList.add('hidden'); return; }
    let history = null;
    try { history = await loadJson(`data/history-${mode}.json?t=${Date.now()}`); } catch (err) { /* no history yet */ }
    state.trendHistory[mode] = history || [];
    applyTrendWindow();
  }

  function ordinal(n) {
    const s = ['th', 'st', 'nd', 'rd'];
    const v = n % 100;
    return n + (s[(v - 20) % 10] || s[v] || s[0]);
  }

  function districtLabel(id) {
    const [st, num] = id.split('-');
    const stateName = STATE_NAMES[st] || st;
    if (num === '00') return `${stateName} (At-Large)`;
    return `${stateName}'s ${ordinal(parseInt(num, 10))} District`;
  }

  function renderCandidatesTable(race) {
    if (!race.candidates || !race.candidates.length) {
      els.candidatesTable.classList.add('hidden');
      return;
    }
    els.candidatesTable.classList.remove('hidden');
    els.candidateCols.forEach((col, i) => {
      const cand = race.candidates[i];
      if (!cand) { col.style.visibility = 'hidden'; return; }
      col.style.visibility = 'visible';
      col.dataset.party = cand.party || '';
      col.querySelector('.candidate-name').textContent = cand.name;
      const img = col.querySelector('.candidate-photo');
      img.src = cand.imageUrl || '';
      img.onerror = () => { img.style.visibility = 'hidden'; };
      img.style.visibility = cand.imageUrl ? 'visible' : 'hidden';
      col.querySelector('.candidate-party').textContent = cand.party || '?';
      col.querySelector('.incumbent-flag').classList.toggle('hidden', !cand.isIncumbent);
      const pctEl = col.querySelector('.candidate-pct');
      const pct = race.bestPoll && race.bestPoll.candidatePcts && cand.party
        ? race.bestPoll.candidatePcts[cand.party]
        : null;
      pctEl.textContent = pct != null ? `${pct.toFixed(1)}%` : '';
    });
  }

  function activeLayerEl() {
    return state.granularity === 'district' ? els.districtLayer : els.stateLayer;
  }

  function activeSelector() {
    return state.granularity === 'district' ? '.district' : '.state';
  }

  function activeAttr() {
    return state.granularity === 'district' ? 'data-district' : 'data-state';
  }

  function showRaceCard(id, pinned) {
    if (state.selectedState && !pinned && state.selectedState !== id) return;
    const race = state.currentRaces && state.currentRaces[id];
    if (!race) return;

    if (pinned) {
      for (const el of activeLayerEl().querySelectorAll(activeSelector() + '.selected')) el.classList.remove('selected');
      const el = activeLayerEl().querySelector(`[${activeAttr()}="${id}"]`);
      if (el) el.classList.add('selected');
      state.selectedState = id;
    }

    els.raceStateName.textContent = state.granularity === 'district' ? districtLabel(id) : (STATE_NAMES[id] || id);
    els.raceStatusPill.textContent = statusLabel(race.status);
    els.raceStatusPill.className = 'race-status-pill ' + statusFillClass(race.status);

    renderCandidatesTable(race);

    if (race.bestPoll) {
      els.raceMargin.textContent = `${race.bestPoll.leaderParty || '?'}+${race.bestPoll.margin.toFixed(1)}`;
      qs('race-margin-row').classList.remove('hidden');
    } else {
      els.raceMargin.textContent = fmtMargin(race);
      qs('race-margin-row').classList.toggle('hidden', race.margin == null);
    }

    if (race.dataType === 'pvi') {
      const pviTxt = race.pviMagnitude != null
        ? `PVI ${race.leaderParty || 'EVEN'}${race.leaderParty ? '+' + race.pviMagnitude : ''}`
        : 'No PVI data';
      const heldTxt = race.incumbentParty ? ` · currently ${race.incumbentParty}-held` : '';
      const competitiveTxt = race.competitive ? ' · competitive' : ' · safe';
      els.racePolls.textContent = `${pviTxt}${heldTxt}${competitiveTxt}`;
    } else if (race.dataType === 'historical-result') {
      const swingTxt = race.swing != null ? ` · swing ${race.swing >= 0 ? 'D' : 'R'}${Math.abs(race.swing).toFixed(1)} since 2020` : '';
      els.racePolls.textContent = `2024 result${race.isFlip ? ' (flipped)' : ''}${swingTxt}`;
    } else if (race.dataType === 'rating') {
      if (race.delegation) {
        els.racePolls.textContent = `Current delegation: D ${race.delegation.D} – R ${race.delegation.R}`;
      } else if (race.raterCount) {
        let holdPickup = '';
        if (race.incumbentParty && race.leaderParty) {
          holdPickup = race.leaderParty === race.incumbentParty
            ? ` · ${race.incumbentParty} hold`
            : ` · ${race.leaderParty} pickup`;
        }
        const pollTxt = race.bestPoll ? ` · latest poll: ${race.bestPoll.source} (${race.bestPoll.date})` : '';
        els.racePolls.textContent = `${race.raterCount} forecaster ratings (consensus)${holdPickup}${pollTxt}`;
      } else {
        els.racePolls.textContent = 'No rating available';
      }
    } else {
      els.racePolls.textContent = race.pollCount ? `${race.pollCount} recent · ${race.lastPollDaysAgo}d ago` : 'No data';
    }

    drawTrend(race.trend);
    els.raceCard.classList.remove('hidden');
  }

  function hideRaceCard() {
    state.selectedState = null;
    for (const el of els.stateLayer.querySelectorAll('.state.selected')) el.classList.remove('selected');
    for (const el of els.districtLayer.querySelectorAll('.district.selected')) el.classList.remove('selected');
    els.raceCard.classList.add('hidden');
  }

  async function switchMode(mode) {
    state.mode = mode;
    for (const btn of els.modeSwitcher.querySelectorAll('.mode-btn')) {
      btn.classList.toggle('active', btn.dataset.mode === mode);
    }
    hideRaceCard();
    const data = await loadModeData(mode);
    applyModeData(data);
  }

  function applyLayoutProps() {
    document.body.classList.toggle('compact', !!state.compact);
    document.body.classList.toggle('light', state.theme === 'light');
  }

  function scheduleRefresh() {
    const ms = Math.max(state.refreshMinutes, 5) * 60 * 1000;
    setInterval(async () => {
      const data = await loadModeData(state.mode, { forceRemote: true });
      applyModeData(data);
    }, ms);
  }

  function wireModeSwitcher() {
    els.modeSwitcher.addEventListener('click', (e) => {
      const btn = e.target.closest('.mode-btn');
      if (!btn) return;
      switchMode(btn.dataset.mode);
    });
  }

  function wireRaceCard() {
    els.raceCardClose.addEventListener('click', hideRaceCard);
    els.map.addEventListener('mouseleave', () => {
      if (!state.selectedState) els.raceCard.classList.add('hidden');
    });
  }

  // ---- Lively Wallpaper property bridge ----
  // livelywallpaper posts a JSON string {name, value} on property change.
  function wireLively() {
    window.livelyPropertyListener = function (name, val) {
      if (name === 'dataUrl') state.dataUrl = val || '';
      if (name === 'refreshMinutes') state.refreshMinutes = Number(val) || 360;
      if (name === 'theme') { state.theme = val; applyLayoutProps(); }
      if (name === 'compact') { state.compact = !!val; applyLayoutProps(); }
      if (name === 'defaultMode' && MODES.includes(val)) switchMode(val);
    };
  }

  async function init() {
    cacheEls();
    wireModeSwitcher();
    wireRaceCard();
    wireTrendWindowPicker();
    wireLively();
    applyLayoutProps();

    try {
      const storedWindow = localStorage.getItem('election-wallpaper-trend-window');
      if (storedWindow) state.trendWindow = storedWindow;
    } catch (e) {}
    for (const btn of els.trendWindowBtns) btn.classList.toggle('active', btn.dataset.window === state.trendWindow);

    const [mapData, districtData] = await Promise.all([loadMapPaths(), loadDistrictPaths()]);
    buildMap(mapData, districtData);

    for (const btn of els.modeSwitcher.querySelectorAll('.mode-btn')) {
      btn.classList.toggle('active', btn.dataset.mode === state.mode);
    }

    const data = await loadModeData(state.mode);
    applyModeData(data);
    scheduleRefresh();
  }

  document.addEventListener('DOMContentLoaded', init);
})();
