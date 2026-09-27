import * as THREE from "three";

const period = 240;
export function wrapLandscape(z: number, travel: number) {
  return THREE.MathUtils.euclideanModulo(z - travel + period / 2, period) - period / 2;
}

export class Landscape {
  readonly root = new THREE.Group();
  private readonly trees: THREE.InstancedMesh;
  private readonly leaves: THREE.InstancedMesh;
  private readonly poles: THREE.InstancedMesh;
  private readonly treePositions: { x: number; z: number; scale: number; birch: boolean }[] = [];
  private readonly transform = new THREE.Object3D();
  private travel = 0;

  constructor() {
    this.root.name = "Passing landscape";
    const sky = new THREE.Mesh(new THREE.SphereGeometry(225, 24, 12), new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      uniforms: {
        horizon: { value: new THREE.Color(0xd5deda) },
        zenith: { value: new THREE.Color(0x82aac9) },
      },
      vertexShader: `varying vec3 direction;
        void main() { direction = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.); }`,
      fragmentShader: `uniform vec3 horizon; uniform vec3 zenith; varying vec3 direction;
        void main() {
          vec3 d = normalize(direction);
          vec3 color = mix(horizon, zenith, pow(max(0., d.y), .55));
          float cloud = sin(d.x * 16. + sin(d.z * 20.) * 1.5) * sin(d.z * 13. - d.x * 7.);
          cloud = smoothstep(.35, .85, cloud) * smoothstep(.04, .23, d.y) * (1. - smoothstep(.5, .85, d.y));
          color = mix(color, vec3(.91, .925, .92), cloud * .4);
          gl_FragColor = vec4(color, 1.);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
    }));
    sky.layers.set(1);
    this.root.add(sky);
    const terrain = new THREE.PlaneGeometry(480, 480, 80, 80);
    terrain.rotateX(-Math.PI / 2);
    const points = terrain.getAttribute("position");
    const colors = new Float32Array(points.count * 3);
    const color = new THREE.Color();
    for (let i = 0; i < points.count; i++) {
      const x = points.getX(i), z = points.getZ(i);
      const height = Math.sin(x * 0.035) * Math.sin(z * 0.032) * Math.min(5, Math.max(0, Math.abs(x) - 18) * 0.055);
      points.setY(i, -1.3 + height);
      color.setHSL(0.21 + Math.sin(z * 0.1) * 0.015, 0.28, 0.38 + Math.sin(x * 0.12 + z * 0.08) * 0.035, THREE.SRGBColorSpace);
      colors.set([color.r, color.g, color.b], i * 3);
    }
    terrain.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    terrain.computeVertexNormals();
    const ground = new THREE.Mesh(terrain, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1 }));
    ground.layers.set(1);
    this.root.add(ground);
    const distant = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1, 2), new THREE.MeshStandardMaterial({ color: 0x668071, roughness: 1 }), 18);
    distant.layers.set(1);
    for (let i = 0; i < 18; i++) {
      this.transform.position.set((i % 2 ? 1 : -1) * (95 + i % 4 * 12), -1.4, (i % 9) * 34 - 130);
      this.transform.scale.set(38, 7 + i % 4 * 2, 33);
      this.transform.updateMatrix();
      distant.setMatrixAt(i, this.transform.matrix);
    }
    this.root.add(distant);
    this.trees = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.11, 0.2, 4.5, 7), new THREE.MeshStandardMaterial({ roughness: 0.96 }), 140);
    this.leaves = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1, 1), new THREE.MeshStandardMaterial({ roughness: 1 }), 140 * 5);
    this.poles = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.07, 0.12, 8, 8), new THREE.MeshStandardMaterial({ color: 0x8e9797, metalness: 0.25, roughness: 0.65 }), 10);
    for (let i = 0; i < 140; i++) {
      const birch = i % 4 === 0;
      this.treePositions.push({ x: (i % 2 ? 1 : -1) * (12 + (i * 17) % 65), z: (i * 31.77) % period - period / 2, scale: 0.75 + (i % 7) * 0.12, birch });
      this.trees.setColorAt(i, new THREE.Color(birch ? 0xc8c4b1 : 0x6c6250));
      for (let j = 0; j < 5; j++) {
        color.setHSL(birch ? 0.225 : 0.28, 0.24 + j * 0.02, 0.29 + ((i + j) % 6) * 0.015, THREE.SRGBColorSpace);
        this.leaves.setColorAt(i * 5 + j, color);
      }
    }
    for (const mesh of [this.trees, this.leaves, this.poles]) {
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.frustumCulled = false;
      mesh.layers.set(1);
      this.root.add(mesh);
    }
    this.update(0);
  }

  update(dt: number) {
    this.travel = (this.travel + dt * 16) % period;
    for (const [i, tree] of this.treePositions.entries()) {
      const z = wrapLandscape(tree.z, this.travel);
      this.transform.rotation.set(0, i * 2.4, 0);
      this.transform.position.set(tree.x, 0.9 * tree.scale, z);
      this.transform.scale.set(tree.scale, tree.scale, tree.scale);
      this.transform.updateMatrix();
      this.trees.setMatrixAt(i, this.transform.matrix);
      for (let j = 0; j < 5; j++) {
        const angle = j * 2.4 + i;
        this.transform.position.set(tree.x + Math.sin(angle) * (j ? 0.9 : 0), (3.7 + j * 0.32) * tree.scale, z + Math.cos(angle) * (j ? 0.8 : 0));
        this.transform.scale.set(1.45 * tree.scale, (tree.birch ? 1.85 : 1.25) * tree.scale, 1.55 * tree.scale);
        this.transform.updateMatrix();
        this.leaves.setMatrixAt(i * 5 + j, this.transform.matrix);
      }
    }
    for (let i = 0; i < 10; i++) {
      this.transform.position.set(i % 2 ? 5.4 : -5.4, 2.7, wrapLandscape(Math.floor(i / 2) * 48, this.travel));
      this.transform.scale.set(1, 1, 1);
      this.transform.rotation.set(0, 0, 0);
      this.transform.updateMatrix();
      this.poles.setMatrixAt(i, this.transform.matrix);
    }
    this.trees.instanceMatrix.needsUpdate = true;
    this.leaves.instanceMatrix.needsUpdate = true;
    this.poles.instanceMatrix.needsUpdate = true;
  }
}
