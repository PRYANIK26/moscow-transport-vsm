import * as THREE from "three";

export type Surface = "fabric" | "carpet" | "leather" | "wood";

export function surfaceTexture(surface: Surface, anisotropy = 4) {
  const size = 128;
  const data = new Uint8Array(size * size * 4);
  let seed = 71421;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      const noise = seed / 0xffffffff;
      let value: number;
      if (surface === "wood") {
        const grain = Math.sin(x * 0.82 + Math.sin(y * Math.PI / 64) * 0.7);
        value = 237 + grain * 4 + noise * 8;
      } else if (surface === "leather") {
        value = 233 + noise * 18 - (x % 7 === 0 && y % 5 === 0 ? 13 : 0);
      } else {
        const weave = ((x % 4 < 2) !== (y % 4 < 2)) ? 10 : -10;
        value = (surface === "carpet" ? 205 : 229) + weave + noise * 15;
      }
      const offset = (y * size + x) * 4;
      data[offset] = data[offset + 1] = data[offset + 2] = value;
      data[offset + 3] = 255;
    }
  }
  const texture = new THREE.DataTexture(data, size, size);
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.anisotropy = anisotropy;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
}

export function projectSurfaceUV(geometry: THREE.BufferGeometry, scale = 1) {
  const position = geometry.getAttribute("position");
  const normal = geometry.getAttribute("normal");
  const uv = new Float32Array(position.count * 2);
  for (let i = 0; i < position.count; i++) {
    const nx = Math.abs(normal.getX(i));
    const ny = Math.abs(normal.getY(i));
    const nz = Math.abs(normal.getZ(i));
    const u = nx > ny && nx > nz ? position.getY(i) : position.getX(i);
    const v = nz > nx && nz > ny ? position.getY(i) : position.getZ(i);
    uv[i * 2] = u * scale;
    uv[i * 2 + 1] = v * scale;
  }
  geometry.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
}

export function disposeTree(root: THREE.Object3D) {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  const textures = new Set<THREE.Texture>();
  root.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    geometries.add(object.geometry);
    const list = Array.isArray(object.material) ? object.material : [object.material];
    for (const material of list) {
      materials.add(material);
      for (const value of Object.values(material)) {
        if (value instanceof THREE.Texture) textures.add(value);
      }
    }
    if (object instanceof THREE.InstancedMesh) object.dispose();
  });
  geometries.forEach((geometry) => geometry.dispose());
  materials.forEach((material) => material.dispose());
  textures.forEach((texture) => texture.dispose());
}
