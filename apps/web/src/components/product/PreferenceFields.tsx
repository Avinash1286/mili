'use client';

import type { LearnerPreferences } from '@tokai/contracts';
import styles from './Product.module.css';

export function PreferenceFields({ value, onChange, profile = false, disabled = false, languageLocked = false }: {
  value: LearnerPreferences; onChange: (value: LearnerPreferences) => void; profile?: boolean; disabled?: boolean; languageLocked?: boolean;
}) {
  function set<K extends keyof LearnerPreferences>(key: K, next: LearnerPreferences[K]) { onChange({ ...value, [key]: next }); }
  return <div className={styles.fields}>
    {profile && <><label className={styles.field}>Display name<input maxLength={80} value={value.displayName} disabled={disabled} onChange={event => set('displayName', event.target.value)} autoComplete="nickname"/></label><label className={styles.field}>Timezone<input value={value.timezone} disabled={disabled} onChange={event => set('timezone', event.target.value)} placeholder="Asia/Kathmandu" maxLength={80}/><small>Review dates use this timezone. Saved due times stay in UTC.</small></label></>}
    <label className={styles.field}>Learning level<select value={value.level} disabled={disabled} onChange={event => set('level', event.target.value as LearnerPreferences['level'])}><option value="beginner">Beginner — start with the foundations</option><option value="intermediate">Intermediate — build on what I know</option><option value="advanced">Advanced — explore the details</option></select></label>
    <label className={styles.field}>Lesson length (minutes)<input type="number" min={5} max={60} step={1} value={Number.isFinite(value.lessonMinutes) ? value.lessonMinutes : ''} disabled={disabled} onChange={event => set('lessonMinutes', event.target.valueAsNumber)}/></label>
    <label className={styles.field}>Lesson language<select value={value.language} disabled={disabled || languageLocked} onChange={event => set('language', event.target.value as LearnerPreferences['language'])}><option value="english">English</option><option value="spanish">Spanish</option><option value="german">German</option><option value="french">French</option><option value="italian">Italian</option><option value="portuguese">Portuguese</option></select></label>
    <label className={styles.field}>Tutor voice<select value={value.voiceId} disabled={disabled} onChange={event => set('voiceId', event.target.value as LearnerPreferences['voiceId'])}><option value="aai-audrey">Audrey</option><option value="aai-jane">Jane</option><option value="aai-michael">Michael</option></select><small>Availability depends on the configured speech account.</small></label>
    <label className={styles.field}>Explanation style<select value={value.explanationStyle} disabled={disabled} onChange={event => set('explanationStyle', event.target.value as LearnerPreferences['explanationStyle'])}><option value="step-by-step">One step at a time</option><option value="concise">Keep it concise</option><option value="slower">Go more slowly</option></select></label>
    {profile && <label className={`${styles.field} ${styles.wide}`}>Default learning goal<textarea value={value.goal} disabled={disabled} maxLength={500} onChange={event => set('goal', event.target.value)} placeholder="What would you like to feel more confident about?"/></label>}
  </div>;
}
