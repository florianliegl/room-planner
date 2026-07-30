import type { FurniturePrintStyle } from "./plannerTypes";

export type FurniturePartSpec = {
  size: [number, number, number];
  center: [number, number, number];
  tone: "primary" | "light" | "dark" | "accent";
  assemblyPart?: "body" | "back";
};

export const furniturePrintStyles: Array<{ id: FurniturePrintStyle; label: string; description: string }> = [
  { id: "classic", label: "Classic", description: "Recognizable everyday proportions." },
  { id: "modern", label: "Modern", description: "Slimmer frames and cleaner lines." },
  { id: "print-friendly", label: "Print-friendly", description: "Chunkier, stronger features for reliable small prints." },
];

export function buildFurnitureParts(
  type: string,
  width: number,
  depth: number,
  height: number,
  style: FurniturePrintStyle,
): FurniturePartSpec[] {
  const w = Math.max(0.01, width);
  const d = Math.max(0.01, depth);
  const h = Math.max(0.01, height);
  const parts: FurniturePartSpec[] = [];
  const add = (
    size: [number, number, number],
    center: [number, number, number],
    tone: FurniturePartSpec["tone"] = "primary",
    assemblyPart: FurniturePartSpec["assemblyPart"] = "body",
  ) => parts.push({ size: size.map((value) => Math.max(0.01, value)) as [number, number, number], center, tone, assemblyPart });

  if (style === "print-friendly") {
    if (type === "table" || type === "desk") {
      add([w, d, h * 0.18], [0, 0, h * 0.91]);
      add([w * 0.16, d * 0.8, h * 0.82], [-w * 0.36, 0, h * 0.41]);
      add([w * 0.16, d * 0.8, h * 0.82], [w * 0.36, 0, h * 0.41]);
    } else if (type === "chair") {
      const seatZ = h * 0.46;
      add([w, d, h * 0.16], [0, 0, seatZ], "accent");
      add([w * 0.16, d * 0.16, seatZ], [-w * 0.36, d * 0.34, seatZ / 2], "dark");
      add([w * 0.16, d * 0.16, seatZ], [w * 0.36, d * 0.34, seatZ / 2], "dark");
      add([w * 0.16, d * 0.16, seatZ], [-w * 0.36, -d * 0.34, seatZ / 2], "dark");
      add([w * 0.16, d * 0.16, seatZ], [w * 0.36, -d * 0.34, seatZ / 2], "dark");
      add([w * 0.16, d * 0.16, h - seatZ], [-w * 0.36, -d * 0.34, (h + seatZ) / 2], "dark", "back");
      add([w * 0.16, d * 0.16, h - seatZ], [w * 0.36, -d * 0.34, (h + seatZ) / 2], "dark", "back");
      add([w * 0.78, d * 0.16, h * 0.3], [0, -d * 0.34, h * 0.8], "accent", "back");
    } else if (type === "bed") {
      add([w, d, h * 0.48], [0, 0, h * 0.24]);
      add([w, d * 0.12, h], [0, -d * 0.44, h * 0.5]);
    } else if (type === "sofa") {
      add([w, d, h * 0.58], [0, 0, h * 0.29]);
      add([w, d * 0.22, h * 0.72], [0, -d * 0.39, h * 0.64]);
      add([w * 0.15, d, h * 0.7], [-w * 0.425, 0, h * 0.35]);
      add([w * 0.15, d, h * 0.7], [w * 0.425, 0, h * 0.35]);
    } else if (type === "shelf") {
      add([w, d, h], [0, 0, h / 2]);
      add([w * 0.76, d * 1.05, h * 0.1], [0, d * 0.03, h * 0.7], "dark");
      add([w * 0.76, d * 1.05, h * 0.1], [0, d * 0.03, h * 0.36], "dark");
    } else {
      add([w, d, h], [0, 0, h / 2]);
    }
    return parts;
  }

  if (type === "bed") {
    const baseHeight = style === "modern" ? h * 0.22 : h * 0.35;
    add([w, d, baseHeight], [0, 0, baseHeight / 2]);
    add([w * 0.94, d * 0.88, h * 0.14], [0, d * 0.02, baseHeight + h * 0.07], "light");
    add([w, d * (style === "modern" ? 0.06 : 0.1), h * 0.82], [0, -d * 0.46, h * 0.41], "accent");
  } else if (type === "sofa") {
    add([w, d, h * (style === "modern" ? 0.3 : 0.45)], [0, 0, h * 0.2]);
    add([w, d * 0.16, h * 0.58], [0, -d * 0.41, h * 0.61], "accent");
    add([w * 0.1, d, h * 0.52], [-w * 0.45, 0, h * 0.36]);
    add([w * 0.1, d, h * 0.52], [w * 0.45, 0, h * 0.36]);
  } else if (type === "chair") {
    const seatZ = h * 0.48;
    const slab = style === "modern" ? h * 0.07 : h * 0.11;
    add([w, d, slab], [0, 0, seatZ], "accent");
    const legW = Math.max(w * (style === "modern" ? 0.055 : 0.09), 0.01);
    const legD = Math.max(d * (style === "modern" ? 0.055 : 0.09), 0.01);
    [-1, 1].forEach((sx) => [-1, 1].forEach((sy) =>
      add([legW, legD, seatZ], [sx * w * 0.4, sy * d * 0.4, seatZ / 2], "dark"),
    ));
    const postWidth = Math.max(w * (style === "modern" ? 0.055 : 0.09), 0.01);
    add([postWidth, legD, h * 0.52], [-w * 0.4, -d * 0.4, h * 0.74], "dark", "back");
    add([postWidth, legD, h * 0.52], [w * 0.4, -d * 0.4, h * 0.74], "dark", "back");
    add([w * 0.86, d * (style === "modern" ? 0.065 : 0.1), h * 0.26], [0, -d * 0.4, h * 0.82], "accent", "back");
  } else if (type === "table" || type === "desk") {
    const topZ = h * 0.9;
    const slab = style === "modern" ? h * 0.07 : h * 0.11;
    add([w, d, slab], [0, 0, topZ], "accent");
    const legW = Math.max(w * (style === "modern" ? 0.055 : 0.09), 0.01);
    const legD = Math.max(d * (style === "modern" ? 0.055 : 0.09), 0.01);
    [-1, 1].forEach((sx) => [-1, 1].forEach((sy) =>
      add([legW, legD, topZ], [sx * w * 0.4, sy * d * 0.4, topZ / 2], "dark"),
    ));
  } else if (type === "shelf") {
    add([w * 0.08, d, h], [-w * 0.46, 0, h / 2], "dark");
    add([w * 0.08, d, h], [w * 0.46, 0, h / 2], "dark");
    for (let level = 0; level < 4; level += 1) add([w, d, h * 0.04], [0, 0, (h * level) / 3], "accent");
  } else if (type === "wardrobe") {
    add([w, d, h], [0, 0, h / 2]);
    add([w * 0.025, d * 1.02, h * 0.9], [0, d * 0.01, h * 0.5], "accent");
  } else if (type === "appliance") {
    add([w, d, h], [0, 0, h / 2]);
    add([w * 0.75, d * 0.03, h * 0.58], [0, -d * 0.515, h * 0.52], "dark");
  } else {
    add([w, d, h], [0, 0, h / 2]);
  }
  return parts;
}

export function chairConnectorLayout(
  width: number,
  depth: number,
  height: number,
  style: FurniturePrintStyle,
) {
  const printFriendly = style === "print-friendly";
  const seatZ = height * (printFriendly ? 0.46 : 0.48);
  const seatThickness = height * (
    printFriendly
      ? 0.16
      : style === "modern"
        ? 0.07
        : 0.11
  );
  return {
    xPositions: [-width * (printFriendly ? 0.36 : 0.4), width * (printFriendly ? 0.36 : 0.4)],
    y: -depth * (printFriendly ? 0.34 : 0.4),
    seatZ,
    seatTopZ: seatZ + seatThickness / 2,
  };
}
