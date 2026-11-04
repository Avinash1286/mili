import { z } from './zod-runtime';
import { SPATIAL_ASSET_HASHES } from './spatial-assets.generated';

export const SpatialModelIdSchema = z.enum(['solar-system', 'dna', 'chloroplast', 'heart']);
export type SpatialModelId = z.infer<typeof SpatialModelIdSchema>;
export type SpatialPart = {
  id: string; label: string; description: string; conceptIds: string[]; meshNames: string[];
  diagram: { x: number; y: number; width: number; height: number; color: string; shape: 'ellipse' | 'rectangle' };
};
export type SpatialModel = {
  id: SpatialModelId; title: string; description: string; topicIds: string[]; assetVersion: string; assetUrl: string; checksum: string;
  license: string; attribution: string; scaleNote: string; accessibilityDescription: string;
  sources: { title: string; url: string }[];
  parts: SpatialPart[]; cameraPresets: { id: string; label: string; position: [number, number, number]; target: [number, number, number] }[];
  animations: { id: string; label: string; description: string }[];
  budget: { maxBytes: number; maxTriangles: number; maxTextures: number; maxMeshes: number };
  fallback: { title: string; description: string; relations: { from: string; to: string; label: string }[] };
};
const part = (id: string, label: string, description: string, x: number, y: number, color: string, width = 110, height = 64, shape: 'ellipse' | 'rectangle' = 'ellipse'): SpatialPart => ({ id, label, description, conceptIds: [id], meshNames: [id], diagram: { x, y, width, height, color, shape } });
const common = (id: SpatialModelId) => ({
  id, assetVersion: '1.0.0', assetUrl: `/models/${id}.glb`, checksum: SPATIAL_ASSET_HASHES[id] ?? '', license: 'MIT',
  attribution: 'Original procedural geometry created for milli (2026). Source code and assets are included; no third-party meshes or textures.',
  budget: { maxBytes: 2_000_000, maxTriangles: 50_000, maxTextures: 0, maxMeshes: 160 },
});
export const SPATIAL_CATALOG: SpatialModel[] = [
  {
    ...common('solar-system'), title: 'Our solar system', topicIds: ['solar-system'],
    description: 'Trace the order of the eight planets around the Sun and compare rocky and giant planets.',
    scaleNote: 'Illustrative model. Planet sizes, orbital distances and orbital speeds are deliberately compressed; orbits are shown as circles in one plane. This is not a scale simulation.',
    accessibilityDescription: 'The Sun sits at the center of eight nested orbital rings. Planets are individually selectable, from Mercury through Neptune.',
    sources: [{ title: 'NASA: About the planets', url: 'https://science.nasa.gov/solar-system/planets/' }],
    cameraPresets: [{ id: 'overview', label: 'Overview', position: [0, 18, 23], target: [0, 0, 0] }, { id: 'top', label: 'From above', position: [0, 29, .01], target: [0, 0, 0] }],
    animations: [{ id: 'orbit', label: 'Orbit planets', description: 'Illustrative orbital motion, with deliberately simplified periods.' }],
    parts: [
      part('sun', 'Sun', 'The Sun is a star. Its gravity holds the solar system together, and its light supplies energy to Earth.', 345, 170, '#e8bf62', 110, 90),
      part('mercury', 'Mercury', 'Mercury is the closest planet to the Sun and the smallest of the eight planets. It is a rocky world.', 35, 45, '#b4a38c'),
      part('venus', 'Venus', 'Venus is the second planet from the Sun. Its dense atmosphere traps heat, making its surface hotter than Mercury’s.', 200, 45, '#d5ab72'),
      part('earth', 'Earth', 'Earth is the third planet from the Sun, a rocky world with liquid oceans and the only world known to support life.', 365, 45, '#6d9ca3'),
      part('mars', 'Mars', 'Mars is the fourth planet from the Sun. Iron-bearing minerals give this rocky planet its reddish appearance.', 530, 45, '#bc8066'),
      part('jupiter', 'Jupiter', 'Jupiter is the fifth planet and the largest planet in the solar system. It is a gas giant.', 35, 310, '#c49b74'),
      part('saturn', 'Saturn', 'Saturn is the sixth planet. It is a gas giant surrounded by a prominent system of rings made mostly of ice particles.', 200, 310, '#cfbb85'),
      part('uranus', 'Uranus', 'Uranus is the seventh planet. This ice giant rotates with its axis tilted almost into the plane of its orbit.', 365, 310, '#8ebbbe'),
      part('neptune', 'Neptune', 'Neptune is the eighth and most distant planet from the Sun. It is an ice giant.', 530, 310, '#7196bc'),
    ], fallback: { title: 'Planet order', description: 'Read outward from the Sun: Mercury, Venus, Earth, Mars, Jupiter, Saturn, Uranus and Neptune. The diagram is not to scale.', relations: [] },
  },
  {
    ...common('dna'), title: 'Inside the DNA double helix', topicIds: ['dna'],
    description: 'See two sugar–phosphate backbones and the complementary base pairs that connect them.',
    scaleNote: 'A schematic double helix, not an atomistic molecular model. Colors are teaching labels; bond lengths, helix pitch and base shapes are illustrative.',
    accessibilityDescription: 'Two twisting backbones form the sides of a ladder. Adenine pairs with thymine; cytosine pairs with guanine. Base pairs form the rungs.',
    sources: [{ title: 'NHGRI: DNA fact sheet', url: 'https://www.genome.gov/about-genomics/fact-sheets/Deoxyribonucleic-Acid-Fact-Sheet' }],
    cameraPresets: [{ id: 'overview', label: 'Overview', position: [8, 5, 13], target: [0, 0, 0] }, { id: 'side', label: 'From the side', position: [0, 0, 16], target: [0, 0, 0] }, { id: 'top', label: 'Down the helix', position: [0, 16, .01], target: [0, 0, 0] }],
    animations: [{ id: 'separate', label: 'Separate strands', description: 'Separates the two illustrated strands to reveal base pairing. This is not a replication simulation.' }],
    parts: [
      part('backbone-a', 'First backbone', 'Alternating sugar and phosphate groups form one outer strand of the DNA molecule.', 60, 110, '#6e9b83', 120, 230, 'rectangle'),
      part('backbone-b', 'Second backbone', 'The second sugar–phosphate backbone runs alongside the first. The two strands are held together through paired bases.', 530, 110, '#a7b976', 120, 230, 'rectangle'),
      part('adenine', 'Adenine (A)', 'Adenine is one of DNA’s four bases. In DNA it pairs with thymine.', 245, 105, '#d4ae59'),
      part('thymine', 'Thymine (T)', 'Thymine is one of DNA’s four bases. In DNA it pairs with adenine.', 380, 105, '#b98b67'),
      part('cytosine', 'Cytosine (C)', 'Cytosine is one of DNA’s four bases. In DNA it pairs with guanine.', 245, 285, '#76a6b0'),
      part('guanine', 'Guanine (G)', 'Guanine is one of DNA’s four bases. In DNA it pairs with cytosine.', 380, 285, '#a188ae'),
      part('base-pair', 'A base pair', 'A base pair joins complementary bases across the double helix: A with T, or C with G. The sequence of bases carries biological information.', 280, 195, '#b8b98d', 160, 56, 'rectangle'),
    ], fallback: { title: 'Complementary base pairing', description: 'Two sugar–phosphate backbones enclose the paired bases. Read A–T and C–G across the ladder.', relations: [{ from: 'adenine', to: 'thymine', label: 'pairs with' }, { from: 'cytosine', to: 'guanine', label: 'pairs with' }] },
  },
  {
    ...common('chloroplast'), title: 'A chloroplast, opened up', topicIds: ['photosynthesis'],
    description: 'Explore the membranes and internal compartments where photosynthesis takes place.',
    scaleNote: 'Schematic cutaway of one chloroplast, not a whole plant cell. Compartments and membranes are enlarged for teaching and are not drawn to scale.',
    accessibilityDescription: 'An outer and inner envelope enclose the stroma. Stacks of thylakoid discs called grana sit inside, connected by lamellae.',
    sources: [{ title: 'NCBI Bookshelf: Chloroplasts and photosynthesis', url: 'https://www.ncbi.nlm.nih.gov/books/NBK26819/' }],
    cameraPresets: [{ id: 'overview', label: 'Cutaway view', position: [10, 8, 12], target: [0, 0, 0] }, { id: 'side', label: 'From the side', position: [0, 3, 15], target: [0, 0, 0] }, { id: 'top', label: 'From above', position: [0, 16, .01], target: [0, 0, 0] }],
    animations: [{ id: 'expand', label: 'Expand the cutaway', description: 'Moves the schematic envelope apart to reveal the internal compartments.' }],
    parts: [
      part('outer-membrane', 'Outer membrane', 'The outer membrane is one layer of the chloroplast envelope that separates the organelle from the cell’s cytoplasm.', 35, 55, '#8aa879', 170, 70),
      part('inner-membrane', 'Inner membrane', 'The inner membrane surrounds the stroma. It is the second membrane of the chloroplast envelope.', 245, 55, '#adc28d', 170, 70),
      part('stroma', 'Stroma', 'The stroma is the fluid compartment inside the inner membrane and outside the thylakoids. Carbon fixation reactions take place here.', 455, 55, '#ced6a2', 170, 70),
      part('granum', 'Granum', 'A granum is a stack of flattened thylakoids. A chloroplast usually contains several grana.', 35, 265, '#527d50', 170, 70),
      part('thylakoid', 'Thylakoid membrane', 'Thylakoid membranes contain chlorophyll and the molecular machinery for the light-dependent reactions of photosynthesis.', 245, 265, '#78a766', 170, 70),
      part('lamella', 'Stroma lamella', 'Stroma lamellae connect the thylakoid membranes of different grana.', 455, 265, '#a2ba6f', 170, 70),
    ], fallback: { title: 'Chloroplast compartments', description: 'The two envelope membranes surround the stroma. Inside are grana made of thylakoid discs, with lamellae connecting the stacks.', relations: [{ from: 'outer-membrane', to: 'inner-membrane', label: 'encloses' }, { from: 'inner-membrane', to: 'stroma', label: 'surrounds' }, { from: 'granum', to: 'thylakoid', label: 'stack of' }] },
  },
  {
    ...common('heart'), title: 'Follow blood through the heart', topicIds: ['heart'],
    description: 'Follow the two pumping circuits through the four chambers and major blood vessels.',
    scaleNote: 'An educational schematic, not a medical or anatomical reference. Shape, wall thickness and vessel paths are simplified. Blue means lower oxygen in this diagram; human blood is never blue. Right and left refer to the person’s body.',
    accessibilityDescription: 'In the front view, the right heart is on the viewer’s left. Blood travels from the body to the right atrium, right ventricle and lungs, then to the left atrium, left ventricle and body.',
    sources: [{ title: 'NHLBI: How blood flows through the heart', url: 'https://www.nhlbi.nih.gov/health/heart/blood-flow' }],
    cameraPresets: [{ id: 'overview', label: 'Front view', position: [0, 3, 15], target: [0, 0, 0] }, { id: 'side', label: 'Side view', position: [14, 3, 2], target: [0, 0, 0] }],
    animations: [{ id: 'flow', label: 'Trace blood flow', description: 'A moving marker traces the schematic flow route. It does not represent real flow speed or a cardiac cycle.' }],
    parts: [
      part('right-atrium', 'Right atrium', 'The right atrium receives oxygen-poor blood returning from the body through the venae cavae.', 105, 115, '#739db4', 150, 74),
      part('right-ventricle', 'Right ventricle', 'The right ventricle pumps blood to the lungs through the pulmonary artery.', 105, 265, '#5c89a3', 150, 84),
      part('left-atrium', 'Left atrium', 'The left atrium receives oxygen-rich blood returning from the lungs through the pulmonary veins.', 455, 115, '#cf8d7b', 150, 74),
      part('left-ventricle', 'Left ventricle', 'The left ventricle pumps oxygen-rich blood to the body through the aorta.', 455, 265, '#b96d60', 150, 84),
      part('vena-cava', 'Venae cavae', 'The superior and inferior venae cavae carry blood from the body into the right atrium.', 20, 20, '#91aebe', 150, 56, 'rectangle'),
      part('pulmonary-artery', 'Pulmonary artery', 'The pulmonary artery carries oxygen-poor blood away from the right ventricle toward the lungs.', 205, 20, '#7d9cb5', 150, 56, 'rectangle'),
      part('pulmonary-veins', 'Pulmonary veins', 'The pulmonary veins carry oxygen-rich blood from the lungs into the left atrium.', 390, 20, '#d8a08c', 150, 56, 'rectangle'),
      part('aorta', 'Aorta', 'The aorta carries oxygen-rich blood from the left ventricle to the body.', 575, 20, '#bd7b69', 110, 56, 'rectangle'),
      part('valves', 'Heart valves', 'Valves open and close to keep blood moving forward. Four valves separate the pumping stages in the heart.', 305, 200, '#d8bc78', 100, 70),
    ], fallback: { title: 'The blood-flow route', description: 'Body → right atrium → right ventricle → lungs → left atrium → left ventricle → body. The pulmonary circuit exchanges gases at the lungs; the systemic circuit supplies the body.', relations: [{ from: 'vena-cava', to: 'right-atrium', label: 'from body' }, { from: 'right-atrium', to: 'right-ventricle', label: 'through valve' }, { from: 'right-ventricle', to: 'pulmonary-artery', label: 'to lungs' }, { from: 'pulmonary-veins', to: 'left-atrium', label: 'from lungs' }, { from: 'left-atrium', to: 'left-ventricle', label: 'through valve' }, { from: 'left-ventricle', to: 'aorta', label: 'to body' }] },
  },
];
export function getSpatialModel(id: string): SpatialModel | undefined { return SPATIAL_CATALOG.find(model => model.id === id); }
export function spatialModelForTopic(topic: string): SpatialModel | undefined { return SPATIAL_CATALOG.find(model => model.topicIds.includes(topic)); }
export const SpatialSelectionSchema = z.object({ modelId: SpatialModelIdSchema, assetVersion: z.string().min(1).max(30), partIds: z.array(z.string().min(1).max(80)).max(8) }).strict().superRefine((selection, context) => {
  const model = getSpatialModel(selection.modelId)!;
  if (model.assetVersion !== selection.assetVersion) context.addIssue({ code: 'custom', message: 'This model version is no longer current. Select a part again.', path: ['assetVersion'] });
  if (new Set(selection.partIds).size !== selection.partIds.length || selection.partIds.some(id => !model.parts.some(part => part.id === id))) context.addIssue({ code: 'custom', message: 'Selection must reference unique parts of this model.', path: ['partIds'] });
});
export type SpatialSelection = z.infer<typeof SpatialSelectionSchema>;
export function resolveSpatialSelection(value: unknown): { model: SpatialModel; parts: SpatialPart[] } {
  const selection = SpatialSelectionSchema.parse(value), model = getSpatialModel(selection.modelId)!;
  return { model, parts: model.parts.filter(part => selection.partIds.includes(part.id)) };
}
