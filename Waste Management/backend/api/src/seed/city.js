/**
 * Gandhinagar ward geometry for the demo.
 *
 * Real ward boundaries would be uploaded as GeoJSON through the admin's ward
 * editor. For the demo we generate eight ward polygons over the real
 * Gandhinagar sector grid and its surrounding GMC localities, so the heatmap,
 * point-in-ward attribution and "nearest truck" queries all operate on
 * genuine, road-served neighbourhoods instead of open farmland.
 *
 * Gandhinagar is a planned city: sectors 1-30 sit on a rotated grid between
 * the Sabarmati (west) and the Pethapur/Chiloda side (east), with the newer
 * Infocity / Kudasan / Sargasan / Raysan belt spreading south towards
 * Ahmedabad. The wards below group adjacent sectors the way Gandhinagar
 * Municipal Corporation actually does, rather than tiling a rectangle.
 */

export const CITY = {
  name: 'Gandhinagar',
  state: 'Gujarat',
  corporation: 'Gandhinagar Municipal Corporation',
  center: { latitude: 23.2156, longitude: 72.6369 },
};

/**
 * Hard geographic envelope for the whole product. Every map view, every
 * seeded point and every accepted GPS fix is expected to fall inside this
 * box -- it is Gandhinagar district's built-up area plus a small margin, not
 * the whole of Gujarat. Exported so the API and the SPA agree on one
 * definition of "inside the city" instead of each hardcoding its own.
 */
export const CITY_BOUNDS = {
  south: 23.1400,
  west: 72.5600,
  north: 23.2900,
  east: 72.7200,
};

/** True when a coordinate falls inside the Gandhinagar envelope above. */
export function isInsideCity({ latitude, longitude } = {}) {
  if (typeof latitude !== 'number' || typeof longitude !== 'number') return false;
  return (
    latitude >= CITY_BOUNDS.south &&
    latitude <= CITY_BOUNDS.north &&
    longitude >= CITY_BOUNDS.west &&
    longitude <= CITY_BOUNDS.east
  );
}

/**
 * Real Gandhinagar sector groups and localities, each with its own genuine
 * centre coordinate -- not a mathematically tiled grid, since the sector
 * blocks and the villages absorbed into GMC aren't laid out that way.
 */
export const WARDS = [
  { name: 'Sector 1-4', code: 'W-01', zone: 'North Zone', population: 32000, center: { latitude: 23.2480, longitude: 72.6450 } },
  { name: 'Sector 5-8', code: 'W-02', zone: 'North Zone', population: 37000, center: { latitude: 23.2330, longitude: 72.6460 } },
  { name: 'Sector 9-13', code: 'W-03', zone: 'Central Zone', population: 41000, center: { latitude: 23.2230, longitude: 72.6300 } },
  { name: 'Sector 14-17', code: 'W-04', zone: 'Central Zone', population: 44000, center: { latitude: 23.2120, longitude: 72.6420 } },
  { name: 'Sector 19-24', code: 'W-05', zone: 'South Zone', population: 39000, center: { latitude: 23.2030, longitude: 72.6250 } },
  { name: 'Sector 26-30', code: 'W-06', zone: 'South Zone', population: 35000, center: { latitude: 23.1910, longitude: 72.6420 } },
  { name: 'Infocity & Kudasan', code: 'W-07', zone: 'Infocity Zone', population: 46000, center: { latitude: 23.1850, longitude: 72.6250 } },
  { name: 'Sargasan & Raysan', code: 'W-08', zone: 'South West Zone', population: 28000, center: { latitude: 23.1720, longitude: 72.6380 } },
];

// ~1.1km x 1.0km around each ward centre -- roughly a Gandhinagar sector
// block plus its ring road, small enough to stay inside the built-up area
// instead of wandering into the Indroda forest or open farmland.
const CELL_LNG = 0.0110;
const CELL_LAT = 0.0090;

/** Slight per-ward jitter so the boundary does not read as a drawn rectangle. */
function jitter(index, scale) {
  const x = Math.sin(index * 12.9898) * 43758.5453;
  return (x - Math.floor(x) - 0.5) * scale;
}

export function wardGeometry(index) {
  const { center } = WARDS[index];

  const west = center.longitude - CELL_LNG / 2 + jitter(index, 0.0004);
  const east = center.longitude + CELL_LNG / 2 + jitter(index + 50, 0.0004);
  const south = center.latitude - CELL_LAT / 2 + jitter(index + 100, 0.0004);
  const north = center.latitude + CELL_LAT / 2 + jitter(index + 150, 0.0004);

  // Wobble the corners so boundaries look surveyed rather than drawn.
  const w = (n) => jitter(index * 7 + n, 0.0004);
  const ring = [
    [west + w(1), south + w(2)],
    [west + CELL_LNG * 0.5, south + w(3)],
    [east + w(4), south + w(5)],
    [east + w(6), south + CELL_LAT * 0.5],
    [east + w(7), north + w(8)],
    [west + CELL_LNG * 0.5, north + w(9)],
    [west + w(10), north + w(11)],
    [west + w(12), south + CELL_LAT * 0.5],
  ];
  ring.push(ring[0]);

  return {
    boundary: { type: 'Polygon', coordinates: [ring.map(([lng, lat]) => [round6(lng), round6(lat)])] },
    center: { longitude: round6(center.longitude), latitude: round6(center.latitude) },
  };
}

/** A deterministic point inside a ward -- used as a road-snap candidate. */
export function pointInWard(index, n) {
  const { center } = WARDS[index];
  return {
    latitude: round6(center.latitude + jitter(index * 31 + n, CELL_LAT * 0.6)),
    longitude: round6(center.longitude + jitter(index * 17 + n * 3, CELL_LNG * 0.6)),
  };
}

const round6 = (n) => Number(n.toFixed(6));

/** Real Gandhinagar streets and roads near the seeded sectors. */
export const STREETS = [
  'Ch Road',
  'Chh Road',
  'Gh Road',
  'K Road',
  'Kh Road',
  'Sector 7 Circle Road',
  'Ch-0 Circle',
  'Infocity Road',
  'Kudasan Main Road',
  'Sargasan Circle Road',
  'Adalaj-Uvarsad Road',
  'Pethapur Road',
  'Vavol Road',
  'Indroda Circle Road',
  'Sarita Udyan Road',
  'Sarkhej-Gandhinagar Highway',
];

export default { CITY, CITY_BOUNDS, isInsideCity, WARDS, wardGeometry, pointInWard, STREETS };
