'use client';

import { useState } from 'react';
import { ArrowDown, ArrowUp, RotateCcw } from 'lucide-react';
import { parseTemplateTokens, type CourseAnswer, type CourseInteraction } from '@milli/contracts';

export function initialCourseAnswer(interaction?: CourseInteraction): CourseAnswer | undefined {
  if (!interaction) return undefined;
  switch (interaction.type) {
    case 'mcq': return { type: 'mcq', selected: [] };
    case 'true-false': return undefined;
    case 'fill-tiles': return { type: 'fill-tiles', slots: {} };
    case 'fill-input': return { type: 'fill-input', slots: {} };
    case 'order': {
      // Deterministic rotation so items don't start already solved
      const rot = interaction.items.length > 1 ? [...interaction.items.slice(1), interaction.items[0]] : interaction.items;
      return { type: 'order', order: rot.map(i => i.id) };
    }
    case 'match': return { type: 'match', pairs: {} };
    case 'categorize': return { type: 'categorize', placement: {} };
    case 'mark-points': return { type: 'mark-points', points: [] };
    case 'slider': return { type: 'slider', value: interaction.initial };
  }
}

export function CourseInteractionWidget({
  interaction, answer, onChange, locked = false, status = 'idle', wrongIds = [], onReset,
}: {
  interaction: CourseInteraction;
  answer?: CourseAnswer;
  onChange: (next: CourseAnswer) => void;
  locked?: boolean;
  status?: 'idle' | 'correct' | 'incorrect';
  wrongIds?: string[];
  onReset: () => void;
}) {
  const wrongSet = new Set(wrongIds);
  switch (interaction.type) {
    case 'mcq': return <McqWidget interaction={interaction} answer={answer} onChange={onChange} locked={locked} status={status} wrongSet={wrongSet} />;
    case 'true-false': return <TrueFalseWidget interaction={interaction} answer={answer} onChange={onChange} locked={locked} status={status} />;
    case 'fill-tiles': return <FillTilesWidget interaction={interaction} answer={answer} onChange={onChange} locked={locked} status={status} wrongSet={wrongSet} onReset={onReset} />;
    case 'fill-input': return <FillInputWidget interaction={interaction} answer={answer} onChange={onChange} locked={locked} status={status} wrongSet={wrongSet} />;
    case 'order': return <OrderWidget interaction={interaction} answer={answer} onChange={onChange} locked={locked} status={status} wrongSet={wrongSet} />;
    case 'match': return <MatchWidget interaction={interaction} answer={answer} onChange={onChange} locked={locked} status={status} wrongSet={wrongSet} onReset={onReset} />;
    case 'categorize': return <CategorizeWidget interaction={interaction} answer={answer} onChange={onChange} locked={locked} status={status} wrongSet={wrongSet} onReset={onReset} />;
    case 'mark-points': return <MarkPointsWidget interaction={interaction} answer={answer} onChange={onChange} locked={locked} onReset={onReset} />;
    case 'slider': return <SliderWidget interaction={interaction} answer={answer} onChange={onChange} locked={locked} />;
  }
}

function McqWidget({
  interaction, answer, onChange, locked, status, wrongSet,
}: {
  interaction: Extract<CourseInteraction, { type: 'mcq' }>;
  answer?: CourseAnswer;
  onChange: (next: CourseAnswer) => void;
  locked: boolean;
  status: 'idle' | 'correct' | 'incorrect';
  wrongSet: Set<string>;
}) {
  const selected = answer?.type === 'mcq' ? answer.selected : [];
  function toggle(id: string) {
    if (locked) return;
    if (interaction.multiple) {
      const next = selected.includes(id) ? selected.filter(x => x !== id) : [...selected, id];
      onChange({ type: 'mcq', selected: next });
    } else {
      onChange({ type: 'mcq', selected: [id] });
    }
  }
  return (
    <div className="milli-course-mcq" role="group" aria-label="Answer choices">
      {interaction.options.map(opt => {
        const chosen = selected.includes(opt.id);
        const stateClass = chosen && status === 'correct' ? 'is-correct' : chosen && (status === 'incorrect' || wrongSet.has(opt.id)) ? 'is-wrong' : chosen ? 'is-selected' : '';
        return (
          <button
            key={opt.id}
            type="button"
            disabled={locked}
            aria-pressed={chosen}
            className={`milli-course-choice ${stateClass}`}
            onClick={() => toggle(opt.id)}
          >
            <span className="milli-course-choice-radio" aria-hidden="true">{chosen ? '●' : '○'}</span>
            <span>{opt.text}</span>
          </button>
        );
      })}
    </div>
  );
}

function TrueFalseWidget({
  interaction, answer, onChange, locked, status,
}: {
  interaction: Extract<CourseInteraction, { type: 'true-false' }>;
  answer?: CourseAnswer;
  onChange: (next: CourseAnswer) => void;
  locked: boolean;
  status: 'idle' | 'correct' | 'incorrect';
}) {
  const current = answer?.type === 'true-false' ? answer.value : undefined;
  return (
    <div className="milli-course-tf-wrap">
      {interaction.statement && <p className="milli-course-tf-statement">“{interaction.statement}”</p>}
      <div className="milli-course-tf-row" role="group" aria-label="True or false">
        {([true, false] as const).map(val => {
          const chosen = current === val;
          const stateClass = chosen && status === 'correct' ? 'is-correct' : chosen && status === 'incorrect' ? 'is-wrong' : chosen ? 'is-selected' : '';
          return (
            <button
              key={String(val)}
              type="button"
              disabled={locked}
              aria-pressed={chosen}
              className={`milli-course-tf-btn ${stateClass}`}
              onClick={() => onChange({ type: 'true-false', value: val })}
            >
              {val ? 'True' : 'False'}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function FillTilesWidget({
  interaction, answer, onChange, locked, status, wrongSet, onReset,
}: {
  interaction: Extract<CourseInteraction, { type: 'fill-tiles' }>;
  answer?: CourseAnswer;
  onChange: (next: CourseAnswer) => void;
  locked: boolean;
  status: 'idle' | 'correct' | 'incorrect';
  wrongSet: Set<string>;
  onReset: () => void;
}) {
  const slots = answer?.type === 'fill-tiles' ? answer.slots : {};
  const [activeSlot, setActiveSlot] = useState<string | undefined>(() => interaction.slots[0]?.id);
  const tokens = parseTemplateTokens(interaction.template);
  const lines = interaction.template.includes('   and   ')
    ? interaction.template.split('   and   ')
    : [interaction.template];

  function placeTile(tileId: string, targetSlotId?: string) {
    if (locked) return;
    const slotId = targetSlotId ?? activeSlot ?? interaction.slots.find(s => !slots[s.id])?.id ?? interaction.slots[0]?.id;
    if (!slotId) return;
    const next = { ...slots, [slotId]: tileId };
    onChange({ type: 'fill-tiles', slots: next });
    const nextEmpty = interaction.slots.find(s => s.id !== slotId && !next[s.id])?.id;
    setActiveSlot(nextEmpty ?? slotId);
  }

  function clearSlot(slotId: string) {
    if (locked) return;
    const next = { ...slots };
    delete next[slotId];
    onChange({ type: 'fill-tiles', slots: next });
    setActiveSlot(slotId);
  }

  const renderTokens = (part: string) =>
    parseTemplateTokens(part).map((tk, idx) => {
      if (tk.kind === 'text') return <span key={idx} className="milli-course-template-text">{tk.text}</span>;
      const tileId = slots[tk.id];
      const tile = interaction.tiles.find(t => t.id === tileId);
      const isFocused = activeSlot === tk.id && !locked;
      const slotState = status === 'correct' && tile ? 'is-correct' : (status === 'incorrect' && wrongSet.has(tk.id)) ? 'is-wrong' : tile ? 'is-filled' : '';
      return (
        <button
          key={tk.id}
          type="button"
          disabled={locked}
          aria-label={`Blank ${tk.id}${tile ? `: ${tile.text}` : ' (empty)'}`}
          className={`milli-course-slot ${slotState} ${isFocused ? 'is-active' : ''}`}
          onClick={() => (tile ? clearSlot(tk.id) : setActiveSlot(tk.id))}
          onDragOver={e => e.preventDefault()}
          onDrop={e => {
            e.preventDefault();
            const dropped = e.dataTransfer.getData('text/plain');
            if (dropped) placeTile(dropped, tk.id);
          }}
        >
          {tile ? tile.text : '\u00A0'}
        </button>
      );
    });

  void tokens;
  return (
    <div className="milli-course-tiles-block">
      <div className={`milli-course-slots-card ${status === 'correct' ? 'is-correct' : ''}`}>
        {lines.map((line, i) => (
          <div key={i} className="milli-course-slots-line">{renderTokens(line)}</div>
        ))}
        {status === 'correct' && <span className="milli-course-card-check" aria-hidden="true">✓</span>}
      </div>
      <div className="milli-course-tile-tray" role="group" aria-label="Answer tiles">
        {interaction.tiles.map(tile => (
          <button
            key={tile.id}
            type="button"
            draggable={!locked}
            disabled={locked}
            className="milli-course-tile"
            onDragStart={e => e.dataTransfer.setData('text/plain', tile.id)}
            onClick={() => placeTile(tile.id)}
          >
            {tile.text}
          </button>
        ))}
      </div>
      {Object.keys(slots).length > 0 && !locked && (
        <div className="milli-course-reset-row">
          <button type="button" className="milli-course-start-over" onClick={onReset}>
            <RotateCcw size={14} /> Start over
          </button>
        </div>
      )}
    </div>
  );
}

function FillInputWidget({
  interaction, answer, onChange, locked, status, wrongSet,
}: {
  interaction: Extract<CourseInteraction, { type: 'fill-input' }>;
  answer?: CourseAnswer;
  onChange: (next: CourseAnswer) => void;
  locked: boolean;
  status: 'idle' | 'correct' | 'incorrect';
  wrongSet: Set<string>;
}) {
  const slots = answer?.type === 'fill-input' ? answer.slots : {};
  const tokens = parseTemplateTokens(interaction.template);
  return (
    <div className={`milli-course-slots-card ${status === 'correct' ? 'is-correct' : ''}`}>
      <div className="milli-course-slots-line">
        {tokens.map((tk, idx) => {
          if (tk.kind === 'text') return <span key={idx} className="milli-course-template-text">{tk.text}</span>;
          const val = slots[tk.id] ?? '';
          const stateClass = status === 'correct' ? 'is-correct' : status === 'incorrect' && wrongSet.has(tk.id) ? 'is-wrong' : '';
          return (
            <input
              key={tk.id}
              type="text"
              aria-label={`Blank ${tk.id}`}
              disabled={locked}
              value={val}
              placeholder="?"
              className={`milli-course-inline-input ${stateClass}`}
              onChange={e => onChange({ type: 'fill-input', slots: { ...slots, [tk.id]: e.target.value } })}
            />
          );
        })}
      </div>
    </div>
  );
}

function OrderWidget({
  interaction, answer, onChange, locked, status, wrongSet,
}: {
  interaction: Extract<CourseInteraction, { type: 'order' }>;
  answer?: CourseAnswer;
  onChange: (next: CourseAnswer) => void;
  locked: boolean;
  status: 'idle' | 'correct' | 'incorrect';
  wrongSet: Set<string>;
}) {
  const order = answer?.type === 'order' && answer.order.length === interaction.items.length
    ? answer.order
    : interaction.items.map(i => i.id);
  const byId = new Map(interaction.items.map(i => [i.id, i]));

  function move(index: number, delta: number) {
    if (locked) return;
    const target = index + delta;
    if (target < 0 || target >= order.length) return;
    const next = [...order];
    [next[index], next[target]] = [next[target], next[index]];
    onChange({ type: 'order', order: next });
  }

  return (
    <div className="milli-course-order-list" role="list" aria-label={interaction.prompt ?? 'Order the steps'}>
      {interaction.prompt && <p className="milli-course-subprompt">{interaction.prompt}</p>}
      {order.map((id, index) => {
        const item = byId.get(id);
        if (!item) return null;
        const stateClass = status === 'correct' ? 'is-correct' : status === 'incorrect' && wrongSet.has(id) ? 'is-wrong' : '';
        return (
          <div key={id} role="listitem" className={`milli-course-order-item ${stateClass}`}>
            <span className="milli-course-order-num">{index + 1}</span>
            <span className="milli-course-order-text">{item.text}</span>
            {!locked && (
              <span className="milli-course-order-btns">
                <button type="button" aria-label={`Move ${item.text} up`} disabled={index === 0} onClick={() => move(index, -1)}><ArrowUp size={15} /></button>
                <button type="button" aria-label={`Move ${item.text} down`} disabled={index === order.length - 1} onClick={() => move(index, 1)}><ArrowDown size={15} /></button>
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}

function MatchWidget({
  interaction, answer, onChange, locked, status, wrongSet, onReset,
}: {
  interaction: Extract<CourseInteraction, { type: 'match' }>;
  answer?: CourseAnswer;
  onChange: (next: CourseAnswer) => void;
  locked: boolean;
  status: 'idle' | 'correct' | 'incorrect';
  wrongSet: Set<string>;
  onReset: () => void;
}) {
  const pairs = answer?.type === 'match' ? answer.pairs : {};
  const [selectedLeft, setSelectedLeft] = useState<string | undefined>(() => interaction.pairs[0]?.id);
  const rightOptions = [...interaction.pairs].reverse();

  function pairWith(rightId: string) {
    if (locked) return;
    const leftId = selectedLeft ?? interaction.pairs.find(p => !pairs[p.id])?.id ?? interaction.pairs[0]?.id;
    if (!leftId) return;
    const next = { ...pairs, [leftId]: rightId };
    onChange({ type: 'match', pairs: next });
    const nextUnpaired = interaction.pairs.find(p => p.id !== leftId && !next[p.id])?.id;
    setSelectedLeft(nextUnpaired);
  }

  return (
    <div className="milli-course-match-block">
      <div className="milli-course-match-grid">
        <div className="milli-course-match-col">
          {interaction.pairs.map(p => {
            const matchedRight = interaction.pairs.find(r => r.id === pairs[p.id]);
            const stateClass = status === 'correct' ? 'is-correct' : status === 'incorrect' && wrongSet.has(p.id) ? 'is-wrong' : selectedLeft === p.id ? 'is-active' : '';
            return (
              <button
                key={p.id}
                type="button"
                disabled={locked}
                className={`milli-course-match-card ${stateClass}`}
                onClick={() => setSelectedLeft(p.id)}
              >
                <strong>{p.left}</strong>
                {matchedRight && <small>→ {matchedRight.right}</small>}
              </button>
            );
          })}
        </div>
        <div className="milli-course-match-col">
          {rightOptions.map(r => (
            <button
              key={r.id}
              type="button"
              disabled={locked}
              className="milli-course-match-card is-right"
              onClick={() => pairWith(r.id)}
            >
              {r.right}
            </button>
          ))}
        </div>
      </div>
      {Object.keys(pairs).length > 0 && !locked && (
        <div className="milli-course-reset-row">
          <button type="button" className="milli-course-start-over" onClick={onReset}><RotateCcw size={14} /> Start over</button>
        </div>
      )}
    </div>
  );
}

function CategorizeWidget({
  interaction, answer, onChange, locked, status, wrongSet, onReset,
}: {
  interaction: Extract<CourseInteraction, { type: 'categorize' }>;
  answer?: CourseAnswer;
  onChange: (next: CourseAnswer) => void;
  locked: boolean;
  status: 'idle' | 'correct' | 'incorrect';
  wrongSet: Set<string>;
  onReset: () => void;
}) {
  const placement = answer?.type === 'categorize' ? answer.placement : {};
  const [selectedItem, setSelectedItem] = useState<string | undefined>(() => interaction.items[0]?.id);

  function assign(bucketId: string, itemId = selectedItem) {
    if (locked || !itemId) return;
    const next = { ...placement, [itemId]: bucketId };
    onChange({ type: 'categorize', placement: next });
    const nextRemaining = interaction.items.find(i => i.id !== itemId && !next[i.id])?.id;
    setSelectedItem(nextRemaining);
  }

  return (
    <div className="milli-course-cat-block">
      <div className="milli-course-cat-buckets">
        {interaction.buckets.map(b => {
          const inside = interaction.items.filter(i => placement[i.id] === b.id);
          return (
            <div
              key={b.id}
              className="milli-course-bucket"
              onDragOver={e => e.preventDefault()}
              onDrop={e => {
                e.preventDefault();
                const id = e.dataTransfer.getData('text/plain');
                if (id) assign(b.id, id);
              }}
            >
              <button
                type="button"
                disabled={locked || !selectedItem}
                className="milli-course-bucket-head"
                onClick={() => assign(b.id)}
              >
                {b.label}
              </button>
              <div className="milli-course-bucket-items">
                {inside.map(item => {
                  const st = status === 'correct' ? 'is-correct' : status === 'incorrect' && wrongSet.has(item.id) ? 'is-wrong' : '';
                  return (
                    <button
                      key={item.id}
                      type="button"
                      disabled={locked}
                      className={`milli-course-tile is-placed ${st}`}
                      onClick={() => {
                        if (locked) return;
                        const next = { ...placement };
                        delete next[item.id];
                        onChange({ type: 'categorize', placement: next });
                        setSelectedItem(item.id);
                      }}
                    >
                      {item.text}
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
      <div className="milli-course-tile-tray" role="group" aria-label="Items to sort">
        {interaction.items.filter(i => !placement[i.id]).map(item => (
          <button
            key={item.id}
            type="button"
            draggable={!locked}
            disabled={locked}
            aria-pressed={selectedItem === item.id}
            className={`milli-course-tile ${selectedItem === item.id ? 'is-active' : ''}`}
            onDragStart={e => e.dataTransfer.setData('text/plain', item.id)}
            onClick={() => setSelectedItem(item.id)}
          >
            {item.text}
          </button>
        ))}
      </div>
      {Object.keys(placement).length > 0 && !locked && (
        <div className="milli-course-reset-row">
          <button type="button" className="milli-course-start-over" onClick={onReset}><RotateCcw size={14} /> Start over</button>
        </div>
      )}
    </div>
  );
}

function MarkPointsWidget({
  interaction, answer, onChange, locked, onReset,
}: {
  interaction: Extract<CourseInteraction, { type: 'mark-points' }>;
  answer?: CourseAnswer;
  onChange: (next: CourseAnswer) => void;
  locked: boolean;
  onReset: () => void;
}) {
  const points = answer?.type === 'mark-points' ? answer.points : [];
  return (
    <div className="milli-course-mark-bar">
      <div className="milli-course-mark-pills" role="status">
        <span>
          Marked {points.length} of {interaction.targets.length} {interaction.targets.length === 1 ? 'point' : 'points'}
        </span>
        {points.map((pt, i) => (
          <button
            key={`${i}-${pt.x}-${pt.y}`}
            type="button"
            disabled={locked}
            className="milli-course-point-chip"
            aria-label={`Remove point (${pt.x}, ${pt.y})`}
            onClick={() => onChange({ type: 'mark-points', points: points.filter((_, idx) => idx !== i) })}
          >
            ({pt.x}, {pt.y}) ×
          </button>
        ))}
      </div>
      {points.length > 0 && !locked && (
        <button type="button" className="milli-course-start-over" onClick={onReset}>
          <RotateCcw size={14} /> Start over
        </button>
      )}
    </div>
  );
}

function SliderWidget({
  interaction, answer, onChange, locked,
}: {
  interaction: Extract<CourseInteraction, { type: 'slider' }>;
  answer?: CourseAnswer;
  onChange: (next: CourseAnswer) => void;
  locked: boolean;
}) {
  const value = answer?.type === 'slider' ? answer.value : interaction.initial;
  return (
    <div className="milli-course-slider-card">
      <label className="milli-course-slider-label">
        <span>{interaction.label}</span>
        <strong>{value}{interaction.unit ?? ''}</strong>
      </label>
      <input
        type="range"
        aria-label={interaction.label}
        min={interaction.min}
        max={interaction.max}
        step={interaction.step}
        disabled={locked}
        value={value}
        onChange={e => onChange({ type: 'slider', value: Number(e.target.value) })}
        className="milli-course-range"
      />
    </div>
  );
}
