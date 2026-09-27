import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import type { SceneAnchor, SceneDefinition, WorldPoint, WorldSessionView } from '@vsm/shared';
import { finishCabin, type CabinSeat } from './Cabin';
import { Landscape } from './Landscape';
import { Passenger } from './Passenger';
import { createSuitcase } from './Props';
import { SceneRendering, type GraphicsQuality } from './Rendering';
import { disposeTree } from './Surfaces';

export type SceneHandle = {
  goTo: (anchorId: string) => void;
  stop: () => void;
  lookAt: (anchorId: string) => void;
  move: (direction: 'forward' | 'back' | 'left' | 'right', active: boolean) => void;
  look: (dx: number, dy: number) => void;
};

type Props = {
  sceneKey: string;
  resetToken: number;
  world: WorldSessionView;
  scenarioTitle: string;
  targetId: string | null;
  quality: GraphicsQuality;
  paused: boolean;
  speaking?: boolean;
  onReady?: () => void;
  onMove: (point: WorldPoint) => void;
  onTravelChange: (anchorId: string | null) => void;
  onInteract: () => void;
  handle: React.RefObject<SceneHandle | null>;
};

function distance(a: WorldPoint, b: WorldPoint) {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

// The same carriage dimensions as the model exporter. Targets and spawn always come from the snapshot.
function pathPosition(scene: SceneDefinition, point: WorldPoint): WorldPoint {
  const first = scene.trainClass === 'first';
  const min = first ? 6.2 : 1.1;
  const max = first ? 26 : 24.3;
  const z = THREE.MathUtils.clamp(point.z, min, max);
  const center = first && z > 9.3 && z < 14.15 ? 0.22 : scene.trainClass === 'standard' && z >= 4.2 ? 0.255 : 0;
  const width = first ? (z < 9.3 || z > 22.5 ? 0.34 : 0.17) : (z < 4.2 || z > 22.9 || (scene.trainClass === 'standard' && z > 18) ? 0.31 : 0.15);
  return { x: THREE.MathUtils.clamp(point.x, center - width, center + width), z };
}

function approachPoint(scene: SceneDefinition, anchor: SceneAnchor): WorldPoint {
  const fromSpawn = scene.spawn.z <= anchor.z ? -1 : 1;
  const aisle = pathPosition(scene, anchor);
  const offset = Math.min(1.2, Math.sqrt(Math.max(0, anchor.radius ** 2 - (anchor.x - aisle.x) ** 2)) * .7);
  return pathPosition(scene, { x: anchor.x, z: anchor.z + fromSpawn * offset });
}

function itemMesh(prefab: SceneDefinition['items'][number]['prefab']) {
  if (prefab === 'bag') return createSuitcase(false);
  const group = new THREE.Group();
  const color = prefab === 'blanket' ? 0x809c91 : prefab === 'cleaning_kit' ? 0x36a3a7 : 0xeac947;
  const body = new THREE.Mesh(
    new THREE.BoxGeometry(prefab === 'blanket' ? 0.44 : 0.22, prefab === 'blanket' ? 0.14 : 0.26, 0.28),
    new THREE.MeshStandardMaterial({ color, roughness: 0.7 }),
  );
  body.position.y = 0.14;
  body.castShadow = true;
  group.add(body);
  return group;
}

export function Scene({ sceneKey, resetToken, world, scenarioTitle, targetId, quality, paused, speaking, onReady, onMove, onTravelChange, onInteract, handle }: Props) {
  const mount = useRef<HTMLDivElement>(null);
  const passengerLabel = useRef<HTMLDivElement>(null);
  const targetLabel = useRef<HTMLDivElement>(null);
  const latest = useRef({ world, targetId, quality, paused, speaking, onReady, resetToken, onMove, onTravelChange, onInteract });
  latest.current = { world, targetId, quality, paused, speaking, onReady, resetToken, onMove, onTravelChange, onInteract };
  const [loading, setLoading] = useState(0);
  const [error, setError] = useState('');
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const host = mount.current!;
    if (!host) return;
    // StrictMode mounts effects twice in development. Defer WebGL setup so the
    // first effect can be cancelled before it allocates a second GPU context.
    let release: (() => void) | undefined;
    let startup = 0;
    const schedule = () => { startup = window.setTimeout(() => { if (host.isConnected) release = initialize(); }, 0); };
    // Navigation's DOMContentLoaded must not wait for GL allocation or model work.
    if (document.readyState === 'complete') schedule();
    else window.addEventListener('load', schedule, { once: true });
    return () => { window.removeEventListener('load', schedule); window.clearTimeout(startup); release?.(); };
    function initialize(): (() => void) | undefined {
    const definition = world.scene;
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
    } catch {
      setError('Не удалось запустить WebGL. Проверьте аппаратное ускорение браузера.');
      return;
    }
    let disposed = false;
    let frame = 0;
    let modelReady = false;
    let didRender = false;
    let unloading = false;
    const gl = renderer.getContext();
    const debug = gl.getExtension('WEBGL_debug_renderer_info');
    const rendererName = debug ? String(gl.getParameter(debug.UNMASKED_RENDERER_WEBGL)) : '';
    const softwareRenderer = /swiftshader|llvmpipe|softpipe/i.test(rendererName);
    host.appendChild(renderer.domElement);
    renderer.domElement.tabIndex = 0;
    renderer.domElement.setAttribute('aria-label', '3D-вагон: WASD — движение, мышь — обзор, E — действие');
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0xcbd8d8);
    scene.fog = new THREE.Fog(0xcbd8d8, 45, 155);
    const camera = new THREE.PerspectiveCamera(63, 1, 0.04, 260);
    camera.layers.enable(1);
    const graphics = new SceneRendering(renderer, scene, camera, quality, softwareRenderer);
    host.dataset.renderer = softwareRenderer ? 'software' : 'hardware';
    const landscape = new Landscape();
    scene.add(landscape.root);
    for (const x of [-0.76, 0.76]) {
      const rail = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.12, 220), new THREE.MeshStandardMaterial({ color: 0x68757b, metalness: 0.8, roughness: 0.4 }));
      rail.position.set(x, -1.1, 0);
      scene.add(rail);
    }
    for (const z of [definition.trainClass === 'first' ? 6.1 : 0.35, definition.trainClass === 'first' ? 27 : 25]) {
      const door = new THREE.Mesh(new THREE.BoxGeometry(3.06, 2.38, 0.06), new THREE.MeshStandardMaterial({ color: 0xd1c9bc, roughness: 0.7 }));
      door.position.set(0, 1.19, z);
      scene.add(door);
      const inset = new THREE.Mesh(new THREE.BoxGeometry(0.84, 1.97, 0.075), new THREE.MeshStandardMaterial({ color: 0x807e76, roughness: 0.42, metalness: 0.25 }));
      inset.position.set(0, 1.025, z);
      scene.add(inset);
      const glass = new THREE.Mesh(new THREE.BoxGeometry(0.59, 0.66, 0.08), new THREE.MeshStandardMaterial({ color: 0x425e67, roughness: 0.2 }));
      glass.position.set(0, 1.43, z);
      scene.add(glass);
    }

    const actorAnchor = definition.anchors.find((a) => a.id === definition.passenger.anchorId);
    const passenger = new Passenger(0x4f6860, 1, true);
    if (actorAnchor) passenger.root.position.set(actorAnchor.x, 0, actorAnchor.z);
    if (definition.passenger.age < 14) passenger.root.scale.setScalar(0.72);
    passenger.root.rotation.y = (definition.passenger.facing ?? 0) * Math.PI / 180;
    scene.add(passenger.root);
    const companions: Passenger[] = [];
    const equipment = new THREE.Group();
    const serviceIndicators: THREE.MeshStandardMaterial[] = [];
    scene.add(equipment);
    for (const anchor of definition.anchors) {
      if (anchor.kind !== 'radio' && anchor.kind !== 'service') continue;
      const box = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.4, 0.3), new THREE.MeshStandardMaterial({ color: anchor.kind === 'radio' ? 0x25454e : 0x96744e, roughness: 0.5 }));
      box.position.set(anchor.x < 0 ? -0.45 : 0.45, 1.25, anchor.z);
      equipment.add(box);
      const indicator = new THREE.MeshStandardMaterial({ color: 0x7fe4cb, emissive: 0x3ba68c, emissiveIntensity: 0.35 });
      if (anchor.kind === 'service') serviceIndicators.push(indicator);
      const screen = new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.16, 0.21), indicator);
      screen.position.copy(box.position);
      screen.position.y += 0.04;
      equipment.add(screen);
    }
    const items = new Map<string, THREE.Group>();
    for (const item of definition.items) {
      const anchor = definition.anchors.find((a) => a.id === item.anchorId);
      if (!anchor) continue;
      const object = itemMesh(item.prefab);
      object.position.set(anchor.x, 0, anchor.z);
      scene.add(object);
      items.set(item.id, object);
    }
    const needsCleaning = /гряз|загряз|уборк|пролил/i.test(scenarioTitle);
    const seat = definition.anchors.find((anchor) => anchor.kind === 'seat') ?? actorAnchor;
    const stain = needsCleaning && seat ? new THREE.Mesh(
      new THREE.CircleGeometry(0.32, 20),
      new THREE.MeshBasicMaterial({ color: 0xa65e31, depthTest: false, depthWrite: false, side: THREE.DoubleSide }),
    ) : null;
    if (stain && seat) { const visiblePoint = pathPosition(definition, { x: 0, z: seat.z + 0.8 }); stain.rotation.x = -Math.PI / 2; stain.position.set(visiblePoint.x, 0.02, visiblePoint.z); stain.renderOrder = 10; scene.add(stain); }
    const targetMarker = new THREE.Mesh(new THREE.OctahedronGeometry(0.12), new THREE.MeshBasicMaterial({ color: 0xffdc54, depthTest: false }));
    targetMarker.renderOrder = 20;
    targetMarker.layers.set(1);
    scene.add(targetMarker);
    const targetRing = new THREE.Mesh(new THREE.RingGeometry(0.24, 0.285, 36), new THREE.MeshBasicMaterial({ color: 0xffdc54, side: THREE.DoubleSide, depthTest: false }));
    targetRing.rotation.x = -Math.PI / 2;
    targetRing.layers.set(1);
    scene.add(targetRing);
    const passengerBadge = new THREE.Mesh(new THREE.SphereGeometry(0.052, 10, 8), new THREE.MeshBasicMaterial({ color: 0x6cdae1, depthTest: false }));
    passengerBadge.layers.set(1);
    scene.add(passengerBadge);
    const labelPosition = new THREE.Vector3();

    const keys = new Set<string>();
    let walkingTo: string | null = null;
    const setWalking = (id: string | null) => {
      if (walkingTo === id) return;
      walkingTo = id;
      latest.current.onTravelChange(id);
    };
    let player = { ...world.position };
    let yaw = actorAnchor ? Math.atan2(-(actorAnchor.x - player.x), -(actorAnchor.z - player.z)) : Math.PI;
    let pitch = -0.12;
    let dragging = false;
    let lastPointer = { x: 0, y: 0 };
    let last = performance.now();
    let lastWorld = world;
    let lastTarget = targetId;
    let lastQuality = quality;
    let lastPaused = paused;
    let wasMoving = false;
    let lookDirty = false;
    let elapsed = 0;
    let lastResetToken = resetToken;
    const faceAnchor = (anchor: SceneAnchor) => {
      yaw = Math.atan2(-(anchor.x - player.x), -(anchor.z - player.z));
      const height = anchor.kind === 'passenger' || anchor.kind === 'seat' ? 1.12 : 1.3;
      pitch = -Math.atan2(1.63 - height, Math.max(.4, distance(player, anchor)));
      lookDirty = true;
    };
    const control: SceneHandle = {
      goTo: (id) => { setWalking(id); keys.clear(); renderer.domElement.focus(); },
      stop: () => { setWalking(null); keys.clear(); if (distance(player, latest.current.world.position) > .08) latest.current.onMove({ ...player }); },
      lookAt: (id) => { const a = definition.anchors.find(anchor => anchor.id === id); if (a) faceAnchor(a); },
      move: (direction, active) => { setWalking(null); active ? keys.add(direction) : keys.delete(direction); },
      look: (dx, dy) => { yaw -= dx * 0.003; pitch = THREE.MathUtils.clamp(pitch - dy * 0.003, -1.1, 1.1); lookDirty = true; },
    };
    handle.current = control;
    const typing = (event: Event) => event.target instanceof Element && !!event.target.closest('button,a,input,textarea,select,[contenteditable=true]');
    const keydown = (event: KeyboardEvent) => {
      if (typing(event) || latest.current.paused) return;
      if (['KeyW','KeyA','KeyS','KeyD','ArrowUp','ArrowDown','ArrowLeft','ArrowRight','KeyE'].includes(event.code)) event.preventDefault();
      if (event.repeat) return;
      if (event.code === 'KeyE') latest.current.onInteract();
      else if (event.code !== 'Space') keys.add(event.code);
      if (event.code !== 'KeyE') setWalking(null);
    };
    const keyup = (event: KeyboardEvent) => keys.delete(event.code);
    const clear = () => { keys.clear(); dragging = false; };
    const pointerDown = (event: PointerEvent) => { if (event.button !== 0 || latest.current.paused) return; dragging = true; lastPointer = { x: event.clientX, y: event.clientY }; renderer.domElement.setPointerCapture(event.pointerId); renderer.domElement.focus(); };
    const pointerMove = (event: PointerEvent) => { if (!dragging || latest.current.paused) return; control.look(event.clientX - lastPointer.x, event.clientY - lastPointer.y); lastPointer = { x: event.clientX, y: event.clientY }; };
    const pointerUp = () => { dragging = false; };
    const contextLost = (event: Event) => { event.preventDefault(); if (!unloading) setError('Графический контекст потерян. Обновите страницу для продолжения.'); };
    const beforeUnload = () => {
      unloading = true;
      cancelAnimationFrame(frame);
    };
    window.addEventListener('beforeunload', beforeUnload);
    window.addEventListener('keydown', keydown);
    window.addEventListener('keyup', keyup);
    window.addEventListener('blur', clear);
    document.addEventListener('visibilitychange', clear);
    renderer.domElement.addEventListener('pointerdown', pointerDown);
    renderer.domElement.addEventListener('pointermove', pointerMove);
    renderer.domElement.addEventListener('pointerup', pointerUp);
    renderer.domElement.addEventListener('pointercancel', pointerUp);
    renderer.domElement.addEventListener('webglcontextlost', contextLost);
    const resize = () => { graphics.resize(host.clientWidth, host.clientHeight); lookDirty = true; };
    const observer = new ResizeObserver(resize);
    observer.observe(host);
    resize();

    const abort = new AbortController();
    fetch('/models/manifest.json', { signal: abort.signal })
      .then((response) => { if (!response.ok) throw new Error('manifest'); return response.json() as Promise<{ cars: { id: string; seats: CabinSeat[] }[] }> })
      .then(async (manifest) => {
        const gltf = await new GLTFLoader().loadAsync(`/models/${definition.trainClass}.glb`, (event) => {
          if (!disposed) setLoading(event.total ? Math.round(event.loaded / event.total * 100) : 40);
        });
        if (disposed) { disposeTree(gltf.scene); return; }
        const seats = manifest.cars.find((car) => car.id === definition.trainClass)?.seats ?? [];
        scene.add(finishCabin(gltf.scene, definition.trainClass, seats, Math.min(8, renderer.capabilities.getMaxAnisotropy())));
        const selected = seats.filter((seat, index) => index % 5 === 2 && (!actorAnchor || distance(seat, actorAnchor) > 0.65)).slice(0, 12);
        selected.forEach((seat, index) => {
          const actor = new Passenger([0x6b7376, 0xb69c7c, 0x8b7269, 0x657b80, 0x837e6d][index % 5], index);
          actor.root.position.set(seat.x, 0, seat.z);
          actor.root.rotation.y = seat.yaw;
          scene.add(actor.root);
          companions.push(actor);
        });
        if (disposed) return;
        modelReady = true;
      })
      .catch(() => { if (!disposed) setError('Не удалось загрузить модель вагона. Проверьте /models и обновите страницу.'); });

    const tick = (now: number) => {
      if (disposed || unloading) return;
      frame = requestAnimationFrame(tick);
      const state = latest.current;
      const changed = state.world !== lastWorld || state.targetId !== lastTarget || state.quality !== lastQuality || state.paused !== lastPaused || state.resetToken !== lastResetToken;
      const moving = !!walkingTo || keys.size > 0;
      if (softwareRenderer && didRender && !moving && !wasMoving && !lookDirty && !changed && !state.speaking) { last = now; return; }
      const realDt = Math.max(0.001, (now - last) / 1000);
      // Match the original game: render each animation frame. Artificial caps
      // quantized 60 Hz input down to 20–30 FPS even on a capable GPU.
      last = now;
      if (document.hidden || !modelReady) return;
      const dt = Math.min(realDt, 0.05);
      const movementDt = Math.min(realDt, 0.3);
      elapsed += dt;
      const authoritative = state.world.position;
      if (state.resetToken !== lastResetToken) {
        player = { ...authoritative };
        setWalking(null);
        keys.clear();
        lastResetToken = state.resetToken;
      }
      if (modelReady && !state.paused) {
        let dx = 0;
        let dz = 0;
        if (walkingTo) {
          const anchor = definition.anchors.find((a) => a.id === walkingTo);
          if (!anchor) setWalking(null);
          else {
            const destination = approachPoint(definition, anchor);
            const delta = destination.z - player.z;
            if (Math.abs(delta) > 0.17) {
              dz = Math.sign(delta) * Math.min(Math.abs(delta), 1.7 * movementDt);
              dx = (destination.x - player.x) * Math.min(1, 1.5 * movementDt);
              yaw = delta > 0 ? Math.PI : 0;
              pitch = 0;
            } else {
              setWalking(null);
              state.onMove({ ...player });
              faceAnchor(anchor);
            }
          }
        } else {
          const forward = Number(keys.has('KeyW') || keys.has('ArrowUp') || keys.has('forward')) - Number(keys.has('KeyS') || keys.has('ArrowDown') || keys.has('back'));
          const side = Number(keys.has('KeyD') || keys.has('right')) - Number(keys.has('KeyA') || keys.has('left'));
          if (keys.has('ArrowLeft')) yaw += dt * 1.4;
          if (keys.has('ArrowRight')) yaw -= dt * 1.4;
          const length = Math.hypot(forward, side) || 1;
          dx = (-Math.sin(yaw) * forward + Math.cos(yaw) * side) / length * 1.7 * movementDt;
          dz = (-Math.cos(yaw) * forward - Math.sin(yaw) * side) / length * 1.7 * movementDt;
        }
        player = pathPosition(definition, { x: player.x + dx, z: player.z + dz });
        if (distance(player, authoritative) > 0.08) {
          state.onMove({ ...player });
        }
      }
      if (state.targetId !== lastTarget && !walkingTo) {
        const nextTarget = definition.anchors.find(anchor => anchor.id === state.targetId);
        if (nextTarget) faceAnchor(nextTarget);
      }
      camera.position.set(player.x, 1.63, player.z);
      camera.rotation.set(pitch, yaw, 0, 'YXZ');
      const selected = state.targetId ? definition.anchors.find((a) => a.id === state.targetId) : null;
      targetMarker.visible = !!selected && distance(player, selected) > 1.5;
      targetRing.visible = !!selected;
      if (selected) {
        targetMarker.position.set(selected.x, 1.85 + Math.sin(elapsed * 2.4) * 0.06, selected.z);
        targetMarker.rotation.y = elapsed;
        targetRing.position.set(selected.x, 0.025, selected.z);
      }
      if (targetLabel.current && selected) {
        camera.updateMatrixWorld();
        labelPosition.set(selected.x, 1.8, selected.z).project(camera);
        const inFrame = labelPosition.z > 0 && labelPosition.z < 1 && Math.abs(labelPosition.x) < .9 && Math.abs(labelPosition.y) < .9;
        targetLabel.current.style.left = `${inFrame ? Math.max(100, Math.min(host.clientWidth - 100, (labelPosition.x + 1) * host.clientWidth / 2)) : host.clientWidth * .65}px`;
        targetLabel.current.style.top = `${inFrame ? Math.max(100, Math.min(host.clientHeight * .65, (1 - labelPosition.y) * host.clientHeight / 2)) : host.clientHeight * .35}px`;
        const label = targetLabel.current.querySelector('span');
        if (label) label.textContent = `${distance(player, selected) <= selected.radius ? 'Вы у цели · ' : inFrame ? '' : 'Цель вне кадра · '}${distance(player, selected).toFixed(1)} м`;
      }
      const currentActor = definition.anchors.find((a) => a.id === (state.world.actorAnchorId ?? definition.passenger.anchorId));
      if (currentActor) {
        passenger.root.position.x = THREE.MathUtils.damp(passenger.root.position.x, currentActor.x, 2, dt);
        passenger.root.position.z = THREE.MathUtils.damp(passenger.root.position.z, currentActor.z, 2, dt);
      }
      passengerBadge.visible = !!currentActor;
      if (passengerLabel.current && currentActor) {
        camera.updateMatrixWorld();
        labelPosition.set(passenger.root.position.x, definition.passenger.age < 14 ? 1.45 : 1.85, passenger.root.position.z).project(camera);
        passengerLabel.current.style.visibility = labelPosition.z > 0 && labelPosition.z < 1 && Math.abs(labelPosition.x) < 1.1 ? 'visible' : 'hidden';
        passengerLabel.current.style.left = `${Math.max(90, Math.min(host.clientWidth - 90, (labelPosition.x + 1) * host.clientWidth / 2))}px`;
        passengerLabel.current.style.top = `${Math.max(70, Math.min(host.clientHeight - 50, (1 - labelPosition.y) * host.clientHeight / 2))}px`;
      }
      if (currentActor) passengerBadge.position.set(passenger.root.position.x, definition.passenger.age < 14 ? 1.38 : 1.77, passenger.root.position.z);
      for (const item of definition.items) {
        const object = items.get(item.id);
        const delivered = state.world.deliveredItems?.includes(item.id);
        if (object) {
          object.visible = !state.world.inventory.includes(item.id);
          const anchor = delivered ? currentActor : definition.anchors.find(anchor => anchor.id === item.anchorId);
          if (anchor) object.position.set(anchor.x, delivered ? .65 : 0, anchor.z);
        }
      }
      if (stain) stain.visible = state.world.service !== 'completed';
      for (const material of serviceIndicators) {
        const color = state.world.service === 'completed' ? 0x75c68d : state.world.service === 'requested' ? 0xf2c550 : 0x7fe4cb;
        material.color.setHex(color);
        material.emissive.setHex(color);
      }
      passenger.update(elapsed, dt, 'calm', 'idle', !!state.speaking, false, camera.position);
      companions.forEach((actor, index) => actor.update(elapsed + index, dt, 'calm', 'idle', false, false, camera.position));
      landscape.update(dt);
      graphics.setQuality(state.quality);
      graphics.render(realDt, modelReady && !state.paused);
      if (!didRender) { didRender = true; setReady(true); state.onReady?.(); }
      lastWorld = state.world;
      lastTarget = state.targetId;
      lastQuality = state.quality;
      lastPaused = state.paused;
      wasMoving = moving;
      lookDirty = false;
      host.dataset.quality = graphics.profile;
      host.dataset.fps = realDt > 0 ? String(Math.round(1 / realDt)) : '0';
    };
    frame = requestAnimationFrame(tick);
    return () => {
      disposed = true;
      abort.abort();
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener('beforeunload', beforeUnload);
      window.removeEventListener('keydown', keydown);
      window.removeEventListener('keyup', keyup);
      window.removeEventListener('blur', clear);
      document.removeEventListener('visibilitychange', clear);
      renderer.domElement.removeEventListener('pointerdown', pointerDown);
      renderer.domElement.removeEventListener('pointermove', pointerMove);
      renderer.domElement.removeEventListener('pointerup', pointerUp);
      renderer.domElement.removeEventListener('pointercancel', pointerUp);
      renderer.domElement.removeEventListener('webglcontextlost', contextLost);
      graphics.dispose();
      disposeTree(scene);
      renderer.dispose();
      renderer.domElement.remove();
      handle.current = null;
    };
    }
  }, [sceneKey, handle]);

  return <div className="immersive-scene" ref={mount}>
    <div className="immersive-passenger-label" ref={passengerLabel}>{world.scene.passenger.name}<span>Пассажир</span></div>
    {targetId && <div className="immersive-target-label" ref={targetLabel}>◆ {world.scene.anchors.find(anchor => anchor.id === targetId)?.label}<span/></div>}
    {!ready && !error && <div className="immersive-loading" role="status">Готовим вагон · {loading}%</div>}
    {error && <div className="immersive-loading immersive-error" role="alert">{error}</div>}
  </div>;
}
