/// <reference lib="webworker" />
import { booleans, colors, extrusions, measurements, primitives, transforms } from "@jscad/modeling";
import { serialize as serialize3mf } from "@jscad/3mf-serializer";
import { serialize as serializeStl } from "@jscad/stl-serializer";
import { zipSync } from "fflate";
import { buildFurnitureParts, chairConnectorLayout } from "./furnitureGeometry";
import type { MetricPlan, Point, PrintExportOptions, PrintLayout, WallSegment } from "./plannerTypes";
import {
  connectedWallExtensions,
  counterClockwise,
  createContinuousWallRing,
  createExpandedFootprint,
} from "./wallGeometryCore";

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
  // Canvas coordinates grow downward. Printing/3D coordinates grow upward,
  // so invert Y to preserve the plan's visible handedness in slicers.
  const y = (plan.boundsM.maxY - point.y) * scale;
  if (!layout.rotated) return { x, y };
  return { x: y, y: plan.boundsM.width * scale - x };
}

function transformedOutlinePoints(plan: MetricPlan, layout: PrintLayout) {
  const points = plan.outlineM.map((point) => {
    const transformed = transformPoint(plan, layout, point);
    return [transformed.x, transformed.y] as [number, number];
  });
  return counterClockwise(points);
}

function physicalWallThickness(
  plan: MetricPlan,
  layout: PrintLayout,
  options: PrintExportOptions,
  kind: WallSegment["kind"],
) {
  const realThickness =
    (kind === "outer" ? plan.settings.outerWallThicknessM : plan.settings.innerWallThicknessM) *
    1000 /
    layout.denominator;
  return Math.max(0.4, options.thicknessMode === "slim" ? options.slimWallThicknessMm : realThickness);
}

function wallFloorOverlap(floorHeight: number) {
  return floorHeight > 0 ? Math.min(0.08, floorHeight * 0.1) : 0;
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
  const thickness = physicalWallThickness(plan, layout, options, wall.kind);
  const wallHeight = layout.heightMm;
  const floorOverlap = wallFloorOverlap(floorHeight);
  const wallBase = floorHeight - floorOverlap;
  const solidHeight = wallHeight + floorOverlap;
  const direction = { x: (b.x - a.x) / length, y: (b.y - a.y) / length };
  const extensions = connectedWallExtensions(wall, plan.walls, thickness);
  const startExtension = extensions.start;
  const endExtension = extensions.end;
  const centerShift = (endExtension - startExtension) / 2;
  let solid: Geom3 = transforms.translate(
    [
      (a.x + b.x) / 2 + direction.x * centerShift,
      (a.y + b.y) / 2 + direction.y * centerShift,
      0,
    ],
    transforms.rotateZ(
      angle,
      primitives.cuboid({
        size: [length + startExtension + endExtension, thickness, solidHeight],
        center: [0, 0, wallBase + solidHeight / 2],
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

function outerWallRing(
  plan: MetricPlan,
  layout: PrintLayout,
  options: PrintExportOptions,
  floorHeight: number,
) {
  if (plan.outlineM.length < 3) return null;
  const thickness = physicalWallThickness(plan, layout, options, "outer");
  const floorOverlap = wallFloorOverlap(floorHeight);
  const points = transformedOutlinePoints(plan, layout);
  const ring = createContinuousWallRing(points, thickness);
  let solid = transforms.translate(
    [0, 0, floorHeight - floorOverlap],
    extrusions.extrudeLinear({ height: layout.heightMm + floorOverlap }, ring),
  ) as Geom3;
  const openingScaleZ = layout.heightMm / Math.max(0.01, plan.settings.wallHeightM);
  const cutters = plan.openings
    .map((opening) => {
      const wall = plan.walls.find((candidate) => candidate.id === opening.wallId);
      if (!wall || wall.kind !== "outer") return null;
      const a = transformPoint(plan, layout, wall.a);
      const b = transformPoint(plan, layout, wall.b);
      const angle = Math.atan2(b.y - a.y, b.x - a.x);
      const center = transformPoint(plan, layout, opening.centerM);
      const width = opening.widthM * 1000 / layout.denominator;
      const bottom = opening.bottomM * openingScaleZ;
      const height = Math.min(layout.heightMm - bottom, opening.heightM * openingScaleZ);
      if (height <= 0.05 || width <= 0.05) return null;
      return transforms.translate(
        [center.x, center.y, 0],
        transforms.rotateZ(
          angle,
          primitives.cuboid({
            size: [width, thickness + 0.8, height + 0.05],
            center: [0, 0, floorHeight + bottom + height / 2],
          }),
        ),
      ) as Geom3;
    })
    .filter((geometry): geometry is Geom3 => Boolean(geometry));
  if (cutters.length) solid = booleans.subtract(solid, ...cutters) as Geom3;
  return solid;
}

function interiorClipGeometry(plan: MetricPlan, layout: PrintLayout, floorHeight: number) {
  if (plan.outlineM.length < 3) return null;
  const points = transformedOutlinePoints(plan, layout);
  const floorOverlap = wallFloorOverlap(floorHeight);
  return transforms.translate(
    [0, 0, floorHeight - floorOverlap],
    extrusions.extrudeLinear(
      { height: layout.heightMm + floorOverlap },
      primitives.polygon({ points }),
    ),
  ) as Geom3;
}

function furnitureGeometry(
  plan: MetricPlan,
  layout: PrintLayout,
  options: PrintExportOptions,
  object: MetricPlan["furniture"][number],
  floorHeight: number,
  preservePosition = true,
) {
  if (object.type === "door" || object.type === "window") return null;
  const center = preservePosition ? transformPoint(plan, layout, { x: object.x, y: object.y }) : { x: 0, y: 0 };
  const scale = 1000 / layout.denominator;
  const width = Math.max(0.5, object.widthM * scale);
  const depth = Math.max(0.5, object.heightM * scale);
  const height = options.exportScope === "room" && options.heightMode === "low"
    ? Math.max(0.6, object.modelHeightM / plan.settings.wallHeightM * options.lowProfileHeightMm)
    : Math.max(0.6, object.modelHeightM * scale);
  const angle = ((layout.rotated ? object.rotation + 90 : object.rotation) * Math.PI) / 180;
  const style = options.furnitureStyles?.[object.id] ?? "classic";
  const pieces = buildFurnitureParts(object.type, width, depth, height, style).map((part) =>
    primitives.cuboid({
      size: part.size,
      center: [part.center[0], part.center[1], floorHeight + part.center[2]],
    }) as Geom3,
  );
  if (!pieces.length) return null;
  let geometry = pieces.length === 1 ? pieces[0] : booleans.union(...pieces) as Geom3;
  geometry = transforms.rotateZ(-angle, geometry) as Geom3;
  geometry = transforms.translate([center.x, center.y, 0], geometry) as Geom3;
  return geometry;
}

function chairFrictionFitGeometries(
  plan: MetricPlan,
  layout: PrintLayout,
  options: PrintExportOptions,
  object: MetricPlan["furniture"][number],
  floorHeight: number,
  preservePosition: boolean,
) {
  if (object.type !== "chair") return null;
  const scale = 1000 / layout.denominator;
  const width = Math.max(0.5, object.widthM * scale);
  const depth = Math.max(0.5, object.heightM * scale);
  const height = options.exportScope === "room" && options.heightMode === "low"
    ? Math.max(0.6, object.modelHeightM / plan.settings.wallHeightM * options.lowProfileHeightMm)
    : Math.max(0.6, object.modelHeightM * scale);
  const style = options.furnitureStyles?.[object.id] ?? "classic";
  const specs = buildFurnitureParts(object.type, width, depth, height, style);
  const makeSolid = (assemblyPart: "body" | "back") => {
    const pieces = specs
      .filter((part) => part.assemblyPart === assemblyPart)
      .map((part) => primitives.cuboid({
        size: part.size,
        center: [part.center[0], part.center[1], floorHeight + part.center[2]],
      }) as Geom3);
    return pieces.length === 1 ? pieces[0] : booleans.union(...pieces) as Geom3;
  };
  let body = makeSolid("body");
  let back = makeSolid("back");
  const connector = chairConnectorLayout(width, depth, height, style);
  const pinRadius = Math.max(0.6, Math.min(1.6, width * 0.035));
  const pinLength = Math.max(1.8, Math.min(5, height * 0.1));
  const socketRadius = pinRadius + Math.max(0, options.connectorClearanceMm) / 2;
  connector.xPositions.forEach((x) => {
    const pin = primitives.cylinderElliptic({
      height: pinLength + 0.08,
      startRadius: [pinRadius * 0.86, pinRadius * 0.86],
      endRadius: [pinRadius, pinRadius],
      center: [x, connector.y, floorHeight + connector.seatZ - pinLength / 2 + 0.04],
      segments: 20,
    }) as Geom3;
    const socket = primitives.cylinder({
      height: pinLength + 0.16,
      radius: socketRadius,
      center: [x, connector.y, floorHeight + connector.seatZ - pinLength / 2],
      segments: 20,
    }) as Geom3;
    back = booleans.union(back, pin) as Geom3;
    body = booleans.subtract(body, socket) as Geom3;
  });
  const center = preservePosition ? transformPoint(plan, layout, { x: object.x, y: object.y }) : { x: 0, y: 0 };
  const angle = ((layout.rotated ? object.rotation + 90 : object.rotation) * Math.PI) / 180;
  const place = (geometry: Geom3) =>
    transforms.translate(
      [center.x, center.y, 0],
      transforms.rotateZ(-angle, geometry),
    ) as Geom3;
  return [
    { suffix: "Body", geometry: place(body) },
    { suffix: "Back", geometry: place(back) },
  ];
}

function floorGeometry(
  plan: MetricPlan,
  layout: PrintLayout,
  options: PrintExportOptions,
  thickness: number,
) {
  const points = transformedOutlinePoints(plan, layout);
  if (points.length < 3) return null;
  const outerWallThickness = physicalWallThickness(plan, layout, options, "outer");
  const footprint = createExpandedFootprint(points, outerWallThickness / 2);
  return extrusions.extrudeLinear({ height: thickness }, footprint) as Geom3;
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

function slideConnectorShape(
  seam: number,
  along: number,
  axis: "x" | "y",
  forward: Point,
  floorHeight: number,
  wallHeight: number,
  thickness: number,
  clearance = 0,
) {
  const origin = axis === "x" ? { x: seam, y: along } : { x: along, y: seam };
  const side = { x: -forward.y, y: forward.x };
  const depth = Math.max(2.2, Math.min(4.5, thickness * 1.4));
  const headWidth = Math.max(0.35, Math.min(thickness * 0.58, thickness - 0.4));
  const neckWidth = Math.max(0.25, headWidth * 0.62);
  const slotExtra = clearance;
  const start = {
    x: origin.x - forward.x * slotExtra * 0.5,
    y: origin.y - forward.y * slotExtra * 0.5,
  };
  const end = {
    x: origin.x + forward.x * (depth + slotExtra * 0.5),
    y: origin.y + forward.y * (depth + slotExtra * 0.5),
  };
  const neckHalf = (neckWidth + slotExtra) / 2;
  const headHalf = (headWidth + slotExtra) / 2;
  const profile = primitives.polygon({
    points: [
      [start.x - side.x * neckHalf, start.y - side.y * neckHalf],
      [end.x - side.x * headHalf, end.y - side.y * headHalf],
      [end.x + side.x * headHalf, end.y + side.y * headHalf],
      [start.x + side.x * neckHalf, start.y + side.y * neckHalf],
    ],
  });
  const verticalClearance = clearance > 0 ? Math.max(0.05, clearance / 2) : 0;
  return transforms.translate(
    [0, 0, floorHeight - verticalClearance],
    extrusions.extrudeLinear(
      { height: wallHeight + verticalClearance * 2 },
      profile,
    ),
  ) as Geom3;
}

function wallConnectorHits(
  plan: MetricPlan,
  layout: PrintLayout,
  options: PrintExportOptions,
  axis: "x" | "y",
  seam: number,
  spanStart: number,
  spanEnd: number,
) {
  const hits: Array<{ along: number; forward: Point; thickness: number }> = [];
  plan.walls.forEach((wall) => {
    const a = transformPoint(plan, layout, wall.a);
    const b = transformPoint(plan, layout, wall.b);
    const hit = axis === "x" ? lineIntersectionAtX(a, b, seam) : lineIntersectionAtY(a, b, seam);
    if (hit === null || hit <= spanStart + 2 || hit >= spanEnd - 2) return;
    const hitPoint = axis === "x" ? { x: seam, y: hit } : { x: hit, y: seam };
    if (
      Math.min(
        Math.hypot(hitPoint.x - a.x, hitPoint.y - a.y),
        Math.hypot(hitPoint.x - b.x, hitPoint.y - b.y),
      ) < 6
    ) return;
    const crossesOpening = plan.openings
      .filter((opening) => opening.wallId === wall.id)
      .some((opening) => {
        const center = transformPoint(plan, layout, opening.centerM);
        return Math.hypot(center.x - hitPoint.x, center.y - hitPoint.y) <
          opening.widthM * 500 / layout.denominator + 1;
      });
    if (crossesOpening) return;
    const wallDx = b.x - a.x;
    const wallDy = b.y - a.y;
    const wallLength = Math.hypot(wallDx, wallDy);
    if (wallLength < 0.01) return;
    let forward = { x: wallDx / wallLength, y: wallDy / wallLength };
    if ((axis === "x" ? forward.x : forward.y) < 0) {
      forward = { x: -forward.x, y: -forward.y };
    }
    const realThickness =
      (wall.kind === "outer" ? plan.settings.outerWallThicknessM : plan.settings.innerWallThicknessM) *
      1000 /
      layout.denominator;
    const thickness = options.thicknessMode === "slim" ? options.slimWallThicknessMm : realThickness;
    hits.push({ along: hit, forward, thickness: Math.max(0.8, thickness) });
  });
  return hits
    .sort((a, b) => a.along - b.along)
    .filter((hit, index, all) => index === 0 || Math.abs(hit.along - all[index - 1].along) > 0.5)
    .slice(0, 4);
}

function geometryHasVolume(geometry: Geom3) {
  try {
    return Math.abs(measurements.measureVolume(geometry)) > 0.0001;
  } catch {
    return false;
  }
}

function completeExport(parts: NamedGeometry[], options: PrintExportOptions) {
  const furnitureOnly = options.exportScope === "furniture";
  const baseName = furnitureOnly ? "furniture-models" : "room-plan";
  report(82, `Serializing ${parts.length} object${parts.length === 1 ? "" : "s"}`);
  if (options.format === "3mf") {
    const bytes = asBytes(serialize3mf({ unit: "millimeter", compress: true, metadata: true }, ...parts));
    ctx.postMessage({ type: "complete", filename: `${baseName}.3mf`, mimeType: "model/3mf", buffer: bytes.buffer }, [bytes.buffer]);
  } else if (parts.length === 1) {
    const bytes = asBytes(serializeStl({ binary: true }, parts[0]));
    ctx.postMessage({ type: "complete", filename: `${baseName}.stl`, mimeType: "model/stl", buffer: bytes.buffer }, [bytes.buffer]);
  } else {
    const files: Record<string, Uint8Array> = {};
    parts.forEach((part, index) => {
      const label = part.name?.replace(/[^a-z0-9_-]+/gi, "-").replace(/^-|-$/g, "") || `${baseName}-${index + 1}`;
      files[`${String(index + 1).padStart(2, "0")}-${label}.stl`] = asBytes(serializeStl({ binary: true }, part));
    });
    const zipped = zipSync(files, { level: 6 });
    ctx.postMessage({ type: "complete", filename: `${baseName}-stl.zip`, mimeType: "application/zip", buffer: zipped.buffer }, [zipped.buffer]);
  }
}

ctx.onmessage = (event: MessageEvent<RequestMessage>) => {
  try {
    const { plan, options, layout } = event.data;
    optionsForScore = options;
    if (options.exportScope === "furniture") {
      report(12, "Building furniture models");
      const parts = plan.furniture.flatMap((object, index) => {
          if (
            object.type === "chair" &&
            options.furnitureAssemblyModes?.[object.id] === "friction-fit"
          ) {
            const split = chairFrictionFitGeometries(plan, layout, options, object, 0, false);
            return (split ?? []).map(({ suffix, geometry }) => {
              const named = colors.colorize([0.4, 0.55, 0.75, 1], geometry) as NamedGeometry;
              named.name = `Furniture ${String(index + 1).padStart(2, "0")} - ${object.label} - ${suffix}`;
              return named;
            });
          }
          const geometry = furnitureGeometry(plan, layout, options, object, 0, false);
          if (!geometry) return [];
          const named = colors.colorize([0.4, 0.55, 0.75, 1], geometry) as NamedGeometry;
          named.name = `Furniture ${String(index + 1).padStart(2, "0")} - ${object.label}`;
          return [named];
        })
        .filter((geometry): geometry is NamedGeometry => Boolean(geometry));
      if (!parts.length) throw new Error("Add at least one printable furniture object.");
      completeExport(parts, options);
      return;
    }
    report(5, "Building walls");
    const floorHeight = options.includeFloor ? options.floorThicknessMm : 0;
    const structural: Geom3[] = [];
    const floor = options.includeFloor ? floorGeometry(plan, layout, options, floorHeight) : null;
    if (floor) structural.push(floor);
    const ring = outerWallRing(plan, layout, options, floorHeight);
    const fallbackOuterWalls = ring
      ? []
      : plan.walls
          .filter((wall) => wall.kind === "outer")
          .map((wall) => wallGeometry(plan, layout, options, wall, floorHeight))
          .filter((geometry): geometry is Geom3 => Boolean(geometry));
    const innerWalls = plan.walls
      .filter((wall) => wall.kind === "inner")
      .map((wall) => wallGeometry(plan, layout, options, wall, floorHeight))
      .filter((geometry): geometry is Geom3 => Boolean(geometry));
    let innerJoined =
      innerWalls.length > 1 ? booleans.union(...innerWalls) as Geom3 : innerWalls[0];
    const interiorClip = interiorClipGeometry(plan, layout, floorHeight);
    if (innerJoined && interiorClip) {
      innerJoined = booleans.intersect(innerJoined, interiorClip) as Geom3;
    }
    const wallSolids = [
      ...(ring ? [ring] : fallbackOuterWalls),
      ...(innerJoined ? [innerJoined] : []),
    ];
    if (wallSolids.length) {
      structural.push(wallSolids.length === 1 ? wallSolids[0] : booleans.union(...wallSolids) as Geom3);
    }
    if (!structural.length) throw new Error("The plan has no printable walls or floor.");
    let base = structural.length === 1 ? structural[0] : booleans.union(...structural) as Geom3;

    report(24, "Building furniture");
    const furniture = plan.furniture.flatMap((object) => {
      if (
        options.furnitureMode === "loose" &&
        object.type === "chair" &&
        options.furnitureAssemblyModes?.[object.id] === "friction-fit"
      ) {
        return (chairFrictionFitGeometries(plan, layout, options, object, floorHeight, true) ?? [])
          .map(({ suffix, geometry }) => ({ object, geometry, suffix }));
      }
      const geometry = furnitureGeometry(plan, layout, options, object, floorHeight);
      return geometry ? [{ object, geometry, suffix: "" }] : [];
    });
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

        if (column < layout.columns - 1) {
          const seam = x1;
          wallConnectorHits(plan, layout, options, "x", seam, y0, y1).forEach((hit) => {
            piece = booleans.union(piece, slideConnectorShape(seam, hit.along, "x", hit.forward, floorHeight, layout.heightMm, hit.thickness)) as Geom3;
          });
        }
        if (column > 0) {
          const seam = x0;
          wallConnectorHits(plan, layout, options, "x", seam, y0, y1).forEach((hit) => {
            piece = booleans.subtract(piece, slideConnectorShape(seam, hit.along, "x", hit.forward, floorHeight, layout.heightMm, hit.thickness, options.connectorClearanceMm)) as Geom3;
          });
        }
        if (row < layout.rows - 1) {
          const seam = y1;
          wallConnectorHits(plan, layout, options, "y", seam, x0, x1).forEach((hit) => {
            piece = booleans.union(piece, slideConnectorShape(seam, hit.along, "y", hit.forward, floorHeight, layout.heightMm, hit.thickness)) as Geom3;
          });
        }
        if (row > 0) {
          const seam = y0;
          wallConnectorHits(plan, layout, options, "y", seam, x0, x1).forEach((hit) => {
            piece = booleans.subtract(piece, slideConnectorShape(seam, hit.along, "y", hit.forward, floorHeight, layout.heightMm, hit.thickness, options.connectorClearanceMm)) as Geom3;
          });
        }
        const named = colors.colorize([0.88, 0.91, 0.95, 1], piece) as NamedGeometry;
        named.name = `Room part R${row + 1}C${column + 1}`;
        parts.push(named);
      }
    }

    if (options.furnitureMode === "loose") {
      furniture.forEach(({ object, geometry, suffix }) => {
        const named = colors.colorize([0.4, 0.55, 0.75, 1], geometry) as NamedGeometry;
        named.name = `Furniture - ${object.label}${suffix ? ` - ${suffix}` : ""}`;
        parts.push(named);
      });
    }
    if (!parts.length) throw new Error("No printable geometry was generated.");

    completeExport(parts, options);
  } catch (error) {
    ctx.postMessage({ type: "error", message: error instanceof Error ? error.message : "Could not generate the print file." });
  }
};

export {};
