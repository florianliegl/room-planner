/// <reference lib="webworker" />
import { booleans, colors, extrusions, hulls, measurements, primitives, transforms } from "@jscad/modeling";
import { serialize as serialize3mf } from "@jscad/3mf-serializer";
import { serialize as serializeStl } from "@jscad/stl-serializer";
import { zipSync } from "fflate";
import type { MetricPlan, Point, PrintExportOptions, PrintLayout, WallSegment } from "./plannerTypes";

type Geom3 = ReturnType<typeof primitives.cuboid>;
type RequestMessage = { plan: MetricPlan; options: PrintExportOptions; layout: PrintLayout };
type NamedGeometry = Geom3 & { name?: string };

const ctx: DedicatedWorkerGlobalScope = self as unknown as DedicatedWorkerGlobalScope;

function report(progress: number, status: string) {
  ctx.postMessage({ type: "progress", progress, status });
}

function asBytes(parts: Array<ArrayBuffer | Uint8Array | string>) {
  const chunks = parts.map((part) => {
    if (typeof part === "string") return new TextEncoder().encode(part);
    return part instanceof Uint8Array ? part : new Uint8Array(part);
  });
  const size = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const result = new Uint8Array(size);
  let offset = 0;
  chunks.forEach((chunk) => {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  });
  return result;
}

function transformPoint(plan: MetricPlan, layout: PrintLayout, point: Point): Point {
  const scale = 1000 / layout.denominator;
  const x = (point.x - plan.boundsM.minX) * scale;
  const y = (point.y - plan.boundsM.minY) * scale;
  if (!layout.rotated) return { x, y };
  return { x: y, y: plan.boundsM.width * scale - x };
}

function wallGeometry(
  plan: MetricPlan,
  layout: PrintLayout,
  options: PrintExportOptions,
  wall: WallSegment,
  floorHeight: number,
) {
  const a = transformPoint(plan, layout, wall.a);
  const b = transformPoint(plan, layout, wall.b);
  const length = Math.hypot(b.x - a.x, b.y - a.y);
  if (length < 0.01) return null;
  const angle = Math.atan2(b.y - a.y, b.x - a.x);
  const realThickness = (wall.kind === "outer" ? plan.settings.outerWallThicknessM : plan.settings.innerWallThicknessM) * 1000 / layout.denominator;
  const thickness = options.thicknessMode === "slim" ? options.slimWallThicknessMm : realThickness;
  const wallHeight = layout.heightMm;
  let solid: Geom3 = transforms.translate(
    [(a.x + b.x) / 2, (a.y + b.y) / 2, 0],
    transforms.rotateZ(
      angle,
      primitives.cuboid({
        size: [length + thickness * 0.35, Math.max(0.4, thickness), wallHeight],
        center: [0, 0, floorHeight + wallHeight / 2],
      }),
    ),
  ) as Geom3;

  const openingScaleZ = wallHeight / Math.max(0.01, plan.settings.wallHeightM);
  const cutters = plan.openings
    .filter((opening) => opening.wallId === wall.id)
    .map((opening) => {
      const center = transformPoint(plan, layout, opening.centerM);
      const openingWidth = opening.widthM * 1000 / layout.denominator;
      const bottom = opening.bottomM * openingScaleZ;
      const height = Math.min(wallHeight - bottom, opening.heightM * openingScaleZ);
      if (height <= 0.05 || openingWidth <= 0.05) return null;
      return transforms.translate(
        [center.x, center.y, 0],
        transforms.rotateZ(
          angle,
          primitives.cuboid({
            size: [openingWidth, Math.max(thickness + 0.8, 1), height + 0.05],
            center: [0, 0, floorHeight + bottom + height / 2],
          }),
        ),
      ) as Geom3;
    })
    .filter((geometry): geometry is Geom3 => Boolean(geometry));

  if (cutters.length) solid = booleans.subtract(solid, ...cutters) as Geom3;
  return solid;
}

function furnitureGeometry(plan: MetricPlan, layout: PrintLayout, options: PrintExportOptions, object: MetricPlan["furniture"][number], floorHeight: number) {
  if (object.type === "door" || object.type === "window") return null;
  const center = transformPoint(plan, layout, { x: object.x, y: object.y });
  const scale = 1000 / layout.denominator;
  const width = Math.max(0.5, object.widthM * scale);
  const depth = Math.max(0.5, object.heightM * scale);
  const height = options.heightMode === "low"
    ? Math.max(0.6, object.modelHeightM / plan.settings.wallHeightM * options.lowProfileHeightMm)
    : Math.max(0.6, object.modelHeightM * scale);
  const angle = ((layout.rotated ? object.rotation + 90 : object.rotation) * Math.PI) / 180;
  const box = (size: [number, number, number], offset: [number, number, number]) =>
    primitives.cuboid({ size, center: [offset[0], offset[1], floorHeight + offset[2]] });
  const pieces: Geom3[] = [];

  if (object.type === "bed") {
    pieces.push(box([width, depth, height * 0.35], [0, 0, height * 0.175]));
    pieces.push(box([width, depth * 0.08, height * 0.75], [0, -depth * 0.46, height * 0.375]));
  } else if (object.type === "sofa") {
    pieces.push(box([width, depth, height * 0.45], [0, 0, height * 0.225]));
    pieces.push(box([width, depth * 0.18, height * 0.55], [0, -depth * 0.4, height * 0.65]));
    pieces.push(box([width * 0.12, depth, height * 0.55], [-width * 0.44, 0, height * 0.36]));
    pieces.push(box([width * 0.12, depth, height * 0.55], [width * 0.44, 0, height * 0.36]));
  } else if (object.type === "table" || object.type === "desk" || object.type === "chair") {
    const topHeight = object.type === "chair" ? height * 0.52 : height * 0.92;
    pieces.push(box([width, depth, Math.max(0.5, height * 0.1)], [0, 0, topHeight]));
    [-1, 1].forEach((sx) => [-1, 1].forEach((sy) => {
      pieces.push(box([Math.max(0.5, width * 0.1), Math.max(0.5, depth * 0.1), topHeight], [sx * width * 0.4, sy * depth * 0.4, topHeight / 2]));
    }));
    if (object.type === "chair") pieces.push(box([width, depth * 0.12, height * 0.5], [0, -depth * 0.44, height * 0.75]));
  } else if (object.type === "shelf") {
    pieces.push(box([width, depth * 0.18, height], [0, -depth * 0.4, height / 2]));
    for (let level = 0; level < 4; level += 1) pieces.push(box([width, depth, Math.max(0.4, height * 0.035)], [0, 0, (height * level) / 3]));
  } else {
    pieces.push(box([width, depth, height], [0, 0, height / 2]));
  }

  let geometry = booleans.union(...pieces) as Geom3;
  geometry = transforms.rotateZ(-angle, geometry) as Geom3;
  geometry = transforms.translate([center.x, center.y, 0], geometry) as Geom3;
  return geometry;
}

function floorGeometry(plan: MetricPlan, layout: PrintLayout, thickness: number) {
  const points = plan.outlineM.map((point) => {
    const transformed = transformPoint(plan, layout, point);
    return [transformed.x, transformed.y] as [number, number];
  });
  if (points.length < 3) return null;
  return extrusions.extrudeLinear({ height: thickness }, primitives.polygon({ points })) as Geom3;
}

function lineIntersectionAtX(a: Point, b: Point, x: number) {
  if ((a.x < x && b.x < x) || (a.x > x && b.x > x) || Math.abs(a.x - b.x) < 0.001) return null;
  const t = (x - a.x) / (b.x - a.x);
  if (t < 0 || t > 1) return null;
  return a.y + (b.y - a.y) * t;
}

function lineIntersectionAtY(a: Point, b: Point, y: number) {
  if ((a.y < y && b.y < y) || (a.y > y && b.y > y) || Math.abs(a.y - b.y) < 0.001) return null;
  const t = (y - a.y) / (b.y - a.y);
  if (t < 0 || t > 1) return null;
  return a.x + (b.x - a.x) * t;
}

function scoreCut(plan: MetricPlan, layout: PrintLayout, axis: "x" | "y", value: number, target: number) {
  let score = Math.abs(value - target) * 0.04;
  const points = plan.walls.map((wall) => ({
    wall,
    a: transformPoint(plan, layout, wall.a),
    b: transformPoint(plan, layout, wall.b),
  }));
  points.forEach(({ a, b }) => {
    const hit = axis === "x" ? lineIntersectionAtX(a, b, value) : lineIntersectionAtY(a, b, value);
    if (hit !== null) score += 10;
    [a, b].forEach((point) => {
      const coordinate = axis === "x" ? point.x : point.y;
      if (Math.abs(coordinate - value) < 5) score += 28;
    });
  });
  plan.openings.forEach((opening) => {
    const center = transformPoint(plan, layout, opening.centerM);
    if (Math.abs((axis === "x" ? center.x : center.y) - value) < opening.widthM * 1000 / layout.denominator / 2 + 5) score += 70;
  });
  if (optionsForScore.furnitureMode === "fused") {
    plan.furniture.forEach((object) => {
      if (object.type === "door" || object.type === "window") return;
      const center = transformPoint(plan, layout, { x: object.x, y: object.y });
      const radius = Math.max(object.widthM, object.heightM) * 500 / layout.denominator;
      if (Math.abs((axis === "x" ? center.x : center.y) - value) < radius + 4) score += 90;
    });
  }
  return score;
}

let optionsForScore: PrintExportOptions;

function chooseCuts(plan: MetricPlan, layout: PrintLayout, axis: "x" | "y", count: number, total: number, available: number) {
  if (count <= 1) return [0, total];
  const cuts = [0];
  for (let index = 1; index < count; index += 1) {
    const target = total * index / count;
    const remaining = count - index;
    const minimum = Math.max(cuts[cuts.length - 1] + Math.max(1, total / count * 0.72), total - remaining * available);
    const maximum = Math.min(cuts[cuts.length - 1] + available, total - remaining * Math.max(1, total / count * 0.72));
    let best = Math.max(minimum, Math.min(maximum, target));
    let bestScore = Infinity;
    for (let sample = 0; sample <= 24; sample += 1) {
      const candidate = minimum + (maximum - minimum) * sample / 24;
      const score = scoreCut(plan, layout, axis, candidate, target);
      if (score < bestScore) {
        bestScore = score;
        best = candidate;
      }
    }
    cuts.push(best);
  }
  cuts.push(total);
  return cuts;
}

function connectorShape(axis: "x" | "y", seam: number, along: number, direction: 1 | -1, floorHeight: number, wallHeight: number, thickness: number, clearance = 0) {
  const depth = 3 + clearance;
  const width = Math.max(4, thickness * 3) + clearance * 2;
  const height = floorHeight > 0 ? Math.max(0.5, floorHeight * 0.62) + clearance : Math.max(1, Math.min(4, wallHeight * 0.45)) + clearance;
  const z = floorHeight > 0 ? height / 2 : Math.max(height / 2, wallHeight * 0.28);
  const small = primitives.cuboid({
    size: axis === "x" ? [depth * 0.72, width * 0.82, height * 0.82] : [width * 0.82, depth * 0.72, height * 0.82],
    center: axis === "x"
      ? [seam + direction * depth * 0.65, along, z]
      : [along, seam + direction * depth * 0.65, z],
  });
  const large = primitives.cuboid({
    size: axis === "x" ? [depth * 0.35, width, height] : [width, depth * 0.35, height],
    center: axis === "x"
      ? [seam + direction * depth * 0.15, along, z]
      : [along, seam + direction * depth * 0.15, z],
  });
  return hulls.hull(small, large) as Geom3;
}

function connectorPositions(plan: MetricPlan, layout: PrintLayout, axis: "x" | "y", seam: number, spanStart: number, spanEnd: number, includeFloor: boolean) {
  if (includeFloor) return [spanStart + (spanEnd - spanStart) / 3, spanStart + (spanEnd - spanStart) * 2 / 3];
  const hits: number[] = [];
  plan.walls.forEach((wall) => {
    const a = transformPoint(plan, layout, wall.a);
    const b = transformPoint(plan, layout, wall.b);
    const hit = axis === "x" ? lineIntersectionAtX(a, b, seam) : lineIntersectionAtY(a, b, seam);
    if (hit !== null && hit > spanStart + 2 && hit < spanEnd - 2) hits.push(hit);
  });
  return hits.slice(0, 3);
}

function geometryHasVolume(geometry: Geom3) {
  try {
    return Math.abs(measurements.measureVolume(geometry)) > 0.0001;
  } catch {
    return false;
  }
}

ctx.onmessage = (event: MessageEvent<RequestMessage>) => {
  try {
    const { plan, options, layout } = event.data;
    optionsForScore = options;
    report(5, "Building walls");
    const floorHeight = options.includeFloor ? options.floorThicknessMm : 0;
    const structural: Geom3[] = [];
    const floor = options.includeFloor ? floorGeometry(plan, layout, floorHeight) : null;
    if (floor) structural.push(floor);
    plan.walls.forEach((wall) => {
      const geometry = wallGeometry(plan, layout, options, wall, floorHeight);
      if (geometry) structural.push(geometry);
    });
    if (!structural.length) throw new Error("The plan has no printable walls or floor.");
    let base = booleans.union(...structural) as Geom3;

    report(24, "Building furniture");
    const furniture = plan.furniture
      .map((object) => ({ object, geometry: furnitureGeometry(plan, layout, options, object, floorHeight) }))
      .filter((entry): entry is { object: MetricPlan["furniture"][number]; geometry: Geom3 } => Boolean(entry.geometry));
    if (options.furnitureMode === "fused" && furniture.length) base = booleans.union(base, ...furniture.map((entry) => entry.geometry)) as Geom3;

    const xCuts = chooseCuts(plan, layout, "x", layout.columns, layout.widthMm, layout.availableWidthMm);
    const yCuts = chooseCuts(plan, layout, "y", layout.rows, layout.depthMm, layout.availableDepthMm);
    const parts: NamedGeometry[] = [];

    report(38, "Splitting print parts");
    for (let row = 0; row < layout.rows; row += 1) {
      for (let column = 0; column < layout.columns; column += 1) {
        const x0 = xCuts[column];
        const x1 = xCuts[column + 1];
        const y0 = yCuts[row];
        const y1 = yCuts[row + 1];
        const clip = primitives.cuboid({
          size: [x1 - x0 + 0.02, y1 - y0 + 0.02, Math.max(500, layout.heightMm + floorHeight + 20)],
          center: [(x0 + x1) / 2, (y0 + y1) / 2, Math.max(500, layout.heightMm + floorHeight + 20) / 2 - 2],
        });
        let piece = booleans.intersect(base, clip) as Geom3;
        if (!geometryHasVolume(piece)) continue;

        const thickness = options.thicknessMode === "slim" ? options.slimWallThicknessMm : Math.max(
          plan.settings.innerWallThicknessM * 1000 / layout.denominator,
          0.8,
        );
        if (column < layout.columns - 1) {
          const seam = x1;
          connectorPositions(plan, layout, "x", seam, y0, y1, options.includeFloor).forEach((along) => {
            piece = booleans.union(piece, connectorShape("x", seam, along, 1, floorHeight, layout.heightMm, thickness)) as Geom3;
          });
        }
        if (column > 0) {
          const seam = x0;
          connectorPositions(plan, layout, "x", seam, y0, y1, options.includeFloor).forEach((along) => {
            piece = booleans.subtract(piece, connectorShape("x", seam, along, 1, floorHeight, layout.heightMm, thickness, options.connectorClearanceMm)) as Geom3;
          });
        }
        if (row < layout.rows - 1) {
          const seam = y1;
          connectorPositions(plan, layout, "y", seam, x0, x1, options.includeFloor).forEach((along) => {
            piece = booleans.union(piece, connectorShape("y", seam, along, 1, floorHeight, layout.heightMm, thickness)) as Geom3;
          });
        }
        if (row > 0) {
          const seam = y0;
          connectorPositions(plan, layout, "y", seam, x0, x1, options.includeFloor).forEach((along) => {
            piece = booleans.subtract(piece, connectorShape("y", seam, along, 1, floorHeight, layout.heightMm, thickness, options.connectorClearanceMm)) as Geom3;
          });
        }
        const named = colors.colorize([0.88, 0.91, 0.95, 1], piece) as NamedGeometry;
        named.name = `Room part R${row + 1}C${column + 1}`;
        parts.push(named);
      }
    }

    if (options.furnitureMode === "loose") {
      furniture.forEach(({ object, geometry }) => {
        const named = colors.colorize([0.4, 0.55, 0.75, 1], geometry) as NamedGeometry;
        named.name = `Furniture - ${object.label}`;
        parts.push(named);
      });
    }
    if (!parts.length) throw new Error("No printable geometry was generated.");

    report(82, `Serializing ${parts.length} object${parts.length === 1 ? "" : "s"}`);
    if (options.format === "3mf") {
      const bytes = asBytes(serialize3mf({ unit: "millimeter", compress: true, metadata: true }, ...parts));
      ctx.postMessage({ type: "complete", filename: "room-plan.3mf", mimeType: "model/3mf", buffer: bytes.buffer }, [bytes.buffer]);
    } else if (parts.length === 1) {
      const bytes = asBytes(serializeStl({ binary: true }, parts[0]));
      ctx.postMessage({ type: "complete", filename: "room-plan.stl", mimeType: "model/stl", buffer: bytes.buffer }, [bytes.buffer]);
    } else {
      const files: Record<string, Uint8Array> = {};
      parts.forEach((part, index) => {
        files[`room-plan-${String(index + 1).padStart(2, "0")}.stl`] = asBytes(serializeStl({ binary: true }, part));
      });
      const zipped = zipSync(files, { level: 6 });
      ctx.postMessage({ type: "complete", filename: "room-plan-stl-parts.zip", mimeType: "application/zip", buffer: zipped.buffer }, [zipped.buffer]);
    }
  } catch (error) {
    ctx.postMessage({ type: "error", message: error instanceof Error ? error.message : "Could not generate the print file." });
  }
};

export {};
