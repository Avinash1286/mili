/**
 * Browser-safe math expression evaluator and deterministic course grader.
 * Never calls `eval` or `Function`; supports +, -, *, /, ^, parentheses, pi, e and common functions.
 */
import type { CourseAnswer, CourseInteraction, CourseScript, CourseStep } from './course';

type Token = { type: 'num'; value: number } | { type: 'id'; value: string } | { type: 'op'; value: string };
const FUNCS: Record<string, (v: number) => number> = {
  sin: Math.sin, cos: Math.cos, tan: Math.tan, sqrt: v => v < 0 ? NaN : Math.sqrt(v),
  abs: Math.abs, log: v => v <= 0 ? NaN : Math.log10(v), ln: v => v <= 0 ? NaN : Math.log(v),
  exp: Math.exp, floor: Math.floor, ceil: Math.ceil, round: Math.round,
};

function tokenize(expr: string): Token[] {
  if (expr.length > 200) throw new Error('Expression is too long.');
  const tokens: Token[] = []; let i = 0;
  while (i < expr.length) {
    const ch = expr[i];
    if (/\s/.test(ch)) { i++; continue; }
    if (/[0-9.]/.test(ch)) {
      let s = ''; while (i < expr.length && /[0-9.]/.test(expr[i])) s += expr[i++];
      const value = Number(s); if (!Number.isFinite(value)) throw new Error('Invalid number.');
      if (tokens.length && (tokens[tokens.length - 1].type === 'id' || (tokens[tokens.length - 1].type === 'op' && tokens[tokens.length - 1].value === ')'))) tokens.push({ type: 'op', value: '*' });
      tokens.push({ type: 'num', value }); continue;
    }
    if (/[a-zA-Z]/.test(ch)) {
      let s = ''; while (i < expr.length && /[a-zA-Z]/.test(expr[i])) s += expr[i++];
      const prev = tokens[tokens.length - 1];
      if (prev && (prev.type === 'num' || prev.type === 'id' || (prev.type === 'op' && prev.value === ')'))) tokens.push({ type: 'op', value: '*' });
      tokens.push({ type: 'id', value: s }); continue;
    }
    if ('+-*/^()'.includes(ch)) {
      const prev = tokens[tokens.length - 1];
      if (ch === '(' && prev && (prev.type === 'num' || (prev.type === 'id' && !(prev.value.toLowerCase() in FUNCS)) || (prev.type === 'op' && prev.value === ')'))) tokens.push({ type: 'op', value: '*' });
      tokens.push({ type: 'op', value: ch }); i++; continue;
    }
    throw new Error(`Unsupported character: ${ch}`);
  }
  return tokens;
}

export function compileMathExpr(expr: string): (vars: Record<string, number>) => number {
  const tokens = tokenize(expr); let pos = 0;
  const peek = () => tokens[pos];
  function parseAdd(): number { return 0; } void parseAdd;
  type Node = (v: Record<string, number>) => number;
  function exprNode(depth: number): Node {
    if (depth > 24) throw new Error('Expression is too deeply nested.');
    let left = termNode(depth + 1);
    while (peek()?.type === 'op' && (peek()!.value === '+' || peek()!.value === '-')) {
      const op = tokens[pos++].value, right = termNode(depth + 1), prev = left;
      left = op === '+' ? v => prev(v) + right(v) : v => prev(v) - right(v);
    }
    return left;
  }
  function termNode(depth: number): Node {
    let left = powNode(depth + 1);
    while (peek()?.type === 'op' && (peek()!.value === '*' || peek()!.value === '/')) {
      const op = tokens[pos++].value, right = powNode(depth + 1), prev = left;
      left = op === '*' ? v => prev(v) * right(v) : v => { const d = right(v); return d === 0 ? NaN : prev(v) / d; };
    }
    return left;
  }
  function powNode(depth: number): Node {
    const base = unaryNode(depth + 1);
    if (peek()?.type === 'op' && peek()!.value === '^') { pos++; const exp = powNode(depth + 1); return v => Math.pow(base(v), exp(v)); }
    return base;
  }
  function unaryNode(depth: number): Node {
    if (peek()?.type === 'op' && (peek()!.value === '+' || peek()!.value === '-')) {
      const op = tokens[pos++].value, inner = unaryNode(depth + 1);
      return op === '-' ? v => -inner(v) : inner;
    }
    return atomNode(depth + 1);
  }
  function atomNode(depth: number): Node {
    const t = tokens[pos++]; if (!t) throw new Error('Unexpected end of expression.');
    if (t.type === 'num') return () => t.value;
    if (t.type === 'op' && t.value === '(') {
      const inner = exprNode(depth + 1);
      if (peek()?.type !== 'op' || peek()!.value !== ')') throw new Error('Unclosed parenthesis.');
      pos++; return inner;
    }
    if (t.type === 'id') {
      const low = t.value.toLowerCase();
      if (low === 'pi') return () => Math.PI;
      if (low === 'e') return () => Math.E;
      if (low in FUNCS && peek()?.type === 'op' && peek()!.value === '(') {
        pos++; const arg = exprNode(depth + 1);
        if (peek()?.type !== 'op' || peek()!.value !== ')') throw new Error('Unclosed function call.');
        pos++; const fn = FUNCS[low]; return v => fn(arg(v));
      }
      if (t.value.length === 1) return v => v[t.value] ?? v[low] ?? NaN;
      // Split multi-letter product like "2pi" or "ax"
      if (low.endsWith('pi') && low.length === 3) { const k = t.value[0]; return v => (v[k] ?? NaN) * Math.PI; }
      throw new Error(`Unknown identifier: ${t.value}`);
    }
    throw new Error('Unexpected token.');
  }
  const root = exprNode(0);
  if (pos !== tokens.length) throw new Error('Trailing expression tokens.');
  return vars => { const value = root(vars); return Number.isFinite(value) && Math.abs(value) <= 1e9 ? value : NaN; };
}

export function evalMathExpr(expr: string, vars: Record<string, number> = {}): number {
  try { return compileMathExpr(expr)(vars); } catch { return NaN; }
}

const normText = (value: string) => value.normalize('NFKC').toLocaleLowerCase('en-US').trim().replace(/\s+/g, ' ');
function parseNumber(raw: string): number {
  const s = raw.trim();
  const frac = /^([+-]?\d+)\s*\/\s*([+-]?\d+)$/.exec(s);
  if (frac) { const d = Number(frac[2]); return d === 0 ? NaN : Number(frac[1]) / d; }
  const v = Number(s.replace(/,/g, ''));
  return s && Number.isFinite(v) ? v : NaN;
}

export function isCourseAnswerReady(interaction: CourseInteraction, answer?: CourseAnswer): boolean {
  if (!answer || answer.type !== interaction.type) return false;
  switch (interaction.type) {
    case 'mcq': return answer.type === 'mcq' && answer.selected.length > 0;
    case 'true-false': return answer.type === 'true-false' && typeof answer.value === 'boolean';
    case 'fill-tiles': return answer.type === 'fill-tiles' && interaction.slots.every(s => Boolean(answer.slots[s.id]));
    case 'fill-input': return answer.type === 'fill-input' && interaction.slots.every(s => Boolean(answer.slots[s.id]?.trim()));
    case 'order': return answer.type === 'order' && answer.order.length === interaction.items.length;
    case 'match': return answer.type === 'match' && interaction.pairs.every(p => Boolean(answer.pairs[p.id]));
    case 'categorize': return answer.type === 'categorize' && interaction.items.every(i => Boolean(answer.placement[i.id]));
    case 'mark-points': return answer.type === 'mark-points' && answer.points.length === interaction.targets.length;
    case 'slider': return answer.type === 'slider' && Number.isFinite(answer.value);
  }
}

export type GradeOutcome = { correct: boolean; message: string; wrongIds?: string[] };
export function gradeCourseInteraction(interaction: CourseInteraction, answer: CourseAnswer): GradeOutcome {
  if (answer.type !== interaction.type) return { correct: false, message: 'Finish the interaction first.' };
  switch (interaction.type) {
    case 'mcq': {
      const a = answer as Extract<CourseAnswer, { type: 'mcq' }>;
      const expected = new Set(interaction.correct), chosen = new Set(a.selected);
      const correct = expected.size === chosen.size && [...expected].every(id => chosen.has(id));
      const specific = !correct ? interaction.feedback.find(f => chosen.has(f.optionId))?.text : undefined;
      return { correct, message: correct ? 'Yep.' : specific ?? 'Not quite — check how the options compare.', wrongIds: [...chosen].filter(id => !expected.has(id)) };
    }
    case 'true-false': {
      const a = answer as Extract<CourseAnswer, { type: 'true-false' }>;
      return { correct: a.value === interaction.answer, message: a.value === interaction.answer ? 'Yep.' : 'Not quite — think carefully about that statement.' };
    }
    case 'fill-tiles': {
      const a = answer as Extract<CourseAnswer, { type: 'fill-tiles' }>;
      const wrong = interaction.slots.filter(s => !s.accept.includes(a.slots[s.id] ?? '')).map(s => s.id);
      return { correct: wrong.length === 0, message: wrong.length === 0 ? 'Yep.' : 'One or more blanks don’t match yet.', wrongIds: wrong };
    }
    case 'fill-input': {
      const a = answer as Extract<CourseAnswer, { type: 'fill-input' }>;
      const wrong = interaction.slots.filter(s => {
        const raw = a.slots[s.id] ?? '';
        if (s.accept.some(acc => normText(acc) === normText(raw))) return false;
        if (s.numeric) { const n = parseNumber(raw); if (Number.isFinite(n) && Math.abs(n - s.numeric.value) <= s.numeric.tolerance + 1e-9) return false; }
        return true;
      }).map(s => s.id);
      return { correct: wrong.length === 0, message: wrong.length === 0 ? 'Yep.' : 'Check the value in the highlighted blank.', wrongIds: wrong };
    }
    case 'order': {
      const a = answer as Extract<CourseAnswer, { type: 'order' }>;
      const wrong = interaction.items.filter((item, index) => a.order[index] !== item.id).map(item => item.id);
      return { correct: wrong.length === 0, message: wrong.length === 0 ? 'Yep — right in order.' : 'The sequence isn’t in the right order yet.', wrongIds: wrong };
    }
    case 'match': {
      const a = answer as Extract<CourseAnswer, { type: 'match' }>;
      const wrong = interaction.pairs.filter(p => a.pairs[p.id] !== p.id).map(p => p.id);
      return { correct: wrong.length === 0, message: wrong.length === 0 ? 'Yep — every pair matches.' : 'Some pairs are swapped.', wrongIds: wrong };
    }
    case 'categorize': {
      const a = answer as Extract<CourseAnswer, { type: 'categorize' }>;
      const wrong = interaction.items.filter(item => a.placement[item.id] !== item.bucket).map(item => item.id);
      return { correct: wrong.length === 0, message: wrong.length === 0 ? 'Yep.' : 'Check the highlighted items.', wrongIds: wrong };
    }
    case 'mark-points': {
      const a = answer as Extract<CourseAnswer, { type: 'mark-points' }>;
      const { targets, tolerance } = interaction;
      const tol = Math.max(0.25, tolerance);
      // At most four targets. Try each compatible assignment so overlapping
      // tolerances don't make the order in which points were marked matter.
      function matches(index: number, used: number): boolean {
        const target = targets[index];
        return !target || a.points.some((point, i) => !(used & (1 << i))
          && Math.hypot(point.x - target.x, point.y - target.y) <= tol
          && matches(index + 1, used | (1 << i)));
      }
      const ok = a.points.length === targets.length && matches(0, 0);
      return { correct: ok, message: ok ? 'Yep.' : `Mark ${interaction.targets.length === 1 ? 'the exact target point' : `all ${interaction.targets.length} target points`} on the graph.` };
    }
    case 'slider': {
      const a = answer as Extract<CourseAnswer, { type: 'slider' }>;
      const low = Math.min(interaction.accept.min, interaction.accept.max), high = Math.max(interaction.accept.min, interaction.accept.max);
      const ok = a.value >= low - 1e-9 && a.value <= high + 1e-9;
      return { correct: ok, message: ok ? 'Yep.' : a.value < low ? 'Try moving the slider higher.' : 'Try moving the slider lower.' };
    }
  }
}

export function revealCourseAnswer(interaction: CourseInteraction): CourseAnswer {
  switch (interaction.type) {
    case 'mcq': return { type: 'mcq', selected: [...interaction.correct] };
    case 'true-false': return { type: 'true-false', value: interaction.answer };
    case 'fill-tiles': return { type: 'fill-tiles', slots: Object.fromEntries(interaction.slots.map(s => [s.id, s.accept[0]])) };
    case 'fill-input': return { type: 'fill-input', slots: Object.fromEntries(interaction.slots.map(s => [s.id, s.accept[0]])) };
    case 'order': return { type: 'order', order: interaction.items.map(i => i.id) };
    case 'match': return { type: 'match', pairs: Object.fromEntries(interaction.pairs.map(p => [p.id, p.id])) };
    case 'categorize': return { type: 'categorize', placement: Object.fromEntries(interaction.items.map(i => [i.id, i.bucket])) };
    case 'mark-points': return { type: 'mark-points', points: interaction.targets.map(t => ({ ...t })) };
    case 'slider': return { type: 'slider', value: Number(((interaction.accept.min + interaction.accept.max) / 2).toFixed(4)) };
  }
}

/** Splits `({slot-a}, 9)` into alternating text and `{slotId}` tokens. */
export function parseTemplateTokens(template: string): ({ kind: 'text'; text: string } | { kind: 'slot'; id: string })[] {
  const out: ({ kind: 'text'; text: string } | { kind: 'slot'; id: string })[] = [];
  const regex = /\{([a-z0-9][a-z0-9-]{0,47})\}/g; let last = 0, match: RegExpExecArray | null;
  while ((match = regex.exec(template)) !== null) {
    if (match.index > last) out.push({ kind: 'text', text: template.slice(last, match.index) });
    out.push({ kind: 'slot', id: match[1] }); last = match.index + match[0].length;
  }
  if (last < template.length) out.push({ kind: 'text', text: template.slice(last) });
  return out;
}

/** Semantic checks for authored and AI-generated steps: answer keys must be solvable and plots must compile. */
export function validateCourseStep(step: CourseStep): string | undefined {
  if (step.visual?.kind === 'plot') {
    for (const fn of step.visual.functions) { try { compileMathExpr(fn.expr); } catch { return `Invalid plot expression: ${fn.expr}`; } }
  }
  if (step.demonstration) {
    const { parameter, value } = step.demonstration;
    const param = step.visual?.kind === 'plot' && step.visual.params.find(item => item.name === parameter);
    if (!param || value < param.min || value > param.max || value === param.value) return 'Demonstration must change an existing plot parameter within its bounds.';
    const interaction = step.interaction;
    if (interaction?.type === 'slider' && interaction.bindParam === parameter
      && value >= interaction.accept.min && value <= interaction.accept.max) return 'Demonstration must leave the target for the learner.';
  }
  if (step.kind === 'concept') return undefined;
  const i = step.interaction;
  if (!i) return step.spokenQuestion ? undefined : 'Question step requires an interaction or a spoken question.';
  if (i.type === 'mcq' && i.correct.some(id => !i.options.some(o => o.id === id))) return 'MCQ correct option is missing from options.';
  if (i.type === 'fill-tiles') {
    const tileIds = new Set(i.tiles.map(t => t.id));
    if (i.slots.some(s => !templateHasSlot(i.template, s.id) || s.accept.some(id => !tileIds.has(id)))) return 'Fill-tiles slots must appear in template and reference existing tiles.';
  }
  if (i.type === 'fill-input' && i.slots.some(s => !templateHasSlot(i.template, s.id))) return 'Fill-input slots must appear in template.';
  if (i.type === 'categorize') {
    const b = new Set(i.buckets.map(x => x.id));
    if (i.items.some(item => !b.has(item.bucket))) return 'Categorize item references unknown bucket.';
  }
  if (i.type === 'mark-points' && step.visual?.kind !== 'plot') return 'mark-points requires a plot visual.';
  if (i.type === 'slider' && (i.max <= i.min || i.accept.min < i.min || i.accept.max > i.max)) return 'Slider bounds are inconsistent.';
  const revealed = revealCourseAnswer(i);
  if (!gradeCourseInteraction(i, revealed).correct) return 'Revealed answer did not pass grading.';
  return undefined;
}
const templateHasSlot = (template: string, id: string) => parseTemplateTokens(template).some(t => t.kind === 'slot' && t.id === id);

export function validateCourseScript(script: CourseScript): string | undefined {
  const stepIds = new Set<string>();
  for (const ch of script.chapters) {
    if (ch.status === 'ready' && !ch.steps.length) return `Ready chapter ${ch.id} has no steps.`;
    for (const s of ch.steps) {
      if (stepIds.has(s.id)) return `Duplicate step id ${s.id}.`;
      stepIds.add(s.id);
      const err = validateCourseStep(s); if (err) return `${s.id}: ${err}`;
    }
  }
  return undefined;
}

export function stripSpeechFormatting(raw: string): string {
  return raw
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\\frac\{([^{}]+)\}\{([^{}]+)\}/g, '$1 over $2')
    .replace(/\\text\{([^{}]+)\}/g, '$1')
    .replace(/\\,/g, ' ')
    .replace(/\^\{([^{}]+)\}/g, ' to the power of $1')
    .replace(/\$([^$]+)\$/g, '$1')
    .replace(/→/g, ' yields ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function visualElementIds(step: CourseStep): string[] {
  const v = step.visual;
  if (!v) return [];
  switch (v.kind) {
    case 'plot': return [...v.points.map(p => p.id), ...v.functions.map(f => f.id)];
    case 'flow': return v.nodes.map(n => n.id);
    case 'fraction-bars': return v.bars.map(b => b.id);
    case 'bars': return v.bars.map(b => b.id);
    case 'number-line': return v.marks.map(m => m.id);
    case 'shapes': return v.elements.map(e => e.id);
    default: return [];
  }
}

/**
 * Splits any step into a Concept Teaching phase (taught & spoken first) and a Question phase
 * (asked right after the concept is introduced).
 */
export function splitStepTeaching(step: CourseStep): {
  conceptText: string;
  conceptSpeech: string;
  questionPrompt: string;
  questionSpeech: string;
  combinedSpeech: string;
  highlightIds: string[];
} {
  const paragraphs = step.body.split(/\n\n+/).map(p => p.trim()).filter(Boolean);
  const derivedConcept = step.conceptBody?.trim()
    || (step.interaction && paragraphs.length > 1 ? paragraphs.slice(0, -1).join('\n\n') : step.body);
  const derivedQuestion = step.spokenQuestion || step.questionPrompt?.trim()
    || (step.interaction ? (paragraphs.length > 1 ? paragraphs[paragraphs.length - 1]! : 'Use the concept above to complete this check.') : '');
  const rawConceptSpeech = step.conceptSpeech?.trim()
    || `${step.title ? `${step.title}. ` : ''}${derivedConcept}`;
  const highlightIds = step.conceptHighlight?.length
    ? step.conceptHighlight
    : visualElementIds(step).slice(0, 3);
  const conceptSpeech = stripSpeechFormatting(rawConceptSpeech).slice(0, 650);
  const questionSpeech = stripSpeechFormatting(derivedQuestion).slice(0, 360);
  const combinedSpeech = questionSpeech && !conceptSpeech.toLowerCase().includes(questionSpeech.toLowerCase().slice(0, 35))
    ? `${conceptSpeech} ${questionSpeech}`.slice(0, 900)
    : conceptSpeech;
  return {
    conceptText: derivedConcept,
    conceptSpeech,
    questionPrompt: derivedQuestion,
    questionSpeech,
    combinedSpeech,
    highlightIds,
  };
}

/** Summarizes the learner's current widget selection so the agentic tutor can inspect exact mistakes. */
export function summarizeCourseAnswer(interaction: CourseInteraction, answer?: CourseAnswer): string {
  if (!answer || answer.type !== interaction.type) return 'No answer entered yet.';
  switch (interaction.type) {
    case 'mcq': {
      const a = answer as Extract<CourseAnswer, { type: 'mcq' }>;
      const labels = a.selected.map(id => interaction.options.find(o => o.id === id)?.text ?? id);
      return labels.length ? `Selected: ${labels.join(', ')}` : 'No option selected.';
    }
    case 'true-false': {
      const a = answer as Extract<CourseAnswer, { type: 'true-false' }>;
      return `Chose: ${a.value ? 'True' : 'False'}`;
    }
    case 'fill-tiles': {
      const a = answer as Extract<CourseAnswer, { type: 'fill-tiles' }>;
      const parts = interaction.slots.map(s => {
        const tile = interaction.tiles.find(t => t.id === a.slots[s.id]);
        return `${s.id}=${tile?.text ?? '(blank)'}`;
      });
      return `Filled tiles: ${parts.join(', ')}`;
    }
    case 'fill-input': {
      const a = answer as Extract<CourseAnswer, { type: 'fill-input' }>;
      return `Typed blanks: ${interaction.slots.map(s => `${s.id}="${a.slots[s.id] ?? ''}"`).join(', ')}`;
    }
    case 'order': {
      const a = answer as Extract<CourseAnswer, { type: 'order' }>;
      const seq = a.order.map(id => interaction.items.find(i => i.id === id)?.text ?? id);
      return `Ordered: ${seq.join(' -> ')}`;
    }
    case 'match': {
      const a = answer as Extract<CourseAnswer, { type: 'match' }>;
      const pairs = interaction.pairs.map(p => {
        const right = interaction.pairs.find(r => r.id === a.pairs[p.id])?.right ?? '(unpaired)';
        return `${p.left} -> ${right}`;
      });
      return `Matched: ${pairs.join('; ')}`;
    }
    case 'categorize': {
      const a = answer as Extract<CourseAnswer, { type: 'categorize' }>;
      const grouped = interaction.buckets.map(b => {
        const items = interaction.items.filter(i => a.placement[i.id] === b.id).map(i => i.text);
        return `${b.label}: [${items.join(', ')}]`;
      });
      return `Sorted: ${grouped.join('; ')}`;
    }
    case 'mark-points': {
      const a = answer as Extract<CourseAnswer, { type: 'mark-points' }>;
      return a.points.length ? `Marked points: ${a.points.map(p => `(${p.x}, ${p.y})`).join(', ')}` : 'No points marked.';
    }
    case 'slider': {
      const a = answer as Extract<CourseAnswer, { type: 'slider' }>;
      return `Slider value: ${a.value}${interaction.unit ?? ''}`;
    }
  }
}
