import { CourseScriptSchema, validateCourseScript, type CourseScript, type Topic } from '@milli/contracts';

/**
 * Authored interactive step-by-step courses in the milli format.
 * Each course is a deterministic prepared script (never presented as live AI) that exercises
 * every visual primitive and interaction type.
 */
const PHOTOSYNTHESIS: CourseScript = CourseScriptSchema.parse({
  version: 1, title: 'How plants make their food', topic: 'photosynthesis', provenance: 'authored',
  summary: 'Chloroplasts capture light in the thylakoids, split water, and use ATP + NADPH in the stroma to build sugar from CO₂.',
  concepts: [{ id: 'inputs', label: 'Light, water, and CO₂' }, { id: 'thylakoid', label: 'Light reactions' }, { id: 'calvin', label: 'Calvin cycle' }],
  cards: [
    { front: 'Where does the oxygen released by a leaf come from?', back: 'From splitting water (H₂O) during the light-dependent reactions.' },
    { front: 'What do ATP and NADPH carry from the thylakoid to the stroma?', back: 'Chemical energy and high-energy electrons used to fix CO₂ into sugar.' },
  ],
  chapters: [
    {
      id: 'ch-1', title: 'What goes in, what comes out', goal: 'Separate the raw materials of photosynthesis from its products.', status: 'ready',
      steps: [
        {
          id: 'ph-1', kind: 'question', title: 'A sealed jar in the sun',
          body: 'A leafy sprig sits in water under a lamp. Tiny bubbles rise from the leaves and collect at the top of the tube.\n\nSort what the leaf **takes in** versus what it **makes**.',
          conceptSpeech: 'Imagine switching on this lamp and seeing bubbles drift up from a submerged leaf. Follow the arrows to see how the leaf makes something new.',
          visual: {
            kind: 'flow', id: 'v-ph-1', alt: 'Sunlight and inputs enter a leaf; sugar and oxygen leave.', layout: 'row',
            nodes: [
              { id: 'n-sun', label: 'Sunlight', emoji: '☀️', detail: 'Energy source', color: 'yellow' },
              { id: 'n-leaf', label: 'Chloroplast', emoji: '🌿', detail: 'Inside leaf cells', color: 'green' },
              { id: 'n-out', label: 'Sugar + O₂', emoji: '🫧', detail: 'Food & gas bubbles', color: 'teal' },
            ],
            links: [{ from: 'n-sun', to: 'n-leaf', label: 'drives' }, { from: 'n-leaf', to: 'n-out', label: 'produces' }],
          },
          interaction: {
            type: 'categorize',
            buckets: [{ id: 'in', label: 'Taken in (inputs)' }, { id: 'out', label: 'Made (outputs)' }],
            items: [
              { id: 'water', text: 'Water (H₂O)', bucket: 'in' },
              { id: 'co2', text: 'Carbon dioxide (CO₂)', bucket: 'in' },
              { id: 'glucose', text: 'Glucose (sugar)', bucket: 'out' },
              { id: 'oxygen', text: 'Oxygen gas (O₂)', bucket: 'out' },
            ],
          },
          hint: 'Which gas forms the bubbles leaving the submerged leaf?',
          explanation: 'Water reaches the leaf through the stem, and carbon dioxide enters through tiny pores. Using light energy, the plant builds sugars and releases oxygen, which can collect in bubbles.',
        },
        {
          id: 'ph-2', kind: 'question', title: 'Counting molecules',
          body: 'To build **1 molecule of glucose** (C₆H₁₂O₆), a plant needs 6 carbon atoms.\n\nComplete the balanced overall summary by dragging tiles into the blanks.',
          visual: {
            kind: 'table', id: 'v-ph-2', alt: 'Atom balance: 6 carbons in 6 CO₂ match 6 carbons in 1 C₆H₁₂O₆.',
            headers: ['Molecule', 'Role', 'Count per glucose'],
            rows: [['CO₂', 'Carbon source', '6'], ['H₂O', 'Electron source', '6'], ['C₆H₁₂O₆', 'Sugar product', '1'], ['O₂', 'Released gas', '6']],
          },
          interaction: {
            type: 'fill-tiles',
            template: '{c} CO₂ + {w} H₂O + light → 1 glucose + {o} O₂',
            tiles: [{ id: 't1', text: '1' }, { id: 't2', text: '2' }, { id: 't6', text: '6' }, { id: 't12', text: '12' }],
            slots: [{ id: 'c', accept: ['t6'] }, { id: 'w', accept: ['t6'] }, { id: 'o', accept: ['t6'] }],
          },
          hint: 'Each CO₂ brings 1 carbon atom, and glucose has 6 carbons.',
          explanation: 'Six CO₂ molecules supply the 6 carbons in C₆H₁₂O₆. In the net classroom equation, 6 H₂O are consumed and 6 O₂ are released.',
        },
        {
          id: 'ph-3', kind: 'question', title: 'Where does the O₂ come from?',
          body: 'Both CO₂ and H₂O contain oxygen atoms. Isotopic tracer experiments tagged water with heavy oxygen ($^{18}\\text{O}$).\n\nTrue or false: **The oxygen gas released by plants comes from splitting water, not from CO₂.**',
          visual: {
            kind: 'shapes', id: 'v-ph-3', alt: 'Water H₂O splits at the thylakoid into O₂ gas and hydrogen ions.',
            elements: [
              { id: 'sh-water', type: 'rect', x: 20, y: 40, w: 105, h: 60, rounded: true, fill: 'blue', label: '2 H₂O' },
              { id: 'sh-arrow', type: 'line', x1: 130, y1: 70, x2: 185, y2: 70, arrow: true, fill: 'green' },
              { id: 'sh-thyl', type: 'circle', cx: 225, cy: 70, r: 34, fill: 'green', label: 'Light' },
              { id: 'sh-arrow2', type: 'line', x1: 265, y1: 70, x2: 310, y2: 70, arrow: true, fill: 'teal' },
              { id: 'sh-o2', type: 'rect', x: 315, y: 40, w: 95, h: 60, rounded: true, fill: 'teal', label: 'O₂ + 4H⁺' },
            ],
          },
          interaction: { type: 'true-false', statement: 'Released O₂ gas comes from splitting water (H₂O).', answer: true },
          hint: 'Follow the arrow starting at 2 H₂O in the diagram.',
          explanation: 'True. Photosystem II splits water molecules to replace excited electrons, releasing O₂ gas. The oxygen in CO₂ ends up in sugar and water.',
        },
      ],
    },
    {
      id: 'ch-2', title: 'Inside the chloroplast', goal: 'Connect the light reactions in the thylakoid to the Calvin cycle in the stroma.', status: 'ready',
      steps: [
        {
          id: 'ph-4', kind: 'question', title: 'Two linked stages',
          body: 'Photosynthesis happens in two stages inside the chloroplast. Put the chain of events in order from sunlight arriving to sugar leaving.',
          visual: {
            kind: 'flow', id: 'v-ph-4', alt: 'Thylakoid membranes make ATP and NADPH, which feed the Calvin cycle in the stroma.', layout: 'cycle',
            nodes: [
              { id: 'f-light', label: 'Thylakoid', emoji: '⚡', detail: 'Splits H₂O, makes ATP + NADPH', color: 'green' },
              { id: 'f-carry', label: 'ATP & NADPH', emoji: '🔋', detail: 'Shuttle energy to stroma', color: 'yellow' },
              { id: 'f-calvin', label: 'Calvin cycle', emoji: '🔄', detail: 'Fixes CO₂ into sugar', color: 'teal' },
            ],
            links: [{ from: 'f-light', to: 'f-carry', label: 'charges' }, { from: 'f-carry', to: 'f-calvin', label: 'powers' }, { from: 'f-calvin', to: 'f-light', label: 'returns ADP + NADP⁺' }],
          },
          interaction: {
            type: 'order', prompt: 'Order from first (top) to last (bottom):',
            items: [
              { id: 'step-1', text: 'Chlorophyll in the thylakoid absorbs light and splits water' },
              { id: 'step-2', text: 'Electron transport charges up ATP and NADPH' },
              { id: 'step-3', text: 'The Calvin cycle in the stroma uses ATP + NADPH to fix CO₂ into sugar' },
            ],
          },
          hint: 'Can the Calvin cycle run before energy carriers (ATP and NADPH) are charged?',
          explanation: 'Light first excites electrons in the thylakoid and splits water, producing ATP and NADPH. Those carriers then drive carbon fixation in the stroma.',
        },
        {
          id: 'ph-5', kind: 'question', title: 'Peak rate vs. light intensity',
          body: 'This simplified model shows that brighter light helps at first. Eventually something else, such as the supply of carbon dioxide, limits the rate.\n\nMark where the rate first reaches 8 and starts to level off.',
          conceptSpeech: 'Imagine turning up a grow lamp. At first it helps. Trace the line from left to right and notice what happens when the lamp gets even brighter.',
          visual: {
            kind: 'plot', id: 'v-ph-5', alt: 'Photosynthesis rate rises from 0 to 8 between light 0 and 6, then stays flat at 8.',
            title: 'Photosynthesis rate vs. light', xLabel: 'Light intensity', yLabel: 'Rate',
            x: { min: 0, max: 10, step: 1 }, y: { min: 0, max: 10, step: 1 },
            points: [{ id: 'p0', x: 0, y: 0, color: 'gray' }, { id: 'p3', x: 3, y: 4, color: 'green' }, { id: 'p6', x: 6, y: 8, color: 'green' }, { id: 'p9', x: 9, y: 8, color: 'green' }],
            functions: [
              { id: 'fn-rise', expr: '4 * x / 3', domain: [0, 6], color: 'green' },
              { id: 'fn-flat', expr: '8', domain: [6, 10], color: 'green' },
            ],
          },
          interaction: { type: 'mark-points', targets: [{ x: 6, y: 8 }], tolerance: 0.6 },
          hint: 'Look for the marked point at height 8 where the curve levels off.',
          explanation: 'At light intensity 6 the rate reaches 8 and plateaus — beyond that, CO₂ or Calvin-cycle enzymes limit the speed, not light.',
        },
        {
          id: 'ph-6', kind: 'question', title: 'What if the lamp turns off?',
          body: 'Suppose a leaf is moved into the dark while plenty of carbon dioxide is still around.\n\nWhy can’t the Calvin cycle keep running at the same rate?',
          interaction: {
            type: 'mcq',
            options: [
              { id: 'no-atp', text: 'The thylakoids stop supplying fresh ATP and NADPH' },
              { id: 'no-co2', text: 'CO₂ can only enter a leaf when light hits it' },
              { id: 'roots', text: 'Water immediately flows backward into the roots' },
            ],
            correct: ['no-atp'],
            feedback: [
              { optionId: 'no-co2', text: 'CO₂ is already present in the air space; the missing ingredient is chemical energy.' },
              { optionId: 'roots', text: 'Water stays in the leaf; what runs out is the charged ATP and NADPH.' },
            ],
          },
          hint: 'What do the light reactions hand over to the Calvin cycle?',
          explanation: 'Even though the Calvin cycle doesn’t use light directly, it depends on ATP and NADPH made by the light-dependent reactions.',
        },
      ],
    },
  ],
});

const FRACTIONS: CourseScript = CourseScriptSchema.parse({
  version: 1, title: 'A whole new way to see fractions', topic: 'fractions', provenance: 'authored',
  summary: 'A fraction names equal parts of one whole. Multiplying top and bottom by the same number keeps the same point on the number line.',
  concepts: [{ id: 'equal-parts', label: 'Equal parts of a whole' }, { id: 'equivalence', label: 'Equivalent fractions' }, { id: 'addition', label: 'Adding with common units' }],
  cards: [
    { front: 'Why does 1/2 equal 2/4?', back: 'Splitting each half into 2 equal pieces doubles both the shaded count and the total parts without changing the amount.' },
    { front: 'Why can’t you add 1/2 + 1/4 by adding the denominators?', back: 'Denominators name the size of each piece; you first rewrite 1/2 as 2/4 so all pieces are the same size.' },
  ],
  chapters: [
    {
      id: 'ch-1', title: 'Same amount, different cuts', goal: 'See why equivalent fractions cover the exact same length.', status: 'ready',
      steps: [
        {
          id: 'fr-1', kind: 'question', title: 'Look at the two bars',
          body: 'Both bars below are the **exact same length**. The top bar is cut into 2 equal parts; the bottom bar is cut into 4 equal parts.\n\nFill in the two fractions that name the shaded length.',
          conceptSpeech: 'Picture cutting your half of a sandwich into two smaller pieces. You have more pieces, but the same amount of lunch. See how the shaded edges line up on these two bars.',
          visual: {
            kind: 'fraction-bars', id: 'v-fr-1', alt: 'Top bar has 1 of 2 parts shaded; bottom bar has 2 of 4 parts shaded.',
            bars: [
              { id: 'b-half', parts: 2, shaded: 1, label: 'halves', color: 'green' },
              { id: 'b-fourth', parts: 4, shaded: 2, label: 'fourths', color: 'teal' },
            ],
          },
          interaction: {
            type: 'fill-tiles',
            template: '1 / {d1}  =  {n2} / 4',
            tiles: [{ id: 't1', text: '1' }, { id: 't2', text: '2' }, { id: 't3', text: '3' }, { id: 't4', text: '4' }],
            slots: [{ id: 'd1', accept: ['t2'] }, { id: 'n2', accept: ['t2'] }],
          },
          hint: 'Count total parts in the top bar for the first blank, and shaded parts in the bottom bar for the second.',
          explanation: '1 out of 2 equal parts covers the exact same bar length as 2 out of 4 equal parts: $\\frac{1}{2} = \\frac{2}{4}$.',
        },
        {
          id: 'fr-2', kind: 'question', title: 'Cut into sixths',
          body: 'The green bar is the reference. The blue bar has six equal pieces.\n\nMove the slider until the blue shading matches one half.',
          conceptSpeech: 'Let’s change the number of cuts. Use the end of the green shading as your target and see if you can line up the blue bar with it.',
          visual: {
            kind: 'fraction-bars', id: 'v-fr-2', alt: 'A reference half and an adjustable bar divided into sixths.',
            bars: [{ id: 'b-ref', parts: 2, shaded: 1, label: '1/2', color: 'green' }, { id: 'b-six', parts: 6, shaded: 1, label: '?/6', color: 'blue' }],
          },
          interaction: { type: 'slider', label: 'Shaded sixths', min: 0, max: 6, step: 1, initial: 1, unit: '/ 6', accept: { min: 3, max: 3 } },
          hint: 'What is half of 6 equal pieces?',
          explanation: '3 out of 6 equal parts is half the bar: $\\frac{3}{6} = \\frac{1}{2}$.',
        },
        {
          id: 'fr-3', kind: 'question', title: 'Adding with like units',
          body: 'To add $\\frac{1}{2} + \\frac{1}{4}$, rewrite $\\frac{1}{2}$ as $\\frac{2}{4}$ so every piece is a fourth.\n\nType the numerator of the sum.',
          visual: {
            kind: 'number-line', id: 'v-fr-3', alt: 'Number line from 0 to 1 in fourths showing 2/4 plus 1/4 landing at 3/4.',
            min: 0, max: 4, step: 1,
            marks: [{ id: 'm0', value: 0, label: '0' }, { id: 'm2', value: 2, label: '2/4', color: 'green' }, { id: 'm3', value: 3, label: '3/4', color: 'teal' }, { id: 'm4', value: 4, label: '1' }],
            range: { from: 0, to: 3, color: 'green' },
          },
          interaction: {
            type: 'fill-input',
            template: '2/4 + 1/4 = {num}/4',
            slots: [{ id: 'num', accept: ['3', 'three'], numeric: { value: 3, tolerance: 0 } }],
          },
          hint: 'Two fourths plus one more fourth gives how many fourths?',
          explanation: 'Once the pieces are the same size (fourths), just count them: $2 + 1 = 3$ fourths, or $\\frac{3}{4}$.',
        },
      ],
    },
  ],
});

const SOLAR_SYSTEM: CourseScript = CourseScriptSchema.parse({
  version: 1, title: 'Periodic phenomena & orbits', topic: 'solar-system', provenance: 'authored',
  summary: 'Repeating motions — from search spikes to planetary orbits — have a period: the time between identical peaks.',
  concepts: [{ id: 'peaks', label: 'Peaks on a graph' }, { id: 'period', label: 'Period of repetition' }, { id: 'orbits', label: 'Orbital period and distance' }],
  cards: [
    { front: 'What is the period of a repeating graph?', back: 'The horizontal time interval from one peak (or cycle point) to the next identical peak.' },
    { front: 'How does a planet’s distance from the Sun affect its orbital period?', back: 'Farther planets travel longer orbits at slower speeds, so their year is longer.' },
  ],
  chapters: [
    {
      id: 'ch-1', title: 'Periodic phenomena', goal: 'Read peaks and periods directly from a repeating graph.', status: 'ready',
      steps: [
        {
          id: 'ss-1', kind: 'question', title: '"Leap year" searches',
          body: 'This made-up search chart illustrates a pattern around leap years.\n\nMark the two peaks where the example reaches 9 million searches.',
          conceptSpeech: 'Think about how often February twenty-ninth comes around. This example shows what a repeating search pattern could look like. Look for the same high point appearing twice.',
          visual: {
            kind: 'plot', id: 'v-ss-1', alt: 'Graph of leap year searches (millions) vs years since 2010, with tallest spikes of 9 at t=2 and t=6.',
            title: 'Illustrative “leap year” searches', xLabel: 'Years since 2010', yLabel: 'Searches (M)',
            x: { min: 0, max: 10, step: 1 }, y: { min: 0, max: 10, step: 1 },
            functions: [{ id: 'fn-leap', expr: '5 + 4 * cos(pi * (x - 2) / 2)', color: 'teal', domain: [0, 6.5] }],
            points: [{ id: 'p-2', x: 2, y: 9, color: 'orange' }, { id: 'p-6', x: 6, y: 9, color: 'orange' }],
          },
          interaction: { type: 'mark-points', targets: [{ x: 2, y: 9 }, { x: 6, y: 9 }], tolerance: 0.55 },
          hint: 'Find height 9 on the vertical axis and tap the two tallest spikes at t = 2 and t = 6.',
          explanation: 'The tallest spikes reach 9 million at $t = 2$ (2012) and $t = 6$ (2016).',
        },
        {
          id: 'ss-2', kind: 'question', title: 'Coordinates of the peaks',
          body: 'The first coordinate tells us when a peak happened. The second tells us its height.\n\nUse the tiles to write the coordinates of the two peaks, earliest first.',
          visual: {
            kind: 'plot', id: 'v-ss-2', alt: 'Same leap year graph with peaks highlighted at (2, 9) and (6, 9).',
            title: 'Illustrative “leap year” searches', xLabel: 'Years since 2010',
            x: { min: 0, max: 10, step: 1 }, y: { min: 0, max: 10, step: 1 },
            functions: [{ id: 'fn-leap2', expr: '5 + 4 * cos(pi * (x - 2) / 2)', color: 'teal', domain: [0, 6.5] }],
            points: [{ id: 'pk-1', x: 2, y: 9, label: '(2, 9)', color: 'orange' }, { id: 'pk-2', x: 6, y: 9, label: '(6, 9)', color: 'orange' }],
          },
          interaction: {
            type: 'fill-tiles',
            template: '({t1}, 9)   and   ({t2}, 9)',
            tiles: [{ id: 't2', text: '2' }, { id: 't3', text: '3' }, { id: 't4', text: '4' }, { id: 't6', text: '6' }, { id: 't9', text: '9' }],
            slots: [{ id: 't1', accept: ['t2'] }, { id: 't2', accept: ['t6'] }],
          },
          hint: 'Read the horizontal coordinate under each orange peak.',
          explanation: 'The graph repeats every 4 years. The tallest spike — height 9 — first peaks at $t = 2$, giving $(2, 9)$. Since the pattern repeats, the next identical peak is 4 years later: $t = 2 + 4 = 6$, giving $(6, 9)$.',
        },
        {
          id: 'ss-3', kind: 'question', title: 'Predict the next leap-year spike',
          body: 'If the 4-year pattern continues, at what year $t$ (years since 2010) will the **next** height-9 peak happen after $t = 6$?',
          interaction: {
            type: 'mcq',
            options: [{ id: 'o8', text: 't = 8' }, { id: 'o9', text: 't = 9' }, { id: 'o10', text: 't = 10' }],
            correct: ['o10'],
            feedback: [
              { optionId: 'o8', text: 't = 8 is only 2 years after 6, halfway to the next peak.' },
              { optionId: 'o9', text: 'Add the full 4-year period to t = 6.' },
            ],
          },
          hint: 'Add the period (4 years) to the previous peak at t = 6.',
          explanation: 'Adding one period of 4 years gives $t = 6 + 4 = 10$ (the year 2020, which was the next leap year).',
        },
      ],
    },
    {
      id: 'ch-2', title: 'Planetary periods', goal: 'Connect orbital distance to a planet’s year.', status: 'ready',
      steps: [
        {
          id: 'ss-4', kind: 'question', title: 'Day vs. year',
          body: 'A planet spins on its axis while it travels around the Sun. Those two motions happen at the same time.\n\nMatch each motion to the cycle it creates.',
          visual: {
            kind: 'bars', id: 'v-ss-4', alt: 'Orbital periods in Earth days: Mercury 88, Earth 365, Mars 687.',
            unit: ' days',
            bars: [
              { id: 'b-merc', label: 'Mercury', value: 88, color: 'orange' },
              { id: 'b-earth', label: 'Earth', value: 365, color: 'green' },
              { id: 'b-mars', label: 'Mars', value: 687, color: 'red' },
            ],
          },
          interaction: {
            type: 'match', leftLabel: 'Motion', rightLabel: 'Cycle',
            pairs: [
              { id: 'spin', left: 'Spinning on its axis', right: 'Day and night' },
              { id: 'orbit', left: 'Completing one trip around the Sun', right: 'One planetary year' },
            ],
          },
          hint: 'Which motion takes Earth 365 days?',
          explanation: 'Rotation on the axis gives the day/night cycle; revolving around the Sun gives the orbital period (a year).',
        },
        {
          id: 'ss-mars', kind: 'question', title: 'A birthday on Mars',
          body: 'An Earth year is about 365 Earth days. A Mars year is about 687 Earth days.\n\nIf Earth and Mars start an orbit together, what is Mars doing when Earth finishes its first orbit?',
          conceptSpeech: 'Imagine starting two clocks as Earth and Mars set out around the Sun. When Earth gets back to its starting point, check where the Mars clock is.',
          interaction: {
            type: 'mcq', options: [
              { id: 'still', text: 'Mars is still on its first orbit.' },
              { id: 'same', text: 'Mars finishes its first orbit at the same time.' },
              { id: 'twice', text: 'Mars has already finished two orbits.' },
            ],
            correct: ['still'], feedback: [],
          },
          hint: 'Compare 365 days with how long one Mars orbit takes.',
          explanation: 'Mars is still on its first orbit. It is a little over halfway through its orbital period when Earth finishes one orbit.',
        },
      ],
    },
  ],
});

const CIRCUITS: CourseScript = CourseScriptSchema.parse({
  version: 1, title: 'Let’s make a light turn on', topic: 'circuits', provenance: 'authored',
  summary: 'Current flows only around a closed conducting loop, and Ohm’s law I = V / R links voltage, resistance and current.',
  concepts: [{ id: 'closed-loop', label: 'Closed loop' }, { id: 'ohms-law', label: 'Ohm’s law I = V / R' }],
  cards: [
    { front: 'According to Ohm’s law, what happens to current if resistance doubles at constant voltage?', back: 'Current is cut in half because I = V / R.' },
    { front: 'Why does a bulb go dark as soon as a switch opens?', back: 'Opening the switch breaks the closed conducting loop, so steady current stops everywhere in the loop.' },
  ],
  chapters: [
    {
      id: 'ch-1', title: 'Loops and Ohm’s law', goal: 'Predict current from voltage and resistance.', status: 'ready',
      steps: [
        {
          id: 'ci-1', kind: 'question', title: 'Close the loop',
          body: 'A battery pushes charges around a circuit only when there is an unbroken conducting path from one terminal to the other.\n\nTrue or false: **Current keeps flowing into a bulb through one wire even if the return wire is disconnected.**',
          conceptSpeech: "Let's figure out why a light switch works. Start at the battery in the picture and trace the wire through the bulb. The way back to the battery matters just as much as the way there.",
          visual: {
            kind: 'flow', id: 'v-ci-1', alt: 'Battery (+) to switch to bulb to battery (-) forms a closed loop.', layout: 'cycle',
            nodes: [
              { id: 'n-bat', label: 'Battery (9 V)', emoji: '🔋', detail: 'Pushes charge', color: 'green' },
              { id: 'n-sw', label: 'Switch', emoji: '🔀', detail: 'Must be closed', color: 'yellow' },
              { id: 'n-bulb', label: 'Bulb (3 Ω)', emoji: '💡', detail: 'Transfers energy', color: 'orange' },
            ],
            links: [{ from: 'n-bat', to: 'n-sw', label: 'wire' }, { from: 'n-sw', to: 'n-bulb', label: 'wire' }, { from: 'n-bulb', to: 'n-bat', label: 'return' }],
          },
          interaction: { type: 'true-false', statement: 'Steady current flows through a single wire without a return path.', answer: false },
          hint: 'Look at the return link from the bulb back to the battery.',
          explanation: 'False. Steady current requires a complete closed loop so charge can circulate continuously.',
        },
        {
          id: 'ci-switch', kind: 'question', title: 'Predict what the switch does',
          body: 'An open switch creates a gap in the conducting path.',
          conceptSpeech: "Picture the light in your room. Flipping the switch open creates a tiny gap in the circuit. Think about what that gap means for the bulb.",
          spokenQuestion: 'What happens to the bulb when you open the switch?',
          hint: 'Trace the loop from the battery. Can charge cross the gap in the open switch?',
          explanation: 'The bulb goes out. The open switch breaks the loop, so current stops flowing through the bulb.',
        },
        {
          id: 'ci-2', kind: 'question', title: 'Ohm’s law in action',
          body: 'Ohm’s law says $I = \\frac{V}{R}$. The graph shows current $I$ (in amps) vs. voltage $V$ across a resistor.\n\nAdjust the resistance $R$ so that a **6 V** battery drives **2 A** of current.',
          conceptSpeech: "Watch the green line as I lower the resistance from six ohms to two. It gets steeper because the same voltage can now push more current.",
          demonstration: { parameter: 'r', value: 2 },
          visual: {
            kind: 'plot', id: 'v-ci-2', alt: 'Line I = V / R passing through (6, 2) when R = 3 ohms.',
            title: 'Current I vs. Voltage V', xLabel: 'Voltage V (volts)', yLabel: 'Current I (amps)',
            x: { min: 0, max: 10, step: 1 }, y: { min: 0, max: 6, step: 1 },
            params: [{ name: 'r', label: 'Resistance R (Ω)', min: 1, max: 6, step: 1, value: 6 }],
            functions: [{ id: 'fn-ohm', expr: 'x / r', color: 'green', label: 'I = V / R' }],
            points: [{ id: 'pt-target', x: 6, y: 2, label: '(6 V, 2 A)', color: 'orange' }],
          },
          interaction: { type: 'slider', label: 'Resistance R', min: 1, max: 6, step: 1, initial: 6, unit: ' Ω', bindParam: 'r', accept: { min: 3, max: 3 } },
          hint: 'We want I = 6 / R = 2. What value of R makes the green line pass through the orange dot?',
          explanation: 'With $R = 3\\,\\Omega$, $I = \\frac{6\\text{ V}}{3\\,\\Omega} = 2\\text{ A}$, so the line passes right through $(6, 2)$.',
        },
        {
          id: 'ci-3', kind: 'question', title: 'Calculate the current',
          body: 'Now a **12 V** battery is connected across the same **3 Ω** resistor.\n\nHow many amps of current flow?',
          interaction: {
            type: 'fill-input',
            template: 'I = 12 V / 3 Ω = {amps} A',
            slots: [{ id: 'amps', accept: ['4', '4.0'], numeric: { value: 4, tolerance: 0 } }],
          },
          hint: 'Divide 12 volts by 3 ohms.',
          explanation: '$I = \\frac{V}{R} = \\frac{12}{3} = 4\\text{ A}$.',
        },
      ],
    },
  ],
});

export const AUTHORED_COURSE_SCRIPTS: Record<Topic, CourseScript> = {
  photosynthesis: PHOTOSYNTHESIS,
  fractions: FRACTIONS,
  'solar-system': SOLAR_SYSTEM,
  circuits: CIRCUITS,
};

for (const [topic, script] of Object.entries(AUTHORED_COURSE_SCRIPTS)) {
  const err = validateCourseScript(script);
  if (err) throw new Error(`Invalid authored course ${topic}: ${err}`);
}

export function getAuthoredCourseScript(topic: string): CourseScript | undefined {
  const key = topic.trim().toLowerCase() as Topic;
  if (Object.hasOwn(AUTHORED_COURSE_SCRIPTS, key)) return structuredClone(AUTHORED_COURSE_SCRIPTS[key]);
  if (/periodic|leap|orbit|planet|solar|trig/.test(key)) return structuredClone(SOLAR_SYSTEM);
  if (/fraction|numerator|denominator|half|fourth/.test(key)) return structuredClone(FRACTIONS);
  if (/circuit|ohm|voltage|current|resistor/.test(key)) return structuredClone(CIRCUITS);
  if (/photo|chloroplast|thylakoid|calvin|plant/.test(key)) return structuredClone(PHOTOSYNTHESIS);
  return undefined;
}
