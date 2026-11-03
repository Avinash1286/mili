# Phase 2 application voice protocol

The browser speaks Tokai's versioned protocol to the local Fastify service. Provider protocols are translated on the server; provider keys never enter the browser. See [provider protocol notes](provider-protocol.md) for the AssemblyAI wire format and [imp.md](../imp.md) for the full product target.

## Ownership and reconnect

1. A live, active lesson owned by the guest obtains a ticket with authenticated `POST /v1/sessions/:id/voice-ticket`.
2. The one-use ticket expires after 30 seconds and is sent to `/v1/voice?ticket=...`. The server validates the exact configured browser Origin and rejects duplicate guest/lesson consumers. Durable guest credentials stay out of the WebSocket URL.
3. `session.ready` supplies the current saved lesson, a connection identity, a new output epoch, and the fixed input/output sample rates. Reconnect always starts with this snapshot. Old audio and partial recognition are never replayed.
4. Typed messages include a request ID persisted as the student's turn identity. Repeated delivery with the same identity does not generate another answer; reusing it for different text is rejected. STT final turns receive identities derived from their provider connection and turn order.
5. This phase reconstructs durable state from the saved snapshot. It does not yet implement the general event-log replay service or shared multi-user editing planned for later phases.

## Controls and audio

The executable source of truth is `packages/contracts/src/voice.ts`. All JSON server events include protocol version, connection ID, session ID, sequence and output epoch. The browser validates them before changing state. PCM audio is mono signed 16-bit little endian; input is 16 kHz and output is 24 kHz. Capture/playback worklets convert from/to the actual AudioContext rate.

| Header offset | Field | Format |
| --- | --- | --- |
| 0 | Magic `TOK1` | Four bytes |
| 4 | Protocol version | u8, value 1 |
| 5 | Direction | u8, 1 input / 2 output |
| 6 | Encoding | u8, 1 PCM16LE |
| 7 | Channels | u8, 1 mono |
| 8 | Stream ID | u32 LE |
| 12 | Output epoch | u32 LE |
| 16 | Audio sequence | u32 LE |
| 20 | Sample rate | u32 LE |
| 24 | Sample count | u32 LE |
| 28 | PCM payload | Exactly sample count × 2 bytes |

Input starts with `input.audio.start` and its stream ID. The browser buffers a bounded amount while the service opens transcription, and sends PCM only after matching `input.ready`. `input.audio.end` requests endpointing. A partial transcript replaces the previous text for that turn; only a finalized turn enters conversation history.

## Output and cancellation

`audio.start` associates a stream with its message and turn. PCM follows as binary frames. `audio.end` means all server audio has been sent; only the browser's completed playback acknowledgement marks the message as fully played. Generated text stays visible even if playback fails or is interrupted, with delivery state indicating the difference.

The browser clears its output queue immediately when the learner presses Stop or starts speaking. The server increments the epoch, cancels generation/synthesis, and rejects late work. Old-epoch audio cannot resume. Playback acknowledgements report processed source samples; they are an estimate of progress, not proof that a person heard or understood the content. The next tutor request does not assume interrupted, unplayed text was heard.

Server credits limit outstanding browser audio to four seconds. Provider audio waits in a separately bounded queue. Input chunks, message size, requests, active connections, idle time, playback-ack time and session duration are bounded. These controls protect the single-process development runtime; they are not distributed quotas or a measured production capacity claim.

## Diagnostic meaning

- Model response time measures the server tutor call.
- TTS first-audio time measures synthesis startup to the first received PCM, including opening the synthesis connection.
- Browser final-text to playback-processing time starts when `transcript.final` reaches the browser. It excludes earlier endpointing and physical output-device latency.
- Audio duration counters are usage diagnostics. No dollar cost is displayed because current account pricing and billed usage have not been verified.
- The real latency/quality gate in `imp.md` remains pending until credentials, a microphone and representative devices are tested.

The current persistence layer remains file-backed and single-process. PostgreSQL/OIDC/Redis and cloud deployment are still open work tracked in the full plan.
