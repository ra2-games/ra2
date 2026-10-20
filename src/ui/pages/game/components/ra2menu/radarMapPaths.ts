// Independently authored fictional terrain, without geographic datasets or borders.
type Point = readonly [number, number];

// Original shape templates are placed independently, without quadrants or mirrored pairs.
const terrainShapes = [
  [
    [34, 76],
    [87, 48],
    [124, 64],
    [156, 46],
    [194, 62],
    [206, 94],
    [181, 110],
    [199, 131],
    [168, 147],
    [177, 172],
    [146, 198],
    [153, 221],
    [122, 234],
    [108, 218],
    [90, 244],
    [66, 229],
    [51, 253],
    [32, 211],
  ],
  [
    [45, 300],
    [82, 281],
    [106, 305],
    [136, 293],
    [167, 315],
    [158, 344],
    [192, 352],
    [175, 375],
    [199, 397],
    [180, 416],
    [184, 446],
    [153, 434],
    [133, 464],
    [111, 445],
    [97, 475],
    [73, 444],
    [58, 397],
    [35, 372],
  ],
  [
    [384, 38],
    [425, 55],
    [452, 42],
    [475, 70],
    [519, 54],
    [551, 84],
    [535, 111],
    [567, 124],
    [558, 158],
    [575, 181],
    [540, 199],
    [528, 231],
    [495, 217],
    [479, 238],
    [448, 217],
    [460, 193],
    [426, 175],
    [439, 147],
    [407, 125],
    [420, 100],
    [390, 81],
  ],
  [
    [543, 254],
    [574, 275],
    [559, 315],
    [578, 343],
    [550, 371],
    [557, 407],
    [530, 435],
    [514, 418],
    [497, 451],
    [468, 434],
    [451, 466],
    [418, 449],
    [391, 462],
    [376, 431],
    [404, 409],
    [385, 383],
    [412, 369],
    [405, 343],
    [435, 330],
    [422, 311],
    [459, 287],
    [477, 305],
    [502, 285],
    [520, 299],
  ],
  [
    [229, 477],
    [252, 461],
    [278, 482],
    [299, 470],
    [319, 487],
    [351, 475],
    [369, 499],
    [348, 516],
    [310, 507],
    [292, 530],
    [265, 513],
    [243, 525],
  ],
  [
    [208, 73],
    [224, 63],
    [243, 78],
    [231, 96],
    [212, 92],
  ],
  [
    [201, 423],
    [220, 410],
    [231, 429],
    [223, 448],
    [205, 441],
  ],
  [
    [359, 337],
    [378, 326],
    [389, 342],
    [375, 363],
    [360, 355],
  ],
] as const satisfies readonly (readonly Point[])[];

function randomSequence(seed: number): () => number {
  let state = seed;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

// Generate once at module load so React updates and reloads preserve the artwork.
const terrainRandom = randomSequence(0x4d6170);
const regions = Array.from({ length: 13 }, (_, i): Point[] => {
  const shape = terrainShapes[Math.floor(terrainRandom() * terrainShapes.length)];
  const xs = shape.map(([x]) => x);
  const ys = shape.map(([, y]) => y);
  const left = Math.min(...xs);
  const top = Math.min(...ys);
  const spanX = Math.max(...xs) - left;
  const spanY = Math.max(...ys) - top;
  const cx = 40 + terrainRandom() * 535;
  const cy = 35 + terrainRandom() * 490;
  const width = i < 5 ? 100 + terrainRandom() * 170 : 18 + terrainRandom() * 65;
  const height = i < 5 ? 110 + terrainRandom() * 180 : 25 + terrainRandom() * 80;
  const angle = terrainRandom() * Math.PI * 2;
  return shape.map(([x, y]) => {
    const dx = ((x - left) / spanX - 0.5) * width;
    const dy = ((y - top) / spanY - 0.5) * height;
    return [cx + dx * Math.cos(angle) - dy * Math.sin(angle), cy + dx * Math.sin(angle) + dy * Math.cos(angle)];
  });
});

const contactRandom = randomSequence(0x736967);
export const RADAR_CONTACTS = Array.from({ length: 7 }, () => {
  let x: number;
  let y: number;
  do {
    x = 65 + contactRandom() * 485;
    y = 60 + contactRandom() * 445;
    // Keep returns inside the sweep radius and outside the opaque title plate.
  } while (Math.hypot(x - 308, y - 253) > 245 || (y > 130 && y < 218));
  return {
    x,
    y,
    strength: 0.8 + contactRandom() * 0.2,
    radius: 2.5 + contactRandom(),
    bloom: 18 + contactRandom() * 17,
  };
});

function coastline(points: readonly Point[], seed: number): string {
  const vertices: Point[] = [];
  const subdivide = (a: Point, b: Point, depth: number, salt: number): void => {
    if (depth === 0) {
      vertices.push(a);
      return;
    }
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const displacement = Math.sin(salt * 127.1 + seed * 311.7) * 0.24;
    const midpoint: Point = [(a[0] + b[0]) / 2 - dy * displacement, (a[1] + b[1]) / 2 + dx * displacement];
    subdivide(a, midpoint, depth - 1, salt * 2 + 1);
    subdivide(midpoint, b, depth - 1, salt * 2 + 2);
  };
  points.forEach((point, i) => subdivide(point, points[(i + 1) % points.length], 4, i + 1));
  return vertices.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ') + ' Z';
}

export const RADAR_LAND_PATHS = regions.map((points, i) => coastline(points, i + 7));

// Interior contours complement the finer static SVG relief texture.
export const RADAR_DETAIL_PATHS = regions.flatMap((points, region) => {
  const cx = points.reduce((sum, [x]) => sum + x, 0) / points.length;
  const cy = points.reduce((sum, [, y]) => sum + y, 0) / points.length;
  return [0.88, 0.7, 0.51].map((scale, level) =>
    coastline(
      points.map(([x, y]) => [cx + (x - cx) * scale, cy + (y - cy) * scale]),
      region * 11 + level,
    ),
  );
});
