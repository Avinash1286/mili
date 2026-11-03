import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { SPATIAL_CATALOG } from '@tokai/contracts';
import { disposeObject, validateSpatialGlb } from '../src/lib/spatial/renderer';

function arrayBuffer(bytes: Uint8Array): ArrayBuffer { return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer; }
describe('original spatial assets', () => {
  for (const model of SPATIAL_CATALOG) it(`${model.id} loads real geometry for every named teaching part within its published budget`, async () => {
    const bytes = readFileSync(resolve('public', model.assetUrl.slice(1))), buffer = arrayBuffer(bytes);
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(model.checksum);
    expect(model.checksum).toMatch(/^[a-f0-9]{64}$/);
    validateSpatialGlb(buffer, model);
    const result = await new GLTFLoader().parseAsync(buffer, '');
    let triangles = 0, meshes = 0;
    result.scene.traverse(object => {
      if (!(object instanceof THREE.Mesh)) return;
      meshes++; const positions = object.geometry.getAttribute('position'); triangles += (object.geometry.index?.count ?? positions.count) / 3;
      expect(Array.from(positions.array).every(Number.isFinite)).toBe(true);
    });
    expect(meshes).toBeGreaterThan(model.parts.length); expect(meshes).toBeLessThanOrEqual(model.budget.maxMeshes);
    expect(triangles).toBeGreaterThan(1000); expect(triangles).toBeLessThanOrEqual(model.budget.maxTriangles);
    for (const part of model.parts) {
      const object = result.scene.getObjectByName(part.meshNames[0]!)!;
      expect(object.userData.partId).toBe(part.id);
      const dimensions = new THREE.Box3().setFromObject(object).getSize(new THREE.Vector3());
      expect(dimensions.length()).toBeGreaterThan(.1);
    }
    disposeObject(result.scene);
  });
  it('rejects truncated files and external-resource GLBs before handing them to the loader', () => {
    const model = SPATIAL_CATALOG[0]!;
    expect(() => validateSpatialGlb(new ArrayBuffer(10), model)).toThrow();
    const json = JSON.stringify({ buffers: [{ uri: 'https://example.invalid/remote.bin' }], nodes: model.parts.map(part => ({ name: part.id })) });
    const encoded = new TextEncoder().encode(json.padEnd(Math.ceil(json.length / 4) * 4, ' '));
    const fake = new ArrayBuffer(20 + encoded.length), view = new DataView(fake);
    view.setUint32(0, 0x46546c67, true); view.setUint32(4, 2, true); view.setUint32(8, fake.byteLength, true); view.setUint32(12, encoded.length, true); view.setUint32(16, 0x4e4f534a, true);
    new Uint8Array(fake, 20).set(encoded);
    expect(() => validateSpatialGlb(fake, model)).toThrow('external');
  });
  it('disposes shared GPU resources once when closing a model', () => {
    const geometry = new THREE.BoxGeometry(), texture = new THREE.Texture(), material = new THREE.MeshStandardMaterial({ map: texture }), scene = new THREE.Scene();
    scene.add(new THREE.Mesh(geometry, material), new THREE.Mesh(geometry, material));
    const geometryDispose = vi.spyOn(geometry, 'dispose'), materialDispose = vi.spyOn(material, 'dispose'), textureDispose = vi.spyOn(texture, 'dispose');
    disposeObject(scene);
    expect(geometryDispose).toHaveBeenCalledTimes(1); expect(materialDispose).toHaveBeenCalledTimes(1); expect(textureDispose).toHaveBeenCalledTimes(1); expect(scene.children).toHaveLength(0);
  });
});
