# Tokai development

Read `imp.md` for the complete target product and `docs/progress.md` for delivered work. This checkout starts a fresh implementation; the Agora prototype remains at `F:\tokai-agora` for reference only.

- Use pnpm workspaces, Node.js 24, TypeScript, Next.js and a persistent Fastify API.
- Shared browser-safe schemas live in `packages/contracts`. Keep provider credentials server-side.
- Clearly distinguish the deterministic sample lesson from live AI. Do not present mocked provider calls as live behavior.
- Preserve guest/session ownership on every route and bound provider work.
- Keep accessible keyboard/text alternatives; avoid inert controls masquerading as working features.
- Do not edit other projects or copy the legacy prototype's client-visible API keys.
- Run `pnpm typecheck`, `pnpm test`, and `pnpm build` for relevant application changes.
- Track actual progress and limitations honestly; do not mark a plan phase complete based only on scaffolding.
