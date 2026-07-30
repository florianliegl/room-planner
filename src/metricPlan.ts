import type {
  ConstructionSettings,
  Furniture,
  MetricOpening,
  MetricPlan,
  Point,
  PrintExportOptions,
  PrintLayout,
  WallSegment,
} from "./plannerTypes";

function distance(a: Point, b: Point) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function projectOnWall(point: Point, wall: WallSegment) {
  const dx = wall.b.x - wall.a.x;
  const dy = wall.b.y - wall.a.y;
  const lengthSquared = dx * dx + dy * dy;
  if (!lengthSquared) return { point: wall.a, distance: Infinity, t: 0 };
  const t = clamp(((point.x - wall.a.x) * dx + (point.y - wall.a.y) * dy) / lengthSquared, 0, 1);
  const projected = { x: wall.a.x + dx * t, y: wall.a.y + dy * t };
  return { point: projected, distance: distance(point, projected), t };
}

export function createMetricPlan(
  outline: Point[],
  walls: WallSegment[],
  furniture: Furniture[],
  scaleMPerPx: number,
  settings: ConstructionSettings,
): MetricPlan {
  const sourcePoints = outline.length ? outline : walls.flatMap((wall) => [wall.a, wall.b]);
  const minPxX = Math.min(...sourcePoints.map((point) => point.x), 0);
  const minPxY = Math.min(...sourcePoints.map((point) => point.y), 0);
  const toMetric = (point: Point): Point => ({
    x: (point.x - minPxX) * scaleMPerPx,
    y: (point.y - minPxY) * scaleMPerPx,
  });

  const metricWalls = walls.map((wall) => ({ ...wall, a: toMetric(wall.a), b: toMetric(wall.b) }));
  const metricFurniture = furniture.map((object) => ({
    ...object,
    x: (object.x - minPxX) * scaleMPerPx,
    y: (object.y - minPxY) * scaleMPerPx,
  }));

  const openings: MetricOpening[] = [];
  metricFurniture.forEach((object) => {
    if (object.type !== "door" && object.type !== "window") return;
    let best: { wall: WallSegment; point: Point; distance: number } | null = null;
    metricWalls.forEach((wall) => {
      const projection = projectOnWall({ x: object.x, y: object.y }, wall);
      if (!best || projection.distance < best.distance) best = { wall, point: projection.point, distance: projection.distance };
    });
    if (!best) return;
    const chosen = best as { wall: WallSegment; point: Point; distance: number };
    openings.push({
      objectId: object.id,
      wallId: chosen.wall.id,
      type: object.type,
      centerM: chosen.point,
      widthM: object.widthM,
      bottomM: object.type === "door" ? 0 : object.openingBottomM ?? 0.9,
      heightM: object.openingHeightM ?? (object.type === "door" ? 2.1 : 1.2),
      rotation: (Math.atan2(chosen.wall.b.y - chosen.wall.a.y, chosen.wall.b.x - chosen.wall.a.x) * 180) / Math.PI,
    });
  });

  const outlineM = outline.map(toMetric);
  const allPoints = outlineM.length ? outlineM : metricWalls.flatMap((wall) => [wall.a, wall.b]);
  const minX = Math.min(...allPoints.map((point) => point.x), 0);
  const minY = Math.min(...allPoints.map((point) => point.y), 0);
  const maxX = Math.max(...allPoints.map((point) => point.x), 0);
  const maxY = Math.max(...allPoints.map((point) => point.y), 0);

  return {
    outlineM,
    walls: metricWalls,
    furniture: metricFurniture,
    openings,
    settings,
    boundsM: { minX, minY, maxX, maxY, width: maxX - minX, depth: maxY - minY },
  };
}

export function calculatePrintLayout(plan: MetricPlan, options: PrintExportOptions): PrintLayout {
  const availableWidthMm = Math.max(10, options.bedWidthMm - options.bedMarginMm * 2);
  const availableDepthMm = Math.max(10, options.bedDepthMm - options.bedMarginMm * 2);
  if (options.exportScope === "furniture") {
    const models = plan.furniture.filter((object) => object.type !== "door" && object.type !== "window");
    const widthM = Math.max(0.001, ...models.map((object) => object.widthM));
    const depthM = Math.max(0.001, ...models.map((object) => object.heightM));
    let denominator = Math.max(1, options.scaleDenominator);
    let rotated = false;
    if (options.scaleMode === "fit") {
      const normal = Math.max((widthM * 1000) / availableWidthMm, (depthM * 1000) / availableDepthMm);
      const turned = Math.max((depthM * 1000) / availableWidthMm, (widthM * 1000) / availableDepthMm);
      rotated = options.autoRotate && turned < normal;
      denominator = rotated ? turned : normal;
    } else if (options.autoRotate) {
      rotated = depthM > widthM && availableWidthMm > availableDepthMm;
    }
    const widthMm = ((rotated ? depthM : widthM) * 1000) / denominator;
    const depthMm = ((rotated ? widthM : depthM) * 1000) / denominator;
    const heightMm = Math.max(0, ...models.map((object) => object.modelHeightM * 1000 / denominator));
    return {
      denominator,
      rotated,
      widthMm,
      depthMm,
      heightMm,
      columns: 1,
      rows: 1,
      partCount: models.length,
      availableWidthMm,
      availableDepthMm,
      warnings: models.length ? [] : ["Add at least one printable furniture object."],
    };
  }
  const widthM = Math.max(0.001, plan.boundsM.width);
  const depthM = Math.max(0.001, plan.boundsM.depth);

  let denominator = Math.max(1, options.scaleDenominator);
  let rotated = false;
  if (options.scaleMode === "fit") {
    const normal = Math.max((widthM * 1000) / availableWidthMm, (depthM * 1000) / availableDepthMm);
    const turned = Math.max((depthM * 1000) / availableWidthMm, (widthM * 1000) / availableDepthMm);
    if (options.autoRotate && turned < normal) {
      denominator = turned;
      rotated = true;
    } else {
      denominator = normal;
    }
  } else if (options.autoRotate) {
    const normalColumns = Math.ceil(((widthM * 1000) / denominator) / availableWidthMm);
    const normalRows = Math.ceil(((depthM * 1000) / denominator) / availableDepthMm);
    const turnedColumns = Math.ceil(((depthM * 1000) / denominator) / availableWidthMm);
    const turnedRows = Math.ceil(((widthM * 1000) / denominator) / availableDepthMm);
    rotated = turnedColumns * turnedRows < normalColumns * normalRows;
  }

  const widthMm = ((rotated ? depthM : widthM) * 1000) / denominator;
  const depthMm = ((rotated ? widthM : depthM) * 1000) / denominator;
  let columns = Math.max(1, Math.ceil(widthMm / availableWidthMm));
  let rows = Math.max(1, Math.ceil(depthMm / availableDepthMm));
  const splitWidthMm = columns > 1 ? Math.max(10, availableWidthMm - 4) : availableWidthMm;
  const splitDepthMm = rows > 1 ? Math.max(10, availableDepthMm - 4) : availableDepthMm;
  columns = Math.max(1, Math.ceil(widthMm / splitWidthMm));
  rows = Math.max(1, Math.ceil(depthMm / splitDepthMm));
  const scaledWallHeight = (plan.settings.wallHeightM * 1000) / denominator;
  const heightMm = options.heightMode === "low" ? options.lowProfileHeightMm : scaledWallHeight;
  const warnings: string[] = [];
  if (options.thicknessMode === "slim" && options.slimWallThicknessMm < 1.2) {
    warnings.push("Wall thickness below 1.2 mm may not print reliably with a typical 0.4 mm nozzle.");
  }
  if (options.includeFloor && options.floorThicknessMm < 0.8) {
    warnings.push("Floor thickness below 0.8 mm may be fragile.");
  }
  if (options.connectorClearanceMm < 0.1 || options.connectorClearanceMm > 0.5) {
    warnings.push("Connector clearance outside 0.10–0.50 mm may be difficult to assemble.");
  }
  if (heightMm > 250) warnings.push("The model is over 250 mm tall; check your printer's Z capacity.");

  return {
    denominator,
    rotated,
    widthMm,
    depthMm,
    heightMm,
    columns,
    rows,
    partCount: columns * rows,
    availableWidthMm: columns > 1 ? splitWidthMm : availableWidthMm,
    availableDepthMm: rows > 1 ? splitDepthMm : availableDepthMm,
    warnings,
  };
}

export function furnitureDefaults(type: string) {
  const heights: Record<string, number> = {
    bed: 0.55,
    sofa: 0.85,
    table: 0.75,
    chair: 0.9,
    desk: 0.75,
    wardrobe: 2,
    shelf: 1.8,
    door: 2.1,
    window: 1.2,
    appliance: 0.9,
    custom: 1,
  };
  return {
    modelHeightM: heights[type] ?? 1,
    openingBottomM: type === "window" ? 0.9 : 0,
    openingHeightM: type === "door" ? 2.1 : type === "window" ? 1.2 : undefined,
  };
}
