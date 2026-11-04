# Phase 6 accessibility, recovery and production browser checks

The audit uses pinned `@axe-core/playwright` 4.14.0 and the actual production Next build. It does not establish full WCAG conformance. The initial rendered audit found contrast, accessible-name and keyboard/reflow defects; these were fixed in the application rather than suppressed in the checks.

## Execution

Build the current UI before production browser checks. Do not run another browser runner or Next build concurrently. The local Convex services and configuration must be available for the real API server.

```powershell
pnpm --filter @tokai/web build
$env:TOKAI_E2E_PRODUCTION = '1'
pnpm exec playwright test --config tests/phase6/playwright.config.ts --workers=1
pnpm exec playwright test --config tests/phase6/regression.config.ts --workers=1
```

The normal audit uses isolated provider fixtures and does not invoke paid providers. Axe is required: its absence fails the suite. The Next development-tool portal is excluded, but no application selector or axe rule is suppressed. Each scan attaches its full results, including incomplete checks, and a screenshot under ignored `test-results/phase6`. The regression run writes to `test-results/regression`.

The separate native integration case is skipped by default. Explicitly enable it against the local production build and real local API/Convex installation:

```powershell
$env:TOKAI_E2E_PRODUCTION = '1'
$env:TOKAI_E2E_NATIVE = '1'
pnpm exec playwright test --config tests/phase6/playwright.config.ts production-integration.spec.ts --workers=1
Remove-Item Env:TOKAI_E2E_NATIVE
```

That case registers its own unique `example.invalid` test account, claims its guest sample lesson, signs out and back in, uploads and downloads one small text source through actual private Convex transfers, then deletes its own test account and learning data. It performs one CPU ingestion job and no paid provider request. Browser tracing is disabled for this case; generated credentials are not emitted. The test checks an enforcing production CSP and records only safe origin/status metadata for transfers and policy violations.

## Automated coverage and fixes

- Default colors and semantics on Discover, onboarding, dashboard, library, settings and review; all four Workspace study panels; generated study packs, notes, card editing, active practice and feedback, review ratings, public shares and camera-free spatial diagrams.
- Mobile onboarding at 390 px; 320 px onboarding with saved large-text/reduced-motion preferences; 320 px Workspace study tabs and practice controls with large text. The last test checks control bounds as well as document overflow, since hidden overflow previously concealed a clipped tab.
- Study tabs have one tab stop, arrow/Home/End navigation, selected state and named panel relationships. Narrow or large-text layouts keep all four controls reachable in two columns.
- The drawing-share dialog is portaled outside the workspace, makes background content inert, traps forward/backward focus, closes with Escape and restores focus to its trigger.
- Board and map accessible names include visible labels; full descriptions remain available separately. Wrapped SVG labels preserve spaces. Interactive 2D spatial parts are exposed as keyboard-operable controls.
- Default text colors were darkened where actual computed contrast failed, including generated content and hovered secondary buttons. Spatial diagram label ink is selected against each part's fill. High-contrast preferences are additional controls, not a substitute for a readable default palette.
- A failed saved-materials request stops its loading state and provides a working retry. Practice has the same recovery behavior. A failed usage read leaves editable settings available and can be retried independently.
- A tutor-authored practice action opens the original saved presentation after explicitly stopping voice; hints survive reload and produce an assisted grade. Opening this question does not silently create another presentation.
- An HTTP tutor response lost after server commit can be retried with the same request identity without duplicating the learner turn; changed input gets a new identity.
- Native account forms expose required labels and password bounds. Unverified-email/no-recovery limitations are stated. Usage displays application allowances separately from provider credits/invoices and shows no invented monetary estimate.

Status at this edit: the 23 original Phase 6 fixture cases have passed across the full run and targeted repairs; the added 320 px Workspace check and final combined production/native/regression runs are pending. Replace this status with their recorded results before release.

## Limits and manual checks

- Run a real screen-reader/browser combination through headings, landmarks, live transcript/status updates, errors, practice feedback and SVG alternatives. Automated snapshots do not establish spoken usability.
- Check keyboard-only completion of board editing, review, sharing/revocation and account settings, with visible focus and sensible order. The automated tab/dialog checks cover specific interactions, not every possible state.
- Check 200% browser zoom, mobile touch ergonomics, opened menus and additional viewport sizes. The automated reflow evidence covers the named routes and widths only.
- Inspect axe incomplete results, text over canvas/SVG, focus indicators and non-text contrast manually.
- Existing regression fixtures cover camera/microphone denial, interruption, stopped tracks, local MediaPipe initialization, 3D model loading and text/keyboard alternatives. Synthetic media and mocks do not establish physical camera accuracy, speech intelligibility, echo behavior, real provider quality or performance on mobile hardware.
- No automated result here establishes human learning effectiveness or full WCAG conformance.

The criteria and patterns follow [W3C contrast guidance](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html), the [WAI tabs pattern](https://www.w3.org/WAI/ARIA/apg/patterns/tabs/) and [WAI modal dialog pattern](https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/). Automated checks detect only a subset of accessibility problems; see [Playwright accessibility testing guidance](https://playwright.dev/docs/accessibility-testing).
