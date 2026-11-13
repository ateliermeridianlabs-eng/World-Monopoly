// Builds data/board.json (the full, explicit square list) from data/sections.json, data/rules.json and the square
// order in data/layout.json. Run: npm run board (generates the layout first, then this).
//
// The order comes from the map (scripts/generate-layout.mjs): New Year, then for each section in sections.json
// order its 14 squares (8 cities, 4 utility meters, World Event, Disaster) walked through the region from the
// side nearest the previous crossing to the side nearest the next, then the crossing's sea squares (an airport
// and a seaport or tax office; the last crossing is a single seaport back to New Year).
//
// Also writes the travel tables both versions share: `flights`, one entry per pair of airports with the
// great-circle distance between their seas (real points in scripts/world.mjs CROSSINGS) and its fare band
// (data/rules.json airports.flightBands), and `seaRoutes`, the shipping routes between seaports (data/layout.json).
import { readFileSync, writeFileSync } from 'node:fs';
import { CROSSINGS } from './world.mjs';

const sections = JSON.parse(readFileSync('data/sections.json', 'utf8')).sections;
const rules = JSON.parse(readFileSync('data/rules.json', 'utf8'));
const layout = JSON.parse(readFileSync('data/layout.json', 'utf8'));

const cities = new Map(sections.flatMap((s) => s.cities.map((c) => [c.id, { city: c, section: s }])));
const sectionById = new Map(sections.map((s) => [s.id, s]));

const squares = layout.squares.map(({ id }) => {
  if (id === 'new-year') return { type: 'newYear', id, name: 'New Year' };
  if (cities.has(id)) {
    const { city, section } = cities.get(id);
    return { type: 'city', id, name: city.name, section: section.id, price: city.price, image: city.image };
  }
  const [kind, ...rest] = id.split('-');
  const tail = rest.join('-');
  if (kind === 'airport') return { type: 'airport', id, name: `Airport ${tail}`, price: rules.airports.price };
  if (kind === 'port') {
    const port = CROSSINGS.find((c) => c.name === layout.squares.find((q) => q.id === id).sea).port;
    return { type: 'seaport', id, name: port, price: rules.seaports.price };
  }
  if (kind === 'tax') return { type: 'tax', id, name: 'Tax Office' };
  const section = sectionById.get(tail);
  if (!section) throw new Error(`unknown square ${id}`);
  if (kind === 'event') return { type: 'event', id, name: 'World Event', section: tail };
  if (kind === 'disaster') return { type: 'disaster', id, name: 'Disaster', section: tail };
  const utility = rules.utilities.kinds.find((k) => k.id === kind);
  if (!utility) throw new Error(`unknown square ${id}`);
  return { type: 'utility', id, name: `${section.name} ${utility.name}`, section: tail, utility: kind, price: rules.utilities.price };
});

squares.forEach((s, index) => {
  s.index = index;
  s.checkpoint = index % rules.salary.checkpointEvery === 0;
});

const ids = new Set(squares.map((s) => s.id));
if (ids.size !== squares.length) throw new Error('duplicate square id');
if (squares[0].type !== 'newYear') throw new Error('square 0 must be New Year');
if (squares.length % rules.salary.checkpointEvery !== 0) throw new Error(`board size ${squares.length} is not a multiple of checkpointEvery`);
for (const s of sections) {
  const at = squares.filter((q) => q.section === s.id).map((q) => q.index);
  if (at.length !== 14 || at[13] - at[0] !== 13) throw new Error(`${s.id}: its 14 squares must be consecutive`);
}

// ---------- flights ----------

const R_EARTH_KM = 6371;
const rad = Math.PI / 180;
function greatCircleKm([lon1, lat1], [lon2, lat2]) {
  const h = Math.sin(((lat2 - lat1) * rad) / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(((lon2 - lon1) * rad) / 2) ** 2;
  return 2 * R_EARTH_KM * Math.asin(Math.sqrt(h));
}
const seaOf = (index) => {
  const sea = layout.squares[index].sea;
  const c = CROSSINGS.find((x) => x.name === sea);
  if (!c?.lonLat) throw new Error(`no lonLat for ${sea}`);
  return c;
};
const bands = rules.airports.flightBands;
const airports = squares.filter((s) => s.type === 'airport').map((s) => s.index);
const flights = [];
for (let i = 0; i < airports.length; i++) for (let j = i + 1; j < airports.length; j++) {
  const [a, b] = [airports[i], airports[j]];
  const km = Math.round(greatCircleKm(seaOf(a).lonLat, seaOf(b).lonLat));
  const band = bands.find((x) => x.maxKm === null || km <= x.maxKm);
  flights.push({ a, b, km, band: band.id });
}

// ---------- sea routes ----------

const indexOf = new Map(squares.map((s) => [s.id, s.index]));
const seaRoutes = layout.seaRoutes.map((r) => ({ id: r.id, name: r.name, a: indexOf.get(r.from), b: indexOf.get(r.to) }));
for (const r of seaRoutes) {
  if (squares[r.a]?.type !== 'seaport' || squares[r.b]?.type !== 'seaport' || r.a === r.b) throw new Error(`sea route ${r.id} must join two seaports`);
}

const ordered = squares.map(({ index, id, type, name, checkpoint, ...rest }) => ({ index, id, type, name, checkpoint, ...rest }));
const body = JSON.stringify({ size: ordered.length, squares: ordered }, null, 2).slice(1, -2);
writeFileSync('data/board.json', `{
  "_note": "Generated by scripts/generate-board.mjs from data/sections.json, data/rules.json, scripts/world.mjs and the square order and sea routes in data/layout.json (inside a section the order follows the map). Do not edit by hand. flights: every pair of airports (a < b, square indices) with the great-circle distance in km between their seas and its fare band (rules.json airports.flightBands); a flight's fare is the same both ways. seaRoutes: the shipping routes between seaports (square indices a and b); every route runs both ways.",${body},
  "flights": [
${flights.map((f) => `    ${JSON.stringify(f)}`).join(',\n')}
  ],
  "seaRoutes": [
${seaRoutes.map((r) => `    ${JSON.stringify(r)}`).join(',\n')}
  ]
}
`);
console.log(`board.json: ${ordered.length} squares, ${flights.length} flights (${bands.map((b) => `${flights.filter((f) => f.band === b.id).length} ${b.id}`).join(', ')}), ${seaRoutes.length} sea routes`);
