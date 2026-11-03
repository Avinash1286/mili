# Tokai spatial lessons

These four GLB models are original procedural teaching illustrations, generated
from the source in `apps/web/src/lib/spatial/build-assets.ts`. No third-party
meshes, textures, scans, or image assets are embedded. The accompanying MIT
license applies to the original models and diagram layouts.

Regenerate from the repository root with:

    pnpm exec tsx scripts/generate-spatial-assets.ts

The command writes each GLB, `manifest.json`, and the SHA-256 catalog values in
`packages/contracts/src/spatial-assets.generated.ts`. It rejects missing semantic
parts and models exceeding the published geometry or download budgets. The
browser verifies the checksum before parsing and rejects external resource URLs.

Every selectable part maps to a real named group in the GLB. The original source
and manifest record semantic descriptions, camera presets, performance budgets,
animation explanations, provenance, scientific references, and a labeled 2D
fallback. The GLBs contain no textures. Download sizes range from about 129 KB to
402 KB; the manifest records exact byte and triangle counts.

- Solar system: Sun and eight planets. Sizes, distances, speeds, and orbital
  planes are simplified. NASA's planet descriptions informed the labels.
- DNA: schematic backbones and complementary A–T / C–G base pairs. This is not
  an atomic molecular model. The primary reference is NHGRI's DNA fact sheet.
- Chloroplast: schematic cutaway of the double envelope, stroma, grana,
  thylakoids and connecting lamellae. It is one organelle, not a whole plant
  cell. The reference is the NCBI Bookshelf chapter listed in the manifest.
- Heart: educational four-chamber and vessel schematic. It is not a medical
  or anatomical reference. Blue denotes lower oxygen in the illustration;
  human blood is not blue. Right and left refer to the person's body. The
  reference is NHLBI's blood-flow guide.

The references supply scientific grounding, not third-party geometry or copied
illustrations. Source websites' text, images and trademarks retain their own
rights. The models and animations make no claims of physical scale, diagnostic
accuracy, realistic fluid flow, or complete molecular/anatomical detail.
