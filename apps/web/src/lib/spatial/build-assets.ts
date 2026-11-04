/** Original, deterministic teaching geometry. This module runs only in the asset generator. */
import * as THREE from 'three';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import type { SpatialModelId } from '@milli/contracts';

const colors = { green: '#6e9b83', yellow: '#d4ae59', blue: '#76a6b0', red: '#b96d60' };
function group(root: THREE.Object3D, name: string) { const value = new THREE.Group(); value.name = name; value.userData.partId = name; root.add(value); return value; }
function mesh(parent: THREE.Object3D, geometry: THREE.BufferGeometry, color: string, position: [number, number, number] = [0, 0, 0], scale: [number, number, number] = [1, 1, 1], opacity = 1) {
  const value = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color, roughness: .7, metalness: .02, transparent: opacity < 1, opacity, side: THREE.DoubleSide, depthWrite: opacity === 1 }));
  value.name = `${parent.name}-mesh-${parent.children.length}`; value.position.set(...position); value.scale.set(...scale); parent.add(value); return value;
}
function ball(parent: THREE.Object3D, color: string, position: [number, number, number], scale: [number, number, number]) { return mesh(parent, new THREE.SphereGeometry(1, 24, 16), color, position, scale); }
function tube(parent: THREE.Object3D, color: string, points: [number, number, number][], radius = .16) {
  return mesh(parent, new THREE.TubeGeometry(new THREE.CatmullRomCurve3(points.map(point => new THREE.Vector3(...point))), 40, radius, 8, false), color);
}
function rod(parent: THREE.Object3D, color: string, a: THREE.Vector3, b: THREE.Vector3, radius = .12) {
  const direction = b.clone().sub(a), middle = a.clone().add(b).multiplyScalar(.5), value = mesh(parent, new THREE.CylinderGeometry(radius, radius, direction.length(), 12), color, middle.toArray() as [number, number, number]);
  value.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction.normalize()); return value;
}
function solar(scene: THREE.Scene) {
  ball(group(scene, 'sun'), '#e8bf62', [0, 0, 0], [.8, .8, .8]);
  const ids = ['mercury', 'venus', 'earth', 'mars', 'jupiter', 'saturn', 'uranus', 'neptune'];
  const palette = ['#b4a38c', '#d5ab72', '#6d9ca3', '#bc8066', '#c49b74', '#cfbb85', '#8ebbbe', '#7196bc'];
  const sizes = [.19, .29, .32, .25, .64, .56, .43, .42];
  const decoration = group(scene, 'orbital-guides'); delete decoration.userData.partId;
  ids.forEach((id, index) => {
    const orbit = 1.7 + index * 1.1, angle = index * .78 + .4, planet = group(scene, id);
    planet.position.set(Math.cos(angle) * orbit, 0, Math.sin(angle) * orbit);
    planet.userData.orbit = { radius: orbit, phase: angle, speed: .5 / (index + 1) };
    ball(planet, palette[index]!, [0, 0, 0], [sizes[index]!, sizes[index]!, sizes[index]!]);
    const ring = mesh(decoration, new THREE.TorusGeometry(orbit, .012, 4, 100), '#c9d0bd'); ring.rotation.x = Math.PI / 2;
    if (id === 'saturn') { const rings = mesh(planet, new THREE.TorusGeometry(.87, .13, 4, 60), '#cdbd91'); rings.rotation.x = Math.PI / 2.4; }
    if (id === 'earth') { ball(planet, '#a7be88', [.11, .14, .18], [.14, .07, .14]); ball(planet, '#a7be88', [-.13, -.04, .22], [.1, .16, .07]); }
  });
}
function dna(scene: THREE.Scene) {
  const pointsA: [number, number, number][] = [], pointsB: [number, number, number][] = [], count = 12, height = 9;
  for (let i = 0; i <= 160; i++) { const t = i / 160, angle = t * Math.PI * 4; pointsA.push([Math.cos(angle) * 1.7, t * height - height / 2, Math.sin(angle) * 1.7]); pointsB.push([-Math.cos(angle) * 1.7, t * height - height / 2, -Math.sin(angle) * 1.7]); }
  tube(group(scene, 'backbone-a'), colors.green, pointsA, .18); tube(group(scene, 'backbone-b'), '#a7b976', pointsB, .18);
  const bases = { adenine: group(scene, 'adenine'), thymine: group(scene, 'thymine'), cytosine: group(scene, 'cytosine'), guanine: group(scene, 'guanine') }, pair = group(scene, 'base-pair');
  for (let i = 0; i < count; i++) {
    const t = (i + .5) / count, angle = t * Math.PI * 4, y = t * height - height / 2;
    const a = new THREE.Vector3(Math.cos(angle) * 1.65, y, Math.sin(angle) * 1.65), b = a.clone().set(-a.x, y, -a.z), middle = new THREE.Vector3(0, y, 0);
    const first = i % 2 ? bases.cytosine : bases.adenine, second = i % 2 ? bases.guanine : bases.thymine;
    const firstColor = i % 2 ? colors.blue : colors.yellow, secondColor = i % 2 ? '#a188ae' : '#b98b67';
    rod(i === 5 ? pair : first, firstColor, a, middle, .14); rod(i === 5 ? pair : second, secondColor, middle, b, .14);
  }
}
function chloroplast(scene: THREE.Scene) {
  const shell = new THREE.SphereGeometry(1, 40, 20, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2);
  mesh(group(scene, 'outer-membrane'), shell, '#8aa879', [0, 0, 0], [4.5, 2.0, 2.7], .5);
  mesh(group(scene, 'inner-membrane'), shell.clone(), '#adc28d', [0, .02, 0], [4.2, 1.75, 2.42], .5);
  mesh(group(scene, 'stroma'), new THREE.SphereGeometry(1, 32, 12), '#ced6a2', [0, -.6, 0], [3.9, .6, 2.12], .28);
  const grana = group(scene, 'granum'), thylakoid = group(scene, 'thylakoid');
  for (const [index, x] of [-2.3, 0, 2.3].entries()) for (let level = 0; level < 5; level++) {
    mesh(index === 1 && level === 4 ? thylakoid : grana, new THREE.CylinderGeometry(.75, .75, .17, 28), index === 1 && level === 4 ? '#a5c275' : '#527d50', [x, -.2 + level * .24, 0], [1, 1, .9]);
  }
  const lamella = group(scene, 'lamella');
  mesh(lamella, new THREE.BoxGeometry(3.5, .08, .5), '#a2ba6f', [-.9, -.05, .25]);
  mesh(lamella, new THREE.BoxGeometry(3.5, .08, .5), '#a2ba6f', [.9, .42, -.25]);
}
function heart(scene: THREE.Scene) {
  ball(group(scene, 'right-atrium'), '#739db4', [-1.4, 1.5, 0], [1.05, .95, .85]);
  ball(group(scene, 'left-atrium'), '#cf8d7b', [1.4, 1.5, 0], [1.05, .95, .85]);
  const right = ball(group(scene, 'right-ventricle'), '#5c89a3', [-1.25, -.8, 0], [1.1, 1.55, .95]); right.rotation.z = .12;
  const left = ball(group(scene, 'left-ventricle'), '#b96d60', [1.25, -.9, 0], [1.2, 1.7, 1]); left.rotation.z = -.12;
  const vena = group(scene, 'vena-cava'); tube(vena, '#91aebe', [[-2, 3.8, 0], [-2, 2.5, 0], [-1.5, 1.5, 0]], .34); tube(vena, '#91aebe', [[-2.8, -3, -.3], [-2.5, 0, -.3], [-1.5, 1.5, 0]], .3);
  tube(group(scene, 'pulmonary-artery'), '#7d9cb5', [[-1.2, -.4, .6], [-.6, 1.5, 1], [-.7, 3.1, .5], [-3.4, 3.1, .1]], .3);
  const veins = group(scene, 'pulmonary-veins'); tube(veins, '#d8a08c', [[3.8, 2.3, -.2], [2.5, 2, -.2], [1.4, 1.5, 0]], .28); tube(veins, '#d8a08c', [[3.8, 1.1, -.3], [2.5, 1.1, -.3], [1.4, 1.5, 0]], .25);
  tube(group(scene, 'aorta'), '#bd7b69', [[1.2, -.4, .5], [.6, 1.5, .5], [1, 3.8, 0], [2.8, 3.3, -.8], [3.1, -2.8, -1]], .34);
  const valves = group(scene, 'valves');
  for (const position of [[-1.4, .4, .75], [1.4, .3, .8], [-.6, 1.1, 1.2], [.6, 1.1, .8]] as [number, number, number][]) mesh(valves, new THREE.TorusGeometry(.31, .08, 8, 24), '#d8bc78', position);
  scene.userData.flowPath = [[-2, 3.8, 0], [-1.4, 1.5, .9], [-1.25, -.8, 1], [-.6, 1.5, 1.35], [-3.4, 3.1, .4], [3.8, 2.3, .2], [1.4, 1.5, 1], [1.25, -.9, 1.15], [.6, 1.5, 1], [1, 3.8, .4], [3.1, -2.8, -.6]];
}
export function createSpatialAsset(id: SpatialModelId): THREE.Scene {
  const scene = new THREE.Scene(); scene.name = `tokai-${id}`;
  ({ 'solar-system': solar, dna, chloroplast, heart })[id](scene);
  scene.userData = { ...scene.userData, author: 'milli', version: '1.0.0', license: 'MIT', illustrative: true };
  return scene;
}
export async function exportSpatialAsset(id: SpatialModelId): Promise<{ bytes: Uint8Array; meshNames: string[]; triangles: number; meshes: number }> {
  const scene = createSpatialAsset(id), meshNames: string[] = []; let triangles = 0, meshes = 0;
  scene.traverse(object => { meshNames.push(object.name); if (object instanceof THREE.Mesh) { meshes++; triangles += (object.geometry.index?.count ?? object.geometry.getAttribute('position').count) / 3; } });
  try {
    const result = await new GLTFExporter().parseAsync(scene, { binary: true, onlyVisible: false, trs: true });
    if (!(result instanceof ArrayBuffer)) throw new Error('GLB export must return binary data.');
    return { bytes: new Uint8Array(result), meshNames, triangles, meshes };
  } finally {
    scene.traverse(object => { if (object instanceof THREE.Mesh) { object.geometry.dispose(); for (const material of Array.isArray(object.material) ? object.material : [object.material]) material.dispose(); } });
  }
}
