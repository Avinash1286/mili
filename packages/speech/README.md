# Tokai speech adapters

`@tokai/speech` is the **server-only** AssemblyAI integration. It implements HTTP WAV synthesis, streaming STT, streaming PCM TTS, bounded provider cancellation, and word-boundary delivery. All permanent credentials remain in Authorization headers in the server process. No automatic retries of potentially billable work occur. The package's tests use local mock WebSocket providers; **credentialed streaming has not been verified**.

The main entry point imports Node APIs and `ws`. Browser consumers may import only `@tokai/speech/epochs` and `@tokai/speech/timing`. The HTTP API remains `synthesizeSpeech({text, apiKey, voiceId?, signal?})`, returning `{audio: Buffer, contentType: 'audio/wav'}`. HTTP abort does not guarantee upstream cancellation.

```ts
import { createTranscriber, createSynthesizer } from '@tokai/speech';

const transcriber = await createTranscriber({
  apiKey, onPartial, onFinal, onSpeechStarted, onError,
});
transcriber.sendAudio(pcm16Mono16k); // Uint8Array, roughly 50ms / 1600 bytes
transcriber.forceEndpoint();
transcriber.close();

const synthesizer = await createSynthesizer({ apiKey, onAudio, onBoundaries, onError });
await synthesizer.speak('What does a chloroplast do?', { signal, onStart, onDone });
await synthesizer.cancel();
synthesizer.close();
```

`onStart` means the provider accepted the requested configuration. `onDone` means provider audio delivery finished; it does **not** mean the browser played it. `speak()` resolves after the provider ends the request's connection and drains optional word timings. `onAudio` receives signed little-endian PCM16 at 24 kHz, mono. Callbacks are synchronous; a consumer should throw when its downstream queue is full so the adapter closes the provider socket.

Each `speak()` opens a fresh provider socket with one `Generate` and one `Flush`. Cancelling immediately suppresses callbacks from that output and waits at most 750ms for acknowledgment before closing. The next output gets a new connection identity. This avoids reusing a cancelled provider namespace but costs another handshake and counts against provider session-creation limits. Overlapping speaks reject as busy; there is no hidden queue.

STT uses `universal-3-6-pro` with 16 kHz mono PCM16. Partial and final callbacks carry `{providerSessionId, turnOrder, turnId, text}`. Finals are committed once when both final and formatted flags are true. Speech-start callbacks carry `{providerSessionId, timestampMs}` because that provider event has no turn order. `close()` intentionally drops later transcripts.

The second factory argument supports trusted dependency injection: `{webSocketFactory, connectTimeoutMs, idleTimeoutMs, requestTimeoutMs, cancelTimeoutMs, maxSessionMs}`. Do not expose these transport settings to browser requests. STT stops after 15 minutes or earlier provider expiry, and after 15 seconds without microphone input; restarting must be an explicit application action. Provider silence is bounded at 20 seconds, negotiation at 10 seconds, and each TTS request at 45 seconds.

`PlaybackTimingMap` maps each connection/flush ID independently: subtract the provider's audio start offset, then anchor to that output's actual playback start. Cancelled provider audio never becomes a browser clock offset. Clear scheduled playback and highlights when invalidating an `OutputEpoch`. Word boundaries arrive after complete audio delivery, can be absent, and may be too late for the initial playback; `liveWordTimings` therefore remains false while `wordBoundaries` is true.

Checks: `pnpm --filter @tokai/speech typecheck` and `pnpm --filter @tokai/speech test`. See [provider protocol and live probe](../../docs/provider-protocol.md) for the verified wire contract, limits and remaining live-validation gates.
