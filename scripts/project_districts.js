// Projects the Census cb_2025_us_cd119_500k district GeoJSON into the SAME
// Albers-USA-style coordinate space as project_us_map.js's state output, so
// district paths line up exactly with the existing state boundary map.
const fs = require('fs');

const inPath = process.argv[2];
const outPath = process.argv[3];

const geo = JSON.parse(fs.readFileSync(inPath, 'utf8'));

const FIPS_TO_USPS = {
  '01': 'AL', '02': 'AK', '04': 'AZ', '05': 'AR', '06': 'CA', '08': 'CO',
  '09': 'CT', '10': 'DE', '11': 'DC', '12': 'FL', '13': 'GA', '15': 'HI',
  '16': 'ID', '17': 'IL', '18': 'IN', '19': 'IA', '20': 'KS', '21': 'KY',
  '22': 'LA', '23': 'ME', '24': 'MD', '25': 'MA', '26': 'MI', '27': 'MN',
  '28': 'MS', '29': 'MO', '30': 'MT', '31': 'NE', '32': 'NV', '33': 'NH',
  '34': 'NJ', '35': 'NM', '36': 'NY', '37': 'NC', '38': 'ND', '39': 'OH',
  '40': 'OK', '41': 'OR', '42': 'PA', '44': 'RI', '45': 'SC', '46': 'SD',
  '47': 'TN', '48': 'TX', '49': 'UT', '50': 'VT', '51': 'VA', '53': 'WA',
  '54': 'WV', '55': 'WI', '56': 'WY',
};

const toRad = (d) => (d * Math.PI) / 180;

function makeAlbers(phi0, phi1, phi2, lambda0) {
  phi0 = toRad(phi0); phi1 = toRad(phi1); phi2 = toRad(phi2); lambda0 = toRad(lambda0);
  const n = (Math.sin(phi1) + Math.sin(phi2)) / 2;
  const C = Math.cos(phi1) ** 2 + 2 * n * Math.sin(phi1);
  const rho0 = Math.sqrt(C - 2 * n * Math.sin(phi0)) / n;
  return function project([lon, lat]) {
    const lambda = toRad(lon);
    const phi = toRad(lat);
    const rho = Math.sqrt(C - 2 * n * Math.sin(phi)) / n;
    const theta = n * (lambda - lambda0);
    const x = rho * Math.sin(theta);
    const y = rho0 - rho * Math.cos(theta);
    return [x, y];
  };
}

// Same params as project_us_map.js, so the two outputs share one coordinate space.
const projConus = makeAlbers(23, 29.5, 45.5, -96);
const projAlaska = makeAlbers(50, 55, 65, -154);
const projHawaii = makeAlbers(13, 8, 18, -157);

// Recompute the exact same fit constants project_us_map.js derived, from the
// same states.js source, so district geometry lands in the identical pixel space.
const TARGET_W = 960;
const MARGIN = 10;

let statesRaw = fs.readFileSync(process.argv[4], 'utf8');
statesRaw = statesRaw.replace('var statesData = ', '').trim();
if (statesRaw.endsWith(';')) statesRaw = statesRaw.slice(0, -1);
const statesGeo = JSON.parse(statesRaw);

function bboxOf(coordsList) {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const [x, y] of coordsList) {
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  return { minX, maxX, minY, maxY };
}

function projectAllPoints(feature, project) {
  const polys = feature.geometry.type === 'Polygon' ? [feature.geometry.coordinates] : feature.geometry.coordinates;
  const pts = [];
  for (const poly of polys) for (const ring of poly) for (const p of ring) pts.push(project(p));
  return pts;
}

const STATE_FIPS_TO_USPS = FIPS_TO_USPS; // same table, PR excluded there already
const groupPts = { conus: [], alaska: [], hawaii: [] };
for (const f of statesGeo.features) {
  const usps = STATE_FIPS_TO_USPS[f.id];
  if (!usps || usps === 'PR') continue;
  if (usps === 'AK') groupPts.alaska.push(...projectAllPoints(f, projAlaska));
  else if (usps === 'HI') groupPts.hawaii.push(...projectAllPoints(f, projHawaii));
  else groupPts.conus.push(...projectAllPoints(f, projConus));
}

const conusBox = bboxOf(groupPts.conus);
const alaskaBox = bboxOf(groupPts.alaska);
const hawaiiBox = bboxOf(groupPts.hawaii);
const conusScale = (TARGET_W - MARGIN * 2) / (conusBox.maxX - conusBox.minX);
const conusH = (conusBox.maxY - conusBox.minY) * conusScale;
const akScale = conusScale * 0.28;
const akW = (alaskaBox.maxX - alaskaBox.minX) * akScale;
const akTx = MARGIN;
const akTy = MARGIN + conusH - ((alaskaBox.maxY - alaskaBox.minY) * akScale) - 4;
const hiScale = conusScale * 0.55;
const hiTx = akTx + akW + 14;
const hiTy = MARGIN + conusH - ((hawaiiBox.maxY - hawaiiBox.minY) * hiScale) - 4;

const FIT = {
  conus: { box: conusBox, scale: conusScale, tx: MARGIN, ty: MARGIN },
  alaska: { box: alaskaBox, scale: akScale, tx: akTx, ty: akTy },
  hawaii: { box: hawaiiBox, scale: hiScale, tx: hiTx, ty: hiTy },
};

function fitPoint(usps, lon, lat) {
  let project, box, scale, tx, ty;
  if (usps === 'AK') { project = projAlaska; ({ box, scale, tx, ty } = FIT.alaska); }
  else if (usps === 'HI') { project = projHawaii; ({ box, scale, tx, ty } = FIT.hawaii); }
  else { project = projConus; ({ box, scale, tx, ty } = FIT.conus); }
  const [x, y] = project([lon, lat]);
  const px = (x - box.minX) * scale + tx;
  const py = (box.maxY - y) * scale + ty;
  return [Math.round(px * 10) / 10, Math.round(py * 10) / 10];
}

// Ramer-Douglas-Peucker simplification, operating in already-projected pixel
// space. At our ~960px-wide render, sub-pixel detail is pure dead weight --
// this cuts the district file from ~7MB (1400+ pts/district) to a fraction of that.
function simplify(points, epsilon) {
  if (points.length < 3) return points;
  let maxDist = 0, idx = 0;
  const [x1, y1] = points[0];
  const [x2, y2] = points[points.length - 1];
  const dx = x2 - x1, dy = y2 - y1;
  const len = Math.hypot(dx, dy) || 1;
  for (let i = 1; i < points.length - 1; i++) {
    const [px, py] = points[i];
    const dist = Math.abs(dy * px - dx * py + x2 * y1 - y2 * x1) / len;
    if (dist > maxDist) { maxDist = dist; idx = i; }
  }
  if (maxDist > epsilon) {
    const left = simplify(points.slice(0, idx + 1), epsilon);
    const right = simplify(points.slice(idx), epsilon);
    return left.slice(0, -1).concat(right);
  }
  return [points[0], points[points.length - 1]];
}

// Plain RDP degenerates on a closed ring (start === end -> zero-length baseline
// -> every point measures distance 0 -> everything gets dropped). Split the ring
// at its farthest point from the start first, simplify each open half, then merge.
function simplifyRing(points, epsilon) {
  if (points.length < 5) return points;
  let farIdx = 0, farDist = 0;
  const [x0, y0] = points[0];
  for (let i = 1; i < points.length - 1; i++) {
    const [x, y] = points[i];
    const dist = Math.hypot(x - x0, y - y0);
    if (dist > farDist) { farDist = dist; farIdx = i; }
  }
  if (farIdx === 0) return points;
  const half1 = simplify(points.slice(0, farIdx + 1), epsilon);
  const half2 = simplify(points.slice(farIdx), epsilon);
  return half1.slice(0, -1).concat(half2);
}

const SIMPLIFY_EPSILON = 0.5; // px, in the final ~960-wide viewBox

function toPathD(usps, geometry) {
  const polys = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
  let d = '';
  for (const poly of polys) {
    for (const ring of poly) {
      const pts = ring.map(([lon, lat]) => fitPoint(usps, lon, lat));
      const simplified = simplifyRing(pts, SIMPLIFY_EPSILON);
      d += 'M' + simplified.map((p) => p.join(',')).join('L') + 'Z';
    }
  }
  return d;
}

const districts = [];
for (const f of geo.features) {
  const usps = FIPS_TO_USPS[f.properties.STATEFP];
  if (!usps) continue; // skip territories (PR, GU, VI, AS, MP)
  const districtNum = f.properties.CD119FP; // '00' = at-large
  districts.push({
    id: `${usps}-${districtNum}`,
    state: usps,
    district: districtNum,
    d: toPathD(usps, f.geometry),
  });
}

districts.sort((a, b) => a.id.localeCompare(b.id));
fs.writeFileSync(outPath, JSON.stringify({ districts }));
console.log('wrote', outPath, 'districts:', districts.length);
