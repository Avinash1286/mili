// Server entry point. Browser consumers use the ./epochs or ./timing subpaths.
export { synthesizeSpeech, SpeechError, SPEECH_CAPABILITIES } from './synthesis.js';
export type { SynthesizeSpeechInput, SpeechResult, SpeechDependencies, SpeechErrorCode } from './synthesis.js';
export { OutputEpoch } from './epochs.js';
export { PlaybackTimingMap } from './timing.js';
export type { WordBoundaryFrame, PlaybackAnchor, TimedWord } from './timing.js';
export { createTranscriber, STT_MODEL, STT_SAMPLE_RATE } from './transcription.js';
export type { Transcriber, TranscriberInput, TranscriptTurn, SpeechStarted } from './transcription.js';
export { createSynthesizer, TTS_SAMPLE_RATE } from './streaming-synthesis.js';
export type { Synthesizer, SynthesizerInput, SpeakOptions, SynthesisIdentity, SynthesisDone, SynthesisBoundaries } from './streaming-synthesis.js';
export type { StreamingDependencies, WebSocketFactory } from './transport.js';
