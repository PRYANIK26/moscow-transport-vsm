import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import type { TrainClass } from "@vsm/shared";
import { disposeTree, projectSurfaceUV, surfaceTexture } from "./Surfaces";

export interface CabinSeat { x: number; z: number; yaw: number; name: string }

export function finishCabin(model: THREE.Group, kind: TrainClass, seats: CabinSeat[], anisotropy: number) {
  const root = new THREE.Group();
  root.name = "Detailed train interior";
  const fabric = surfaceTexture("fabric", anisotropy);
  const leather = surfaceTexture("leather", anisotropy);
  const carpet = surfaceTexture("carpet", anisotropy);
  const wood = surfaceTexture("wood", anisotropy);
  const upholstery = { comfort: 0xb19a7c, business: 0x8e7b68, first: 0xc8b492, standard: 0xa2624e }[kind];
  const material = (color: number, roughness: number, metalness = 0, map?: THREE.Texture) =>
    new THREE.MeshStandardMaterial({ color, roughness, metalness, map: map ?? null, bumpMap: map ?? null, bumpScale: map ? 0.0014 : 0, envMapIntensity: 0.65 });
  const palette = {
    fabric: material(upholstery, 0.88, 0, kind === "first" || kind === "business" ? leather : fabric),
    floor: material(0x474b49, 0.98, 0, carpet),
    wall: material(0xe4ded3, 0.62),
    ceiling: material(0xeee7db, 0.82),
    duct: material(0xcac4b8, 0.55, 0.12),
    trim: material(0x9b8e7a, 0.36, 0.58),
    metal: material(0x9ba2a1, 0.31, 0.8),
    frame: material(0x303638, 0.58, 0.15),
    tray: material(0xb8aa94, 0.53, 0, wood),
    rack: material(0xd5cec0, 0.49, 0.25),
    wood: material(0x957650, 0.62, 0, wood),
    grille: material(0x666963, 0.7, 0.25),
    light: new THREE.MeshStandardMaterial({ color: 0xfff2db, emissive: 0xffdfb0, emissiveIntensity: 2.1, roughness: 0.35 }),
    glass: new THREE.MeshStandardMaterial({ color: 0xc9dbe0, metalness: 0.18, roughness: 0.14, transparent: true, opacity: 0.1, depthWrite: false, side: THREE.DoubleSide, envMapIntensity: 0.7 }),
  };
  const fallback = new Map<THREE.Material, THREE.Material>();
  const batches = new Map<THREE.Material, THREE.BufferGeometry[]>();
  model.updateMatrixWorld(true);
  model.traverseVisible((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    if (!(object.material instanceof THREE.MeshStandardMaterial)) throw new Error("Cabin material is not a single PBR material");
    const original = object.material;
    const name = original.name;
    let surface: THREE.Material;
    if (original.transparent || /остекление|Стеклянная/.test(name)) surface = palette.glass;
    else if (/Lights|Light$|ReadingLight/.test(object.name)) surface = palette.light;
    else if (/Потолочные|потолочные/.test(name)) surface = palette.ceiling;
    else if (/воздуховод/.test(name)) surface = palette.duct;
    else if (/Вентиляционные/.test(name)) surface = palette.grille;
    else if (/Пояс отделки/.test(name)) surface = palette.trim;
    else if (/Надоконные/.test(name)) surface = palette.rack;
    else if (/^Пол\d*$|Проход:|Покрытие|Нескользящий/.test(name)) surface = palette.floor;
    else if (/Борт |Перегородка|Стены /.test(name)) surface = palette.wall;
    else if (/Кресло/.test(name)) {
      object.geometry.computeBoundingBox();
      const height = object.geometry.boundingBox!.max.z;
      surface = height > 1000 ? palette.fabric : height < 500 ? palette.metal : palette.tray;
    } else if (/Межвагонный/.test(name)) surface = palette.frame;
    else if (/Направляющая|Урна|Зеркало/.test(name)) surface = palette.metal;
    else if (/Тумба|шкаф|шкафы|стол|Столешница/.test(name)) surface = palette.wood;
    else {
      if (!fallback.has(original)) {
        const copy = original.clone();
        copy.roughness = 0.65;
        copy.metalness = 0.05;
        fallback.set(original, copy);
      }
      surface = fallback.get(original)!;
    }
    const geometry = object.geometry.clone();
    if (!geometry.getAttribute("normal")) geometry.computeVertexNormals();
    projectSurfaceUV(geometry, surface === palette.wood || surface === palette.tray ? 0.006 : 0.012);
    geometry.applyMatrix4(object.matrixWorld);
    if (surface === palette.glass) {
      const mesh = new THREE.Mesh(geometry, surface);
      mesh.layers.set(1);
      root.add(mesh);
    } else {
      const list = batches.get(surface) ?? [];
      list.push(geometry);
      batches.set(surface, list);
    }
  });
  for (const [surface, geometries] of batches) {
    const merged = mergeGeometries(geometries, false);
    if (!merged) throw new Error("Cabin geometry attributes are incompatible");
    const mesh = new THREE.Mesh(merged, surface);
    mesh.castShadow = surface !== palette.light;
    mesh.receiveShadow = true;
    root.add(mesh);
    geometries.forEach((geometry) => geometry.dispose());
  }
  disposeTree(model);

  const cloth = material(0xe8e2d3, 0.96, 0, fabric);
  const coverGeometry = new RoundedBoxGeometry(kind === "first" ? 0.32 : 0.28, 0.16, 0.018, 2, 0.012);
  const covers = new THREE.InstancedMesh(coverGeometry, cloth, seats.length);
  const backGeometry = new RoundedBoxGeometry(kind === "first" ? 0.41 : 0.36, 0.42, 0.06, 3, 0.025);
  projectSurfaceUV(backGeometry, 12);
  const backs = new THREE.InstancedMesh(backGeometry, palette.fabric, seats.length);
  const pockets = new THREE.InstancedMesh(new RoundedBoxGeometry(0.28, 0.10, 0.018, 2, 0.008), palette.frame, seats.length);
  const leaflets = new THREE.InstancedMesh(new THREE.BoxGeometry(0.18, 0.12, 0.003), material(0xe5dfcd, 0.94), seats.length);
  const transform = new THREE.Object3D();
  for (const [i, seat] of seats.entries()) {
    transform.position.set(seat.x, 1.13, seat.z);
    transform.rotation.set(0, seat.yaw, 0);
    transform.translateZ(-0.372);
    transform.updateMatrix();
    covers.setMatrixAt(i, transform.matrix);
    transform.position.set(seat.x, 0.82, seat.z);
    transform.translateZ(-0.207);
    transform.rotation.x = -0.08;
    transform.updateMatrix();
    backs.setMatrixAt(i, transform.matrix);
    transform.rotation.set(0, seat.yaw, 0);
    transform.position.set(seat.x, 0.7, seat.z);
    transform.translateZ(-0.387);
    transform.updateMatrix();
    pockets.setMatrixAt(i, transform.matrix);
    transform.position.set(seat.x, 0.756, seat.z);
    transform.translateZ(-0.375);
    transform.updateMatrix();
    leaflets.setMatrixAt(i, transform.matrix);
  }
  covers.castShadow = backs.castShadow = true;
  covers.receiveShadow = backs.receiveShadow = true;
  pockets.castShadow = pockets.receiveShadow = true;
  leaflets.receiveShadow = true;
  root.add(covers, backs, pockets, leaflets);
  const usedTextures = new Set<THREE.Texture>();
  root.traverse((object) => {
    if (object instanceof THREE.Mesh && object.material instanceof THREE.MeshStandardMaterial && object.material.map) usedTextures.add(object.material.map);
  });
  for (const texture of [fabric, leather, carpet, wood]) if (!usedTextures.has(texture)) texture.dispose();
  return root;
}
