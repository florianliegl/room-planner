export type Point = { x: number; y: number };

export type WallSegment = {
  id: string;
  a: Point;
  b: Point;
  kind: "outer" | "inner";
};

export type Furniture = {
  id: string;
  type: string;
  label: string;
  x: number;
  y: number;
  widthM: number;
  heightM: number;
  modelHeightM: number;
  openingBottomM?: number;
  openingHeightM?: number;
  rotation: number;
  color: string;
};

export type ConstructionSettings = {
  wallHeightM: number;
  outerWallThicknessM: number;
  innerWallThicknessM: number;
};

export const defaultConstructionSettings: ConstructionSettings = {
  wallHeightM: 2.5,
  outerWallThicknessM: 0.2,
  innerWallThicknessM: 0.1,
};

export type MetricOpening = {
  objectId: string;
  wallId: string;
  type: "door" | "window";
  centerM: Point;
  widthM: number;
  bottomM: number;
  heightM: number;
  rotation: number;
};

export type MetricPlan = {
  outlineM: Point[];
  walls: WallSegment[];
  furniture: Furniture[];
  openings: MetricOpening[];
  settings: ConstructionSettings;
  boundsM: { minX: number; minY: number; maxX: number; maxY: number; width: number; depth: number };
};

export type PrintExportOptions = {
  format: "3mf" | "stl";
  heightMode: "scaled" | "low";
  lowProfileHeightMm: number;
  thicknessMode: "real" | "slim";
  slimWallThicknessMm: number;
  includeFloor: boolean;
  floorThicknessMm: number;
  furnitureMode: "none" | "fused" | "loose";
  bedWidthMm: number;
  bedDepthMm: number;
  bedMarginMm: number;
  scaleMode: "fit" | "manual";
  scaleDenominator: number;
  autoRotate: boolean;
  connectorClearanceMm: number;
};

export const defaultPrintOptions: PrintExportOptions = {
  format: "3mf",
  heightMode: "scaled",
  lowProfileHeightMm: 10,
  thicknessMode: "real",
  slimWallThicknessMm: 1.6,
  includeFloor: true,
  floorThicknessMm: 2,
  furnitureMode: "none",
  bedWidthMm: 220,
  bedDepthMm: 220,
  bedMarginMm: 5,
  scaleMode: "fit",
  scaleDenominator: 50,
  autoRotate: true,
  connectorClearanceMm: 0.2,
};

export type PrintLayout = {
  denominator: number;
  rotated: boolean;
  widthMm: number;
  depthMm: number;
  heightMm: number;
  columns: number;
  rows: number;
  partCount: number;
  availableWidthMm: number;
  availableDepthMm: number;
  warnings: string[];
};

export type PrintablePart = {
  id: string;
  name: string;
  row: number;
  column: number;
  boundsMm: { minX: number; minY: number; maxX: number; maxY: number };
};
