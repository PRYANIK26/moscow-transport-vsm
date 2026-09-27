import * as THREE from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";

function part(parent: THREE.Object3D, geometry: THREE.BufferGeometry, material: THREE.Material, x: number, y: number, z: number) {
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.set(x, y, z);
  mesh.castShadow = mesh.receiveShadow = true;
  parent.add(mesh);
  return mesh;
}

export function createSuitcase(unattended: boolean) {
  const root = new THREE.Group();
  const shell = new THREE.MeshStandardMaterial({ color: unattended ? 0x535e66 : 0x986e49, metalness: 0.2, roughness: 0.44 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x292e30, roughness: 0.72 });
  const alloy = new THREE.MeshStandardMaterial({ color: 0x8b9699, metalness: 0.85, roughness: 0.3 });
  part(root, new RoundedBoxGeometry(0.34, 0.51, 0.235, 3, 0.035), shell, 0, 0.32, 0);
  for (const x of [-0.1, -0.05, 0, 0.05, 0.1]) {
    part(root, new RoundedBoxGeometry(0.015, 0.36, 0.012, 2, 0.005), shell, x, 0.32, 0.117);
  }
  for (const side of [-1, 1]) {
    const wheel = part(root, new THREE.CylinderGeometry(0.032, 0.032, 0.027, 14), dark, side * 0.13, 0.045, 0.055);
    wheel.rotation.z = Math.PI / 2;
    part(root, new THREE.CylinderGeometry(0.009, 0.009, 0.20, 8), alloy, side * 0.065, 0.65, -0.055);
  }
  part(root, new RoundedBoxGeometry(0.16, 0.03, 0.035, 2, 0.012), dark, 0, 0.751, -0.055);
  part(root, new RoundedBoxGeometry(0.11, 0.028, 0.035, 2, 0.01), dark, 0, 0.581, 0.018);
  part(root, new THREE.BoxGeometry(0.04, 0.06, 0.004), new THREE.MeshStandardMaterial({ color: 0xd6c7a9, roughness: 0.9 }), 0.09, 0.53, 0.12);
  return root;
}

export function createCat() {
  const root = new THREE.Group();
  const fur = new THREE.MeshStandardMaterial({ color: 0xa39480, roughness: 1 });
  const cream = new THREE.MeshStandardMaterial({ color: 0xd5caba, roughness: 1 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x343b34, roughness: 0.48 });
  const pink = new THREE.MeshStandardMaterial({ color: 0x9c736a, roughness: 0.76 });
  const body = part(root, new THREE.SphereGeometry(1, 18, 14), fur, 0, 0.22, -0.04);
  body.scale.set(0.115, 0.175, 0.155);
  part(root, new THREE.SphereGeometry(0.094, 20, 16), fur, 0, 0.414, 0.038);
  for (const side of [-1, 1]) {
    const ear = part(root, new THREE.ConeGeometry(0.044, 0.09, 3), fur, side * 0.064, 0.504, 0.027);
    ear.rotation.z = -side * 0.22;
    ear.rotation.y = Math.PI;
    const inside = part(root, new THREE.ConeGeometry(0.022, 0.049, 3), pink, side * 0.064, 0.51, 0.047);
    inside.rotation.y = Math.PI;
    const eye = part(root, new THREE.SphereGeometry(0.015, 12, 8), new THREE.MeshStandardMaterial({ color: 0x999c64, roughness: 0.36 }), side * 0.036, 0.424, 0.117);
    eye.scale.y = 0.7;
    const pupil = part(root, new THREE.SphereGeometry(0.006, 10, 8), dark, side * 0.036, 0.424, 0.131);
    pupil.scale.x = 0.4;
    const muzzle = part(root, new THREE.SphereGeometry(0.027, 14, 10), cream, side * 0.021, 0.387, 0.117);
    muzzle.scale.y = 0.7;
    part(root, new THREE.CapsuleGeometry(0.032, 0.14, 4, 10), fur, side * 0.055, 0.145, 0.084);
    const paw = part(root, new THREE.SphereGeometry(0.038, 12, 8), cream, side * 0.055, 0.033, 0.108);
    paw.scale.y = 0.65;
  }
  part(root, new THREE.SphereGeometry(0.011, 8, 6), pink, 0, 0.397, 0.14);
  const tail = new THREE.CatmullRomCurve3([
    new THREE.Vector3(0, 0.15, -0.17), new THREE.Vector3(0.13, 0.06, -0.25),
    new THREE.Vector3(0.20, 0.04, -0.09), new THREE.Vector3(0.16, 0.05, 0.09),
  ]);
  part(root, new THREE.TubeGeometry(tail, 18, 0.026, 8, false), fur, 0, 0, 0);
  return root;
}
