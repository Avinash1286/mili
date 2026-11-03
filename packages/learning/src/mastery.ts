import { MasteryEvidenceSchema, MasteryEstimateSchema, type MasteryEvidence, type MasteryEstimate } from '@tokai/contracts';
import { DAY, check, immutable, timestamp, unique } from './common';

/** Evidence is qualitative. Repeating one question on one UTC day cannot create additional support. */
export function deriveMastery(input: MasteryEvidence[], now: string, concepts: { packId: string; conceptId: string }[] = []): MasteryEstimate[] {
  const evaluated = timestamp(now), seen = new Map<string, MasteryEvidence>();
  for (const raw of input) {
    const item = MasteryEvidenceSchema.parse(raw);
    check(timestamp(item.observedAt) <= evaluated, 'INVALID_TIME', 'Mastery evidence cannot come from the future.');
    const duplicate = seen.get(item.id);
    check(!duplicate || JSON.stringify(duplicate) === JSON.stringify(item), 'IDEMPOTENCY_CONFLICT', 'An evidence ID cannot identify different observations.');
    seen.set(item.id, item);
  }
  const keys = unique([...concepts.map(item => JSON.stringify([item.packId, item.conceptId])), ...[...seen.values()].map(item => JSON.stringify([item.packId, item.conceptId]))]);
  return immutable(keys.map(key => {
    const [packId, conceptId] = JSON.parse(key) as [string, string];
    const active = [...seen.values()].filter(item => item.packId === packId && item.conceptId === conceptId && !item.invalidatedAt && item.outcome !== 'uncertain').sort((a, b) => timestamp(a.observedAt) - timestamp(b.observedAt) || a.id.localeCompare(b.id));
    const attempts = new Map<string, MasteryEvidence>();
    for (const item of active) attempts.set(item.attemptId, item);
    const observations = new Map<string, MasteryEvidence>();
    for (const item of attempts.values()) observations.set(JSON.stringify([item.assessmentId, item.observedAt.slice(0, 10)]), item);
    const evidence = [...observations.values()].sort((a, b) => timestamp(a.observedAt) - timestamp(b.observedAt));
    const independent = evidence.filter(item => item.outcome === 'independent-correct'), assisted = evidence.filter(item => item.outcome === 'assisted-correct');
    const recentIndependent = independent.filter(item => evaluated - timestamp(item.observedAt) <= 30 * DAY);
    const recent = evidence.at(-1), stale = Boolean(recent && evaluated - timestamp(recent.observedAt) > 30 * DAY);
    const supported = recentIndependent.length >= 3 && new Set(recentIndependent.map(item => item.assessmentId)).size >= 2 && new Set(recentIndependent.map(item => item.observedAt.slice(0, 10))).size >= 2;
    let state: MasteryEstimate['state'] = 'unknown', confidence: MasteryEstimate['confidence'] = 'insufficient';
    let explanation = 'No usable assessment evidence yet. Seeing a concept or hearing an explanation does not establish understanding.';
    if (evidence.length) {
      state = 'learning'; confidence = 'emerging'; explanation = 'Some practice is recorded. Independent success across different questions and days will provide stronger evidence.';
      if (supported) { state = 'demonstrated'; confidence = 'supported'; explanation = 'Recent independent successes span multiple questions and UTC days. This is supported evidence, not a precise ability score.'; }
      else if (recentIndependent.length >= 2) { state = 'practicing'; explanation = 'There are independent successes, with more varied or spaced practice still needed.'; }
      if (recent?.outcome === 'incorrect') { state = 'needs-review'; explanation = 'The most recent usable attempt showed a difficulty. Revisit the explanation and try another question.'; }
      if (stale || (independent.length >= 3 && recentIndependent.length === 0)) { state = 'needs-review'; confidence = 'stale'; explanation = 'The independent evidence is over 30 days old, or recent evidence is missing. A fresh retrieval attempt will update this estimate.'; }
    }
    return MasteryEstimateSchema.parse({ packId, conceptId, state, confidence, evidenceCount: evidence.length, independentSuccesses: independent.length, assistedSuccesses: assisted.length, ...(recent ? { lastEvidenceAt: recent.observedAt } : {}), evaluatedAt: now, algorithmVersion: 'tokai-mastery-v1', explanation });
  }));
}
