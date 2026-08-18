/**
 * Ahmedabad ward geometry for the demo.
 *
 * Real ward boundaries would be uploaded as GeoJSON through the admin's ward
 * editor. For the demo we generate eight ward polygons around real,
 * well-known Ahmedabad localities so the heatmap, point-in-ward attribution
 * and "nearest truck" queries all operate on genuine, road-served
 * neighbourhoods instead of open farmland.
 */

export const CITY = {
  name: 'Ahmedabad',
  state: 'Gujarat',
  corporation: 'Ahmedabad Municipal Corporation',
  center: { latitude: 23.0225, longitude: 72.5714 },
};

/**
 * Real Ahmedabad localities, spread across the city's zones, each with its
 * own genuine centre coordinate — not a mathematically tiled grid, since
 * real neighbourhoods aren't laid out that way.
 */
export const WARDS = [
  { name: 'Navrangpura', code: 'W-01', zone: 'West Zone', population: 41000, center: { latitude: 23.0336, longitude: 72.5645 } },
  { name: 'Naranpura', code: 'W-02', zone: 'West Zone', population: 38000, center: { latitude: 23.0511, longitude: 72.5642 } },
  { name: 'Vastrapur', code: 'W-03', zone: 'West Zone', population: 44000, center: { latitude: 23.0396, longitude: 72.5250 } },
  { name: 'Satellite', code: 'W-04', zone: 'West Zone', population: 36000, center: { latitude: 23.0258, longitude: 72.5077 } },
  { name: 'Bopal', code: 'W-05', zone: 'West Zone', population: 29000, center: { latitude: 23.0324, longitude: 72.4720 } },
  { name: 'Paldi', code: 'W-06', zone: 'South Zone', population: 33000, center: { latitude: 23.0154, longitude: 72.5626 } },
  { name: 'Maninagar', code: 'W-07', zone: 'South Zone', population: 46000, center: { latitude: 22.9962, longitude: 72.6047 } },
  { name: 'Chandkheda', code: 'W-08', zone: 'North Zone', population: 27000, center: { latitude: 23.1017, longitude: 72.5797 } },
];

// ~800m x 750m around each locality's centre — small enough to stay inside
// the built-up area instead of wandering into open ground between localities.
const CELL_LNG = 0.0075;
const CELL_LAT = 0.0068;

/** Slight per-ward jitter so the boundary does not read as a drawn rectangle. */
function jitter(index, scale) {
  const x = Math.sin(index * 12.9898) * 43758.5453;
  return (x - Math.floor(x) - 0.5) * scale;
}

export function wardGeometry(index) {
  const { center } = WARDS[index];

  const west = center.longitude - CELL_LNG / 2 + jitter(index, 0.0008);
  const east = center.longitude + CELL_LNG / 2 + jitter(index + 50, 0.0008);
  const south = center.latitude - CELL_LAT / 2 + jitter(index + 100, 0.0008);
  const north = center.latitude + CELL_LAT / 2 + jitter(index + 150, 0.0008);

  // Wobble the corners so boundaries look surveyed rather than drawn.
  const w = (n) => jitter(index * 7 + n, 0.0006);
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

/** A deterministic point inside a ward — used as a road-snap candidate. */
export function pointInWard(index, n) {
  const { center } = WARDS[index];
  return {
    latitude: round6(center.latitude + jitter(index * 31 + n, CELL_LAT * 0.6)),
    longitude: round6(center.longitude + jitter(index * 17 + n * 3, CELL_LNG * 0.6)),
  };
}

const round6 = (n) => Number(n.toFixed(6));

/** Real Ahmedabad streets and roads near the seeded localities. */
export const STREETS = [
  'C G Road',
  'Ashram Road',
  'S M Road',
  'Drive In Road',
  'Judges Bungalow Road',
  'Prahlad Nagar Road',
  'Sardar Patel Ring Road',
  'Bopal-Ghuma Road',
  'Vastrapur Lake Road',
  'Maninagar Station Road',
  'Paldi Cross Road',
  'Chandkheda-Motera Road',
];

export default { CITY, WARDS, wardGeometry, pointInWard, STREETS };
