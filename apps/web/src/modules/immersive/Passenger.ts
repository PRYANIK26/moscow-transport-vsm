import * as THREE from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { surfaceTexture } from "./Surfaces";

type Emotion = "calm" | "concerned" | "angry" | "irritated";
type Behavior = "stand" | "look_away" | "talk" | "raise_hand" | "idle";

function batchRigidParts(parent: THREE.Object3D) {
  const batches = new Map<THREE.Material, THREE.Mesh[]>();
  for (const child of parent.children) {
    if (!(child instanceof THREE.Mesh) || Array.isArray(child.material) || child.userData.animated) continue;
    const parts = batches.get(child.material) ?? [];
    parts.push(child);
    batches.set(child.material, parts);
  }
  for (const [material, parts] of batches) {
    if (parts.length < 2) continue;
    const geometries = parts.map((part) => {
      part.updateMatrix();
      const geometry = part.geometry.index ? part.geometry.toNonIndexed() : part.geometry.clone();
      return geometry.applyMatrix4(part.matrix);
    });
    const merged = mergeGeometries(geometries, false);
    if (!merged) throw new Error("Passenger geometry attributes are incompatible");
    const mesh = new THREE.Mesh(merged, material);
    mesh.castShadow = mesh.receiveShadow = true;
    parent.add(mesh);
    for (const part of parts) { parent.remove(part); part.geometry.dispose(); }
    geometries.forEach((geometry) => geometry.dispose());
  }
}

export class Passenger {
  readonly root = new THREE.Group();
  readonly torso = new THREE.Group();
  readonly head = new THREE.Group();
  readonly leftArm = new THREE.Group();
  readonly rightArm = new THREE.Group();
  readonly leftLeg = new THREE.Group();
  readonly rightLeg = new THREE.Group();
  readonly blanket: THREE.Mesh;
  readonly mouth: THREE.Mesh;
  private readonly eyes = new THREE.Group();
  private readonly brows: THREE.Mesh[] = [];
  private readonly elbows: THREE.Group[] = [];
  private readonly shins: THREE.Group[] = [];
  private readonly lookTarget = new THREE.Vector3();
  private seated = 1;

  constructor(color: number, private readonly variant = 0, private readonly attentive = false) {
    const skin = new THREE.MeshStandardMaterial({ color: [0xd4a182, 0xc49475, 0xe0b294, 0xb48667][variant % 4], roughness: 0.63 });
    const fabric = surfaceTexture("fabric");
    fabric.repeat.set(4, 4);
    const cloth = new THREE.MeshStandardMaterial({ color, roughness: 0.92, map: fabric, bumpMap: fabric, bumpScale: 0.0005 });
    const rib = new THREE.MeshStandardMaterial({ color: new THREE.Color(color).multiplyScalar(0.72), roughness: 0.93 });
    const inner = new THREE.MeshStandardMaterial({ color: 0xddd5c6, roughness: 0.9, map: fabric });
    const pants = new THREE.MeshStandardMaterial({ color: variant % 3 === 0 ? 0x384350 : 0x42413e, roughness: 0.92, map: fabric });
    const hair = new THREE.MeshStandardMaterial({ color: [0x32251f, 0x483329, 0x6a5745, 0x262626, 0x7b756b][variant % 5], roughness: 0.86 });
    const shoes = new THREE.MeshStandardMaterial({ color: variant % 2 ? 0x443830 : 0x353938, roughness: 0.52 });
    const sole = new THREE.MeshStandardMaterial({ color: 0x242827, roughness: 0.94 });
    const mesh = (geometry: THREE.BufferGeometry, material: THREE.Material, parent: THREE.Object3D, x = 0, y = 0, z = 0) => {
      const object = new THREE.Mesh(geometry, material);
      object.position.set(x, y, z);
      object.castShadow = object.receiveShadow = true;
      parent.add(object);
      return object;
    };
    const ellipsoid = (parent: THREE.Object3D, material: THREE.Material, position: number[], scale: number[], detail = 16) => {
      const object = mesh(new THREE.SphereGeometry(1, detail, 12), material, parent, position[0], position[1], position[2]);
      object.scale.set(scale[0], scale[1], scale[2]);
      return object;
    };
    this.root.add(this.torso, this.leftLeg, this.rightLeg);
    this.root.name = attentive ? "Active passenger" : `Traveller ${variant + 1}`;
    const torsoGeometry = new RoundedBoxGeometry(0.385, 0.48, 0.245, 4, 0.09);
    const torsoPoints = torsoGeometry.getAttribute("position");
    for (let i = 0; i < torsoPoints.count; i++) {
      const y = torsoPoints.getY(i);
      torsoPoints.setX(i, torsoPoints.getX(i) * (0.86 + (y + 0.24) * 0.28));
    }
    torsoGeometry.computeVertexNormals();
    mesh(torsoGeometry, cloth, this.torso, 0, 0.235);
    mesh(new THREE.CylinderGeometry(0.051, 0.063, 0.13, 16), skin, this.torso, 0, 0.49);
    const collar = mesh(new THREE.TorusGeometry(0.074, 0.016, 8, 24), rib, this.torso, 0, 0.467);
    collar.rotation.x = Math.PI / 2;
    if (variant % 3 !== 0) {
      mesh(new RoundedBoxGeometry(0.014, 0.42, 0.009, 2, 0.003), inner, this.torso, 0, 0.22, 0.123);
      for (const side of [-1, 1]) {
        const lapel = mesh(new RoundedBoxGeometry(0.07, 0.15, 0.02, 2, 0.009), rib, this.torso, side * 0.062, 0.397, 0.109);
        lapel.rotation.z = side * 0.34;
        mesh(new RoundedBoxGeometry(0.095, 0.006, 0.008, 2, 0.002), rib, this.torso, side * 0.105, 0.17, 0.125);
      }
    }
    const hem = mesh(new RoundedBoxGeometry(0.327, 0.035, 0.23, 3, 0.015), rib, this.torso, 0, 0.015);
    hem.scale.z = 0.94;
    this.torso.add(this.head);
    this.head.position.set(0, 0.665, 0.006);
    const faceGeometry = new THREE.SphereGeometry(1, 28, 20);
    const facePoints = faceGeometry.getAttribute("position");
    for (let i = 0; i < facePoints.count; i++) {
      const y = facePoints.getY(i);
      const jaw = 1 - Math.max(0, -y) * 0.2;
      facePoints.setXYZ(i, facePoints.getX(i) * 0.132 * jaw, y * 0.179, facePoints.getZ(i) * 0.117 - Math.max(0, -y) * 0.005);
    }
    faceGeometry.computeVertexNormals();
    mesh(faceGeometry, skin, this.head);
    const hairGeometry = new THREE.SphereGeometry(1, 24, 14, 0, Math.PI * 2, 0, Math.PI / 2);
    const hairPoints = hairGeometry.getAttribute("position");
    for (let i = 0; i < hairPoints.count; i++) {
      const x = hairPoints.getX(i), y = hairPoints.getY(i), z = hairPoints.getZ(i);
      const hairline = z > 0 ? 0.059 + Math.sin(x * 4 + variant) * 0.008 : -0.034;
      hairPoints.setXYZ(i, x * 0.137, y * 0.187 + (1 - y) * hairline, z * 0.122 - 0.004);
    }
    hairGeometry.computeVertexNormals();
    mesh(hairGeometry, hair, this.head);
    for (let i = 0; i < 5; i++) {
      const x = -0.08 + i * 0.04;
      const lock = ellipsoid(this.head, hair, [x, 0.154 - Math.abs(x) * 0.36, 0.03], [0.05, 0.031, 0.075]);
      lock.rotation.z = -0.22 + (variant % 3) * 0.2;
    }
    if (variant % 4 === 2) ellipsoid(this.head, hair, [0, -0.027, -0.107], [0.105, 0.139, 0.064]);
    for (const side of [-1, 1]) {
      ellipsoid(this.head, skin, [side * 0.13, -0.01, -0.004], [0.026, 0.039, 0.023]);
      ellipsoid(this.head, new THREE.MeshStandardMaterial({ color: skin.color.clone().multiplyScalar(0.83), roughness: 0.7 }), [side * 0.147, -0.009, 0.006], [0.007, 0.021, 0.01], 10);
    }
    const nose = ellipsoid(this.head, skin, [0, -0.005, 0.116], [0.015, 0.03, 0.023]);
    nose.rotation.x = -0.2;
    const eyeWhite = new THREE.MeshStandardMaterial({ color: 0xe6dfd0, roughness: 0.46 });
    const iris = new THREE.MeshStandardMaterial({ color: variant % 2 ? 0x5b665c : 0x685542, roughness: 0.38 });
    const pupil = new THREE.MeshStandardMaterial({ color: 0x18211f, roughness: 0.22 });
    this.head.add(this.eyes);
    this.eyes.position.set(0, 0.026, 0);
    for (const side of [-1, 1]) {
      ellipsoid(this.eyes, eyeWhite, [side * 0.05, 0, 0.109], [0.018, 0.008, 0.009]);
      ellipsoid(this.eyes, iris, [side * 0.05, 0, 0.117], [0.0057, 0.0065, 0.003], 12);
      ellipsoid(this.eyes, pupil, [side * 0.05, 0, 0.12], [0.0027, 0.004, 0.0015], 10);
      const brow = mesh(new RoundedBoxGeometry(0.047, 0.009, 0.01, 2, 0.004), hair, this.head, side * 0.05, 0.053, 0.107);
      brow.userData.animated = true;
      this.brows.push(brow);
    }
    if (variant % 5 === 3) {
      const rim = new THREE.MeshStandardMaterial({ color: 0x544b42, metalness: 0.55, roughness: 0.38 });
      for (const side of [-1, 1]) {
        const lens = mesh(new THREE.TorusGeometry(0.029, 0.003, 6, 20), rim, this.head, side * 0.05, 0.026, 0.128);
        lens.scale.y = 0.72;
      }
      mesh(new THREE.CylinderGeometry(0.0025, 0.0025, 0.043, 6), rim, this.head, 0, 0.031, 0.127).rotation.z = Math.PI / 2;
    }
    this.mouth = ellipsoid(this.head, new THREE.MeshStandardMaterial({ color: 0x865b4f, roughness: 0.72 }), [0, -0.072, 0.104], [0.032, 0.008, 0.009]);
    this.mouth.userData.animated = true;
    this.torso.add(this.leftArm, this.rightArm);
    for (const [arm, side] of [[this.leftArm, -1], [this.rightArm, 1]] as const) {
      arm.position.set(side * 0.205, 0.402, 0);
      mesh(new THREE.CapsuleGeometry(0.061, 0.14, 5, 12), cloth, arm, 0, -0.115);
      const elbow = new THREE.Group();
      elbow.position.y = -0.25;
      arm.add(elbow);
      this.elbows.push(elbow);
      mesh(new THREE.CapsuleGeometry(0.048, 0.147, 5, 12), cloth, elbow, 0, -0.087);
      mesh(new THREE.CylinderGeometry(0.044, 0.041, 0.027, 12), rib, elbow, 0, -0.192);
      mesh(new RoundedBoxGeometry(0.067, 0.079, 0.036, 3, 0.018), skin, elbow, 0, -0.243, 0.004);
      for (let finger = 0; finger < 4; finger++) {
        mesh(new THREE.CapsuleGeometry(0.007, 0.028 - Math.abs(finger - 1.5) * 0.004, 3, 6), skin, elbow, -0.024 + finger * 0.016, -0.29, 0.01);
      }
      const thumb = mesh(new THREE.CapsuleGeometry(0.009, 0.025, 3, 8), skin, elbow, -side * 0.035, -0.254, 0.02);
      thumb.rotation.z = side * 0.4;
      batchRigidParts(arm);
      batchRigidParts(elbow);
    }
    for (const [leg, side] of [[this.leftLeg, -1], [this.rightLeg, 1]] as const) {
      leg.position.x = side * 0.095;
      mesh(new THREE.CapsuleGeometry(0.082, 0.225, 5, 12), pants, leg, 0, -0.16);
      const shin = new THREE.Group();
      shin.position.y = -0.36;
      leg.add(shin);
      this.shins.push(shin);
      const calf = mesh(new THREE.CylinderGeometry(0.074, 0.052, 0.35, 12), pants, shin, 0, -0.16);
      calf.rotation.x = 0.02;
      mesh(new RoundedBoxGeometry(0.123, 0.1, 0.255, 3, 0.041), shoes, shin, 0, -0.365, 0.047);
      mesh(new RoundedBoxGeometry(0.127, 0.024, 0.261, 3, 0.01), sole, shin, 0, -0.41, 0.047);
      for (let lace = 0; lace < 3; lace++) mesh(new THREE.CylinderGeometry(0.002, 0.002, 0.061, 5), inner, shin, 0, -0.322, 0.052 + lace * 0.018).rotation.z = Math.PI / 2;
      batchRigidParts(shin);
    }
    const blanketGeometry = new THREE.PlaneGeometry(0.48, 0.6, 20, 24);
    const blanketPoints = blanketGeometry.getAttribute("position");
    for (let i = 0; i < blanketPoints.count; i++) {
      const x = blanketPoints.getX(i), v = (blanketPoints.getY(i) + 0.3) / 0.6;
      blanketPoints.setXYZ(i, x, Math.sin(x * 60) * 0.008 - Math.max(0, v - 0.63) * 0.55, v * 0.55 - 0.04);
    }
    blanketGeometry.computeVertexNormals();
    this.blanket = mesh(blanketGeometry, new THREE.MeshStandardMaterial({ color: 0x7c8e80, roughness: 1, map: fabric, side: THREE.DoubleSide }), this.root, 0, 0.64, 0.05);
    this.blanket.visible = false;
    batchRigidParts(this.torso);
    batchRigidParts(this.head);
    batchRigidParts(this.eyes);
  }

  update(time: number, dt: number, emotion: Emotion, behavior: Behavior, speaking: boolean, walking: boolean, camera: THREE.Vector3) {
    const standing = walking || behavior === "stand";
    this.seated = THREE.MathUtils.damp(this.seated, standing ? 0 : 1, 6, dt);
    const stride = Math.sin(time * 8.5);
    const hip = 0.82 - this.seated * 0.27;
    this.torso.position.y = hip + Math.sin(time * 1.8) * 0.003 + (walking ? Math.abs(stride) * 0.008 : 0);
    this.torso.rotation.z = walking ? stride * 0.018 : Math.sin(time * 0.9 + this.variant) * 0.006;
    this.torso.rotation.x = emotion === "concerned" ? 0.045 : 0;
    for (const [i, leg] of [this.leftLeg, this.rightLeg].entries()) {
      const sign = i ? 1 : -1;
      leg.position.y = hip;
      leg.rotation.x = -this.seated * 1.3 + (walking ? stride * 0.39 * sign : 0);
      this.shins[i].rotation.x = this.seated * 1.3 + (walking ? Math.max(0, -stride * sign) * 0.5 : 0);
    }
    this.lookTarget.copy(camera);
    this.root.worldToLocal(this.lookTarget);
    const distance = this.lookTarget.length();
    const look = Math.atan2(this.lookTarget.x, this.lookTarget.z);
    const engaged = this.attentive || (distance < 2.2 && Math.abs(look) < 1.2);
    const idleLook = Math.sin(time * 0.3 + this.variant * 3) * 0.14;
    this.head.rotation.y = THREE.MathUtils.damp(this.head.rotation.y, behavior === "look_away" ? 0.8 : engaged ? THREE.MathUtils.clamp(look, -1.05, 1.05) : idleLook, 4, dt);
    this.head.rotation.x = THREE.MathUtils.damp(this.head.rotation.x, speaking ? Math.sin(time * 4) * 0.032 : engaged ? -0.04 : 0.035, 4, dt);
    this.head.rotation.z = emotion === "concerned" ? 0.07 : Math.sin(time * 1.6) * 0.009;
    const blinkPhase = (time + this.variant * 0.71) % 4.3;
    this.eyes.scale.y = blinkPhase < 0.14 ? Math.max(0.08, Math.abs(blinkPhase - 0.07) / 0.07) : 1;
    this.brows.forEach((brow, i) => {
      const target = (i ? 1 : -1) * (emotion === "angry" || emotion === "irritated" ? 0.22 : emotion === "concerned" ? -0.22 : -0.04);
      brow.rotation.z = THREE.MathUtils.damp(brow.rotation.z, target, 6, dt);
    });
    this.mouth.scale.y = speaking ? 0.009 + Math.abs(Math.sin(time * 16)) * 0.011 : emotion === "concerned" ? 0.006 : 0.004;
    const gesture = speaking || behavior === "talk" || emotion === "angry";
    for (const [i, arm] of [this.leftArm, this.rightArm].entries()) {
      const side = i ? 1 : -1;
      const raised = i === 0 && behavior === "raise_hand";
      arm.rotation.x = THREE.MathUtils.damp(arm.rotation.x, raised ? -2.3 : walking ? stride * 0.33 * side : gesture ? -0.28 + Math.sin(time * 2.5 + i) * 0.15 : -0.15 * this.seated, 5, dt);
      arm.rotation.z = -side * (raised ? 0.15 : emotion === "angry" ? 0.28 : 0.08);
      this.elbows[i].rotation.x = THREE.MathUtils.damp(this.elbows[i].rotation.x, raised ? -0.4 : walking ? -0.15 : gesture ? -1.15 + Math.sin(time * 3 + i) * 0.15 : -1.1 * this.seated, 5, dt);
    }
    this.blanket.position.y = hip + 0.09;
  }
}
