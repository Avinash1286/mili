# AssemblyAI provider protocol

Checked against official documentation on **2026-11-03**. The adapters implement the protocol; local mock-provider tests do not prove account access, latency, recognition quality, audibility or live-provider compatibility. No credentialed request was made during implementation. `SPEECH_CAPABILITIES.credentialedStreamingVerified` is false.

## Transcription

The server connects to `wss://streaming.assemblyai.com/v3/ws` using an Authorization header. Input is binary, raw signed PCM16 little endian, mono, 16 kHz. The application should send approximately 50ms chunks (1600 bytes), paced near real time. Audio is never JSON/base64 on this connection. The pinned `speech_model` is `universal-3-6-pro`; `Begin.configuration.model` must match. STT's current Begin schema does not echo audio format, so the query pins it and any future echo is checked. [Message sequence](https://www.assemblyai.com/docs/streaming/message-sequence), [model selection](https://www.assemblyai.com/docs/streaming/select-the-speech-model).

The adapter requests heartbeat events, partials, balanced mode, a 400ms minimum silence and a 1600ms maximum silence. These are initial application settings awaiting live listening tests. `SpeechStarted` uses its provider timestamp; the adapter does not invent a turn number. A `Turn` becomes final only with both `end_of_turn` and `turn_is_formatted` true; connection ID plus `turn_order` is its stable identity. Repeated/older finals are suppressed before application callbacks. [Turn detection](https://www.assemblyai.com/docs/streaming/turn-detection), [WebSocket schema](https://www.assemblyai.com/docs/streaming/api-spec/streaming-websocket).

## Synthesis

The server connects to `wss://tts.us.assemblyai.com/v1/ws` using Authorization, requesting `assemblyai-tts-1`, `aai-audrey`, English, `pcm_s16le`, 24000Hz and word boundaries. Begin must confirm the chosen configuration. Every provider TTS message is JSON text. Audio payloads are bounded base64 strings decoded to mono PCM16; browser framing is a separate application concern. [TTS WebSocket reference](https://www.assemblyai.com/docs/tts/api-reference/websocket-api).

Each output uses a new connection and flush ID zero. `Generate` submits bounded text; `Flush` ends that request. `FlushDone` triggers the delivery callback. The adapter then sends `Terminate`, reads optional boundaries and waits for `Termination`. Cancellation before FlushDone sends `Cancel`, invalidates callbacks immediately, and waits at most 750ms before closing. During negotiation or final draining it closes directly. Frames from cancelled connections never reach callbacks for another output. Provider acknowledgment is not proof of stopped browser playback or a billing refund. [Message frames](https://www.assemblyai.com/docs/tts/message-frames).

Word timings are best-effort and may arrive after the browser has begun playing. They use the provider session timeline. For a matching connection/flush ID, calculate `word.startMs - audioStartMs`, then add the actual browser playback anchor. The player owns scheduling and epoch invalidation. A missing boundary frame does not fail valid audio delivery. [Word boundaries](https://www.assemblyai.com/docs/tts/word-boundaries).

## Resource limits and tradeoffs

The implementation allows at most 2000 Unicode code points per output, additionally bounded by Begin's text limits. There is one active output and no queued speech. A request has a 45-second deadline, a 20-second provider-silence timeout, and a two-minute PCM output cap. Negotiation has a 10-second deadline. Incoming frames are capped at 1MiB; malformed JSON, binary TTS messages, invalid base64, odd PCM byte counts and wrong flush IDs fail closed. Unknown frame types are ignored.

STT accepts at most 500ms per input chunk and normalizes it to 50ms provider frames. A partial final frame is zero-padded on ForceEndpoint; explicit close discards it. This also accommodates the provider error reference's 50ms minimum. Intake uses a bounded token bucket refilling at 1.25× real time with a two-second capacity. The adapter closes after 15 seconds without input and by the lesser of 15 minutes or the negotiated expiry. Heartbeats detect a stalled provider. Both adapters remove signal listeners/timers and close sockets after success, failure, caller abort or deadline. Secrets and raw provider error text never appear in outward errors. No retries occur. [STT errors and closures](https://www.assemblyai.com/docs/streaming/common-session-errors-and-closures).

Fresh TTS connections isolate cancellation but consume session-creation quota and handshake latency. Provider account limits concern new sessions per minute, not a promise of allowed concurrency. Rapid turns on a free account may be rate limited. Reusing sockets requires a separately tested cancel-acknowledgment/flush namespace implementation; this phase deliberately uses fresh sockets. [Provider limits](https://www.assemblyai.com/docs/tts/limits).

## Explicit live validation

Normal startup and tests do not make provider calls. From the repository root:

```powershell
pnpm exec tsx scripts/verify-speech.ts
# Prints instructions only; no network request.

pnpm exec tsx scripts/verify-speech.ts --live
# One paid HTTP synthesis; writes var/probes/assemblyai-tts-probe.wav.

pnpm exec tsx scripts/verify-speech.ts --live --streaming
# Paid streaming TTS, a second deliberately cancelled TTS output, then streaming STT.
# Writes var/probes/assemblyai-streaming-probe.wav only if all checks pass.
```

Live probes require `ASSEMBLYAI_API_KEY` in the root `.env` or process environment. They reserve their fixed output filename before spending credits, refuse overwrites, and reject an output directory resolving outside this project. Move an existing probe deliberately before running another. The streaming probe resamples the generated fixed sentence to 16kHz, sends it in real time and requires a final transcript; it does not certify transcription accuracy. It also requires an interrupted second output on an independent provider session. It does not certify that the provider acknowledged cancellation when the adapter's bounded close fallback was used.

Remaining live gates: run the explicit probe with account access, listen to the saved audio, test microphone permissions/resampling, check browser playback and interruption on real devices, measure latency and endpointing, verify voice/model access and account rate limits, and confirm delayed timing behavior. Human speech accuracy and end-to-end tutoring must be tested separately from this protocol probe. Never describe unrun live gates as passed.
