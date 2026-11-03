// Server entry point. Browser consumers use the ./epochs or ./timing subpaths.
export { synthesizeSpeech, SpeechError, SPEECH_CAPABILITIES } from './synthesis.js';
export type { SynthesizeSpeechInput, SpeechResult, SpeechDependencies, SpeechErrorCode } from './synthesis.js';
export { OutputEpoch } from './epochs.js';
export { PlaybackTimingMap } from './timing.js';
export type { WordBoundaryFrame, PlaybackAnchor, TimedWord } from './timing.js';
