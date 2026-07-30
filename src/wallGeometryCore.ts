import { booleans, expansions, primitives } from "@jscad/modeling";
import type { Point, WallSegment } from "./plannerTypes";

export type GeometryPoint2 = [number, number];

export function counterClockwise(points: GeometryPoint2[]) {
  const signedArea = points.reduce((area, point, index) => {
    const next = points[(index + 1) % points.length];
    return area + point[0] * next[1] - next[0] * point[1];
  }, 0);
  return signedArea < 0 ? [...points].reverse() : points;
}

export function createContinuousWallRing(points: GeometryPoint2[], thickness: number) {
  const footprint = primitives.polygon({ points: counterClockwise(points) });
  const outside = expansions.offset({ delta: thickness / 2, corners: "edge" }, footprint);
  const inside = expansions.offset({ delta: -thickness / 2, corners: "edge" }, footprint);
  return booleans.subtract(outside, inside);
}

export function createExpandedFootprint(points: GeometryPoint2[], outwardDistance: number) {
  const footprint = primitives.polygon({ points: counterClockwise(points) });
  return expansions.offset({ delta: outwardDistance, corners: "edge" }, footprint);
}

export function pointTouchesWall(point: Point, wall: WallSegment, tolerance = 0.005) {
  const dx = wall.b.x - wall.a.x;
  const dy = wall.b.y - wall.a.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared < 0.000001) return false;
  const t = Math.max(0, Math.min(1, ((point.x - wall.a.x) * dx + (point.y - wall.a.y) * dy) / lengthSquared));
  const closest = { x: wall.a.x + dx * t, y: wall.a.y + dy * t };
  return Math.hypot(point.x - closest.x, point.y - closest.y) < tolerance;
}

export function connectedWallExtensions(wall: WallSegment, walls: WallSegment[], thickness: number) {
  const startConnected = walls.some(
    (candidate) => candidate.id !== wall.id && pointTouchesWall(wall.a, candidate),
  );
  const endConnected = walls.some(
    (candidate) => candidate.id !== wall.id && pointTouchesWall(wall.b, candidate),
  );
  return {
    start: startConnected ? thickness / 2 : 0,
    end: endConnected ? thickness / 2 : 0,
  };
}
