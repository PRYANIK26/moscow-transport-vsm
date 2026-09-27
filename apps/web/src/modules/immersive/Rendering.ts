import * as THREE from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { GTAOPass } from "three/addons/postprocessing/GTAOPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";

export type GraphicsQuality = "auto" | "high" | "low";

class CabinOcclusion extends GTAOPass {
  override setSize(width: number, height: number) {
    super.setSize(Math.max(1, Math.round(width * 0.6)), Math.max(1, Math.round(height * 0.6)));
  }
  override render(renderer: THREE.WebGLRenderer, write: THREE.WebGLRenderTarget, read: THREE.WebGLRenderTarget, dt: number, mask: boolean) {
    const layers = this.camera.layers.mask;
    this.camera.layers.set(0);
    try {
      super.render(renderer, write, read, dt, mask);
    } finally {
      this.camera.layers.mask = layers;
    }
  }
}

export class SceneRendering {
  private composer?: EffectComposer;
  private ao?: CabinOcclusion;
  private environment?: THREE.WebGLRenderTarget;
  private readonly sun: THREE.DirectionalLight;
  private width = 1;
  private height = 1;
  private quality: GraphicsQuality;
  private tier: number;
  private slowFrames = 0;
  private sampleSeconds = 0;
  private frames = 0;
  private warmup = 1;
  private shadowTime = 0;

  constructor(private readonly renderer: THREE.WebGLRenderer, private readonly scene: THREE.Scene, private readonly camera: THREE.PerspectiveCamera, quality: GraphicsQuality, private readonly softwareRenderer = false) {
    this.quality = quality;
    this.tier = quality === "low" || (quality === "auto" && this.softwareRenderer) ? 0 : 1;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 0.96;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    renderer.shadowMap.autoUpdate = false;
    renderer.info.autoReset = false;
    scene.add(new THREE.HemisphereLight(0xe6eff8, 0x9b8570, 1.25));
    this.sun = new THREE.DirectionalLight(0xffe4bd, 2.5);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.camera.left = -8;
    this.sun.shadow.camera.right = 8;
    this.sun.shadow.camera.top = 15;
    this.sun.shadow.camera.bottom = -15;
    this.sun.shadow.camera.near = 1;
    this.sun.shadow.camera.far = 42;
    this.sun.shadow.bias = -0.00015;
    this.sun.shadow.normalBias = 0.025;
    this.sun.shadow.radius = 2;
    scene.add(this.sun, this.sun.target);
    const bounce = new THREE.DirectionalLight(0xc8d9ec, 0.5);
    bounce.position.set(4, 3, -8);
    scene.add(bounce);
    const ceilingFill = new THREE.DirectionalLight(0xffe6c5, 0.35);
    ceilingFill.position.set(0, -3, 10);
    scene.add(ceilingFill);
    if (this.tier) this.initEffects();
  }

  private initEffects() {
    if (this.composer) return;
    const room = new RoomEnvironment();
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.environment = pmrem.fromScene(room, 0.06, 0.1, 100, { size: 128 });
    this.scene.environment = this.environment.texture;
    this.scene.environmentIntensity = 0.6;
    room.dispose();
    pmrem.dispose();
    const target = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 4 });
    this.composer = new EffectComposer(this.renderer, target);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.ao = new CabinOcclusion(this.scene, this.camera, 1, 1);
    this.ao.updateGtaoMaterial({ radius: 0.32, thickness: 0.12, distanceExponent: 2, distanceFallOff: 0.9, scale: 1, samples: 8 });
    this.ao.updatePdMaterial({ radius: 4, samples: 8, rings: 2, lumaPhi: 8, depthPhi: 4, normalPhi: 3 });
    this.ao.blendIntensity = 0.85;
    this.composer.addPass(this.ao);
    this.composer.addPass(new OutputPass());
  }

  private disposeEffects() {
    this.composer?.passes.forEach((pass) => pass.dispose());
    this.composer?.dispose();
    this.environment?.dispose();
    this.composer = undefined;
    this.ao = undefined;
    this.environment = undefined;
    this.scene.environment = null;
  }

  setQuality(quality: GraphicsQuality) {
    if (quality === this.quality) return;
    this.quality = quality;
    this.tier = quality === "low" || (quality === "auto" && this.softwareRenderer) ? 0 : 1;
    if (this.tier) this.initEffects();
    else this.disposeEffects();
    this.warmup = 1;
    this.slowFrames = 0;
    this.sampleSeconds = 0;
    this.frames = 0;
    this.resize(this.width, this.height);
  }

  resize(width: number, height: number) {
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
    const pixelRatio = Math.min(window.devicePixelRatio || 1, this.softwareRenderer ? 0.4 : this.tier && this.quality === "high" ? 1.5 : 1);
    this.renderer.setPixelRatio(pixelRatio);
    this.renderer.setSize(this.width, this.height);
    this.composer?.setPixelRatio(pixelRatio);
    this.composer?.setSize(this.width, this.height);
    this.camera.aspect = this.width / this.height;
    this.camera.updateProjectionMatrix();
    if (this.ao) this.ao.enabled = this.tier === 1;
    this.renderer.shadowMap.enabled = this.tier === 1;
    this.renderer.shadowMap.needsUpdate = true;
  }

  render(dt: number, measurable: boolean) {
    this.shadowTime += dt;
    if (this.shadowTime > 0.1) {
      this.sun.position.set(-9, 12, this.camera.position.z + 6);
      this.sun.target.position.set(0, 0, this.camera.position.z);
      this.renderer.shadowMap.needsUpdate = true;
      this.shadowTime = 0;
    }
    this.renderer.info.reset();
    if (this.tier) this.composer?.render(Math.min(dt, 0.05));
    else this.renderer.render(this.scene, this.camera);
    if (!measurable) {
      this.sampleSeconds = 0;
      this.frames = 0;
      this.slowFrames = 0;
      return;
    }
    if (this.warmup > 0) { this.warmup -= dt; return; }
    // Long frames count as slow samples. They used to be excluded at the scene call site.
    if (this.quality === "auto" && this.tier && dt > 0.5) {
      this.slowFrames++;
      if (this.slowFrames >= 2) {
        this.tier = 0;
        this.disposeEffects();
        this.resize(this.width, this.height);
      }
      this.sampleSeconds = 0;
      this.frames = 0;
      return;
    }
    this.sampleSeconds += dt;
    this.frames++;
    if (this.sampleSeconds < 1) return;
    const fps = this.frames / this.sampleSeconds;
    this.slowFrames = fps < 29 ? this.slowFrames + 1 : 0;
    if (this.quality === "auto" && this.tier && this.slowFrames >= 2) {
      this.tier = 0;
      this.disposeEffects();
      this.resize(this.width, this.height);
    }
    this.sampleSeconds = 0;
    this.frames = 0;
  }

  get profile() { return this.tier ? "high" : "low"; }

  dispose() {
    this.disposeEffects();
    this.sun.shadow.dispose();
  }
}
