// Election-night live results: which races to show and where each one's numbers
// come from. Only official state results feeds that are free and scriptable are
// used. States whose feeds are behind bot protection (Cloudflare challenge,
// reCAPTCHA) or that publish no live statewide feed get `feed: null` and render as
// "No live state feed" with a link to the state's official results page.
//
// `match` is tested against the contest name in that state's feed. It must match
// exactly one contest; zero or several is reported as an error for that race
// rather than guessing. `dryRun` overrides point a source at a past election so
// the whole pipeline can be tested before Nov 3 (node scripts/fetch_live_results.js --dry-run).

const ELECTION_DATE = '2026-11-03';

const GROUPS = [
  { id: 'canaries', label: 'Early canaries', blurb: 'Polls close 6-7 PM ET. These tell you what kind of night it is.' },
  { id: 'senate', label: 'Senate control', blurb: 'D needs 51 seats; R holds the chamber at 50.' },
  { id: 'nc', label: 'North Carolina', blurb: 'Home state, full detail.' },
  { id: 'house', label: 'Top House flips', blurb: 'Toss-up and lean districts across the map.' },
];

// Official results pages, for states without a usable live feed (and as the
// "official source" link for ones with a feed).
const OFFICIAL_PAGES = {
  NC: 'https://er.ncsbe.gov/?election_dt=11/03/2026',
  VA: 'https://enr.elections.virginia.gov/results/public/Virginia/elections/2026-November-General',
  GA: 'https://results.sos.ga.gov/results/public/Georgia',
  IA: 'https://electionresults.iowa.gov/IA/',
  CO: 'https://results.enr.clarityelections.com/CO/',
  KY: 'https://elect.ky.gov/results/Pages/default.aspx',
  ME: 'https://www.maine.gov/sos/cec/elec/results/index.html',
  AK: 'https://www.elections.alaska.gov/election-results/',
  KS: 'https://sos.ks.gov/elections/election-results.html',
  OH: 'https://liveresults.ohiosos.gov/',
  TX: 'https://results.texas-election.com/',
  PA: 'https://www.electionreturns.pa.gov/',
  MI: 'https://mielections.us/election/results/',
  AZ: 'https://results.arizona.vote/',
  NY: 'https://nyenr.elections.ny.gov/',
};

const NO_FEED_REASON = {
  KY: 'Kentucky publishes no live statewide feed',
  ME: 'Maine publishes no live statewide results; towns report to the press',
  AK: 'Alaska results server not reachable for automated checks',
  KS: 'Kansas results server not reachable for automated checks',
  OH: 'Ohio results feed not verified',
  TX: 'Texas results site blocks automated access',
  PA: 'Pennsylvania results site requires a CAPTCHA',
  MI: 'Michigan results server not reachable for automated checks',
  AZ: 'Arizona results site blocks automated access',
  NY: 'New York results site blocks automated access',
};

// Feed sources. `type` picks the adapter in fetch_live_results.js.
const SOURCES = {
  NC: { type: 'ncsbe', dateKey: '20261103', dryRun: { dateKey: '20241105' } },
  VA: {
    type: 'enhancedvoting', host: 'https://enr.elections.virginia.gov', jurisdiction: 'Virginia',
    dryRun: { electionId: '2025-November-General' },
  },
  GA: {
    type: 'enhancedvoting', host: 'https://results.sos.ga.gov', jurisdiction: 'Georgia',
    dryRun: { electionId: '2024NovGen' },
  },
  IA: { type: 'clarity', state: 'IA', dryRun: { eid: '126082' } },
  CO: { type: 'clarity', state: 'CO', dryRun: { eid: '126592' } },
};

// chamber: 'senate' | 'governor' | 'house' (used to pull known candidate parties
// from the site's own race data when a feed's party codes are unclear).
const RACES = [
  // --- Early canaries
  { id: 'KY-06', label: 'Kentucky 6th (open, Barr seat)', state: 'KY', chamber: 'house', groups: ['canaries'], feed: null },
  { id: 'GA-sen', label: 'Georgia Senate', state: 'GA', chamber: 'senate', groups: ['canaries', 'senate'],
    feed: 'GA', match: /^US Senate\b/i, dryRunMatch: /^President of the US/i },
  { id: 'GA-gov', label: 'Georgia Governor', state: 'GA', chamber: 'governor', groups: ['canaries'],
    feed: 'GA', match: /^Governor\b/i, dryRunMatch: /^US House of Representatives - District 2$/i },
  { id: 'VA-sen', label: 'Virginia Senate', state: 'VA', chamber: 'senate', groups: ['canaries'],
    feed: 'VA', match: /^Member, United States Senate$/i, dryRunMatch: /^Governor$/i },
  { id: 'VA-01', label: 'Virginia 1st', state: 'VA', chamber: 'house', groups: ['canaries', 'house'],
    feed: 'VA', match: /^Member, House of Representatives \(1st District\)$/i, dryRunMatch: /^Lieutenant Governor$/i },
  { id: 'VA-02', label: 'Virginia 2nd', state: 'VA', chamber: 'house', groups: ['canaries', 'house'],
    feed: 'VA', match: /^Member, House of Representatives \(2nd District\)$/i, dryRunMatch: /^Attorney General$/i },

  // --- Senate control
  { id: 'NC-sen', label: 'North Carolina Senate', state: 'NC', chamber: 'senate', groups: ['senate', 'nc'],
    feed: 'NC', match: /^US SENATE\b/i, dryRunMatch: /^US PRESIDENT\b/i },
  { id: 'ME-sen', label: 'Maine Senate', state: 'ME', chamber: 'senate', groups: ['senate'], feed: null },
  { id: 'IA-sen', label: 'Iowa Senate', state: 'IA', chamber: 'senate', groups: ['senate'],
    feed: 'IA', match: /^United States Senator$/i, dryRunMatch: /^United States Senator - Rep\.$/i },
  { id: 'OH-sen', label: 'Ohio Senate (special)', state: 'OH', chamber: 'senate', groups: ['senate'], feed: null },
  { id: 'TX-sen', label: 'Texas Senate', state: 'TX', chamber: 'senate', groups: ['senate'], feed: null },
  { id: 'KS-sen', label: 'Kansas Senate', state: 'KS', chamber: 'senate', groups: ['senate'], feed: null },
  { id: 'AK-sen', label: 'Alaska Senate', state: 'AK', chamber: 'senate', groups: ['senate'], feed: null },
  { id: 'MI-sen', label: 'Michigan Senate', state: 'MI', chamber: 'senate', groups: ['senate'], feed: null },

  // --- North Carolina
  { id: 'NC-01', label: 'NC 1st', state: 'NC', chamber: 'house', groups: ['nc', 'house'],
    feed: 'NC', match: /^US HOUSE OF REPRESENTATIVES DISTRICT 01\b/i, dryRunMatch: /^US HOUSE OF REPRESENTATIVES DISTRICT 01\b/i },
  { id: 'NC-11', label: 'NC 11th (open)', state: 'NC', chamber: 'house', groups: ['nc', 'house'],
    feed: 'NC', match: /^US HOUSE OF REPRESENTATIVES DISTRICT 11\b/i, dryRunMatch: /^US HOUSE OF REPRESENTATIVES DISTRICT 11\b/i },

  // --- Top House flips
  { id: 'IA-01', label: 'Iowa 1st', state: 'IA', chamber: 'house', groups: ['house'],
    feed: 'IA', match: /^United States Representative District 1$/i, dryRunMatch: /^United States Representative District 1 - Rep\.$/i },
  { id: 'IA-02', label: 'Iowa 2nd (open)', state: 'IA', chamber: 'house', groups: ['house'],
    feed: 'IA', match: /^United States Representative District 2$/i, dryRunMatch: /^United States Representative District 2 - Rep\.$/i },
  { id: 'IA-03', label: 'Iowa 3rd', state: 'IA', chamber: 'house', groups: ['house'],
    feed: 'IA', match: /^United States Representative District 3$/i, dryRunMatch: /^United States Representative District 3 - Rep\.$/i },
  { id: 'CO-08', label: 'Colorado 8th', state: 'CO', chamber: 'house', groups: ['house'],
    feed: 'CO', match: /United States Congress - District 8$/i, dryRunMatch: /United States Congress - District 8 - Republican Party$/i },
  { id: 'CO-05', label: 'Colorado 5th', state: 'CO', chamber: 'house', groups: ['house'],
    feed: 'CO', match: /United States Congress - District 5$/i, dryRunMatch: /United States Congress - District 5 - Republican Party$/i },
  { id: 'PA-07', label: 'Pennsylvania 7th', state: 'PA', chamber: 'house', groups: ['house'], feed: null },
  { id: 'PA-10', label: 'Pennsylvania 10th', state: 'PA', chamber: 'house', groups: ['house'], feed: null },
  { id: 'MI-07', label: 'Michigan 7th', state: 'MI', chamber: 'house', groups: ['house'], feed: null },
  { id: 'AZ-06', label: 'Arizona 6th', state: 'AZ', chamber: 'house', groups: ['house'], feed: null },
  { id: 'NY-17', label: 'New York 17th', state: 'NY', chamber: 'house', groups: ['house'], feed: null },
];

module.exports = { ELECTION_DATE, GROUPS, OFFICIAL_PAGES, NO_FEED_REASON, SOURCES, RACES };
