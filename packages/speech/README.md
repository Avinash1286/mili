# Tokai speech foundation

`@tokai/speech` is a **server-only** HTTP AssemblyAI TTS adapter. It sends one bounded text request to the US endpoint and returns validated WAV bytes. Credentials stay in the server process. Requests time out after 30 seconds, can be locally aborted, reject redirects, cap audio at 8 MiB, and do not expose upstream error bodies. There is no automatic retry of potentially billable requests.

```ts
import { synthesizeSpeech } from '@tokai/speech';
const { audio, contentType } = await synthesizeSpeech({
  text: 'What does a chloroplast do?',
  apiKey: process.env.ASSEMBLYAI_API_KEY!,
  signal: requestAbortSignal,
});
```

Do not import the main entry point in a browser bundle. Provider-independent `@tokai/speech/epochs` and `@tokai/speech/timing` subpaths are browser-safe. Epoch invalidation aborts work and rejects late results; the player must additionally clear its audio queue. HTTP abort does not establish provider-side cancellation or a billing refund.

`PlaybackTimingMap` prepares the streaming timing contract: correlate a provider connection plus flush ID, subtract `audio_start_ms` from word offsets, and anchor to the actual request playback start. This remains correct when the provider timeline includes cancelled audio. Boundaries arriving after playback cannot retroactively highlight words; use them only for future buffered playback or saved recap playback.

Implemented: HTTP synthesis, bounded safe errors, local request cancellation, epoch and timing helpers. **Not implemented:** streaming STT, TTS WebSocket sessions, browser microphone/AudioWorklet, live word timings, provider cancellation acknowledgements, provider rotation. `SPEECH_CAPABILITIES` reports this accurately. No live API request has been made by the unit tests.

Run package checks using `pnpm --filter @tokai/speech typecheck` and `pnpm --filter @tokai/speech test`. The repository probe makes no request without `--live`: `pnpm exec tsx scripts/verify-speech.ts --live`. It requires `ASSEMBLYAI_API_KEY`, writes only `var/probes/assemblyai-tts-probe.wav`, and refuses to overwrite that file. It tests HTTP TTS only, not the full probe envisioned by `imp.md`.

References checked 3 November 2026: [AssemblyAI HTTP quickstart](https://www.assemblyai.com/docs/tts/getting-started/quickstart), [word boundary semantics](https://www.assemblyai.com/docs/tts/word-boundaries).
