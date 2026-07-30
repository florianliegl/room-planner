import {
  Armchair,
  BedDouble,
  Box,
  BringToFront,
  Download,
  FileDown,
  FileUp,
  Grid2X2,
  Hand,
  ImagePlus,
  Maximize2,
  MousePointer2,
  MoveHorizontal,
  Pencil,
  PencilRuler,
  Plus,
  Printer,
  RotateCw,
  Ruler,
  Save,
  Sofa,
  Square,
  Trash2,
  Undo2,
} from "lucide-react";
import React from "react";
import { ChangeEvent, lazy, PointerEvent, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { createMetricPlan, furnitureDefaults } from "./metricPlan";
import {
  defaultConstructionSettings,
  type ConstructionSettings,
  type Furniture,
  type Point,
  type WallSegment,
} from "./plannerTypes";

type Tool = "select" | "pan" | "outer" | "wall" | "customRoom" | "scale" | "ruler";
type Selection = { kind: "room" | "object" | "wall"; id: string } | null;

type Room = {
  id: string;
  name: string;
  points: Point[];
  color: string;
  wallSeed?: Point;
};

type Background = {
  dataUrl: string;
  name: string;
  width: number;
  height: number;
  opacity: number;
};

type ProjectFile = {
  roomPlannerVersion: 1 | 2;
  background: Background | null;
  scaleMPerPx: number | null;
  scaleSource: string;
  wallSnapEnabled?: boolean;
  outerOutline?: Point[];
  innerWalls?: WallSegment[];
  rooms: Room[];
  objects: Furniture[];
  construction?: ConstructionSettings;
  view: Viewport;
};

type Viewport = { x: number; y: number; zoom: number };
type ResizeHandle = "left" | "right" | "top" | "bottom";
type WallProjection = { wall: WallSegment; point: Point; distance: number; t: number };
type OpeningProjection = { objectId: string; wallId: string; a: Point; b: Point; wallKind: WallSegment["kind"] };

type DragState =
  | { kind: "pan"; start: Point; view: Viewport }
  | { kind: "object"; id: string; start: Point; object: Furniture }
  | { kind: "object-resize"; id: string; handle: ResizeHandle; object: Furniture }
  | { kind: "object-rotate"; id: string; startAngle: number; object: Furniture }
  | { kind: "room"; id: string; start: Point; points: Point[] }
  | { kind: "vertex"; roomId: string; index: number }
  | { kind: "outer-point"; index: number }
  | { kind: "inner-wall-point"; wallId: string; end: "a" | "b" }
  | null;

type PinchGesture = {
  startDistance: number;
  startCenter: Point;
  startViewport: Viewport;
  startWorldCenter: Point;
};

type PendingTouchTap = {
  pointerId: number;
  startScreen: Point;
  currentWorld: Point;
  tool: Tool;
  moved: boolean;
};

type MobileDrawer = "tools" | "files" | "details" | null;

const defaultScaleMPerPx = 0.02;
const colors = ["#2563eb", "#16a34a", "#dc2626", "#ca8a04", "#7c3aed", "#0891b2"];
const pointEps = 0.75;
const autosaveKey = "room-planner-autosave-v1";
const ThreeDView = lazy(() => import("./ThreeDView"));
const PrintExportDialog = lazy(() => import("./PrintExportDialog"));

const presets = [
  { type: "bed", label: "Bed", widthM: 2, heightM: 1.6, color: "#7c3aed", icon: BedDouble },
  { type: "sofa", label: "Sofa", widthM: 2.2, heightM: 0.95, color: "#0f766e", icon: Sofa },
  { type: "table", label: "Table", widthM: 1.4, heightM: 0.85, color: "#b45309", icon: Square },
  { type: "chair", label: "Chair", widthM: 0.55, heightM: 0.55, color: "#475569", icon: Armchair },
  { type: "desk", label: "Desk", widthM: 1.4, heightM: 0.7, color: "#0284c7", icon: BringToFront },
  { type: "wardrobe", label: "Wardrobe", widthM: 1.8, heightM: 0.65, color: "#9333ea", icon: Box },
  { type: "shelf", label: "Shelf", widthM: 1.2, heightM: 0.35, color: "#64748b", icon: Grid2X2 },
  { type: "door", label: "Door", widthM: 0.9, heightM: 0.12, color: "#92400e", icon: Maximize2 },
  { type: "window", label: "Window", widthM: 1.2, heightM: 0.12, color: "#0284c7", icon: Maximize2 },
  { type: "appliance", label: "Appliance", widthM: 0.65, heightM: 0.65, color: "#334155", icon: Box },
  { type: "custom", label: "Custom", widthM: 1, heightM: 1, color: "#111827", icon: Plus },
];

function normalizeFurniture(objects: Array<Partial<Furniture> & Pick<Furniture, "id" | "type" | "label" | "x" | "y" | "widthM" | "heightM" | "rotation" | "color">>) {
  return objects.map((object) => ({
    ...furnitureDefaults(object.type),
    ...object,
  })) as Furniture[];
}

function uid(prefix: string) {
  return `${prefix}-${Math.random().toString(36).slice(2, 9)}`;
}

function distance(a: Point, b: Point) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function midpoint(a: Point, b: Point): Point {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

function centerOf(a: Point, b: Point): Point {
  return midpoint(a, b);
}

function polygonAreaSigned(points: Point[]) {
  let area = 0;
  for (let i = 0; i < points.length; i += 1) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    area += a.x * b.y - b.x * a.y;
  }
  return area / 2;
}

function polygonAreaPx(points: Point[]) {
  return Math.abs(polygonAreaSigned(points));
}

function centroid(points: Point[]) {
  if (!points.length) return { x: 0, y: 0 };
  const total = points.reduce((acc, p) => ({ x: acc.x + p.x, y: acc.y + p.y }), { x: 0, y: 0 });
  return { x: total.x / points.length, y: total.y / points.length };
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function pointInPolygon(point: Point, polygon: Point[]) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const pi = polygon[i];
    const pj = polygon[j];
    const intersect = pi.y > point.y !== pj.y > point.y && point.x < ((pj.x - pi.x) * (point.y - pi.y)) / (pj.y - pi.y) + pi.x;
    if (intersect) inside = !inside;
  }
  return inside;
}

function nearestPoint(point: Point, points: Point[], threshold: number) {
  let best: Point | null = null;
  let bestDistance = threshold;
  points.forEach((candidate) => {
    const d = distance(point, candidate);
    if (d <= bestDistance) {
      bestDistance = d;
      best = candidate;
    }
  });
  return best;
}

function projectPointToSegment(point: Point, a: Point, b: Point): Point {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) return a;
  const t = clamp(((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSquared, 0, 1);
  return { x: a.x + dx * t, y: a.y + dy * t };
}

function nearestPointOnSegments(point: Point, segments: WallSegment[], threshold: number) {
  let best: Point | null = null;
  let bestDistance = threshold;
  segments.forEach((segment) => {
    const projected = projectPointToSegment(point, segment.a, segment.b);
    const projectedDistance = distance(point, projected);
    if (projectedDistance <= bestDistance) {
      bestDistance = projectedDistance;
      best = projected;
    }
  });
  return best;
}

function nearestWallProjection(point: Point, segments: WallSegment[], threshold = Infinity): WallProjection | null {
  let best: WallProjection | null = null;
  let bestDistance = threshold;
  segments.forEach((segment) => {
    const dx = segment.b.x - segment.a.x;
    const dy = segment.b.y - segment.a.y;
    const lengthSquared = dx * dx + dy * dy;
    if (!lengthSquared) return;
    const t = clamp(((point.x - segment.a.x) * dx + (point.y - segment.a.y) * dy) / lengthSquared, 0, 1);
    const projected = { x: segment.a.x + dx * t, y: segment.a.y + dy * t };
    const projectedDistance = distance(point, projected);
    if (projectedDistance <= bestDistance) {
      bestDistance = projectedDistance;
      best = { wall: segment, point: projected, distance: projectedDistance, t };
    }
  });
  return best;
}

function wallRotationDegrees(wall: WallSegment) {
  return normalizeDegrees((Math.atan2(wall.b.y - wall.a.y, wall.b.x - wall.a.x) * 180) / Math.PI);
}

function isWallOpening(object: Furniture) {
  return object.type === "door" || object.type === "window";
}

function snapOpeningToWall(object: Furniture, walls: WallSegment[], threshold: number) {
  if (!isWallOpening(object)) return object;
  const projection = nearestWallProjection({ x: object.x, y: object.y }, walls, threshold);
  if (!projection) return object;
  return {
    ...object,
    x: projection.point.x,
    y: projection.point.y,
    rotation: wallRotationDegrees(projection.wall),
  };
}

function openingProjection(object: Furniture, walls: WallSegment[], pxPerMeter: number, threshold: number): OpeningProjection | null {
  if (!isWallOpening(object)) return null;
  const projection = nearestWallProjection({ x: object.x, y: object.y }, walls, threshold);
  if (!projection) return null;
  const wallLength = distance(projection.wall.a, projection.wall.b);
  if (!wallLength) return null;
  const halfLength = Math.min(wallLength / 2, Math.max(8, (object.widthM * pxPerMeter) / 2));
  const ux = (projection.wall.b.x - projection.wall.a.x) / wallLength;
  const uy = (projection.wall.b.y - projection.wall.a.y) / wallLength;
  return {
    objectId: object.id,
    wallId: projection.wall.id,
    wallKind: projection.wall.kind,
    a: { x: projection.point.x - ux * halfLength, y: projection.point.y - uy * halfLength },
    b: { x: projection.point.x + ux * halfLength, y: projection.point.y + uy * halfLength },
  };
}

function downloadFile(name: string, content: BlobPart, type: string) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
}

function loadImage(src: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = reject;
    image.src = src;
  });
}

function outerWallsFromOutline(outline: Point[]): WallSegment[] {
  if (outline.length < 3) return [];
  return outline.map((point, index) => ({
    id: `outer-${index}`,
    a: point,
    b: outline[(index + 1) % outline.length],
    kind: "outer",
  }));
}

function pointKey(point: Point) {
  return `${Math.round(point.x * 100) / 100},${Math.round(point.y * 100) / 100}`;
}

function segmentIntersection(a: Point, b: Point, c: Point, d: Point) {
  const r = { x: b.x - a.x, y: b.y - a.y };
  const s = { x: d.x - c.x, y: d.y - c.y };
  const denominator = r.x * s.y - r.y * s.x;
  if (Math.abs(denominator) < 0.000001) return null;
  const ca = { x: c.x - a.x, y: c.y - a.y };
  const t = (ca.x * s.y - ca.y * s.x) / denominator;
  const u = (ca.x * r.y - ca.y * r.x) / denominator;
  if (t < -0.000001 || t > 1.000001 || u < -0.000001 || u > 1.000001) return null;
  return { point: { x: a.x + t * r.x, y: a.y + t * r.y }, t };
}

function splitWallsAtIntersections(walls: WallSegment[]) {
  const edges: Array<{ a: Point; b: Point }> = [];

  walls.forEach((wall, index) => {
    const points = [
      { point: wall.a, t: 0 },
      { point: wall.b, t: 1 },
    ];

    walls.forEach((other, otherIndex) => {
      if (index === otherIndex) return;
      const hit = segmentIntersection(wall.a, wall.b, other.a, other.b);
      if (hit) points.push(hit);
    });

    const unique = points
      .sort((a, b) => a.t - b.t)
      .filter((entry, entryIndex, sorted) => entryIndex === 0 || distance(entry.point, sorted[entryIndex - 1].point) > pointEps);

    for (let i = 0; i < unique.length - 1; i += 1) {
      const a = unique[i].point;
      const b = unique[i + 1].point;
      if (distance(a, b) > pointEps) edges.push({ a, b });
    }
  });

  const seen = new Set<string>();
  return edges.filter((edge) => {
    const ka = pointKey(edge.a);
    const kb = pointKey(edge.b);
    const key = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function canonicalCycle(keys: string[]) {
  const rotations = [keys, [...keys].reverse()].flatMap((candidate) =>
    candidate.map((_, index) => [...candidate.slice(index), ...candidate.slice(0, index)].join("|")),
  );
  return rotations.sort()[0];
}

function wallFaces(walls: WallSegment[]) {
  const splitEdges = splitWallsAtIntersections(walls);
  const nodes = new Map<string, Point>();
  const adjacency = new Map<string, string[]>();

  splitEdges.forEach((edge) => {
    const ka = pointKey(edge.a);
    const kb = pointKey(edge.b);
    nodes.set(ka, edge.a);
    nodes.set(kb, edge.b);
    adjacency.set(ka, [...(adjacency.get(ka) ?? []), kb]);
    adjacency.set(kb, [...(adjacency.get(kb) ?? []), ka]);
  });

  adjacency.forEach((neighbors, key) => {
    const origin = nodes.get(key)!;
    neighbors.sort((left, right) => {
      const a = nodes.get(left)!;
      const b = nodes.get(right)!;
      return Math.atan2(a.y - origin.y, a.x - origin.x) - Math.atan2(b.y - origin.y, b.x - origin.x);
    });
  });

  const visited = new Set<string>();
  const faces: Point[][] = [];
  const seenCycles = new Set<string>();

  adjacency.forEach((neighbors, start) => {
    neighbors.forEach((neighbor) => {
      const directedStart = `${start}->${neighbor}`;
      if (visited.has(directedStart)) return;

      let from = start;
      let to = neighbor;
      const cycle: string[] = [];

      for (let guard = 0; guard < 500; guard += 1) {
        visited.add(`${from}->${to}`);
        cycle.push(from);
        const nextNeighbors = adjacency.get(to);
        if (!nextNeighbors) break;
        const reverseIndex = nextNeighbors.indexOf(from);
        if (reverseIndex === -1) break;
        const nextIndex = (reverseIndex - 1 + nextNeighbors.length) % nextNeighbors.length;
        const next = nextNeighbors[nextIndex];
        from = to;
        to = next;
        if (from === start && to === neighbor) {
          if (cycle.length >= 3) {
            const key = canonicalCycle(cycle);
            if (!seenCycles.has(key)) {
              seenCycles.add(key);
              faces.push(cycle.map((nodeKey) => nodes.get(nodeKey)!));
            }
          }
          break;
        }
      }
    });
  });

  return faces.filter((face) => polygonAreaPx(face) > 25);
}

function wallFaceAt(point: Point, walls: WallSegment[], outerOutline: Point[]) {
  const faces = wallFaces(walls)
    .filter((face) => pointInPolygon(point, face))
    .filter((face) => !outerOutline.length || polygonAreaPx(face) <= polygonAreaPx(outerOutline) + 1)
    .sort((a, b) => polygonAreaPx(a) - polygonAreaPx(b));
  return faces[0] ?? null;
}

function localPointForObject(point: Point, object: Furniture): Point {
  const angle = (-object.rotation * Math.PI) / 180;
  const dx = point.x - object.x;
  const dy = point.y - object.y;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return { x: dx * cos - dy * sin, y: dx * sin + dy * cos };
}

function rotatedOffset(point: Point, rotation: number): Point {
  const angle = (rotation * Math.PI) / 180;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return { x: point.x * cos - point.y * sin, y: point.x * sin + point.y * cos };
}

function pointerAngleDegrees(point: Point, object: Furniture) {
  return (Math.atan2(point.y - object.y, point.x - object.x) * 180) / Math.PI;
}

function normalizeDegrees(degrees: number) {
  return ((((degrees + 180) % 360) + 360) % 360) - 180;
}

function repairDefaultRoomIdentities(rooms: Room[]) {
  const defaultNamePattern = /^Room\s+\d+$/;
  const defaultRooms = rooms.filter((room) => defaultNamePattern.test(room.name));
  const seen = new Set<string>();
  const hasDuplicateDefaultName = defaultRooms.some((room) => {
    if (seen.has(room.name)) return true;
    seen.add(room.name);
    return false;
  });
  const hasSingleDefaultColor =
    defaultRooms.length > 1 && new Set(defaultRooms.map((room) => room.color)).size === 1;

  if (!hasDuplicateDefaultName && !hasSingleDefaultColor) return rooms;

  let defaultIndex = 0;
  return rooms.map((room) => {
    if (!defaultNamePattern.test(room.name)) return room;
    defaultIndex += 1;
    return {
      ...room,
      name: `Room ${defaultIndex}`,
      color: colors[(defaultIndex - 1) % colors.length],
    };
  });
}

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const backgroundImageRef = useRef<HTMLImageElement | null>(null);
  const activePointersRef = useRef<Map<number, Point>>(new Map());
  const pinchGestureRef = useRef<PinchGesture | null>(null);
  const pendingTouchTapRef = useRef<PendingTouchTap | null>(null);

  const [stageSize, setStageSize] = useState({ width: 1200, height: 800 });
  const [tool, setTool] = useState<Tool>("select");
  const [viewport, setViewport] = useState<Viewport>({ x: 420, y: 140, zoom: 1 });
  const [background, setBackground] = useState<Background | null>(null);
  const [scaleMPerPx, setScaleMPerPx] = useState<number | null>(null);
  const [scaleSource, setScaleSource] = useState("Not calibrated");
  const [outerOutline, setOuterOutline] = useState<Point[]>([]);
  const [innerWalls, setInnerWalls] = useState<WallSegment[]>([]);
  const [rooms, setRooms] = useState<Room[]>([]);
  const [objects, setObjects] = useState<Furniture[]>([]);
  const [draftPoints, setDraftPoints] = useState<Point[]>([]);
  const [pointerWorld, setPointerWorld] = useState<Point | null>(null);
  const [scaleLine, setScaleLine] = useState<{ a: Point; b: Point } | null>(null);
  const [scaleLineDrafting, setScaleLineDrafting] = useState(false);
  const [rulerLine, setRulerLine] = useState<{ a: Point; b: Point } | null>(null);
  const [rulerLineDrafting, setRulerLineDrafting] = useState(false);
  const [selection, setSelection] = useState<Selection>(null);
  const [drag, setDrag] = useState<DragState>(null);
  const [knownLength, setKnownLength] = useState("1.00");
  const [knownArea, setKnownArea] = useState("75.00");
  const [showDimensions, setShowDimensions] = useState(true);
  const [showGrid, setShowGrid] = useState(true);
  const [wallSnapEnabled, setWallSnapEnabled] = useState(true);
  const [construction, setConstruction] = useState<ConstructionSettings>(defaultConstructionSettings);
  const [workspaceMode, setWorkspaceMode] = useState<"2d" | "3d">("2d");
  const [printDialogOpen, setPrintDialogOpen] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  const [mobileDrawer, setMobileDrawer] = useState<MobileDrawer>(null);

  const effectiveScale = scaleMPerPx ?? defaultScaleMPerPx;
  const outerWalls = useMemo(() => outerWallsFromOutline(outerOutline), [outerOutline]);
  const allWalls = useMemo(() => [...outerWalls, ...innerWalls], [outerWalls, innerWalls]);
  const openingSnapDistance = 34 / viewport.zoom;
  const snappedObjects = useMemo(
    () => objects.map((object) => snapOpeningToWall(object, allWalls, openingSnapDistance)),
    [objects, allWalls, openingSnapDistance],
  );
  const metricPlan = useMemo(
    () => createMetricPlan(outerOutline, allWalls, snappedObjects, effectiveScale, construction),
    [outerOutline, allWalls, snappedObjects, effectiveScale, construction],
  );
  const openingProjections = useMemo(
    () =>
      snappedObjects
        .map((object) => openingProjection(object, allWalls, 1 / effectiveScale, openingSnapDistance))
        .filter((projection): projection is OpeningProjection => Boolean(projection)),
    [snappedObjects, allWalls, effectiveScale, openingSnapDistance],
  );
  const snapPoints = useMemo(
    () => [...outerOutline, ...innerWalls.flatMap((wall) => [wall.a, wall.b])],
    [outerOutline, innerWalls],
  );
  const resolvedRooms = useMemo(
    () =>
      rooms.map((room) => {
        if (!room.wallSeed) return room;
        const face = wallFaceAt(room.wallSeed, allWalls, outerOutline);
        return face ? { ...room, points: face } : room;
      }),
    [rooms, allWalls, outerOutline],
  );
  const selectedRoom =
    selection?.kind === "room" ? resolvedRooms.find((room) => room.id === selection.id) ?? null : null;
  const selectedObject =
    selection?.kind === "object" ? snappedObjects.find((object) => object.id === selection.id) ?? null : null;
  const selectedWall = selection?.kind === "wall" ? allWalls.find((wall) => wall.id === selection.id) ?? null : null;

  const roomStats = useMemo(
    () =>
      resolvedRooms.map((room) => ({
        id: room.id,
        name: room.name,
        area: polygonAreaPx(room.points) * effectiveScale * effectiveScale,
      })),
    [resolvedRooms, effectiveScale],
  );

  const worldToScreen = (point: Point): Point => ({
    x: point.x * viewport.zoom + viewport.x,
    y: point.y * viewport.zoom + viewport.y,
  });

  const screenToWorld = (point: Point): Point => ({
    x: (point.x - viewport.x) / viewport.zoom,
    y: (point.y - viewport.y) / viewport.zoom,
  });

  const pointerPoint = (event: PointerEvent): Point => {
    const rect = stageRef.current!.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };

  const snapWorldPoint = (point: Point) => {
    const threshold = 18 / viewport.zoom;
    return nearestPoint(point, snapPoints, threshold) ?? nearestPointOnSegments(point, allWalls, threshold) ?? point;
  };

  const updateObject = (id: string, patch: Partial<Furniture>) => {
    setObjects((current) => current.map((object) => (object.id === id ? { ...object, ...patch } : object)));
  };

  const updateRoom = (id: string, patch: Partial<Room>) => {
    setRooms((current) => current.map((room) => (room.id === id ? { ...room, ...patch } : room)));
  };

  const closeSnapDistance = () => 28 / viewport.zoom;

  const resetViewport = () => {
    setViewport({
      x: Math.max(40, stageSize.width * 0.22),
      y: Math.max(40, stageSize.height * 0.16),
      zoom: 1,
    });
  };

  const projectSnapshot = (): ProjectFile => ({
    roomPlannerVersion: 2,
    background,
    scaleMPerPx,
    scaleSource,
    wallSnapEnabled,
    outerOutline,
    innerWalls,
    rooms,
    objects,
    construction,
    view: viewport,
  });

  useEffect(() => {
    if (!stageRef.current) return;
    const observer = new ResizeObserver(([entry]) => {
      setStageSize({
        width: entry.contentRect.width,
        height: entry.contentRect.height,
      });
    });
    observer.observe(stageRef.current);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;

    const preventBrowserGesture = (event: Event) => {
      event.preventDefault();
    };

    const preventMultiTouchScroll = (event: TouchEvent) => {
      if (event.touches.length > 1) {
        event.preventDefault();
      }
    };

    stage.addEventListener("touchmove", preventMultiTouchScroll, { passive: false });
    window.addEventListener("gesturestart", preventBrowserGesture, { passive: false } as AddEventListenerOptions);
    window.addEventListener("gesturechange", preventBrowserGesture, { passive: false } as AddEventListenerOptions);
    window.addEventListener("gestureend", preventBrowserGesture, { passive: false } as AddEventListenerOptions);

    return () => {
      stage.removeEventListener("touchmove", preventMultiTouchScroll);
      window.removeEventListener("gesturestart", preventBrowserGesture);
      window.removeEventListener("gesturechange", preventBrowserGesture);
      window.removeEventListener("gestureend", preventBrowserGesture);
    };
  }, []);

  useEffect(() => {
    const saved = window.localStorage.getItem(autosaveKey);
    if (!saved) {
      setHydrated(true);
      return;
    }

    try {
      const project = JSON.parse(saved) as ProjectFile;
      if (project.roomPlannerVersion === 1 || project.roomPlannerVersion === 2) {
        setBackground(project.background);
        setScaleMPerPx(project.scaleMPerPx);
        setScaleSource(project.scaleSource);
        setWallSnapEnabled(project.wallSnapEnabled ?? true);
        setOuterOutline(project.outerOutline ?? []);
        setInnerWalls(project.innerWalls ?? []);
        setRooms(repairDefaultRoomIdentities(project.rooms));
        setObjects(normalizeFurniture(project.objects));
        setConstruction(project.construction ?? defaultConstructionSettings);
        setViewport(project.view);
      }
    } catch {
      window.localStorage.removeItem(autosaveKey);
    } finally {
      setHydrated(true);
    }
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    window.localStorage.setItem(autosaveKey, JSON.stringify(projectSnapshot()));
  }, [hydrated, background, scaleMPerPx, scaleSource, wallSnapEnabled, outerOutline, innerWalls, rooms, objects, construction, viewport]);

  useEffect(() => {
    if (!hydrated) return;
    setRooms((current) => repairDefaultRoomIdentities(current));
  }, [hydrated]);

  useEffect(() => {
    if (!background) {
      backgroundImageRef.current = null;
      drawBackground();
      return;
    }

    let cancelled = false;
    loadImage(background.dataUrl).then((image) => {
      if (cancelled) return;
      backgroundImageRef.current = image;
      drawBackground(image);
    });
    return () => {
      cancelled = true;
    };
  }, [background, viewport, stageSize, showGrid]);

  useEffect(() => {
    drawBackground();
  }, [viewport, stageSize, showGrid]);

  const drawBackground = (image = backgroundImageRef.current) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, stageSize.width * dpr);
    canvas.height = Math.max(1, stageSize.height * dpr);
    canvas.style.width = `${stageSize.width}px`;
    canvas.style.height = `${stageSize.height}px`;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, stageSize.width, stageSize.height);
    ctx.fillStyle = "#f8fafc";
    ctx.fillRect(0, 0, stageSize.width, stageSize.height);

    if (showGrid) drawGrid(ctx);

    if (background && image) {
      ctx.save();
      ctx.globalAlpha = background.opacity;
      ctx.setTransform(dpr * viewport.zoom, 0, 0, dpr * viewport.zoom, dpr * viewport.x, dpr * viewport.y);
      ctx.drawImage(image, 0, 0, background.width, background.height);
      ctx.restore();
    }
  };

  const drawGrid = (ctx: CanvasRenderingContext2D) => {
    const stepWorld = 50;
    const start = screenToWorld({ x: 0, y: 0 });
    const end = screenToWorld({ x: stageSize.width, y: stageSize.height });
    ctx.strokeStyle = "#e2e8f0";
    ctx.lineWidth = 1;

    for (let x = Math.floor(start.x / stepWorld) * stepWorld; x <= end.x; x += stepWorld) {
      const sx = worldToScreen({ x, y: 0 }).x;
      ctx.beginPath();
      ctx.moveTo(sx, 0);
      ctx.lineTo(sx, stageSize.height);
      ctx.stroke();
    }

    for (let y = Math.floor(start.y / stepWorld) * stepWorld; y <= end.y; y += stepWorld) {
      const sy = worldToScreen({ x: 0, y }).y;
      ctx.beginPath();
      ctx.moveTo(0, sy);
      ctx.lineTo(stageSize.width, sy);
      ctx.stroke();
    }
  };

  const fitToBackground = (bg = background) => {
    if (!bg) return;
    const margin = 72;
    const zoom = Math.min((stageSize.width - margin * 2) / bg.width, (stageSize.height - margin * 2) / bg.height);
    const nextZoom = clamp(Number.isFinite(zoom) ? zoom : 1, 0.08, 4);
    setViewport({
      zoom: nextZoom,
      x: (stageSize.width - bg.width * nextZoom) / 2,
      y: (stageSize.height - bg.height * nextZoom) / 2,
    });
  };

  const handleBackgroundImport = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result);
      loadImage(dataUrl).then((image) => {
        const nextBackground = {
          dataUrl,
          name: file.name,
          width: image.naturalWidth,
          height: image.naturalHeight,
          opacity: 0.72,
        };
        setBackground(nextBackground);
        window.setTimeout(() => fitToBackground(nextBackground), 0);
      });
    };
    reader.readAsDataURL(file);
    event.target.value = "";
  };

  const handleProjectImport = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const project = JSON.parse(String(reader.result)) as ProjectFile;
      if (project.roomPlannerVersion !== 1 && project.roomPlannerVersion !== 2) {
        window.alert("Unsupported project file.");
        return;
      }
      setBackground(project.background);
      setScaleMPerPx(project.scaleMPerPx);
      setScaleSource(project.scaleSource);
      setWallSnapEnabled(project.wallSnapEnabled ?? true);
      setOuterOutline(project.outerOutline ?? []);
      setInnerWalls(project.innerWalls ?? []);
      const repairedRooms = repairDefaultRoomIdentities(project.rooms);
      setRooms(repairedRooms);
      const normalizedObjects = normalizeFurniture(project.objects);
      setObjects(normalizedObjects);
      setConstruction(project.construction ?? defaultConstructionSettings);
      setViewport(project.view);
      setDraftPoints([]);
      setPointerWorld(null);
      setScaleLineDrafting(false);
      setRulerLineDrafting(false);
      setSelection(null);
      window.localStorage.setItem(
        autosaveKey,
        JSON.stringify({
          roomPlannerVersion: 2,
          background: project.background,
          scaleMPerPx: project.scaleMPerPx,
          scaleSource: project.scaleSource,
          wallSnapEnabled: project.wallSnapEnabled ?? true,
          outerOutline: project.outerOutline ?? [],
          innerWalls: project.innerWalls ?? [],
          rooms: repairedRooms,
          objects: normalizedObjects,
          construction: project.construction ?? defaultConstructionSettings,
          view: project.view,
        } satisfies ProjectFile),
      );
    };
    reader.readAsText(file);
    event.target.value = "";
  };

  const exportProject = () => {
    downloadFile("room-plan.json", JSON.stringify(projectSnapshot(), null, 2), "application/json");
  };

  const exportPng = async () => {
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(stageSize.width * 2);
    canvas.height = Math.round(stageSize.height * 2);
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.scale(2, 2);
    ctx.fillStyle = "#f8fafc";
    ctx.fillRect(0, 0, stageSize.width, stageSize.height);
    if (showGrid) drawGrid(ctx);

    if (background) {
      const image = backgroundImageRef.current ?? (await loadImage(background.dataUrl));
      ctx.save();
      ctx.globalAlpha = background.opacity;
      ctx.setTransform(2 * viewport.zoom, 0, 0, 2 * viewport.zoom, 2 * viewport.x, 2 * viewport.y);
      ctx.drawImage(image, 0, 0, background.width, background.height);
      ctx.restore();
    }

    drawPlanToCanvas(ctx);
    canvas.toBlob((blob) => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = "room-plan.png";
      link.click();
      URL.revokeObjectURL(url);
    });
  };

  const drawPlanToCanvas = (ctx: CanvasRenderingContext2D) => {
    ctx.save();
    ctx.translate(viewport.x, viewport.y);
    ctx.scale(viewport.zoom, viewport.zoom);
    ctx.lineJoin = "round";

    drawCanvasWalls(ctx);

    resolvedRooms.forEach((room) => {
      if (room.points.length < 2) return;
      ctx.beginPath();
      ctx.moveTo(room.points[0].x, room.points[0].y);
      room.points.slice(1).forEach((point) => ctx.lineTo(point.x, point.y));
      ctx.closePath();
      ctx.fillStyle = `${room.color}22`;
      ctx.strokeStyle = room.color;
      ctx.lineWidth = 2 / viewport.zoom;
      ctx.fill();
      ctx.stroke();
      const c = centroid(room.points);
      ctx.fillStyle = "#0f172a";
      ctx.font = `${14 / viewport.zoom}px sans-serif`;
      ctx.textAlign = "center";
      ctx.fillText(`${room.name} ${formatArea(polygonAreaPx(room.points) * effectiveScale * effectiveScale)}`, c.x, c.y);
      if (showDimensions && scaleMPerPx) drawCanvasDimensions(ctx, room.points);
    });

    snappedObjects.forEach((object) => drawCanvasObject(ctx, object));
    ctx.restore();
  };

  const drawCanvasWalls = (ctx: CanvasRenderingContext2D) => {
    allWalls.forEach((wall) => {
      ctx.beginPath();
      ctx.moveTo(wall.a.x, wall.a.y);
      ctx.lineTo(wall.b.x, wall.b.y);
      ctx.strokeStyle = wall.kind === "outer" ? "#111827" : "#475569";
      ctx.lineWidth = (wall.kind === "outer" ? 8 : 5) / viewport.zoom;
      ctx.stroke();
    });

    openingProjections.forEach((opening) => {
      ctx.save();
      ctx.globalAlpha = 0.78;
      ctx.beginPath();
      ctx.moveTo(opening.a.x, opening.a.y);
      ctx.lineTo(opening.b.x, opening.b.y);
      ctx.strokeStyle = "#f8fafc";
      ctx.lineWidth = (opening.wallKind === "outer" ? 10 : 7) / viewport.zoom;
      ctx.stroke();
      ctx.restore();
    });
  };

  const drawCanvasDimensions = (ctx: CanvasRenderingContext2D, points: Point[]) => {
    ctx.font = `${12 / viewport.zoom}px sans-serif`;
    ctx.fillStyle = "#334155";
    ctx.textAlign = "center";
    points.forEach((point, index) => {
      const next = points[(index + 1) % points.length];
      const mid = midpoint(point, next);
      const label = formatLength(distance(point, next) * effectiveScale);
      ctx.fillText(label, mid.x, mid.y - 5 / viewport.zoom);
    });
  };

  const drawCanvasObject = (ctx: CanvasRenderingContext2D, object: Furniture) => {
    const width = object.widthM / effectiveScale;
    const height = object.heightM / effectiveScale;
    ctx.save();
    ctx.translate(object.x, object.y);
    ctx.rotate((object.rotation * Math.PI) / 180);
    ctx.fillStyle = `${object.color}33`;
    ctx.strokeStyle = object.color;
    ctx.lineWidth = 2 / viewport.zoom;
    ctx.fillRect(-width / 2, -height / 2, width, height);
    ctx.strokeRect(-width / 2, -height / 2, width, height);
    ctx.fillStyle = "#0f172a";
    ctx.font = `${12 / viewport.zoom}px sans-serif`;
    ctx.textAlign = "center";
    ctx.fillText(object.label, 0, 4 / viewport.zoom);
    ctx.restore();
  };

  const addObject = (preset: (typeof presets)[number]) => {
    const center = screenToWorld({ x: stageSize.width / 2, y: stageSize.height / 2 });
    const modelDefaults = furnitureDefaults(preset.type);
    const object = snapOpeningToWall(
      {
        id: uid("object"),
        type: preset.type,
        label: preset.label,
        x: center.x,
        y: center.y,
        widthM: preset.widthM,
        heightM: preset.heightM,
        ...modelDefaults,
        rotation: 0,
        color: preset.color,
      },
      allWalls,
      openingSnapDistance,
    );
    setObjects((current) => [...current, object]);
    setSelection({ kind: "object", id: object.id });
    setTool("select");
  };

  const finishCustomRoom = () => {
    if (draftPoints.length < 3) return;
    createRoom(draftPoints, "Room");
    setDraftPoints([]);
    setPointerWorld(null);
    setTool("select");
  };

  const finishOuterOutline = () => {
    if (draftPoints.length < 3) return;
    setOuterOutline(draftPoints);
    setDraftPoints([]);
    setPointerWorld(null);
    setTool("wall");
  };

  const finishInnerWalls = () => {
    setDraftPoints([]);
    setPointerWorld(null);
  };

  const cancelDrawing = () => {
    setDraftPoints([]);
    setPointerWorld(null);
    pendingTouchTapRef.current = null;
    setTool("select");
  };

  const createRoom = (points: Point[], baseName: string, wallSeed?: Point) => {
    const roomId = uid("room");
    setRooms((current) => {
      const defaultNamePattern = new RegExp(`^${baseName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s+(\\d+)$`);
      const highestDefaultNumber = current.reduce((highest, room) => {
        const match = room.name.match(defaultNamePattern);
        return match ? Math.max(highest, Number(match[1])) : highest;
      }, 0);
      const roomIndex = Math.max(current.length + 1, highestDefaultNumber + 1);
      return [
        ...current,
        {
          id: roomId,
          name: `${baseName} ${roomIndex}`,
          points,
          color: colors[current.length % colors.length],
          wallSeed,
        },
      ];
    });
    setSelection({ kind: "room", id: roomId });
  };

  const addDraftPoint = (point: Point) => {
    if (tool === "outer") {
      if (draftPoints.length >= 3 && distance(draftPoints[0], point) < closeSnapDistance()) {
        finishOuterOutline();
        return;
      }
      setDraftPoints((current) => [...current, point]);
      return;
    }

    if (tool === "wall") {
      if (draftPoints.length === 0) {
        setDraftPoints([point]);
        return;
      }
      const previous = draftPoints[draftPoints.length - 1];
      if (distance(previous, point) < closeSnapDistance()) {
        finishInnerWalls();
        return;
      }
      const wall: WallSegment = { id: uid("wall"), a: previous, b: point, kind: "inner" };
      setInnerWalls((current) => [...current, wall]);
      setDraftPoints([point]);
      return;
    }

    if (tool === "customRoom") {
      if (draftPoints.length >= 3 && distance(draftPoints[0], point) < 14 / viewport.zoom) {
        finishCustomRoom();
        return;
      }
      setDraftPoints((current) => [...current, point]);
    }
  };

  const applyKnownLength = () => {
    if (!scaleLine || scaleLineDrafting) return;
    const meters = Number(knownLength);
    const px = distance(scaleLine.a, scaleLine.b);
    if (!meters || !px) return;
    setScaleMPerPx(meters / px);
    setScaleSource(`${meters.toFixed(2)} m calibration line`);
  };

  const clearScaleLine = () => {
    setScaleLine(null);
    setScaleLineDrafting(false);
  };

  const clearRulerLine = () => {
    setRulerLine(null);
    setRulerLineDrafting(false);
  };

  const applyKnownArea = () => {
    const meters2 = Number(knownArea);
    const outlineAreaPx = polygonAreaPx(outerOutline);
    if (!meters2 || !outlineAreaPx) return;
    setScaleMPerPx(Math.sqrt(meters2 / outlineAreaPx));
    setScaleSource(`Flat set to ${meters2.toFixed(2)} m2`);
  };

  const createRoomFromWallsAt = (point: Point) => {
    if (allWalls.length < 3) return;
    const face = wallFaceAt(point, allWalls, outerOutline);
    if (!face) return;
    const duplicate = resolvedRooms.some((room) => {
      const c = centroid(face);
      return pointInPolygon(c, room.points) && Math.abs(polygonAreaPx(room.points) - polygonAreaPx(face)) < 4;
    });
    if (!duplicate) createRoom(face, "Room", point);
  };

  const updateOuterPoint = (index: number, point: Point) => {
    setOuterOutline((current) => current.map((existing, pointIndex) => (pointIndex === index ? point : existing)));
  };

  const updateInnerWallPoint = (wallId: string, end: "a" | "b", point: Point) => {
    setInnerWalls((current) => current.map((wall) => (wall.id === wallId ? { ...wall, [end]: point } : wall)));
  };

  const deleteSelectedWall = () => {
    if (!selectedWall) return;
    if (selectedWall.kind === "inner") {
      setInnerWalls((current) => current.filter((wall) => wall.id !== selectedWall.id));
      setSelection(null);
      return;
    }

    const edgeIndex = Number(selectedWall.id.replace("outer-", ""));
    if (!Number.isFinite(edgeIndex)) return;
    setOuterOutline((current) => {
      if (current.length <= 3) return [];
      const removeIndex = (edgeIndex + 1) % current.length;
      return current.filter((_, index) => index !== removeIndex);
    });
    setRooms([]);
    setSelection(null);
  };

  const placeAtWorldPoint = (world: Point) => {
    if (tool === "outer" || tool === "wall" || tool === "customRoom") {
      addDraftPoint(world);
      return true;
    }

    if (tool === "scale") {
      if (!scaleLine || !scaleLineDrafting) {
        setScaleLine({ a: world, b: world });
        setScaleLineDrafting(true);
      } else {
        setScaleLine({ a: scaleLine.a, b: world });
        setScaleLineDrafting(false);
      }
      return true;
    }

    if (tool === "ruler") {
      if (!rulerLine || !rulerLineDrafting) {
        setRulerLine({ a: world, b: world });
        setRulerLineDrafting(true);
      } else {
        setRulerLine({ a: rulerLine.a, b: world });
        setRulerLineDrafting(false);
      }
      return true;
    }

    setSelection(null);
    return true;
  };

  const zoomAround = (screen: Point, nextZoom: number, world = screenToWorld(screen)) => {
    setViewport({
      zoom: nextZoom,
      x: screen.x - world.x * nextZoom,
      y: screen.y - world.y * nextZoom,
    });
  };

  const beginPinch = () => {
    const points = [...activePointersRef.current.values()];
    if (points.length < 2) return;
    const startCenter = centerOf(points[0], points[1]);
    pinchGestureRef.current = {
      startDistance: Math.max(1, distance(points[0], points[1])),
      startCenter,
      startViewport: viewport,
      startWorldCenter: screenToWorld(startCenter),
    };
    pendingTouchTapRef.current = null;
    setDrag(null);
  };

  const updatePinch = () => {
    const pinch = pinchGestureRef.current;
    const points = [...activePointersRef.current.values()];
    if (!pinch || points.length < 2) return;
    const currentCenter = centerOf(points[0], points[1]);
    const currentDistance = Math.max(1, distance(points[0], points[1]));
    const nextZoom = clamp(pinch.startViewport.zoom * (currentDistance / pinch.startDistance), 0.08, 8);
    setViewport({
      zoom: nextZoom,
      x: currentCenter.x - pinch.startWorldCenter.x * nextZoom,
      y: currentCenter.y - pinch.startWorldCenter.y * nextZoom,
    });
  };

  const handleStagePointerDown = (event: PointerEvent<SVGSVGElement>) => {
    if (event.detail > 1) return;
    event.preventDefault();
    const screen = pointerPoint(event);
    const world = snapWorldPoint(screenToWorld(screen));
    event.currentTarget.setPointerCapture(event.pointerId);

    if (event.pointerType === "touch") {
      activePointersRef.current.set(event.pointerId, screen);
      if (activePointersRef.current.size >= 2) {
        beginPinch();
        return;
      }

      if (tool === "pan" || tool === "select") {
        setDrag({ kind: "pan", start: screen, view: viewport });
        return;
      }

      pendingTouchTapRef.current = {
        pointerId: event.pointerId,
        startScreen: screen,
        currentWorld: world,
        tool,
        moved: false,
      };
      setPointerWorld(world);
      return;
    }

    if (tool === "pan" || event.button === 1 || event.altKey) {
      setDrag({ kind: "pan", start: screen, view: viewport });
      return;
    }

    placeAtWorldPoint(world);
  };

  const handleStageDoubleClick = (event: React.MouseEvent<SVGSVGElement>) => {
    const rect = stageRef.current!.getBoundingClientRect();
    const world = screenToWorld({ x: event.clientX - rect.left, y: event.clientY - rect.top });
    createRoomFromWallsAt(world);
  };

  const handleWallPointerDown = (event: PointerEvent<SVGLineElement>, wall: WallSegment) => {
    event.stopPropagation();
    event.preventDefault();
    const screen = pointerPoint(event);
    const world = snapWorldPoint(screenToWorld(screen));

    if (tool === "wall") {
      addDraftPoint(world);
      return;
    }

    if (tool === "pan") {
      setDrag({ kind: "pan", start: screen, view: viewport });
      return;
    }

    if (tool !== "select") {
      placeAtWorldPoint(world);
      return;
    }

    setSelection({ kind: "wall", id: wall.id });
  };

  const handlePointerMove = (event: PointerEvent<SVGSVGElement>) => {
    event.preventDefault();
    const screen = pointerPoint(event);
    const rawWorld = screenToWorld(screen);
    const world = snapWorldPoint(rawWorld);
    const wallMoveWorld = wallSnapEnabled ? world : rawWorld;
    setPointerWorld(world);

    if (event.pointerType === "touch") {
      activePointersRef.current.set(event.pointerId, screen);
      if (pinchGestureRef.current) {
        updatePinch();
        return;
      }

      const pending = pendingTouchTapRef.current;
      if (pending?.pointerId === event.pointerId) {
        pending.currentWorld = world;
        pending.moved = pending.moved || distance(screen, pending.startScreen) > 8;
        pendingTouchTapRef.current = pending;
      }
    }

    if (tool === "scale" && scaleLine && scaleLineDrafting) {
      setScaleLine({ ...scaleLine, b: world });
    }

    if (tool === "ruler" && rulerLine && rulerLineDrafting) {
      setRulerLine({ ...rulerLine, b: world });
    }

    if (!drag) return;
    if (drag.kind === "pan") {
      setViewport({
        ...drag.view,
        x: drag.view.x + screen.x - drag.start.x,
        y: drag.view.y + screen.y - drag.start.y,
      });
    }
    if (drag.kind === "object") {
      const nextObject = {
        ...drag.object,
        x: drag.object.x + world.x - drag.start.x,
        y: drag.object.y + world.y - drag.start.y,
      };
      updateObject(drag.id, snapOpeningToWall(nextObject, allWalls, openingSnapDistance));
    }
    if (drag.kind === "object-resize") {
      const widthPx = drag.object.widthM / effectiveScale;
      const heightPx = drag.object.heightM / effectiveScale;
      const local = localPointForObject(world, drag.object);
      const minPx = 0.1 / effectiveScale;
      const maxPx = 20 / effectiveScale;
      let nextWidthPx = widthPx;
      let nextHeightPx = heightPx;
      let localCenterOffset: Point = { x: 0, y: 0 };

      if (drag.handle === "right") {
        const fixed = -widthPx / 2;
        const moving = clamp(local.x, fixed + minPx, fixed + maxPx);
        nextWidthPx = moving - fixed;
        localCenterOffset = { x: (moving + fixed) / 2, y: 0 };
      }
      if (drag.handle === "left") {
        const fixed = widthPx / 2;
        const moving = clamp(local.x, fixed - maxPx, fixed - minPx);
        nextWidthPx = fixed - moving;
        localCenterOffset = { x: (moving + fixed) / 2, y: 0 };
      }
      if (drag.handle === "bottom") {
        const fixed = -heightPx / 2;
        const moving = clamp(local.y, fixed + minPx, fixed + maxPx);
        nextHeightPx = moving - fixed;
        localCenterOffset = { x: 0, y: (moving + fixed) / 2 };
      }
      if (drag.handle === "top") {
        const fixed = heightPx / 2;
        const moving = clamp(local.y, fixed - maxPx, fixed - minPx);
        nextHeightPx = fixed - moving;
        localCenterOffset = { x: 0, y: (moving + fixed) / 2 };
      }

      const centerOffset = rotatedOffset(localCenterOffset, drag.object.rotation);
      const nextObject = {
        ...drag.object,
        x: drag.object.x + centerOffset.x,
        y: drag.object.y + centerOffset.y,
        widthM: clamp(nextWidthPx * effectiveScale, 0.1, 20),
        heightM: clamp(nextHeightPx * effectiveScale, 0.1, 20),
      };
      updateObject(drag.id, snapOpeningToWall(nextObject, allWalls, openingSnapDistance));
    }
    if (drag.kind === "object-rotate") {
      const nextObject = {
        ...drag.object,
        rotation: normalizeDegrees(drag.object.rotation + pointerAngleDegrees(world, drag.object) - drag.startAngle),
      };
      updateObject(drag.id, snapOpeningToWall(nextObject, allWalls, openingSnapDistance));
    }
    if (drag.kind === "room") {
      updateRoom(drag.id, {
        points: drag.points.map((point) => ({ x: point.x + world.x - drag.start.x, y: point.y + world.y - drag.start.y })),
      });
    }
    if (drag.kind === "vertex") {
      setRooms((current) =>
        current.map((room) =>
          room.id === drag.roomId
            ? {
                ...room,
                points: room.points.map((point, index) => (index === drag.index ? world : point)),
              }
            : room,
        ),
      );
    }
    if (drag.kind === "outer-point") {
      updateOuterPoint(drag.index, wallMoveWorld);
    }
    if (drag.kind === "inner-wall-point") {
      updateInnerWallPoint(drag.wallId, drag.end, wallMoveWorld);
    }
  };

  const handlePointerUp = (event: PointerEvent<SVGSVGElement>) => {
    event.preventDefault();
    const screen = pointerPoint(event);
    const world = snapWorldPoint(screenToWorld(screen));

    if (event.pointerType === "touch") {
      const pending = pendingTouchTapRef.current;
      const wasPinching = Boolean(pinchGestureRef.current);
      activePointersRef.current.delete(event.pointerId);

      if (activePointersRef.current.size < 2) {
        pinchGestureRef.current = null;
      }

      if (!wasPinching && pending?.pointerId === event.pointerId) {
        pendingTouchTapRef.current = null;
        if (pending.tool === tool) {
          placeAtWorldPoint(pending.moved ? pending.currentWorld : world);
        }
      }

      setDrag(null);
      return;
    }

    setDrag(null);
  };

  const handlePointerCancel = (event: PointerEvent<SVGSVGElement>) => {
    activePointersRef.current.delete(event.pointerId);
    pendingTouchTapRef.current = null;
    if (activePointersRef.current.size < 2) {
      pinchGestureRef.current = null;
    }
    setDrag(null);
  };

  const handleWheel = (event: React.WheelEvent) => {
    event.preventDefault();
    const rect = stageRef.current!.getBoundingClientRect();
    const screen = { x: event.clientX - rect.left, y: event.clientY - rect.top };
    const nextZoom = clamp(viewport.zoom * (event.deltaY > 0 ? 0.9 : 1.1), 0.08, 8);
    zoomAround(screen, nextZoom);
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && draftPoints.length > 0) {
        event.preventDefault();
        cancelDrawing();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [draftPoints.length]);

  const deleteWalls = () => {
    setOuterOutline([]);
    setInnerWalls([]);
    setRooms([]);
    setDraftPoints([]);
    setPointerWorld(null);
    setScaleMPerPx(null);
    setScaleSource("Not calibrated");
    setScaleLineDrafting(false);
    setRulerLineDrafting(false);
  };

  const clearAutosavedPlan = () => {
    window.localStorage.removeItem(autosaveKey);
    setBackground(null);
    setScaleMPerPx(null);
    setScaleSource("Not calibrated");
    setOuterOutline([]);
    setInnerWalls([]);
    setRooms([]);
    setObjects([]);
    setConstruction(defaultConstructionSettings);
    setDraftPoints([]);
    setPointerWorld(null);
    setScaleLine(null);
    setScaleLineDrafting(false);
    setRulerLine(null);
    setRulerLineDrafting(false);
    setSelection(null);
    resetViewport();
  };

  const formatArea = (area: number) => `${area.toFixed(2)} m2`;
  const formatLength = (length: number) => `${length.toFixed(length < 10 ? 2 : 1)} m`;

  const selectedArea = selectedRoom ? polygonAreaPx(selectedRoom.points) * effectiveScale * effectiveScale : 0;
  const rulerLength = rulerLine ? distance(rulerLine.a, rulerLine.b) * effectiveScale : null;
  const scaleLineLength = scaleLine ? distance(scaleLine.a, scaleLine.b) * effectiveScale : null;
  const flatArea = outerOutline.length >= 3 ? polygonAreaPx(outerOutline) * effectiveScale * effectiveScale : 0;
  const draftPreview =
    pointerWorld && draftPoints.length > 0 && (tool === "outer" || tool === "wall" || tool === "customRoom")
      ? { a: draftPoints[draftPoints.length - 1], b: pointerWorld }
      : null;
  const activeSnapPoint: Point | null =
    pointerWorld && (tool === "wall" || tool === "outer" || tool === "customRoom")
      ? nearestPoint(pointerWorld, snapPoints, 0.5 / viewport.zoom) ?? nearestPointOnSegments(pointerWorld, allWalls, 0.5 / viewport.zoom)
      : null;
  const canCloseOuterFromPointer =
    tool === "outer" &&
    draftPoints.length >= 3 &&
    pointerWorld &&
    distance(draftPoints[0], pointerWorld) < closeSnapDistance();
  const snapTargetMarker = activeSnapPoint ? (
    <circle className="snap-target" cx={(activeSnapPoint as Point).x} cy={(activeSnapPoint as Point).y} r={12 / viewport.zoom} />
  ) : null;

  return (
    <div className={`app mobile-drawer-${mobileDrawer ?? "closed"}`}>
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">RP</div>
          <div>
            <h1>Room Planner</h1>
            <p>{scaleMPerPx ? scaleSource : hydrated ? "Autosaved in this browser" : "Loading saved plan"}</p>
          </div>
        </div>

        <section className="panel">
          <h2>Files</h2>
          <div className="button-grid">
            <label className="tool-button" title="Import a floor plan image as the background layer">
              <ImagePlus size={17} />
              <span>Plan</span>
              <input type="file" accept="image/png,image/jpeg,image/webp,image/svg+xml" onChange={handleBackgroundImport} />
            </label>
            <label className="tool-button" title="Open a saved Room Planner JSON project">
              <FileUp size={17} />
              <span>Open</span>
              <input type="file" accept="application/json,.json" onChange={handleProjectImport} />
            </label>
            <button className="tool-button" onClick={exportProject} title="Download an editable JSON backup of this plan">
              <Save size={17} />
              <span>Save</span>
            </button>
            <button className="tool-button" onClick={exportPng} title="Export the visible plan as a PNG image">
              <FileDown size={17} />
              <span>PNG</span>
            </button>
            <button className="tool-button" onClick={() => setPrintDialogOpen(true)} title="Create a printable 3MF or STL model">
              <Printer size={17} />
              <span>3D Print</span>
            </button>
          </div>
        </section>

        <section className="panel">
          <h2>Tools</h2>
          <div className="tool-strip">
            <ToolButton
              active={tool === "select"}
              onClick={() => setTool("select")}
              label="Select"
              tooltip="Select, move, resize, rename, or delete walls, rooms, and objects"
              icon={<MousePointer2 />}
            />
            <ToolButton active={tool === "pan"} onClick={() => setTool("pan")} label="Pan" tooltip="Drag the plan without editing it" icon={<Hand />} />
            <ToolButton
              active={tool === "outer"}
              onClick={() => setTool("outer")}
              label="Flat outline"
              tooltip="Click around the outside walls, then close the outline to define the flat"
              icon={<Square />}
            />
            <ToolButton
              active={tool === "wall"}
              onClick={() => setTool("wall")}
              label="Inner wall"
              tooltip="Draw partition walls; snap to existing walls and use Stop wall to start elsewhere"
              icon={<MoveHorizontal />}
            />
            <ToolButton
              active={tool === "customRoom"}
              onClick={() => setTool("customRoom")}
              label="Manual room"
              tooltip="Click custom room points when a room is not fully enclosed by walls"
              icon={<Pencil />}
            />
            <ToolButton
              active={tool === "scale"}
              onClick={() => setTool("scale")}
              label="Scale"
              tooltip="Click two points on a known length, then enter the real length in meters"
              icon={<PencilRuler />}
            />
            <ToolButton active={tool === "ruler"} onClick={() => setTool("ruler")} label="Ruler" tooltip="Measure any distance with a temporary two-point ruler" icon={<Ruler />} />
          </div>
          <div className="toggles">
            <label title="Show or hide wall and room dimension labels">
              <input type="checkbox" checked={showDimensions} onChange={(event) => setShowDimensions(event.target.checked)} />
              Dimensions
            </label>
            <label title="Show or hide the background grid">
              <input type="checkbox" checked={showGrid} onChange={(event) => setShowGrid(event.target.checked)} />
              Grid
            </label>
            <label title="Snap wall point edits to nearby wall corners and segments">
              <input type="checkbox" checked={wallSnapEnabled} onChange={(event) => setWallSnapEnabled(event.target.checked)} />
              Wall snap
            </label>
          </div>
          {draftPoints.length > 0 && (
            <div className="inline-actions">
              <button onClick={() => setDraftPoints((current) => current.slice(0, -1))} title="Remove the last point from the current drawing">
                <Undo2 size={16} />
                Undo
              </button>
              {tool === "outer" && (
                <button onClick={finishOuterOutline} disabled={draftPoints.length < 3} title="Close the outside wall outline">
                  <Square size={16} />
                  Close outline
                </button>
              )}
              {tool === "wall" && (
                <button onClick={finishInnerWalls} title="End this wall chain but keep the Inner wall tool active">
                  <MoveHorizontal size={16} />
                  Stop wall
                </button>
              )}
              {tool === "customRoom" && (
                <button onClick={finishCustomRoom} disabled={draftPoints.length < 3} title="Create a manual room from the clicked points">
                  <Square size={16} />
                  Create room
                </button>
              )}
            </div>
          )}
        </section>

        <section className="panel">
          <h2>Scale</h2>
          <label className="field">
            <span>Whole flat area</span>
            <div className="field-row">
              <input value={knownArea} onChange={(event) => setKnownArea(event.target.value)} inputMode="decimal" />
              <button onClick={applyKnownArea} disabled={outerOutline.length < 3} title="Use the finished flat outline and this real area to calibrate the scale">
                Set
              </button>
            </div>
          </label>
          <label className="field">
            <span>Known length</span>
            <div className="field-row">
              <input value={knownLength} onChange={(event) => setKnownLength(event.target.value)} inputMode="decimal" />
              <button
                onClick={applyKnownLength}
                disabled={!scaleLine || scaleLineDrafting || distance(scaleLine.a, scaleLine.b) === 0}
                title="Use the red scale line and this real length to calibrate the scale"
              >
                Set
              </button>
            </div>
          </label>
          {scaleLine && (
            <div className="inline-actions">
              <button onClick={clearScaleLine} title="Remove the current scale line">
                <Trash2 size={16} />
                Clear scale line
              </button>
              <button onClick={() => setTool("scale")} title="Draw a new two-point scale line">
                <PencilRuler size={16} />
                {scaleLineDrafting ? "Pick second point" : "Redraw"}
              </button>
            </div>
          )}
          <div className="metric-line">
            <span>Flat</span>
            <strong>{outerOutline.length >= 3 ? formatArea(flatArea) : "-"}</strong>
          </div>
          <div className="metric-line">
            <span>Ruler</span>
            <strong>{rulerLength ? formatLength(rulerLength) : "-"}</strong>
          </div>
          {rulerLine && (
            <div className="inline-actions">
              <button onClick={clearRulerLine} title="Remove the current ruler measurement">
                <Trash2 size={16} />
                Clear ruler
              </button>
              <button onClick={() => setTool("ruler")} title="Draw a new two-point ruler measurement">
                <Ruler size={16} />
                {rulerLineDrafting ? "Pick second point" : "Redraw"}
              </button>
            </div>
          )}
          <div className="metric-line">
            <span>Scale line</span>
            <strong>{scaleLineLength ? formatLength(scaleLineLength) : "-"}</strong>
          </div>
        </section>

        <section className="panel">
          <h2>Objects</h2>
          <div className="preset-grid">
            {presets.map((preset) => {
              const Icon = preset.icon;
              return (
                <button key={preset.type} onClick={() => addObject(preset)} title={`Add ${preset.label.toLowerCase()} with default dimensions`}>
                  <Icon size={17} />
                  <span>{preset.label}</span>
                </button>
              );
            })}
          </div>
        </section>
      </aside>

      <main className="workspace">
        <div className="topbar">
          <div>
            <strong>{rooms.length}</strong> rooms
            <span>{outerOutline.length >= 3 ? "flat outline ready" : "draw flat outline"}</span>
            <span>{innerWalls.length} inner walls</span>
            <span>{objects.length} objects</span>
            <span>{scaleMPerPx ? `${(1 / scaleMPerPx).toFixed(1)} px/m` : "default sizing"}</span>
          </div>
          <div>
            <div className="view-switch" aria-label="Workspace view">
              <button className={workspaceMode === "2d" ? "active" : ""} onClick={() => setWorkspaceMode("2d")}>2D</button>
              <button className={workspaceMode === "3d" ? "active" : ""} onClick={() => setWorkspaceMode("3d")}>3D</button>
            </div>
            <button onClick={() => fitToBackground()} disabled={!background || workspaceMode === "3d"} title="Fit the imported background image into view">
              <Maximize2 size={16} />
              Fit
            </button>
            <button onClick={resetViewport} disabled={workspaceMode === "3d"} title="Reset zoom and pan">
              <RotateCw size={16} />
              Reset
            </button>
            <button onClick={deleteWalls} title="Remove all outer and inner walls">
              <Trash2 size={16} />
              Clear walls
            </button>
            <button onClick={() => setPrintDialogOpen(true)} title="Create a printable 3MF or STL model">
              <Printer size={16} />
              3D Print
            </button>
            <button onClick={exportPng} disabled={workspaceMode === "3d"} title="Export the current plan as a PNG image">
              <Download size={16} />
              PNG
            </button>
          </div>
        </div>

        {workspaceMode === "2d" ? (
        <div className="stage" ref={stageRef} onWheel={handleWheel}>
          <canvas ref={canvasRef} className="background-canvas" />
          <svg
            className="overlay"
            width={stageSize.width}
            height={stageSize.height}
            onDoubleClick={handleStageDoubleClick}
            onPointerDown={handleStagePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerCancel={handlePointerCancel}
          >
            <g transform={`translate(${viewport.x} ${viewport.y}) scale(${viewport.zoom})`}>
              {resolvedRooms.map((room) => (
                <RoomShape
                  key={room.id}
                  room={room}
                  locked={Boolean(room.wallSeed)}
                  selected={selection?.kind === "room" && selection.id === room.id}
                  scale={effectiveScale}
                  calibrated={Boolean(scaleMPerPx)}
                  showDimensions={showDimensions}
                  onSelect={(event) => {
                    event.stopPropagation();
                    setSelection({ kind: "room", id: room.id });
                    setTool("select");
                  }}
                  onDrag={(event) => {
                    event.stopPropagation();
                    setSelection({ kind: "room", id: room.id });
                    if (room.wallSeed) return;
                    setDrag({ kind: "room", id: room.id, start: screenToWorld(pointerPoint(event)), points: room.points });
                  }}
                  onVertexDrag={(event, index) => {
                    event.stopPropagation();
                    if (room.wallSeed) return;
                    setSelection({ kind: "room", id: room.id });
                    setDrag({ kind: "vertex", roomId: room.id, index });
                  }}
                />
              ))}

              <WallLayer
                walls={allWalls}
                openings={openingProjections}
                selectedWallId={selection?.kind === "wall" ? selection.id : null}
                scale={effectiveScale}
                calibrated={Boolean(scaleMPerPx)}
                showDimensions={showDimensions}
                onSelect={handleWallPointerDown}
              />
              <WallHandles
                outerOutline={outerOutline}
                innerWalls={innerWalls}
                zoom={viewport.zoom}
                onOuterPointerDown={(event, index) => {
                  event.stopPropagation();
                  if (tool === "wall") {
                    addDraftPoint(outerOutline[index]);
                    return;
                  }
                  setTool("select");
                  setSelection({ kind: "wall", id: `outer-${index}` });
                  setDrag({ kind: "outer-point", index });
                }}
                onInnerPointerDown={(event, wallId, end) => {
                  event.stopPropagation();
                  if (tool === "wall") {
                    const wall = innerWalls.find((candidate) => candidate.id === wallId);
                    if (wall) addDraftPoint(wall[end]);
                    return;
                  }
                  setTool("select");
                  setSelection({ kind: "wall", id: wallId });
                  setDrag({ kind: "inner-wall-point", wallId, end });
                }}
              />

              {draftPoints.length > 0 && (
                <g className="draft">
                  <polyline points={draftPoints.map((point) => `${point.x},${point.y}`).join(" ")} />
                  {draftPreview && (
                    <line className="draft-preview" x1={draftPreview.a.x} y1={draftPreview.a.y} x2={draftPreview.b.x} y2={draftPreview.b.y} />
                  )}
                  {tool === "outer" && draftPoints.length >= 3 && pointerWorld && (
                    <line
                      className={`draft-close-preview ${canCloseOuterFromPointer ? "ready" : ""}`}
                      x1={pointerWorld.x}
                      y1={pointerWorld.y}
                      x2={draftPoints[0].x}
                      y2={draftPoints[0].y}
                    />
                  )}
                  {draftPoints.map((point, index) => (
                    <circle key={index} cx={point.x} cy={point.y} r={6 / viewport.zoom} />
                  ))}
                  {tool === "outer" && draftPoints.length >= 3 && (
                    <circle className="close-target" cx={draftPoints[0].x} cy={draftPoints[0].y} r={16 / viewport.zoom} />
                  )}
                  {draftPreview && <circle className="draft-target" cx={draftPreview.b.x} cy={draftPreview.b.y} r={9 / viewport.zoom} />}
                  {snapTargetMarker}
                </g>
              )}

              {snappedObjects.map((object) => (
                <ObjectShape
                  key={object.id}
                  object={object}
                  selected={selection?.kind === "object" && selection.id === object.id}
                  pxPerMeter={1 / effectiveScale}
                  zoom={viewport.zoom}
                  onSelect={(event) => {
                    event.stopPropagation();
                    setSelection({ kind: "object", id: object.id });
                    setTool("select");
                    setDrag({ kind: "object", id: object.id, start: screenToWorld(pointerPoint(event)), object });
                  }}
                  onResize={(event, handle) => {
                    event.stopPropagation();
                    setSelection({ kind: "object", id: object.id });
                    setDrag({ kind: "object-resize", id: object.id, handle, object });
                  }}
                  onRotate={(event) => {
                    event.stopPropagation();
                    setSelection({ kind: "object", id: object.id });
                    const world = screenToWorld(pointerPoint(event));
                    setDrag({ kind: "object-rotate", id: object.id, startAngle: pointerAngleDegrees(world, object), object });
                  }}
                />
              ))}

              {scaleLine && (
                <MeasurementLine
                  line={scaleLine}
                  label={scaleLineLength ? formatLength(scaleLineLength) : ""}
                  color="#dc2626"
                  zoom={viewport.zoom}
                />
              )}
              {rulerLine && (
                <MeasurementLine
                  line={rulerLine}
                  label={rulerLength ? formatLength(rulerLength) : ""}
                  color="#0f766e"
                  zoom={viewport.zoom}
                />
              )}
            </g>
          </svg>
          {tool === "wall" && draftPoints.length > 0 && (
            <div className="stage-actions">
              <button onClick={finishInnerWalls} title="End this wall chain but keep the Inner wall tool active">
                <MoveHorizontal size={16} />
                Stop wall
              </button>
              <button onClick={() => setDraftPoints((current) => current.slice(0, -1))} title="Remove the last wall point">
                <Undo2 size={16} />
                Undo point
              </button>
            </div>
          )}
          {tool === "scale" && scaleLine && (
            <div className="stage-actions">
              <button onClick={clearScaleLine} title="Remove the current scale line">
                <Trash2 size={16} />
                Clear scale
              </button>
              <button onClick={() => setScaleLineDrafting(true)} disabled={scaleLineDrafting} title="Move the second point of the scale line">
                <PencilRuler size={16} />
                {scaleLineDrafting ? "Pick point 2" : "Move point 2"}
              </button>
            </div>
          )}
          {tool === "ruler" && rulerLine && (
            <div className="stage-actions">
              <button onClick={clearRulerLine} title="Remove the current ruler measurement">
                <Trash2 size={16} />
                Clear ruler
              </button>
              <button onClick={() => setRulerLineDrafting(true)} disabled={rulerLineDrafting} title="Move the second point of the ruler measurement">
                <Ruler size={16} />
                {rulerLineDrafting ? "Pick point 2" : "Move point 2"}
              </button>
            </div>
          )}
        </div>
        ) : (
          <div className="stage stage-3d">
            <Suspense fallback={<div className="three-loading">Preparing 3D view…</div>}>
              <ThreeDView
                plan={metricPlan}
                selectedObjectId={selection?.kind === "object" ? selection.id : null}
                onSelectObject={(id) => {
                  setSelection({ kind: "object", id });
                  setMobileDrawer("details");
                }}
              />
            </Suspense>
          </div>
        )}
        <div className="mobile-dock" aria-label="Mobile planner menus">
          <button className={mobileDrawer === "tools" ? "active" : ""} onClick={() => setMobileDrawer(mobileDrawer === "tools" ? null : "tools")} title="Show or hide drawing tools">
            Tools
          </button>
          <button className={mobileDrawer === "files" ? "active" : ""} onClick={() => setMobileDrawer(mobileDrawer === "files" ? null : "files")} title="Show or hide plan file actions">
            Plan
          </button>
          <button
            className={mobileDrawer === "details" ? "active" : ""}
            onClick={() => setMobileDrawer(mobileDrawer === "details" ? null : "details")}
            title="Show or hide selected item details"
          >
            Details
          </button>
          <button onClick={() => setMobileDrawer(null)} title="Hide all mobile panels">Hide</button>
        </div>
      </main>

      <aside className="inspector">
        <section className="panel">
          <h2>Selection</h2>
          {!selection && <p className="empty">Double-click inside a closed wall area to create a room.</p>}

          {selectedWall && (
            <div className="stack">
              <div className="metric-card">
                <span>{selectedWall.kind === "outer" ? "Outer wall" : "Inner wall"}</span>
                <strong>{formatLength(distance(selectedWall.a, selectedWall.b) * effectiveScale)}</strong>
              </div>
              <button className="danger" onClick={deleteSelectedWall} title="Delete the selected wall segment">
                <Trash2 size={16} />
                Delete wall
              </button>
            </div>
          )}

          {selectedRoom && (
            <div className="stack">
              <label className="field">
                <span>Name</span>
                <input value={selectedRoom.name} onChange={(event) => updateRoom(selectedRoom.id, { name: event.target.value })} />
              </label>
              <label className="field">
                <span>Color</span>
                <input type="color" value={selectedRoom.color} onChange={(event) => updateRoom(selectedRoom.id, { color: event.target.value })} />
              </label>
              <div className="metric-card">
                <span>Area</span>
                <strong>{formatArea(selectedArea)}</strong>
              </div>
              <button
                className="danger"
                onClick={() => {
                  setRooms((current) => current.filter((room) => room.id !== selectedRoom.id));
                  setSelection(null);
                }}
                title="Delete the selected room label and area"
              >
                <Trash2 size={16} />
                Delete room
              </button>
            </div>
          )}

          {selectedObject && (
            <div className="stack">
              <label className="field">
                <span>Label</span>
                <input value={selectedObject.label} onChange={(event) => updateObject(selectedObject.id, { label: event.target.value })} />
              </label>
              <div className="two-col">
                <label className="field">
                  <span>Width m</span>
                  <input
                    value={selectedObject.widthM}
                    type="number"
                    min="0.1"
                    step="0.01"
                    onChange={(event) => updateObject(selectedObject.id, { widthM: Number(event.target.value) })}
                  />
                </label>
                <label className="field">
                  <span>Depth m</span>
                  <input
                    value={selectedObject.heightM}
                    type="number"
                    min="0.1"
                    step="0.01"
                    onChange={(event) => updateObject(selectedObject.id, { heightM: Number(event.target.value) })}
                  />
                </label>
              </div>
              <label className="field">
                <span>{isWallOpening(selectedObject) ? "Opening height m" : "Model height m"}</span>
                <input
                  value={isWallOpening(selectedObject) ? selectedObject.openingHeightM ?? selectedObject.modelHeightM : selectedObject.modelHeightM}
                  type="number"
                  min="0.05"
                  step="0.01"
                  onChange={(event) => {
                    const value = Number(event.target.value);
                    updateObject(
                      selectedObject.id,
                      isWallOpening(selectedObject)
                        ? { openingHeightM: value, modelHeightM: value }
                        : { modelHeightM: value },
                    );
                  }}
                />
              </label>
              {selectedObject.type === "window" && (
                <label className="field">
                  <span>Window sill height m</span>
                  <input
                    value={selectedObject.openingBottomM ?? 0.9}
                    type="number"
                    min="0"
                    step="0.01"
                    onChange={(event) => updateObject(selectedObject.id, { openingBottomM: Number(event.target.value) })}
                  />
                </label>
              )}
              <label className="field">
                <span>Color</span>
                <input type="color" value={selectedObject.color} onChange={(event) => updateObject(selectedObject.id, { color: event.target.value })} />
              </label>
              <button
                className="danger"
                onClick={() => {
                  setObjects((current) => current.filter((object) => object.id !== selectedObject.id));
                  setSelection(null);
                }}
                title="Delete the selected object"
              >
                <Trash2 size={16} />
                Delete object
              </button>
            </div>
          )}
        </section>

        <section className="panel">
          <h2>3D Construction</h2>
          <label className="field">
            <span>Wall height m</span>
            <input
              type="number"
              min="0.2"
              step="0.05"
              value={construction.wallHeightM}
              onChange={(event) => setConstruction((current) => ({ ...current, wallHeightM: Math.max(0.2, Number(event.target.value)) }))}
            />
          </label>
          <div className="two-col">
            <label className="field">
              <span>Outer wall m</span>
              <input
                type="number"
                min="0.02"
                step="0.01"
                value={construction.outerWallThicknessM}
                onChange={(event) => setConstruction((current) => ({ ...current, outerWallThicknessM: Math.max(0.02, Number(event.target.value)) }))}
              />
            </label>
            <label className="field">
              <span>Inner wall m</span>
              <input
                type="number"
                min="0.02"
                step="0.01"
                value={construction.innerWallThicknessM}
                onChange={(event) => setConstruction((current) => ({ ...current, innerWallThicknessM: Math.max(0.02, Number(event.target.value)) }))}
              />
            </label>
          </div>
          <p className="empty">Used by the live 3D view and real-thickness print exports.</p>
        </section>

        <section className="panel">
          <h2>Walls</h2>
          <div className="metric-line">
            <span>Outer points</span>
            <strong>{outerOutline.length}</strong>
          </div>
          <div className="metric-line">
            <span>Inner walls</span>
            <strong>{innerWalls.length}</strong>
          </div>
          <div className="metric-line">
            <span>Flat area</span>
            <strong>{outerOutline.length >= 3 ? formatArea(flatArea) : "-"}</strong>
          </div>
        </section>

        <section className="panel">
          <h2>Rooms</h2>
          <div className="room-list">
            {roomStats.map((room) => (
              <button key={room.id} onClick={() => setSelection({ kind: "room", id: room.id })} title={`Select ${room.name}`}>
                <span>{room.name}</span>
                <strong>{formatArea(room.area)}</strong>
              </button>
            ))}
            {roomStats.length === 0 && <p className="empty">No rooms yet</p>}
          </div>
        </section>

        <section className="panel">
          <h2>Browser Save</h2>
          <div className="metric-line">
            <span>Status</span>
            <strong>{hydrated ? "Autosaved" : "Loading"}</strong>
          </div>
          <button className="danger" onClick={clearAutosavedPlan} title="Clear the browser autosave and reset the current plan">
            <Trash2 size={16} />
            Clear saved plan
          </button>
        </section>

        <section className="panel">
          <h2>Background</h2>
          {background ? (
            <div className="stack">
              <div className="metric-line">
                <span>{background.name}</span>
                <strong>
                  {background.width} x {background.height}
                </strong>
              </div>
              <label className="field">
                <span>Opacity</span>
                <input
                  type="range"
                  min="0.1"
                  max="1"
                  step="0.05"
                  value={background.opacity}
                  onChange={(event) => setBackground({ ...background, opacity: Number(event.target.value) })}
                />
              </label>
            </div>
          ) : (
            <p className="empty">No plan image</p>
          )}
        </section>
      </aside>
      {printDialogOpen && (
        <Suspense fallback={<div className="modal-backdrop"><div className="three-loading">Preparing print tools…</div></div>}>
          <PrintExportDialog plan={metricPlan} calibrated={Boolean(scaleMPerPx)} onClose={() => setPrintDialogOpen(false)} />
        </Suspense>
      )}
    </div>
  );
}

function ToolButton({
  active,
  icon,
  label,
  tooltip,
  onClick,
}: {
  active: boolean;
  icon: React.ReactElement;
  label: string;
  tooltip?: string;
  onClick: () => void;
}) {
  return (
    <button className={active ? "active" : ""} onClick={onClick} title={tooltip ?? label} aria-label={label}>
      {React.cloneElement(icon, { size: 18 } as { size: number })}
      <span>{label}</span>
    </button>
  );
}

function WallLayer({
  walls,
  openings,
  selectedWallId,
  scale,
  calibrated,
  showDimensions,
  onSelect,
}: {
  walls: WallSegment[];
  openings: OpeningProjection[];
  selectedWallId: string | null;
  scale: number;
  calibrated: boolean;
  showDimensions: boolean;
  onSelect: (event: PointerEvent<SVGLineElement>, wall: WallSegment) => void;
}) {
  return (
    <g className="wall-layer">
      {walls.map((wall) => {
        const mid = midpoint(wall.a, wall.b);
        const wallOpenings = openings.filter((opening) => opening.wallId === wall.id);
        return (
          <g key={wall.id} className={`wall-segment ${wall.kind} ${selectedWallId === wall.id ? "selected" : ""}`}>
            <line className="wall-hit" x1={wall.a.x} y1={wall.a.y} x2={wall.b.x} y2={wall.b.y} onPointerDown={(event) => onSelect(event, wall)} />
            <line className="wall-visible" x1={wall.a.x} y1={wall.a.y} x2={wall.b.x} y2={wall.b.y} />
            {wallOpenings.map((opening) => (
              <line
                key={opening.objectId}
                className="wall-opening-fade"
                x1={opening.a.x}
                y1={opening.a.y}
                x2={opening.b.x}
                y2={opening.b.y}
              />
            ))}
            {showDimensions && calibrated && (
              <text x={mid.x} y={mid.y - 8} textAnchor="middle" className="dimension-label">
                {(distance(wall.a, wall.b) * scale).toFixed(2)} m
              </text>
            )}
          </g>
        );
      })}
    </g>
  );
}

function WallHandles({
  outerOutline,
  innerWalls,
  zoom,
  onOuterPointerDown,
  onInnerPointerDown,
}: {
  outerOutline: Point[];
  innerWalls: WallSegment[];
  zoom: number;
  onOuterPointerDown: (event: PointerEvent<SVGCircleElement>, index: number) => void;
  onInnerPointerDown: (event: PointerEvent<SVGCircleElement>, wallId: string, end: "a" | "b") => void;
}) {
  return (
    <g className="wall-handles">
      {outerOutline.map((point, index) => (
        <circle
          key={`outer-handle-${index}`}
          cx={point.x}
          cy={point.y}
          r={9 / zoom}
          onPointerDown={(event) => onOuterPointerDown(event, index)}
        />
      ))}
      {innerWalls.flatMap((wall) => [
        <circle
          key={`${wall.id}-a`}
          cx={wall.a.x}
          cy={wall.a.y}
          r={8 / zoom}
          onPointerDown={(event) => onInnerPointerDown(event, wall.id, "a")}
        />,
        <circle
          key={`${wall.id}-b`}
          cx={wall.b.x}
          cy={wall.b.y}
          r={8 / zoom}
          onPointerDown={(event) => onInnerPointerDown(event, wall.id, "b")}
        />,
      ])}
    </g>
  );
}

function RoomShape({
  room,
  locked,
  selected,
  scale,
  calibrated,
  showDimensions,
  onSelect,
  onDrag,
  onVertexDrag,
}: {
  room: Room;
  locked: boolean;
  selected: boolean;
  scale: number;
  calibrated: boolean;
  showDimensions: boolean;
  onSelect: (event: PointerEvent<SVGPolygonElement>) => void;
  onDrag: (event: PointerEvent<SVGPolygonElement>) => void;
  onVertexDrag: (event: PointerEvent<SVGCircleElement>, index: number) => void;
}) {
  const center = centroid(room.points);
  const area = polygonAreaPx(room.points) * scale * scale;
  return (
    <g className={`room-shape ${locked ? "locked" : ""} ${selected ? "selected" : ""}`}>
      <polygon
        points={room.points.map((point) => `${point.x},${point.y}`).join(" ")}
        fill={`${room.color}24`}
        stroke={room.color}
        onPointerDown={onDrag}
        onClick={onSelect}
      />
      <text x={center.x} y={center.y} textAnchor="middle" className="room-label">
        {room.name} {calibrated ? `${area.toFixed(2)} m2` : ""}
      </text>
      {showDimensions &&
        calibrated &&
        room.points.map((point, index) => {
          const next = room.points[(index + 1) % room.points.length];
          const mid = midpoint(point, next);
          return (
            <text key={`${room.id}-${index}`} x={mid.x} y={mid.y - 6} textAnchor="middle" className="dimension-label">
              {(distance(point, next) * scale).toFixed(2)} m
            </text>
          );
        })}
      {selected &&
        !locked &&
        room.points.map((point, index) => (
          <circle
            className="vertex"
            key={`${room.id}-vertex-${index}`}
            cx={point.x}
            cy={point.y}
            r={7}
            onPointerDown={(event) => onVertexDrag(event, index)}
          />
        ))}
    </g>
  );
}

function ObjectShape({
  object,
  selected,
  pxPerMeter,
  zoom,
  onSelect,
  onResize,
  onRotate,
}: {
  object: Furniture;
  selected: boolean;
  pxPerMeter: number;
  zoom: number;
  onSelect: (event: PointerEvent<SVGGElement>) => void;
  onResize: (event: PointerEvent<SVGRectElement>, handle: ResizeHandle) => void;
  onRotate: (event: PointerEvent<SVGCircleElement>) => void;
}) {
  const width = object.widthM * pxPerMeter;
  const height = object.heightM * pxPerMeter;
  const opening = isWallOpening(object);
  const handleSize = 12 / zoom;
  const handleLength = Math.max(22 / zoom, Math.min(46 / zoom, Math.min(width, height) * 0.62));
  const rotateY = -height / 2 - 30 / zoom;
  return (
    <g
      className={`object-shape ${selected ? "selected" : ""}`}
      transform={`translate(${object.x} ${object.y}) rotate(${object.rotation})`}
      onPointerDown={onSelect}
    >
      <rect x={-width / 2} y={-height / 2} width={width} height={height} rx={4 / zoom} fill={`${object.color}30`} stroke={object.color} />
      <text textAnchor="middle" dominantBaseline="middle" className="object-label">
        {object.label}
      </text>
      {selected && (
        <>
          <rect
            className="resize-handle handle-right"
            x={width / 2 - handleSize / 2}
            y={-handleLength / 2}
            width={handleSize}
            height={handleLength}
            rx={3 / zoom}
            onPointerDown={(event) => onResize(event, "right")}
          />
          <rect
            className="resize-handle handle-left"
            x={-width / 2 - handleSize / 2}
            y={-handleLength / 2}
            width={handleSize}
            height={handleLength}
            rx={3 / zoom}
            onPointerDown={(event) => onResize(event, "left")}
          />
          <rect
            className="resize-handle handle-top"
            x={-handleLength / 2}
            y={-height / 2 - handleSize / 2}
            width={handleLength}
            height={handleSize}
            rx={3 / zoom}
            onPointerDown={(event) => onResize(event, "top")}
          />
          <rect
            className="resize-handle handle-bottom"
            x={-handleLength / 2}
            y={height / 2 - handleSize / 2}
            width={handleLength}
            height={handleSize}
            rx={3 / zoom}
            onPointerDown={(event) => onResize(event, "bottom")}
          />
          {!opening && (
            <>
              <line className="rotate-stem" x1={0} y1={-height / 2} x2={0} y2={rotateY} />
              <circle className="rotate-handle" cx={0} cy={rotateY} r={8 / zoom} onPointerDown={onRotate} />
            </>
          )}
        </>
      )}
    </g>
  );
}

function MeasurementLine({
  line,
  label,
  color,
  zoom,
}: {
  line: { a: Point; b: Point };
  label: string;
  color: string;
  zoom: number;
}) {
  const mid = midpoint(line.a, line.b);
  return (
    <g className="measure-line" style={{ color }}>
      <line x1={line.a.x} y1={line.a.y} x2={line.b.x} y2={line.b.y} stroke={color} strokeWidth={2 / zoom} />
      <circle cx={line.a.x} cy={line.a.y} r={5 / zoom} fill={color} />
      <circle cx={line.b.x} cy={line.b.y} r={5 / zoom} fill={color} />
      {label && (
        <text x={mid.x} y={mid.y - 10 / zoom} textAnchor="middle" fill={color}>
          {label}
        </text>
      )}
    </g>
  );
}
