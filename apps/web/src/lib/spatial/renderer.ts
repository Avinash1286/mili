import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { SpatialModel } from '@milli/contracts';

export type SpatialInteractionAdapter = {
  orbit: (dx: number, dy: number) => void; zoom: (factor: number) => void; reset: () => void;
  selectAt: (x: number, y: number) => string | undefined; getViewportRect: () => DOMRect;
};
export type SpatialLabel = { id: string; x: number; y: number };
type Options = { onPart: (id: string) => void; onReady: (partIds: string[]) => void; onError: (message: string) => void; onLabels: (labels: SpatialLabel[]) => void };

/** Parse only the project-owned, bounded GLB form. No external resource URLs. */
export function validateSpatialGlb(buffer: ArrayBuffer, model: SpatialModel): void {
  if (buffer.byteLength < 20 || buffer.byteLength > model.budget.maxBytes) throw new Error('The model file has an invalid size.');
  const view = new DataView(buffer);
  if (view.getUint32(0, true) !== 0x46546c67 || view.getUint32(4, true) !== 2 || view.getUint32(8, true) !== buffer.byteLength || view.getUint32(16, true) !== 0x4e4f534a) throw new Error('The model file is not a supported GLB.');
  const jsonLength = view.getUint32(12, true);
  if (jsonLength > buffer.byteLength - 20) throw new Error('The model file is incomplete.');
  const data = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 20, jsonLength))) as { nodes?: { name?: string }[]; buffers?: { uri?: string }[]; images?: unknown[]; meshes?: unknown[] };
  if (data.buffers?.some(buffer => buffer.uri) || data.images?.length || (data.meshes?.length ?? 0) > model.budget.maxMeshes) throw new Error('The model contains unsupported external or excessive resources.');
  for (const part of model.parts) for (const name of part.meshNames) if (!data.nodes?.some(node => node.name === name)) throw new Error('A named learning part is missing from the model.');
}

export class SpatialRenderer implements SpatialInteractionAdapter {
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(40, 1, .05, 150);
  private readonly renderer: THREE.WebGLRenderer;
  private readonly controls: OrbitControls;
  private readonly abort = new AbortController();
  private readonly resize: ResizeObserver;
  private readonly parts = new Map<string, THREE.Object3D>();
  private readonly originals = new Map<THREE.Object3D, THREE.Vector3>();
  private modelRoot?: THREE.Group;
  private disposed = false;
  private loaded = false;
  private frame = 0;
  private readyFrame = 0;
  private selected: string[] = [];
  private isolated = false;
  private animation = false;
  private elapsed = 0;
  private previousTime?: number;
  private width = 1;
  private height = 1;
  private flowMarker?: THREE.Mesh;
  private flowCurve?: THREE.CatmullRomCurve3;
  private pointerDown?: { x: number; y: number };
  private readonly raycaster = new THREE.Raycaster();

  constructor(private readonly container: HTMLElement, readonly model: SpatialModel, private readonly options: Options) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'low-power' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
    this.renderer.setClearColor('#f5f5ec');
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    const canvas = this.renderer.domElement;
    canvas.setAttribute('aria-label', `${model.title} interactive 3D model`);
    canvas.setAttribute('role', 'img'); canvas.tabIndex = 0;
    canvas.style.width = '100%'; canvas.style.height = '100%'; canvas.style.display = 'block';
    this.container.append(canvas);
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = false; this.controls.minDistance = 2; this.controls.maxDistance = 45;
    this.controls.addEventListener('change', this.requestRender);
    this.scene.add(new THREE.HemisphereLight('#fff8dd', '#536e61', 2.5));
    const light = new THREE.DirectionalLight('#ffffff', 3); light.position.set(7, 12, 10); this.scene.add(light);
    const fill = new THREE.DirectionalLight('#d9e7dc', 1); fill.position.set(-6, 3, -3); this.scene.add(fill);
    canvas.addEventListener('webglcontextlost', this.contextLost);
    canvas.addEventListener('pointerdown', this.pointerStart);
    canvas.addEventListener('pointerup', this.pointerEnd);
    canvas.addEventListener('keydown', this.keyDown);
    document.addEventListener('visibilitychange', this.visibility);
    this.resize = new ResizeObserver(() => this.measure()); this.resize.observe(container); this.measure(); this.reset();
    void this.load();
  }
  private async load() {
    let parsed: THREE.Group | undefined;
    try {
      const response = await fetch(this.model.assetUrl, { signal: this.abort.signal, credentials: 'same-origin' });
      if (!response.ok) throw new Error('The model file could not be loaded.');
      const declared = Number(response.headers.get('content-length') ?? 0);
      if (declared > this.model.budget.maxBytes) throw new Error('The model file exceeds its size limit.');
      const bytes = await response.arrayBuffer(); validateSpatialGlb(bytes, this.model);
      const digest = await crypto.subtle.digest('SHA-256', bytes), hash = [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('');
      if (hash !== this.model.checksum) throw new Error('The model integrity check failed. Reload to get the current version.');
      const result = await new GLTFLoader().parseAsync(bytes, ''); parsed = result.scene;
      if (this.disposed) { disposeObject(parsed); return; }
      this.modelRoot = parsed; this.scene.add(parsed);
      for (const part of this.model.parts) {
        const object = parsed.getObjectByName(part.meshNames[0]!);
        if (!object) throw new Error(`The ${part.label} part is missing.`);
        this.parts.set(part.id, object); this.originals.set(object, object.position.clone());
      }
      parsed.traverse(object => {
        if (object instanceof THREE.Mesh) {
          for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
            if (material instanceof THREE.MeshStandardMaterial) material.userData.baseEmissive = material.emissive.getHex();
          }
        }
      });
      const path = parsed.userData.flowPath;
      if (Array.isArray(path) && path.length > 2) {
        this.flowCurve = new THREE.CatmullRomCurve3(path.map((point: [number, number, number]) => new THREE.Vector3(...point)));
        this.flowMarker = new THREE.Mesh(new THREE.SphereGeometry(.17, 12, 8), new THREE.MeshBasicMaterial({ color: '#f9d569' }));
        this.flowMarker.visible = false; this.scene.add(this.flowMarker);
      }
      this.loaded = true; this.setSelection(this.selected, this.isolated); this.requestRender();
    } catch (error) {
      if (this.disposed || this.abort.signal.aborted) return;
      if (parsed && parsed !== this.modelRoot) disposeObject(parsed);
      this.options.onError(error instanceof Error ? error.message : 'The model could not be displayed.');
    }
  }
  private measure() {
    const box = this.container.getBoundingClientRect(); if (box.width <= 0 || box.height <= 0) return;
    this.width = box.width; this.height = box.height;
    this.camera.aspect = box.width / box.height; this.camera.updateProjectionMatrix();
    this.renderer.setSize(Math.min(2048, box.width), Math.min(2048, box.height), false); this.requestRender();
  }
  private contextLost = (event: Event) => { event.preventDefault(); this.loaded = false; cancelAnimationFrame(this.readyFrame); if (!this.disposed) this.options.onError('3D graphics were interrupted. The same parts are available in the diagram.'); };
  private visibility = () => { this.previousTime = undefined; if (document.hidden) { cancelAnimationFrame(this.frame); this.frame = 0; } else this.requestRender(); };
  private pointerStart = (event: PointerEvent) => { this.pointerDown = { x: event.clientX, y: event.clientY }; };
  private pointerEnd = (event: PointerEvent) => {
    if (!this.pointerDown || Math.hypot(event.clientX - this.pointerDown.x, event.clientY - this.pointerDown.y) > 5) { this.pointerDown = undefined; return; }
    this.pointerDown = undefined; const box = this.getViewportRect(); this.selectAt((event.clientX - box.left) / box.width, (event.clientY - box.top) / box.height);
  };
  private keyDown = (event: KeyboardEvent) => {
    if (event.key === 'ArrowLeft') this.orbit(-.07, 0); else if (event.key === 'ArrowRight') this.orbit(.07, 0); else if (event.key === 'ArrowUp') this.orbit(0, -.07); else if (event.key === 'ArrowDown') this.orbit(0, .07); else if (event.key === '+' || event.key === '=') this.zoom(1.2); else if (event.key === '-') this.zoom(1 / 1.2); else if (event.key.toLowerCase() === 'r') this.reset(); else return;
    event.preventDefault();
  };
  private requestRender = () => { if (!this.disposed && !this.frame && !document.hidden) this.frame = requestAnimationFrame(this.render); };
  private render = (time: number) => {
    this.frame = 0; if (this.disposed || document.hidden) return;
    if (this.animation && this.loaded) {
      if (this.previousTime !== undefined) this.elapsed += Math.min(.1, (time - this.previousTime) / 1000);
      this.animate(this.elapsed); this.previousTime = time;
    }
    this.controls.update(); this.renderer.render(this.scene, this.camera);
    const canvas = this.renderer.domElement;
    canvas.dataset.cameraPose = JSON.stringify([...this.camera.position.toArray(), ...this.controls.target.toArray()].map(value => Math.round(value * 1000) / 1000));
    canvas.dataset.selectedParts = this.selected.join(',');
    if (this.loaded) { canvas.dataset.rendered = 'true'; this.publishLabels(); }
    if (this.animation) this.requestRender();
  };
  private publishLabels() {
    const labels: SpatialLabel[] = [];
    for (const [id, object] of this.parts) {
      if (!object.visible) continue;
      const position = new THREE.Box3().setFromObject(object).getCenter(new THREE.Vector3()).project(this.camera);
      if (position.z < -1 || position.z > 1) continue;
      labels.push({ id, x: Math.max(55, Math.min(this.width - 55, (position.x + 1) / 2 * this.width)), y: Math.max(20, Math.min(this.height - 20, (1 - position.y) / 2 * this.height)) });
    }
    // Keep labels legible where several semantic groups share the same center.
    labels.sort((a, b) => a.y - b.y);
    for (let i = 1; i < labels.length; i++) for (let j = 0; j < i; j++) if (Math.abs(labels[i]!.x - labels[j]!.x) < 105 && Math.abs(labels[i]!.y - labels[j]!.y) < 30) labels[i]!.y = Math.min(this.height - 15, labels[j]!.y + 30);
    this.options.onLabels(labels);
  }
  setSelection(ids: string[], isolate = false) {
    this.selected = ids.filter(id => this.model.parts.some(part => part.id === id)); this.isolated = isolate;
    for (const [id, object] of this.parts) {
      object.visible = !isolate || !this.selected.length || this.selected.includes(id);
      object.traverse(child => { if (child instanceof THREE.Mesh) for (const material of Array.isArray(child.material) ? child.material : [child.material]) if (material instanceof THREE.MeshStandardMaterial) { material.emissive.setHex(this.selected.includes(id) ? 0x8b6d21 : Number(material.userData.baseEmissive ?? 0)); material.emissiveIntensity = this.selected.includes(id) ? .38 : 1; } });
    }
    const decoration = this.modelRoot?.getObjectByName('orbital-guides'); if (decoration) decoration.visible = !isolate;
    this.requestRender(); cancelAnimationFrame(this.readyFrame);
    if (this.loaded) this.readyFrame = requestAnimationFrame(() => {
      // requestRender was scheduled first, so acknowledgement observes a frame
      // with the requested semantic selection rather than just a parsed asset.
      if (!this.disposed && this.loaded && !document.hidden) this.options.onReady([...this.selected]);
    });
  }
  setAnimation(enabled: boolean) {
    this.animation = enabled; this.previousTime = undefined;
    if (!enabled) {
      for (const [object, position] of this.originals) object.position.copy(position);
      if (this.flowMarker) this.flowMarker.visible = false;
    }
    this.requestRender();
  }
  private animate(time: number) {
    if (this.model.id === 'solar-system') for (const object of this.parts.values()) {
      const orbit = object.userData.orbit as { radius: number; phase: number; speed: number } | undefined;
      if (orbit) object.position.set(Math.cos(orbit.phase + time * orbit.speed) * orbit.radius, 0, Math.sin(orbit.phase + time * orbit.speed) * orbit.radius);
    }
    if (this.model.id === 'dna') for (const [id, object] of this.parts) {
      const original = this.originals.get(object)!; const offset = (1 - Math.cos(time * .7)) * .5;
      object.position.copy(original); object.position.x += (['backbone-a', 'adenine', 'cytosine'].includes(id) ? -1 : id === 'base-pair' ? 0 : 1) * offset;
    }
    if (this.model.id === 'chloroplast') for (const id of ['outer-membrane', 'inner-membrane']) { const object = this.parts.get(id)!; object.position.copy(this.originals.get(object)!); object.position.y -= (1 - Math.cos(time * .6)) * (id === 'outer-membrane' ? .8 : .4); }
    if (this.model.id === 'heart' && this.flowMarker && this.flowCurve) { this.flowMarker.visible = !this.isolated; this.flowMarker.position.copy(this.flowCurve.getPointAt((time / 14) % 1)); }
  }
  orbit(dx: number, dy: number) {
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) return;
    const spherical = new THREE.Spherical().setFromVector3(this.camera.position.clone().sub(this.controls.target));
    spherical.theta -= Math.max(-.2, Math.min(.2, dx)) * Math.PI; spherical.phi = Math.max(.06, Math.min(Math.PI - .06, spherical.phi + Math.max(-.2, Math.min(.2, dy)) * Math.PI));
    this.camera.position.copy(this.controls.target).add(new THREE.Vector3().setFromSpherical(spherical)); this.controls.update(); this.requestRender();
  }
  zoom(factor: number) {
    if (!Number.isFinite(factor) || factor <= 0) return;
    const offset = this.camera.position.clone().sub(this.controls.target), distance = Math.max(2, Math.min(45, offset.length() / Math.max(.5, Math.min(2, factor))));
    this.camera.position.copy(this.controls.target).add(offset.setLength(distance)); this.controls.update(); this.requestRender();
  }
  reset(presetId = 'overview') {
    const preset = this.model.cameraPresets.find(item => item.id === presetId) ?? this.model.cameraPresets[0]!;
    this.camera.position.set(...preset.position); this.controls.target.set(...preset.target); this.controls.update(); this.requestRender();
  }
  focusSelected() {
    const box = new THREE.Box3(); for (const id of this.selected) { const object = this.parts.get(id); if (object) box.union(new THREE.Box3().setFromObject(object)); }
    if (box.isEmpty()) return;
    const center = box.getCenter(new THREE.Vector3()), size = box.getSize(new THREE.Vector3()), distance = Math.max(3, size.length() * 1.35), direction = this.camera.position.clone().sub(this.controls.target).normalize();
    this.controls.target.copy(center); this.camera.position.copy(center).add(direction.multiplyScalar(distance)); this.controls.update(); this.requestRender();
  }
  selectAt(x: number, y: number): string | undefined {
    if (!this.loaded || !Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 1 || y < 0 || y > 1) return;
    this.raycaster.setFromCamera(new THREE.Vector2(x * 2 - 1, 1 - y * 2), this.camera);
    const matches = this.raycaster.intersectObjects([...this.parts.values()].filter(object => object.visible), true);
    for (const match of matches) {
      let object: THREE.Object3D | null = match.object;
      while (object) { const id = object.userData.partId as string | undefined; if (id && this.parts.has(id)) { this.options.onPart(id); return id; } object = object.parent; }
    }
  }
  getViewportRect() { return this.renderer.domElement.getBoundingClientRect(); }
  dispose() {
    if (this.disposed) return; this.disposed = true; this.abort.abort(); cancelAnimationFrame(this.frame); cancelAnimationFrame(this.readyFrame);
    this.resize.disconnect(); document.removeEventListener('visibilitychange', this.visibility);
    const canvas = this.renderer.domElement;
    canvas.removeEventListener('webglcontextlost', this.contextLost); canvas.removeEventListener('pointerdown', this.pointerStart); canvas.removeEventListener('pointerup', this.pointerEnd); canvas.removeEventListener('keydown', this.keyDown);
    this.controls.removeEventListener('change', this.requestRender); this.controls.dispose(); disposeObject(this.scene); this.renderer.dispose(); this.renderer.forceContextLoss(); canvas.remove(); this.parts.clear(); this.originals.clear();
  }
}
export function disposeObject(root: THREE.Object3D) {
  const geometries = new Set<THREE.BufferGeometry>(), materials = new Set<THREE.Material>(), textures = new Set<THREE.Texture>();
  root.traverse(object => { if (object instanceof THREE.Mesh) { geometries.add(object.geometry); for (const material of Array.isArray(object.material) ? object.material : [object.material]) { materials.add(material); for (const value of Object.values(material)) if (value instanceof THREE.Texture) textures.add(value); } } });
  for (const geometry of geometries) geometry.dispose(); for (const material of materials) material.dispose(); for (const texture of textures) { const image: unknown = texture.source.data; if (typeof ImageBitmap !== 'undefined' && image instanceof ImageBitmap) image.close(); texture.dispose(); }
  root.clear();
}
