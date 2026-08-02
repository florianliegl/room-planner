import { useEffect, useRef, useState } from "react";
import {
  booleans as jscadBooleans,
  extrusions as jscadExtrusions,
  primitives as jscadPrimitives,
  transforms as jscadTransforms,
} from "@jscad/modeling";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { PointerLockControls } from "three/examples/jsm/controls/PointerLockControls.js";
import type { Furniture, MetricPlan, Point, WallSegment } from "./plannerTypes";
import { connectedWallExtensions, counterClockwise, createContinuousWallRing } from "./wallGeometryCore";

type Props = {
  plan: MetricPlan;
  showRealWallThickness: boolean;
  northAngleDeg: number;
  selectedObjectId: string | null;
  onSelectObject: (id: string) => void;
};

function wallLength(wall: WallSegment) {
  return Math.hypot(wall.b.x - wall.a.x, wall.b.y - wall.a.y);
}

function createBox(
  width: number,
  height: number,
  depth: number,
  color: string,
  x = 0,
  y = height / 2,
  z = 0,
  opacity = 1,
) {
  const material = new THREE.MeshStandardMaterial({
    color,
    roughness: 0.72,
    transparent: opacity < 1,
    opacity,
  });
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(Math.max(0.001, width), Math.max(0.001, height), Math.max(0.001, depth)), material);
  mesh.position.set(x, y, z);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

type JscadGeom3 = ReturnType<typeof jscadPrimitives.cuboid>;

function buildWallSolid(plan: MetricPlan, wall: WallSegment, thickness: number) {
  const length = wallLength(wall);
  if (length < 0.001) return null;
  const angle = Math.atan2(wall.b.y - wall.a.y, wall.b.x - wall.a.x);
  const direction = {
    x: (wall.b.x - wall.a.x) / length,
    y: (wall.b.y - wall.a.y) / length,
  };
  const extensions = connectedWallExtensions(wall, plan.walls, thickness);
  const startExtension = extensions.start;
  const endExtension = extensions.end;
  const centerShift = (endExtension - startExtension) / 2;
  let solid = jscadTransforms.translate(
    [
      (wall.a.x + wall.b.x) / 2 + direction.x * centerShift,
      (wall.a.y + wall.b.y) / 2 + direction.y * centerShift,
      plan.settings.wallHeightM / 2,
    ],
    jscadTransforms.rotateZ(
      angle,
      jscadPrimitives.cuboid({
        size: [length + startExtension + endExtension, thickness, plan.settings.wallHeightM],
      }),
    ),
  ) as JscadGeom3;
  const openingCutters = plan.openings
    .filter((opening) => opening.wallId === wall.id)
    .map((opening) => {
      const bottom = Math.max(0, opening.bottomM);
      const height = Math.min(
        plan.settings.wallHeightM - bottom,
        opening.heightM,
      );
      if (height <= 0.001) return null;
      return jscadTransforms.translate(
        [opening.centerM.x, opening.centerM.y, bottom + height / 2],
        jscadTransforms.rotateZ(
          angle,
          jscadPrimitives.cuboid({
            size: [opening.widthM, thickness + 0.02, height + 0.01],
          }),
        ),
      ) as JscadGeom3;
    })
    .filter((cutter): cutter is JscadGeom3 => Boolean(cutter));
  if (openingCutters.length) {
    solid = jscadBooleans.subtract(solid, ...openingCutters) as JscadGeom3;
  }
  return solid;
}

function buildOuterWallRing(plan: MetricPlan, thickness: number) {
  if (plan.outlineM.length < 3) return null;
  let solid = jscadExtrusions.extrudeLinear(
    { height: plan.settings.wallHeightM },
    createContinuousWallRing(
      plan.outlineM.map((point) => [point.x, point.y]),
      thickness,
    ),
  ) as JscadGeom3;
  const cutters = plan.openings
    .map((opening) => {
      const wall = plan.walls.find((candidate) => candidate.id === opening.wallId);
      if (!wall || wall.kind !== "outer") return null;
      const angle = Math.atan2(wall.b.y - wall.a.y, wall.b.x - wall.a.x);
      const bottom = Math.max(0, opening.bottomM);
      const height = Math.min(plan.settings.wallHeightM - bottom, opening.heightM);
      if (height <= 0.001) return null;
      return jscadTransforms.translate(
        [opening.centerM.x, opening.centerM.y, bottom + height / 2],
        jscadTransforms.rotateZ(
          angle,
          jscadPrimitives.cuboid({
            size: [opening.widthM, thickness + 0.02, height + 0.01],
          }),
        ),
      ) as JscadGeom3;
    })
    .filter((cutter): cutter is JscadGeom3 => Boolean(cutter));
  if (cutters.length) solid = jscadBooleans.subtract(solid, ...cutters) as JscadGeom3;
  return solid;
}

function solidToThreeMesh(solid: JscadGeom3, color: string) {
  const vertices: number[] = [];
  solid.polygons.forEach((polygon) => {
    if (polygon.vertices.length < 3) return;
    const first = polygon.vertices[0];
    for (let index = 1; index < polygon.vertices.length - 1; index += 1) {
      const triangle = [first, polygon.vertices[index + 1], polygon.vertices[index]];
      triangle.forEach((vertex) => vertices.push(vertex[0], vertex[2], vertex[1]));
    }
  });
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(vertices, 3));
  geometry.computeVertexNormals();
  const mesh = new THREE.Mesh(
    geometry,
    new THREE.MeshStandardMaterial({ color, roughness: 0.72, flatShading: true }),
  );
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

function buildWalls(plan: MetricPlan, showRealWallThickness: boolean) {
  const group = new THREE.Group();
  const thicknessFor = (kind: WallSegment["kind"]) =>
    showRealWallThickness
      ? kind === "outer"
        ? plan.settings.outerWallThicknessM
        : plan.settings.innerWallThicknessM
      : kind === "outer"
        ? 0.08
        : 0.05;
  const solidsFor = (kind: WallSegment["kind"]) =>
    plan.walls
      .filter((wall) => wall.kind === kind)
      .map((wall) => buildWallSolid(plan, wall, thicknessFor(kind)))
      .filter((solid): solid is JscadGeom3 => Boolean(solid));
  const outerRing = buildOuterWallRing(plan, thicknessFor("outer"));
  const outerSolids = outerRing ? [] : solidsFor("outer");
  const innerSolids = solidsFor("inner");
  if (!outerRing && !outerSolids.length && !innerSolids.length) return group;

  const outerJoined =
    outerRing ??
    (outerSolids.length > 1 ? jscadBooleans.union(...outerSolids) as JscadGeom3 : outerSolids[0]);
  let innerJoined =
    innerSolids.length > 1 ? jscadBooleans.union(...innerSolids) as JscadGeom3 : innerSolids[0];
  if (innerJoined && plan.outlineM.length >= 3) {
    const interiorPoints = counterClockwise(plan.outlineM.map((point) => [point.x, point.y]));
    const interior = jscadExtrusions.extrudeLinear(
      { height: plan.settings.wallHeightM },
      jscadPrimitives.polygon({
        points: interiorPoints,
      }),
    ) as JscadGeom3;
    innerJoined = jscadBooleans.intersect(innerJoined, interior) as JscadGeom3;
  }
  const joined =
    outerJoined && innerJoined
      ? jscadBooleans.union(outerJoined, innerJoined) as JscadGeom3
      : outerJoined ?? innerJoined;
  if (joined) group.add(solidToThreeMesh(joined, "#e2e8f0"));
  return group;
}

function furnitureMaterial(color: string) {
  return new THREE.MeshStandardMaterial({ color, roughness: 0.65 });
}

function tagObject(group: THREE.Object3D, id: string) {
  group.traverse((child) => {
    child.userData.objectId = id;
  });
}

function buildFurnitureModel(object: Furniture, selected: boolean) {
  const group = new THREE.Group();
  const w = Math.max(0.1, object.widthM);
  const d = Math.max(0.1, object.heightM);
  const h = Math.max(0.08, object.modelHeightM);
  const color = selected ? "#f59e0b" : object.color;
  const add = (mesh: THREE.Mesh) => group.add(mesh);

  if (object.type === "bed") {
    add(createBox(w, h * 0.35, d, color, 0, h * 0.175));
    add(createBox(w, h * 0.12, d * 0.9, "#f8fafc", 0, h * 0.43));
    add(createBox(w, h * 0.75, d * 0.08, color, 0, h * 0.375, -d * 0.46));
  } else if (object.type === "sofa") {
    add(createBox(w, h * 0.45, d, color, 0, h * 0.225));
    add(createBox(w, h * 0.55, d * 0.18, color, 0, h * 0.62, -d * 0.4));
    add(createBox(w * 0.12, h * 0.55, d, color, -w * 0.44, h * 0.36));
    add(createBox(w * 0.12, h * 0.55, d, color, w * 0.44, h * 0.36));
  } else if (object.type === "table" || object.type === "desk") {
    add(createBox(w, h * 0.1, d, color, 0, h * 0.95));
    const legMaterial = furnitureMaterial(color);
    [-1, 1].forEach((sx) => [-1, 1].forEach((sz) => {
      const leg = new THREE.Mesh(new THREE.BoxGeometry(w * 0.08, h * 0.9, d * 0.08), legMaterial);
      leg.position.set(sx * w * 0.4, h * 0.45, sz * d * 0.4);
      leg.castShadow = true;
      add(leg);
    }));
  } else if (object.type === "chair") {
    add(createBox(w, h * 0.12, d, color, 0, h * 0.5));
    add(createBox(w, h * 0.48, d * 0.12, color, 0, h * 0.76, -d * 0.44));
    [-1, 1].forEach((sx) => [-1, 1].forEach((sz) => add(createBox(w * 0.1, h * 0.5, d * 0.1, color, sx * w * 0.4, h * 0.25, sz * d * 0.4))));
  } else if (object.type === "shelf") {
    add(createBox(w, h, d * 0.18, color, 0, h / 2, -d * 0.4));
    for (let level = 0; level < 4; level += 1) add(createBox(w, h * 0.035, d, color, 0, (h * level) / 3));
  } else {
    add(createBox(w, h, d, color));
  }

  group.position.set(object.x, 0, object.y);
  group.rotation.y = (-object.rotation * Math.PI) / 180;
  tagObject(group, object.id);
  return group;
}

function buildOpenings(plan: MetricPlan) {
  const group = new THREE.Group();
  plan.openings.forEach((opening) => {
    const source = plan.furniture.find((item) => item.id === opening.objectId);
    if (!source) return;
    if (opening.type === "door") {
      const leaf = createBox(opening.widthM * 0.96, opening.heightM * 0.96, 0.045, source.color, 0, opening.heightM * 0.48);
      leaf.position.x = opening.centerM.x;
      leaf.position.z = opening.centerM.y;
      leaf.rotation.y = (-opening.rotation * Math.PI) / 180;
      tagObject(leaf, source.id);
      group.add(leaf);
    } else {
      const pane = createBox(opening.widthM * 0.92, opening.heightM * 0.9, 0.03, "#7dd3fc", 0, opening.bottomM + opening.heightM / 2, 0, 0.48);
      pane.position.x = opening.centerM.x;
      pane.position.z = opening.centerM.y;
      pane.rotation.y = (-opening.rotation * Math.PI) / 180;
      pane.castShadow = false;
      tagObject(pane, source.id);
      group.add(pane);
    }
  });
  return group;
}

function pointSegmentDistance(point: Point, wall: WallSegment) {
  const dx = wall.b.x - wall.a.x;
  const dy = wall.b.y - wall.a.y;
  const lengthSquared = dx * dx + dy * dy;
  const t = lengthSquared ? Math.max(0, Math.min(1, ((point.x - wall.a.x) * dx + (point.y - wall.a.y) * dy) / lengthSquared)) : 0;
  return { distance: Math.hypot(point.x - (wall.a.x + dx * t), point.y - (wall.a.y + dy * t)), t };
}

function canWalkTo(plan: MetricPlan, point: Point) {
  return !plan.walls.some((wall) => {
    const hit = pointSegmentDistance(point, wall);
    const thickness = wall.kind === "outer" ? plan.settings.outerWallThicknessM : plan.settings.innerWallThicknessM;
    if (hit.distance > thickness / 2 + 0.18) return false;
    const length = wallLength(wall);
    const along = hit.t * length;
    const hasDoor = plan.openings.some((opening) => {
      if (opening.wallId !== wall.id || opening.type !== "door") return false;
      const ux = (wall.b.x - wall.a.x) / Math.max(length, 0.001);
      const uz = (wall.b.y - wall.a.y) / Math.max(length, 0.001);
      const center = (opening.centerM.x - wall.a.x) * ux + (opening.centerM.y - wall.a.y) * uz;
      return Math.abs(along - center) < opening.widthM / 2 - 0.08;
    });
    return !hasDoor;
  });
}

function formatTime(hours: number) {
  const totalMinutes = Math.round(hours * 60);
  const hour = Math.floor(totalMinutes / 60) % 24;
  const minute = totalMinutes % 60;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function disposeGroup(group: THREE.Group) {
  group.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return;
    child.geometry.dispose();
    const materials = Array.isArray(child.material) ? child.material : [child.material];
    materials.forEach((material) => material.dispose());
  });
  group.clear();
}

function createSunRay(start: THREE.Vector3, end: THREE.Vector3) {
  const direction = end.clone().sub(start);
  const length = direction.length();
  const material = new THREE.MeshBasicMaterial({
    color: "#fde68a",
    transparent: true,
    opacity: 0.34,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const ray = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.035, length, 8, 1, true), material);
  ray.position.copy(start).add(end).multiplyScalar(0.5);
  ray.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction.normalize());
  ray.renderOrder = 3;
  return ray;
}

export default function ThreeDView({ plan, showRealWallThickness, northAngleDeg, selectedObjectId, onSelectObject }: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const planRef = useRef(plan);
  const selectRef = useRef(onSelectObject);
  const movementRef = useRef(new Set<string>());
  const modeRef = useRef<"orbit" | "walk">("orbit");
  const [mode, setMode] = useState<"orbit" | "walk">("orbit");
  const [error, setError] = useState("");
  const [sunEnabled, setSunEnabled] = useState(false);
  const [sunTime, setSunTime] = useState(12);
  const [sunPlaying, setSunPlaying] = useState(false);
  const [showSunRays, setShowSunRays] = useState(false);
  const runtimeRef = useRef<{
    scene: THREE.Scene;
    camera: THREE.PerspectiveCamera;
    orbit: OrbitControls;
    pointer: PointerLockControls;
    content: THREE.Group;
    hemisphere: THREE.HemisphereLight;
    sunlight: THREE.DirectionalLight;
    sunVisual: THREE.Group;
    sunRays: THREE.Group;
  } | null>(null);

  planRef.current = plan;
  selectRef.current = onSelectObject;
  modeRef.current = mode;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true });
    } catch {
      setError("3D view needs WebGL. The 2D planner is still available.");
      return;
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    host.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    scene.background = new THREE.Color("#dbeafe");
    scene.fog = new THREE.Fog("#dbeafe", 35, 90);
    const camera = new THREE.PerspectiveCamera(55, 1, 0.05, 200);
    const centerX = plan.boundsM.width / 2;
    const centerZ = plan.boundsM.depth / 2;
    const size = Math.max(plan.boundsM.width, plan.boundsM.depth, 4);
    camera.position.set(centerX + size * 0.85, size * 0.75, centerZ + size * 0.85);

    const orbit = new OrbitControls(camera, renderer.domElement);
    orbit.target.set(centerX, 0.7, centerZ);
    orbit.enableDamping = true;
    orbit.maxPolarAngle = Math.PI / 2 - 0.02;
    orbit.minDistance = 0.5;
    orbit.maxDistance = Math.max(20, size * 5);
    orbit.update();
    const pointer = new PointerLockControls(camera, renderer.domElement);

    const hemisphere = new THREE.HemisphereLight("#ffffff", "#64748b", 1.55);
    scene.add(hemisphere);
    const sunlight = new THREE.DirectionalLight("#fff7ed", 2.1);
    sunlight.position.set(-8, 14, 7);
    sunlight.castShadow = true;
    sunlight.shadow.mapSize.set(2048, 2048);
    const shadowExtent = Math.max(12, size * 1.5);
    sunlight.shadow.camera.left = -shadowExtent;
    sunlight.shadow.camera.right = shadowExtent;
    sunlight.shadow.camera.top = shadowExtent;
    sunlight.shadow.camera.bottom = -shadowExtent;
    sunlight.shadow.camera.near = 0.1;
    sunlight.shadow.camera.far = Math.max(60, size * 8);
    sunlight.target.position.set(centerX, 0, centerZ);
    scene.add(sunlight);
    scene.add(sunlight.target);
    const sunVisual = new THREE.Group();
    const sunCore = new THREE.Mesh(
      new THREE.SphereGeometry(Math.max(0.32, size * 0.055), 24, 16),
      new THREE.MeshBasicMaterial({ color: "#fbbf24" }),
    );
    const sunGlow = new THREE.Mesh(
      new THREE.SphereGeometry(Math.max(0.52, size * 0.085), 24, 16),
      new THREE.MeshBasicMaterial({
        color: "#fde68a",
        transparent: true,
        opacity: 0.22,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    );
    sunVisual.add(sunCore, sunGlow);
    sunVisual.visible = false;
    scene.add(sunVisual);
    const sunRays = new THREE.Group();
    sunRays.visible = false;
    scene.add(sunRays);
    const ground = createBox(Math.max(40, size * 4), 0.04, Math.max(40, size * 4), "#cbd5e1", centerX, -0.04, centerZ);
    scene.add(ground);
    const grid = new THREE.GridHelper(Math.max(40, size * 4), 80, "#94a3b8", "#cbd5e1");
    grid.position.set(centerX, 0, centerZ);
    scene.add(grid);
    const content = new THREE.Group();
    scene.add(content);
    runtimeRef.current = { scene, camera, orbit, pointer, content, hemisphere, sunlight, sunVisual, sunRays };

    const raycaster = new THREE.Raycaster();
    const pointerPosition = new THREE.Vector2();
    const selectAt = (event: MouseEvent) => {
      if (modeRef.current === "walk") {
        if (!pointer.isLocked) pointer.lock();
        return;
      }
      const rect = renderer.domElement.getBoundingClientRect();
      pointerPosition.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
      raycaster.setFromCamera(pointerPosition, camera);
      const match = raycaster.intersectObjects(content.children, true).find((hit) => hit.object.userData.objectId);
      if (match) selectRef.current(String(match.object.userData.objectId));
    };
    renderer.domElement.addEventListener("dblclick", selectAt);

    const onKeyDown = (event: KeyboardEvent) => movementRef.current.add(event.key.toLowerCase());
    const onKeyUp = (event: KeyboardEvent) => movementRef.current.delete(event.key.toLowerCase());
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);

    let previous = performance.now();
    let animationId = 0;
    const animate = (now: number) => {
      const delta = Math.min(0.05, (now - previous) / 1000);
      previous = now;
      if (modeRef.current === "orbit") {
        orbit.update();
      } else {
        const keys = movementRef.current;
        const speed = 2.4 * delta;
        const direction = new THREE.Vector3();
        camera.getWorldDirection(direction);
        direction.y = 0;
        direction.normalize();
        const right = new THREE.Vector3(-direction.z, 0, direction.x);
        const movement = new THREE.Vector3();
        if (keys.has("w") || keys.has("arrowup") || keys.has("forward")) movement.add(direction);
        if (keys.has("s") || keys.has("arrowdown") || keys.has("back")) movement.sub(direction);
        if (keys.has("a")) movement.sub(right);
        if (keys.has("d")) movement.add(right);
        if (keys.has("left")) camera.rotation.y += 1.7 * delta;
        if (keys.has("right")) camera.rotation.y -= 1.7 * delta;
        if (movement.lengthSq()) {
          movement.normalize().multiplyScalar(speed);
          const candidate = camera.position.clone().add(movement);
          if (canWalkTo(planRef.current, { x: candidate.x, y: candidate.z })) camera.position.copy(candidate);
        }
        camera.position.y = 1.65;
      }
      renderer.render(scene, camera);
      animationId = requestAnimationFrame(animate);
    };
    animationId = requestAnimationFrame(animate);

    const resize = () => {
      const rect = host.getBoundingClientRect();
      renderer.setSize(Math.max(1, rect.width), Math.max(1, rect.height), false);
      camera.aspect = Math.max(1, rect.width) / Math.max(1, rect.height);
      camera.updateProjectionMatrix();
    };
    const observer = new ResizeObserver(resize);
    observer.observe(host);
    resize();

    return () => {
      cancelAnimationFrame(animationId);
      observer.disconnect();
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      renderer.domElement.removeEventListener("dblclick", selectAt);
      pointer.disconnect();
      orbit.dispose();
      renderer.dispose();
      renderer.domElement.remove();
      runtimeRef.current = null;
    };
  }, []);

  useEffect(() => {
    const runtime = runtimeRef.current;
    if (!runtime) return;
    const centerX = (plan.boundsM.minX + plan.boundsM.maxX) / 2;
    const centerZ = (plan.boundsM.minY + plan.boundsM.maxY) / 2;
    const size = Math.max(plan.boundsM.width, plan.boundsM.depth, 4);

    runtime.sunlight.target.position.set(centerX, 0, centerZ);
    if (!sunEnabled) {
      runtime.sunlight.visible = true;
      runtime.sunlight.color.set("#fff7ed");
      runtime.sunlight.intensity = 2.1;
      runtime.sunlight.position.set(centerX - size * 1.2, size * 2, centerZ + size);
      runtime.sunVisual.visible = false;
      runtime.hemisphere.intensity = 1.55;
      runtime.scene.background = new THREE.Color("#dbeafe");
      runtime.scene.fog = new THREE.Fog("#dbeafe", 35, 90);
      return;
    }

    const dayProgress = (sunTime - 6) / 12;
    const elevationFactor = Math.max(0, Math.sin(dayProgress * Math.PI));
    const elevation = elevationFactor * (Math.PI / 3);
    const solarBearing = 90 + dayProgress * 180;
    const planBearing = ((northAngleDeg + solarBearing) * Math.PI) / 180;
    const distance = Math.max(24, size * 5);
    const horizontalDistance = Math.cos(elevation) * distance;

    runtime.sunlight.position.set(
      centerX + Math.sin(planBearing) * horizontalDistance,
      Math.max(0.05, Math.sin(elevation) * distance),
      centerZ - Math.cos(planBearing) * horizontalDistance,
    );
    runtime.sunlight.visible = elevationFactor > 0.001;
    runtime.sunVisual.visible = elevationFactor > 0.001;
    const sunDisplayDistance = Math.max(4, size * 1.15);
    runtime.sunVisual.position
      .copy(runtime.sunlight.position)
      .sub(runtime.sunlight.target.position)
      .normalize()
      .multiplyScalar(sunDisplayDistance)
      .add(runtime.sunlight.target.position);
    runtime.sunlight.color.set(elevationFactor < 0.25 ? "#fb923c" : "#fff7ed");
    runtime.sunlight.intensity = 0.3 + elevationFactor * 3.2;
    runtime.hemisphere.intensity = 0.18 + elevationFactor * 0.72;
    const skyColor = elevationFactor > 0.08 ? "#bfdbfe" : "#172554";
    runtime.scene.background = new THREE.Color(skyColor);
    runtime.scene.fog = new THREE.Fog(skyColor, 35, 90);
  }, [northAngleDeg, plan.boundsM, sunEnabled, sunTime]);

  useEffect(() => {
    const runtime = runtimeRef.current;
    if (!runtime) return;
    disposeGroup(runtime.sunRays);
    runtime.sunRays.visible = sunEnabled && showSunRays && runtime.sunlight.visible;
    if (!runtime.sunRays.visible) return;

    const target = runtime.sunlight.target.position;
    const travelDirection = target.clone().sub(runtime.sunlight.position).normalize();
    const rayLength = Math.max(6, Math.max(plan.boundsM.width, plan.boundsM.depth) * 1.8);
    plan.openings
      .filter((opening) => opening.type === "window")
      .forEach((opening) => {
        const wallAngle = (opening.rotation * Math.PI) / 180;
        const tangent = new THREE.Vector3(Math.cos(wallAngle), 0, Math.sin(wallAngle));
        const samples = [
          { across: -0.28, height: 0.28 },
          { across: 0, height: 0.5 },
          { across: 0.28, height: 0.72 },
        ];
        samples.forEach((sample) => {
          const start = new THREE.Vector3(
            opening.centerM.x,
            opening.bottomM + opening.heightM * sample.height,
            opening.centerM.y,
          )
            .addScaledVector(tangent, opening.widthM * sample.across)
            .addScaledVector(travelDirection, 0.04);
          const end = start.clone().addScaledVector(travelDirection, rayLength);
          runtime.sunRays.add(createSunRay(start, end));
        });
      });
  }, [northAngleDeg, plan.boundsM, plan.openings, showSunRays, sunEnabled, sunTime]);

  useEffect(() => {
    if (!sunPlaying) return;
    if (sunTime >= 21) setSunTime(5);
    const interval = window.setInterval(() => {
      setSunTime((current) => {
        const next = current + 0.08;
        if (next >= 21) {
          window.setTimeout(() => setSunPlaying(false), 0);
          return 21;
        }
        return next;
      });
    }, 50);
    return () => window.clearInterval(interval);
  }, [sunPlaying]);

  useEffect(() => {
    const runtime = runtimeRef.current;
    if (!runtime) return;
    runtime.content.traverse((child) => {
      if (child instanceof THREE.Mesh) {
        child.geometry.dispose();
        const materials = Array.isArray(child.material) ? child.material : [child.material];
        materials.forEach((material) => material.dispose());
      }
    });
    runtime.content.clear();

    if (plan.outlineM.length >= 3) {
      const shape = new THREE.Shape();
      shape.moveTo(plan.outlineM[0].x, plan.outlineM[0].y);
      plan.outlineM.slice(1).forEach((point) => shape.lineTo(point.x, point.y));
      shape.closePath();
      const floor = new THREE.Mesh(new THREE.ShapeGeometry(shape), new THREE.MeshStandardMaterial({ color: "#f8fafc", roughness: 0.9 }));
      floor.rotation.x = Math.PI / 2;
      floor.receiveShadow = true;
      runtime.content.add(floor);
    }
    runtime.content.add(buildWalls(plan, showRealWallThickness));
    runtime.content.add(buildOpenings(plan));
    plan.furniture
      .filter((object) => object.type !== "door" && object.type !== "window")
      .forEach((object) => runtime.content.add(buildFurnitureModel(object, object.id === selectedObjectId)));
  }, [plan, selectedObjectId, showRealWallThickness]);

  const setCameraPreset = (preset: "top" | "iso" | "reset") => {
    const runtime = runtimeRef.current;
    if (!runtime) return;
    const centerX = plan.boundsM.width / 2;
    const centerZ = plan.boundsM.depth / 2;
    const size = Math.max(plan.boundsM.width, plan.boundsM.depth, 4);
    setMode("orbit");
    runtime.pointer.unlock();
    runtime.orbit.enabled = true;
    runtime.orbit.target.set(centerX, 0.5, centerZ);
    if (preset === "top") runtime.camera.position.set(centerX, size * 1.8, centerZ + 0.001);
    else runtime.camera.position.set(centerX + size, size * 0.9, centerZ + size);
    runtime.camera.lookAt(centerX, 0.5, centerZ);
    runtime.orbit.update();
  };

  const toggleWalk = () => {
    const runtime = runtimeRef.current;
    if (!runtime) return;
    if (mode === "walk") {
      setMode("orbit");
      runtime.pointer.unlock();
      runtime.orbit.enabled = true;
      setCameraPreset("reset");
    } else {
      setMode("walk");
      runtime.orbit.enabled = false;
      runtime.camera.position.set(plan.boundsM.width / 2, 1.65, plan.boundsM.depth / 2);
      runtime.camera.rotation.set(0, 0, 0);
    }
  };

  const press = (key: string, active: boolean) => {
    if (active) movementRef.current.add(key);
    else movementRef.current.delete(key);
  };

  const sunDayProgress = Math.min(1, Math.max(0, (sunTime - 6) / 12));
  const sunElevationFactor = Math.max(0, Math.sin(sunDayProgress * Math.PI));
  const sunAboveHorizon = sunTime >= 6 && sunTime <= 18;

  return (
    <div className="three-view" ref={hostRef}>
      {error && <div className="three-error">{error}</div>}
      {sunEnabled && sunAboveHorizon && (
        <div
          className="sun-orb"
          aria-label={`Sun position at ${formatTime(sunTime)}`}
          style={{
            left: `${15 + sunDayProgress * 70}%`,
            top: `${10 + (1 - sunElevationFactor) * 35}%`,
          }}
        />
      )}
      <div className="three-toolbar">
        <span className="three-thickness-status">
          {showRealWallThickness ? "Real wall thickness" : "Schematic walls"}
        </span>
        <button onClick={() => setCameraPreset("top")}>Top</button>
        <button onClick={() => setCameraPreset("iso")}>Isometric</button>
        <button onClick={() => setCameraPreset("reset")}>Reset</button>
        <button className={mode === "walk" ? "active" : ""} onClick={toggleWalk}>{mode === "walk" ? "Exit walk" : "Walkthrough"}</button>
        <button
          className={sunEnabled ? "active" : ""}
          onClick={() => {
            setSunEnabled((enabled) => !enabled);
            if (sunEnabled) setSunPlaying(false);
          }}
        >
          Sun
        </button>
        <button
          className={showSunRays ? "active" : ""}
          disabled={!sunEnabled}
          onClick={() => setShowSunRays((visible) => !visible)}
          title={sunEnabled ? "Show or hide rays entering through windows" : "Enable the sun first"}
        >
          Sun rays
        </button>
      </div>
      {sunEnabled && (
        <div className="sun-controls" aria-label="Sun simulation controls">
          <div className="sun-controls-header">
            <strong>Sun study</strong>
            <span>{formatTime(sunTime)}</span>
          </div>
          <input
            type="range"
            min="5"
            max="21"
            step="0.05"
            value={sunTime}
            aria-label="Time of day"
            onChange={(event) => {
              setSunPlaying(false);
              setSunTime(Number(event.target.value));
            }}
          />
          <div className="sun-controls-footer">
            <span>05:00</span>
            <button onClick={() => setSunPlaying((playing) => !playing)}>{sunPlaying ? "Pause" : "Play day"}</button>
            <span>21:00</span>
          </div>
          <small>Idealized east-to-west path · north {Math.round(((northAngleDeg % 360) + 360) % 360)}°</small>
          {showSunRays && plan.openings.every((opening) => opening.type !== "window") && (
            <small className="sun-rays-empty">Add a window to see rays entering the room.</small>
          )}
        </div>
      )}
      {mode === "walk" && (
        <>
          <div className="walk-hint">Click the view for mouse look · WASD to move · Esc releases the mouse</div>
          <div className="walk-touch" aria-label="Walkthrough touch controls">
            {[
              ["↶", "left"],
              ["↑", "forward"],
              ["↷", "right"],
              ["↓", "back"],
            ].map(([label, key]) => (
              <button
                key={key}
                onPointerDown={(event) => { event.preventDefault(); press(key, true); }}
                onPointerUp={() => press(key, false)}
                onPointerCancel={() => press(key, false)}
                onPointerLeave={() => press(key, false)}
              >
                {label}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
