# milli

**milli is a complete voice-first, adaptive learning experience.** It teaches with short conversational explanations, live visuals, hands-on challenges, and follow-up questions that respond to what the learner actually says or does.

The product is built for a one-to-one tutoring moment—not an audiobook. A learner can say or type a topic, watch milli introduce the first idea, adjust a graph or diagram, answer aloud or in writing, ask a side question, and continue through an adaptive course. Their courses persist privately and can be resumed later.

> **Project status:** complete for local use. The full product workflow, live providers, persistence, native sign-in, and automated checks are implemented. Hosting it publicly is a deployment/configuration decision; it is not required to run the application locally.

## What milli does

- **Teaches conversationally.** Live course prompts direct milli to use the learner’s words, teach through a concrete example, ask one question at a time, and respond to misconceptions rather than reciting definitions.
- **Supports real voice interaction.** AssemblyAI streaming transcription captures spoken answers, and AssemblyAI TTS delivers milli’s teaching. The learner can interrupt narration, talk back, or switch to the keyboard at any time.
- **Makes learning active.** Course steps can include multiple choice, true/false, fill-in, ordering, matching, categorization, point marking, sliders, graphs, diagrams, and spoken open questions. Interactions have accessible keyboard/text alternatives.
- **Adapts to the learner.** Correct answers receive specific feedback; repeated difficulty can insert a smaller remedial step. A side question is answered and then gently bridged back to the current task.
- **Distinguishes prepared and live behavior honestly.** Offline demo courses use deterministic, prepared teaching and are visibly labeled. Live AI courses use configured providers; unavailable speech or model services fall back to typed continuation rather than pretending a response was live.
- **Saves courses securely.** Guests receive an expiring browser-bound workspace. A signed-in learner can claim that work and access it through **Courses**.
- **Provides a complete learning toolkit.** The workspace includes source upload/grounding, assessment and mastery tools, recall cards, study packs, exports, recap audio, revocable sharing, notes, and learner preferences.

## Product routes

| Route | Purpose |
| --- | --- |
| `/` | Public milli landing page |
| `/learn` | Learn hub: type or dictate a topic, start a prepared activity, or resume a course |
| `/learn/[id]` | Interactive course player |
| `/courses` | All courses owned by the current guest or signed-in learner |
| `/sign-in` | Convex-backed email/password account entry |
| `/settings` | Account, privacy, preferences, voice, and accessibility settings |
| `/library` | Private learner source library |

The top navigation intentionally stays small: **Learn** plus a profile menu for Courses, Settings, and Sign in/Account. Legacy `/review`, `/dashboard`, and `/learn/new` links redirect to their current destinations.

## Architecture

```text
┌─────────────────────────────────────────────────────────────────┐
│ Next.js web app                                                   │
│ Landing · Learn · Course player · Courses · Settings · Sign in   │
│ Browser audio, captions, keyboard/text alternatives, visuals     │
└───────────────────────┬─────────────────────────────────────────┘
                        │ authenticated HTTP + bounded WebSocket
┌───────────────────────▼─────────────────────────────────────────┐
│ Fastify API                                                       │
│ Ownership checks · course orchestration · rate/usage limits      │
│ private transfers · speech relay · background-job coordination   │
└───────┬──────────────────────┬───────────────────────┬──────────┘
        │                      │                       │
┌───────▼────────┐   ┌─────────▼──────────┐   ┌────────▼─────────┐
│ Convex         │   │ Tutor providers    │   │ AssemblyAI       │
│ sessions/files │   │ Groq → Cerebras →  │   │ streaming STT    │
│ jobs/auth/data │   │ Gemini             │   │ TTS + previews   │
└────────────────┘   └────────────────────┘   └──────────────────┘
```

### Main building blocks

| Area | Responsibility |
| --- | --- |
| `apps/web` | Next.js UI, lesson player, browser audio, accessible interactions, local gesture/3D experiences |
| `apps/api` | Persistent Fastify API, ownership enforcement, course routes, speech relay, provider orchestration |
| `convex` | Transactional persistence, durable jobs, private storage, native auth state, retention cleanup |
| `packages/contracts` | Browser-safe schemas, validated course scripts, interaction engine, safe math evaluation |
| `packages/tutor-core` | Sample courses, live course authoring, adaptive teaching rules, provider adapters |
| `packages/speech` | Server-side AssemblyAI STT/TTS adapters and audio lifecycle support |
| `packages/learning` | Assessments, mastery, recall scheduling, study packs, exports |
| `packages/grounding` | Bounded source parsing, OCR, embeddings, retrieval |
| `packages/db` | Convex storage adapter plus an isolated compatibility adapter for tests/legacy data |

### Course lifecycle

1. The learner types or says a topic in `/learn`, or opens a prepared lesson.
2. The API creates an owner-scoped course immediately; the first concept loads before the full syllabus is ready.
3. milli teaches one focused idea with a visual and AssemblyAI speech, then opens a question or task.
4. A typed answer, spoken answer, or visual action is evaluated against the current step.
5. milli gives grounded feedback, adapts when needed, and records the progress in Convex.
6. The learner can resume the course from `/courses`, finish it, and use its saved study materials.

## Live providers

All credentials stay server-side in ignored environment files.

| Capability | Provider behavior |
| --- | --- |
| General live tutoring, courses, grading, cards, recaps | **Groq → Cerebras → Gemini**; unconfigured providers are skipped and cancellation stops the chain |
| Visual/image explanations | Gemini vision adapter |
| Spoken learner input | AssemblyAI streaming STT |
| milli’s spoken teaching and recap | AssemblyAI TTS |

Prepared courses never masquerade as provider-backed interactions. When live speech is unavailable, milli states that clearly and opens the typed route so the lesson can continue.

## Local setup

### Requirements

- Node.js 24
- pnpm 10.33+
- Provider credentials for the live features you want to use

```powershell
cd F:\mili
pnpm install --frozen-lockfile
if (-not (Test-Path -LiteralPath .env)) { Copy-Item -LiteralPath .env.example -Destination .env }
pnpm assets:sync
pnpm models:sync
```

Add provider credentials only to ignored `.env`. Do not put provider keys in `NEXT_PUBLIC_*` variables.

### Initialize Convex and native accounts

Run this once from the repository root:

```powershell
pnpm exec convex init
pnpm local:setup
```

Start the local Convex runtime in one terminal. The explicit anonymous mode prevents the CLI from asking to link a cloud account:

```powershell
$env:CONVEX_AGENT_MODE='anonymous'
pnpm local:convex
```

In another terminal, provision the locally generated service configuration:

```powershell
pnpm exec convex env set --from-file .tokai/convex.env
```

Then run the product:

```powershell
pnpm dev
```

Open [http://localhost:3000](http://localhost:3000). The API health endpoint at [http://localhost:4000/health/live](http://localhost:4000/health/live) reports whether live tutor, speech, and voice capabilities are available.

### Authentication

Native email/password authentication is powered by Convex and Better Auth. A guest can use milli immediately; creating or signing into an account migrates their browser-owned learning space to that account. Email verification and password recovery are intentionally not configured for the local setup, and the sign-in UI discloses this.

## Development and verification

```powershell
pnpm typecheck
pnpm test
pnpm build
pnpm test:e2e
pnpm assets:check
pnpm models:check
pnpm api:spec:check
pnpm check:secrets
```

Focused provider checks consume configured provider quota and are intentionally separate:

```powershell
pnpm verify:tutor --live
pnpm verify:teaching --live --timeout=45000
pnpm verify:speech --live --streaming
```

The application was verified with workspace typechecking, unit/integration tests, a production Next.js build, browser course walkthroughs, navigation/Courses tests, live AssemblyAI speech, and real Groq/Cerebras provider probes. Live measurements are local observations, not production latency guarantees.

## Privacy and security

- Provider keys are server-only and `.env*`, `.convex`, and `.tokai` are ignored by Git.
- Every course, source, file transfer, provider operation, and voice stream is ownership-bound to its guest or signed-in learner.
- Guest credentials expire; account sign-in claims eligible guest work rather than exposing it to other users.
- Streaming voice authenticates in the first message or cookie, never in a URL. Streams are origin-checked and bounded.
- Sharing is opt-in and revocable. Transcript and recap retention are learner-configurable.
- Camera processing stays in the browser. A learner must explicitly choose to share a visual context.

## Deliberate boundaries

milli is complete as a locally runnable product, but these operational boundaries remain explicit:

- Public hosting, custom domains, billing upgrades, and hackathon submission materials are not included.
- Live quality and latency depend on the configured third-party providers and network conditions.
- The local native-account flow has no email verification or password-recovery email service.
- Real-device, assistive-technology, Safari/iOS, and independent curriculum-effectiveness studies are separate validation activities; they are not represented as completed by automated Chromium tests.

For detailed engineering evidence and historical implementation notes, see [docs/progress.md](docs/progress.md), [the OpenAPI contract](docs/openapi.json), [the local Convex guide](infra/local/README.md), and [privacy/provenance notes](docs/provenance.md).
