import { useEffect, useRef } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { buildFurnitureParts, chairConnectorLayout } from "./furnitureGeometry";
import type { Furniture, FurnitureAssemblyMode, FurniturePrintStyle } from "./plannerTypes";

export default function FurnitureStylePreview({
  object,
  style,
  assemblyMode,
}: {
  object: Furniture;
  style: FurniturePrintStyle;
  assemblyMode: FurnitureAssemblyMode;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    renderer.shadowMap.enabled = true;
    host.appendChild(renderer.domElement);
    const scene = new THREE.Scene();
    scene.background = new THREE.Color("#eef2f7");
    const camera = new THREE.PerspectiveCamera(38, 1, 0.01, 100);
    const model = new THREE.Group();
    const bodyGroup = new THREE.Group();
    const backGroup = new THREE.Group();
    model.add(bodyGroup, backGroup);
    scene.add(model);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enablePan = false;
    controls.autoRotate = false;
    controls.enableDamping = true;
    scene.add(new THREE.HemisphereLight("#ffffff", "#64748b", 2));
    const light = new THREE.DirectionalLight("#ffffff", 2.4);
    light.position.set(4, 7, 5);
    scene.add(light);
    const tones = { primary: object.color, light: "#f8fafc", dark: "#334155", accent: "#64748b" };
    buildFurnitureParts(object.type, object.widthM, object.heightM, object.modelHeightM, style).forEach((part) => {
      const mesh = new THREE.Mesh(
        // Printable geometry uses X/Y/Z as width/depth/height. Three.js box
        // arguments are width/height/depth, so Y and Z must be swapped here.
        new THREE.BoxGeometry(part.size[0], part.size[2], part.size[1]),
        new THREE.MeshStandardMaterial({ color: tones[part.tone], roughness: 0.68 }),
      );
      mesh.position.set(part.center[0], part.center[2], part.center[1]);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      (part.assemblyPart === "back" ? backGroup : bodyGroup).add(mesh);
    });
    if (object.type === "chair" && assemblyMode === "friction-fit") {
      const connector = chairConnectorLayout(
        object.widthM,
        object.heightM,
        object.modelHeightM,
        style,
      );
      const pinRadius = Math.max(0.012, object.widthM * 0.035);
      const pinLength = Math.max(0.025, object.modelHeightM * 0.06);
      connector.xPositions.forEach((x) => {
        const pin = new THREE.Mesh(
          new THREE.CylinderGeometry(pinRadius, pinRadius * 0.88, pinLength, 16),
          new THREE.MeshStandardMaterial({ color: "#2563eb", roughness: 0.55 }),
        );
        pin.position.set(x, connector.seatTopZ - pinLength / 2, connector.y);
        pin.castShadow = true;
        backGroup.add(pin);
        const socket = new THREE.Mesh(
          new THREE.CylinderGeometry(pinRadius * 1.14, pinRadius * 1.14, 0.01, 20),
          new THREE.MeshStandardMaterial({ color: "#0f172a", roughness: 0.8 }),
        );
        socket.position.set(x, connector.seatTopZ + 0.006, connector.y);
        bodyGroup.add(socket);
      });
      backGroup.position.set(0, object.modelHeightM * 0.16, -object.heightM * 0.2);
    }
    const bounds = new THREE.Box3().setFromObject(model);
    const center = bounds.getCenter(new THREE.Vector3());
    const dimensions = bounds.getSize(new THREE.Vector3());
    const size = Math.max(dimensions.x, dimensions.y, dimensions.z, 0.5);
    controls.target.copy(center);
    camera.position.set(center.x + size * 1.35, center.y + size * 0.9, center.z + size * 1.45);
    camera.near = Math.max(0.001, size / 100);
    camera.far = size * 20;
    camera.updateProjectionMatrix();
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(size * 3, size * 3),
      new THREE.MeshStandardMaterial({ color: "#dbe4ee", roughness: 1 }),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    scene.add(ground);
    let animation = 0;
    const draw = () => {
      controls.update();
      renderer.render(scene, camera);
      animation = requestAnimationFrame(draw);
    };
    const resize = () => {
      const rect = host.getBoundingClientRect();
      renderer.setSize(Math.max(1, rect.width), Math.max(1, rect.height), false);
      camera.aspect = Math.max(1, rect.width) / Math.max(1, rect.height);
      camera.updateProjectionMatrix();
    };
    const observer = new ResizeObserver(resize);
    observer.observe(host);
    resize();
    draw();
    return () => {
      cancelAnimationFrame(animation);
      observer.disconnect();
      controls.dispose();
      scene.traverse((child) => {
        if (!(child instanceof THREE.Mesh)) return;
        child.geometry.dispose();
        if (Array.isArray(child.material)) child.material.forEach((material) => material.dispose());
        else child.material.dispose();
      });
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, [assemblyMode, object, style]);

  return <div className="furniture-style-preview" ref={hostRef} aria-label={`${object.label} ${style} 3D preview`} />;
}
