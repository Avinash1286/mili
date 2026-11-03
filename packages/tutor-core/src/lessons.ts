import { TOPICS, type Board, type Session, type Topic } from '@tokai/contracts';

type Lesson = {
  intro: string;
  nodes: { id: string; label: string; detail: string }[];
  links: [string, string, string][];
  questions: { prompt: string; answer: string; matches: RegExp }[];
  cards: { front: string; back: string; conceptId: string }[];
};

export const LESSONS: Record<Topic, Lesson> = {
  photosynthesis: {
    intro: 'A plant makes sugar using energy from sunlight. Let’s trace that process together. First, what do you think a plant takes in from the air?',
    nodes: [
      { id: 'plant', label: 'Photosynthesis', detail: 'Plants convert light energy into chemical energy stored in sugars. It happens mainly in chloroplasts in leaves.' },
      { id: 'light', label: 'Sunlight', detail: 'Light supplies the energy. Chlorophyll absorbs light; sunlight is not a material ingredient in the sugar.' },
      { id: 'co2', label: 'Carbon dioxide', detail: 'Carbon dioxide enters leaves through stomata. Its carbon becomes part of the sugar the plant makes.' },
      { id: 'water', label: 'Water', detail: 'Roots absorb water. Water supplies hydrogen and electrons, and the released oxygen comes from water.' },
      { id: 'chloroplast', label: 'Chloroplast', detail: 'This cell structure contains chlorophyll. Light reactions occur in thylakoid membranes; carbon fixation occurs in the stroma.' },
      { id: 'sugar', label: 'Sugar + oxygen', detail: 'The process builds sugars and releases oxygen. Soil supplies water and minerals, but is not the main source of a plant’s food.' }
    ],
    links: [['light', 'chloroplast', 'energy'], ['co2', 'chloroplast', 'carbon'], ['water', 'chloroplast', 'input'], ['chloroplast', 'sugar', 'produces'], ['plant', 'chloroplast', 'happens here']],
    questions: [
      { prompt: 'Which gas from the air supplies carbon for a plant’s sugars?', answer: 'Carbon dioxide supplies the carbon. Oxygen is released rather than used as the carbon source.', matches: /carbon\s*dioxide|\bco2\b|\bco₂\b/i },
      { prompt: 'What provides the energy for photosynthesis?', answer: 'Sunlight provides energy that chlorophyll absorbs. Water and carbon dioxide provide materials.', matches: /sun|light|solar/i },
      { prompt: 'Inside which cell structure does photosynthesis happen?', answer: 'Photosynthesis happens in chloroplasts, which contain chlorophyll.', matches: /chloroplast/i }
    ],
    cards: [
      { front: 'What are the main material inputs to photosynthesis?', back: 'Carbon dioxide and water; light supplies the energy.', conceptId: 'co2' },
      { front: 'Where does photosynthesis happen in plant cells?', back: 'In chloroplasts, which contain light-absorbing chlorophyll.', conceptId: 'chloroplast' },
      { front: 'Does a plant get most of its food from soil?', back: 'No. It makes sugars by photosynthesis. Soil supplies water and minerals.', conceptId: 'sugar' }
    ]
  },
  fractions: {
    intro: 'A fraction describes equal parts of a whole. Imagine a pizza cut into four equal slices. If you take one slice, what fraction of the whole pizza do you have?',
    nodes: [
      { id: 'whole', label: 'One whole', detail: 'A fraction must refer to a specified whole. Equal-sized parts matter: unequal slices do not each represent the same fraction.' },
      { id: 'numerator', label: 'Numerator', detail: 'The top number counts how many equal parts we are considering.' },
      { id: 'denominator', label: 'Denominator', detail: 'The bottom number tells how many equal parts make the whole; it cannot be zero.' },
      { id: 'quarter', label: '1 / 4', detail: 'One out of four equal parts. Four quarters make one whole.' },
      { id: 'equivalent', label: 'Equivalent fractions', detail: 'Multiplying numerator and denominator by the same nonzero number preserves the amount: 1/2 = 2/4.' },
      { id: 'addition', label: 'Add equal units', detail: 'With the same denominator, add numerators: 1/4 + 2/4 = 3/4. Do not add the denominators.' }
    ],
    links: [['whole', 'quarter', 'split equally'], ['numerator', 'quarter', 'parts taken'], ['denominator', 'quarter', 'parts in whole'], ['quarter', 'equivalent', 'same amount'], ['quarter', 'addition', 'combine']],
    questions: [
      { prompt: 'One of four equal slices is what fraction?', answer: 'One quarter, written 1/4. The denominator counts the equal slices in the whole.', matches: /1\s*\/\s*4|one[ -]quarter|a quarter|one[ -]fourth|¼/i },
      { prompt: 'What fraction is 1/4 + 2/4?', answer: 'It is 3/4. The pieces are still quarters, so the denominator stays four.', matches: /3\s*\/\s*4|three[ -]quarters|three[ -]fourths|¾/i },
      { prompt: 'Complete this equivalent fraction: 1/2 = ?/4.', answer: 'The missing numerator is 2: one half equals two quarters.', matches: /\b2\b|two/i }
    ],
    cards: [
      { front: 'What does the denominator tell you?', back: 'How many equal parts make the specified whole.', conceptId: 'denominator' },
      { front: 'Why is 1/2 equal to 2/4?', back: 'Both cover the same amount of the same whole; numerator and denominator were both multiplied by two.', conceptId: 'equivalent' },
      { front: 'What is 1/4 + 2/4?', back: '3/4. Add the number of quarters, keeping the unit of quarters.', conceptId: 'addition' }
    ]
  },
  'solar-system': {
    intro: 'Our solar system contains the Sun and the objects bound to it by gravity. Earth travels around the Sun. What force keeps Earth’s path curved into an orbit?',
    nodes: [
      { id: 'sun', label: 'The Sun', detail: 'The Sun is a star and contains most of the solar system’s mass. It produces energy through nuclear fusion.' },
      { id: 'gravity', label: 'Gravity', detail: 'Gravity attracts objects with mass. Together with a planet’s sideways motion, it produces an orbit.' },
      { id: 'inner', label: 'Rocky planets', detail: 'Mercury, Venus, Earth and Mars are the four inner rocky planets.' },
      { id: 'outer', label: 'Giant planets', detail: 'Jupiter and Saturn are gas giants. Uranus and Neptune are ice giants.' },
      { id: 'earth', label: 'Earth’s orbit', detail: 'Earth takes about one year to orbit the Sun and about one day to rotate. These are different motions.' },
      { id: 'moon', label: 'The Moon', detail: 'The Moon orbits Earth while the Earth–Moon system orbits the Sun. A moon is a natural satellite.' }
    ],
    links: [['sun', 'gravity', 'attracts'], ['gravity', 'inner', 'binds'], ['gravity', 'outer', 'binds'], ['inner', 'earth', 'includes'], ['earth', 'moon', 'has satellite']],
    questions: [
      { prompt: 'Which force helps keep Earth in orbit?', answer: 'Gravity. Earth also has sideways motion, so it continually falls around the Sun rather than straight into it.', matches: /gravit/i },
      { prompt: 'Does one trip around the Sun take Earth about a day or a year?', answer: 'About a year. One rotation of Earth takes about a day.', matches: /year|365/i },
      { prompt: 'Name one of the four inner rocky planets.', answer: 'Mercury, Venus, Earth or Mars are all correct.', matches: /mercury|venus|earth|mars/i }
    ],
    cards: [
      { front: 'Why can a planet orbit instead of falling straight into the Sun?', back: 'Its sideways motion and the Sun’s gravity together produce its curved path.', conceptId: 'gravity' },
      { front: 'What is the difference between Earth’s rotation and orbit?', back: 'Rotation is Earth spinning (about a day); its orbit around the Sun takes about a year.', conceptId: 'earth' },
      { front: 'Which planets are the ice giants?', back: 'Uranus and Neptune.', conceptId: 'outer' }
    ]
  },
  circuits: {
    intro: 'A simple circuit needs a source, connecting wires and a complete path through a component. Picture a battery, switch and lamp. Will the lamp light when the switch leaves a gap?',
    nodes: [
      { id: 'circuit', label: 'A complete circuit', detail: 'A conducting path connects the battery terminals through the lamp. A gap prevents a steady current in this simple circuit.' },
      { id: 'battery', label: 'Battery', detail: 'A battery transfers chemical energy to electrical energy and maintains a potential difference. It does not create all the charges in the wires.' },
      { id: 'wires', label: 'Conducting wires', detail: 'Charges are already present in the conducting wires. They can move when the circuit is complete.' },
      { id: 'switch', label: 'Switch', detail: 'A closed switch completes the path. An open switch introduces a gap and the lamp goes out.' },
      { id: 'lamp', label: 'Lamp', detail: 'The lamp transfers electrical energy into light and heat. In a simple series circuit, current is not used up by the lamp.' },
      { id: 'current', label: 'Current', detail: 'Current is the rate of flow of electric charge. Conventional current direction is from positive to negative through the external circuit.' }
    ],
    links: [['battery', 'wires', 'supplies energy'], ['wires', 'switch', 'connects'], ['switch', 'lamp', 'completes path'], ['lamp', 'battery', 'return path'], ['circuit', 'current', 'allows']],
    questions: [
      { prompt: 'Will the lamp light with an open switch?', answer: 'No. An open switch breaks the conducting path, so no steady current flows in this simple circuit.', matches: /\bno\b|not|won.t|doesn.t|off/i },
      { prompt: 'Should the switch be open or closed to light the lamp?', answer: 'Closed: this completes the path through the battery and lamp.', matches: /clos|complete/i },
      { prompt: 'Is the current used up when it passes through the lamp?', answer: 'No. The lamp transfers energy; charge continues around the complete circuit.', matches: /\bno\b|not|isn.t|same|conserv/i }
    ],
    cards: [
      { front: 'What does a closed switch do?', back: 'It completes the conducting path so current can flow.', conceptId: 'switch' },
      { front: 'Does a lamp use up current?', back: 'No. It transfers electrical energy to light and heat; charge is conserved.', conceptId: 'lamp' },
      { front: 'What does a battery supply to a circuit?', back: 'Energy and a potential difference that can drive charge around a complete path.', conceptId: 'battery' }
    ]
  }
};

export function lessonBoard(topic: Topic): Board {
  const lesson = LESSONS[topic];
  const positions = [[360, 50], [60, 210], [360, 210], [660, 210], [200, 390], [540, 390]];
  return {
    nodes: lesson.nodes.map((node, i) => ({ ...node, x: positions[i]![0]!, y: positions[i]![1]!, kind: i === 0 ? 'root' : 'concept' })),
    edges: lesson.links.map(([from, to, label], i) => ({ id: `${topic}-edge-${i}`, from, to, label }))
  };
}

export function createLesson(input: { id: string; topic: Topic; mode: 'sample' | 'live'; now: string; messageId: string }): Session {
  const lesson = LESSONS[input.topic];
  return {
    id: input.id, topic: input.topic, mode: input.mode, title: TOPICS.find(t => t.id === input.topic)!.title,
    status: 'active', createdAt: input.now, updatedAt: input.now, revision: 0,
    messages: [{ id: input.messageId, role: 'tutor', text: lesson.intro, createdAt: input.now }],
    board: lessonBoard(input.topic),
    concepts: lesson.nodes.map(node => ({ id: node.id, label: node.label, status: 'introduced' })),
    flashcards: lesson.cards.map((card, i) => ({ ...card, id: `${input.topic}-card-${i}` }))
  };
}

export function sampleReply(session: Session, text: string, selectedNodeId?: string): string {
  const lesson = LESSONS[session.topic];
  // Only an actually asked authored question advances this guide. Greetings,
  // help and board exploration must not consume an assessment slot.
  let questionIndex = 0;
  for (const message of [...session.messages].reverse()) {
    if (message.role !== 'tutor') continue;
    const mentioned = lesson.questions.map((question, index) => ({ index, at: message.text.lastIndexOf(question.prompt) })).filter(item => item.at >= 0).sort((a, b) => b.at - a.at);
    if (mentioned[0]) { questionIndex = mentioned[0].index; break; }
  }
  const current = lesson.questions[questionIndex]!;
  if (selectedNodeId) {
    const selected = session.board.nodes.find(n => n.id === selectedNodeId);
    if (selected) return `You selected “${selected.label}”. ${selected.detail}\n\nWhen you’re ready, back to our guided question: ${current.prompt}`;
  }
  if (/^(hi|hello|hey)\b/i.test(text)) return `Welcome back! ${current.prompt}`;
  if (/help|confus|explain|why|what|don.t know|not sure|\?/i.test(text)) {
    return `${current.answer}\n\nLet’s try that question again: ${current.prompt}\n\nYou can also select any board card and ask about it. This sample follows a fixed teaching guide; Live AI supports open-ended questions.`;
  }
  const match = current.matches.exec(text);
  // Conservative guard against a correct keyword occurring inside a denial.
  // This is deliberately bounded matching, not a general semantic grader.
  const beforeMatch = match ? text.slice(0, match.index).toLowerCase().replace(/[’]/g, "'") : '';
  const negated = /(?:\bnot|\bno|\bnever|\bisn't|\bisnt|\bdon't|\bdoesn't)(?:\s+[a-z]+){0,2}\s*$/.test(beforeMatch);
  const contradictoryYesNo = /\b(?:yes|yeah|yep)\b/i.test(text) && /\bno\b/i.test(text);
  const correct = Boolean(match) && !negated && !contradictoryYesNo;
  const next = lesson.questions[Math.min(questionIndex + 1, lesson.questions.length - 1)]!;
  const followup = !correct ? current.prompt : questionIndex >= lesson.questions.length - 1
    ? 'Try explaining the idea back in your own words, or select a board card to explore it. Your review cards are ready whenever you finish.'
    : next.prompt;
  return `${correct ? 'That matches the key idea.' : 'Let’s check that together.'} ${current.answer}\n\n${followup}\n\nSample feedback uses simple answer matching, so it may miss a correct answer phrased differently.`;
}

export function summarizeSession(session: Session): string {
  const turns = session.messages.filter(message => message.role === 'student').length;
  const covered = session.board.nodes.map(node => `- **${node.label}:** ${node.detail}`).join('\n');
  return `# ${session.title}\n\n${session.mode === 'sample' ? 'Guided sample' : 'Live AI'} session with ${turns} student ${turns === 1 ? 'message' : 'messages'}.\n\n## Lesson reference\n\n${covered}\n\n## Keep practicing\n\nReview the ${session.flashcards.length} cards and explain one concept without looking. These notes summarize the lesson reference, not verified mastery or everything you heard. Your conversation is saved separately.`;
}
