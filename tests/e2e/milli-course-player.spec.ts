import { test, expect } from '@playwright/test';
import { fixtureTransport } from '../fixtures/browser.js';

test.beforeEach(async ({ page }) => { await fixtureTransport(page); });
// Let pending progress writes finish before Playwright disposes routed responses.
test.afterEach(async ({ page }) => { await page.unrouteAll({ behavior: 'wait' }); });

test('fits a tall generated diagram above the answer on desktop and mobile', async ({ page }) => {
  await page.route('http://localhost:4000/v1/sessions/*/course', async route => {
    const url = new URL(route.request().url());
    url.port = '4100';
    const response = await route.fetch({ url: url.toString() });
    const body = await response.json();
    body.script.chapters[0].steps[0].visual = {
      kind: 'shapes', id: 'tall-leaf', alt: 'Sun beside a tall leaf',
      elements: [
        { type: 'circle', id: 'sun', cx: 80, cy: 55, r: 30, fill: 'yellow' },
        { type: 'polygon', id: 'leaf', points: [[200, 45], [300, 195], [200, 345], [100, 195]], fill: 'green' },
      ],
    };
    await route.fulfill({ response, json: body });
  });
  await page.goto('/learn');
  await page.getByRole('button', { name: 'Offline demo', exact: true }).click();
  await page.getByRole('button', { name: /^Photosynthesis/ }).click();
  await page.getByRole('button', { name: /Ready for question/ }).click();
  const diagram = page.locator('svg[aria-label="Sun beside a tall leaf"]');
  for (const width of [1366, 390]) {
    await page.setViewportSize({ width, height: 768 });
    await expect.poll(() => diagram.evaluate(svg => {
      const leaf = svg.querySelector('polygon')!.getBoundingClientRect();
      const frame = svg.getBoundingClientRect();
      const answerArea = document.querySelector('.milli-course-question-section')!.getBoundingClientRect();
      return leaf.bottom < frame.bottom && frame.bottom < answerArea.top;
    })).toBe(true);
  }
});

test('asks for an answer in words, demonstrates a graph change, and responds when the learner reaches the target', async ({ page }) => {
  await page.goto('/learn');
  await page.getByRole('button', { name: 'Offline demo', exact: true }).click();
  await page.getByRole('button', { name: /^Circuits/ }).click();
  const ready = page.getByRole('button', { name: /Ready for question/ });
  await ready.click();
  await page.getByRole('button', { name: 'False', exact: true }).click();
  await page.getByRole('button', { name: 'Check', exact: true }).click();
  await page.getByRole('button', { name: 'Continue', exact: true }).click();

  await ready.click();
  await expect(page.getByText('What happens to the bulb when you open the switch?', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Check', exact: true })).toHaveCount(0);
  const answer = page.getByRole('textbox', { name: 'Your answer', exact: true });
  await answer.fill('The bulb gets brighter.');
  await page.getByRole('button', { name: 'Send answer' }).click();
  await expect(page.getByText(/Can charge cross the gap/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Continue', exact: true })).toHaveCount(0);
  await answer.fill('The bulb goes out.');
  await page.getByRole('button', { name: 'Send answer' }).click();
  await expect(page.getByText(/current stops flowing through the bulb/)).toBeVisible();
  await page.getByRole('button', { name: 'Continue', exact: true }).first().click();

  await page.getByRole('button', { name: 'Watch milli adjust the graph' }).click();
  await expect(page.getByText(/Milli set Resistance R .* to 2/)).toBeVisible();
  await ready.click();
  const resistance = page.getByRole('slider', { name: /Resistance R/ });
  await expect(resistance).toHaveValue('6');
  await resistance.fill('3');
  await expect(page.getByText(/At 3 Ω, the graph hits the target/)).toBeVisible();
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await ready.click();
  await page.getByRole('textbox', { name: 'Blank amps' }).fill('4');
  await page.getByRole('button', { name: 'Check', exact: true }).click();
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Quick recall' })).toBeVisible();
});

test('completes Fractions from equivalent bars to addition', async ({ page }) => {
  await page.goto('/learn');
  await page.getByRole('button', { name: 'Offline demo', exact: true }).click();
  await page.getByRole('button', { name: /^Fractions/ }).click();
  const ready = page.getByRole('button', { name: /Ready for question/ });
  const check = page.getByRole('button', { name: 'Check', exact: true });
  const next = page.getByRole('button', { name: 'Continue', exact: true });
  await ready.click();
  const two = page.getByRole('group', { name: 'Answer tiles' }).getByRole('button', { name: '2', exact: true });
  await two.click();
  await two.click();
  await check.click();
  await next.click();
  await ready.click();
  const slider = page.getByRole('slider', { name: 'Shaded sixths' });
  await expect(slider).toHaveValue('1');
  await slider.fill('3');
  await expect(page.getByRole('img', { name: '3 of 6 shaded' })).toBeVisible();
  await check.click();
  await next.click();
  await ready.click();
  await page.getByRole('textbox', { name: 'Blank num' }).fill('3');
  await check.click();
  await next.click();
  await expect(page.getByRole('heading', { name: 'Quick recall' })).toBeVisible();
  await page.getByText('Why does 1/2 equal 2/4?', { exact: true }).click();
  await expect(page.getByText(/without changing the amount/)).toBeVisible();
});

test('completes Photosynthesis and marks the true plateau by keyboard entry', async ({ page }) => {
  await page.goto('/learn');
  await page.getByRole('button', { name: 'Offline demo', exact: true }).click();
  await page.getByRole('button', { name: /^Photosynthesis/ }).click();
  const ready = page.getByRole('button', { name: /Ready for question/ });
  const check = page.getByRole('button', { name: 'Check', exact: true });
  const next = page.getByRole('button', { name: 'Continue', exact: true });
  async function advance() { await check.click(); await next.click(); await ready.click(); }
  await ready.click();
  await page.getByRole('button', { name: /Taken in/ }).click();
  await page.getByRole('button', { name: /Taken in/ }).click();
  await page.getByRole('button', { name: /Made \(outputs\)/ }).click();
  await page.getByRole('button', { name: /Made \(outputs\)/ }).click();
  await advance();
  const six = page.getByRole('group', { name: 'Answer tiles' }).getByRole('button', { name: '6', exact: true });
  await six.click();
  await six.click();
  await six.click();
  await advance();
  await page.getByRole('button', { name: 'True', exact: true }).click();
  await advance();
  const moveLight = page.getByRole('button', { name: /^Move Chlorophyll.* up$/ });
  await moveLight.click();
  await moveLight.click();
  await advance();
  await page.getByText('Enter a point by coordinates', { exact: true }).click();
  await page.getByRole('spinbutton', { name: 'X coordinate' }).fill('6');
  await page.getByRole('spinbutton', { name: 'Y coordinate' }).fill('8');
  await page.getByRole('button', { name: 'Mark point' }).click();
  await advance();
  await page.getByRole('button', { name: /stop supplying fresh ATP/ }).click();
  await check.click();
  await next.click();
  await expect(page.getByRole('heading', { name: 'Quick recall' })).toBeVisible();
});

test('learner experiences Concept -> Question agentic loop, asks an off-script side-question with bridge-back, and earns XP', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', err => errors.push(err.message));
  let releaseCorrectSave!: () => void;
  const correctSaveGate = new Promise<void>(resolve => { releaseCorrectSave = resolve; });
  await page.route('http://localhost:4000/v1/sessions/*/course-progress', async route => {
    const { progress } = route.request().postDataJSON();
    if (progress.step === 0 && progress.xp === 15) await correctSaveGate;
    await route.fallback();
  });

  await page.goto('/learn');
  await expect(page.getByRole('heading', { name: 'What do you want to learn?' })).toBeVisible();
  await page.getByRole('button', { name: 'Offline demo', exact: true }).click();
  await page.getByRole('button', { name: /^The solar system/ }).click();
  await expect(page).toHaveURL(/\/learn\//);

  // Step 1 starts in 'teach' stage: presents concept + visual first before asking the question
  await expect(page.getByRole('heading', { name: '"Leap year" searches' })).toBeVisible();
  await expect(page.getByText('Concept 1.1')).toBeVisible();
  const readyBtn = page.getByRole('button', { name: /Ready for question/ });
  await expect(readyBtn).toBeVisible();
  await page.screenshot({ path: '.logs/milli-course-step-1-teach.png', fullPage: true });

  // Advance to 'practice' stage -> reveals question prompt & interactive plot targets
  await readyBtn.click();
  await expect(page.getByText('Your turn · 1.1')).toBeVisible();
  const checkBtn = page.getByRole('button', { name: 'Check', exact: true });
  await expect(checkBtn).toBeDisabled();

  // Learner ignores the active question and asks a side question instead!
  await page.getByRole('button', { name: /Ask milli anything by typing/ }).click();
  const input = page.getByRole('textbox', { name: /Ask milli any question/ });
  await input.fill('Wait, why do leap years happen every 4 years?');
  await input.press('Enter');

  // Tutor answers the side-question AND shows the re-anchoring bridge back to the prepared study track!
  await expect(page.getByText('Answered your question')).toBeVisible();
  await expect(page.getByText('Back on our lesson track')).toBeVisible();
  await page.screenshot({ path: '.logs/milli-course-step-1-side-question.png', fullPage: true });
  await page.getByRole('button', { name: 'Back to question', exact: true }).click();

  // Click the two orange target points on the plot and Check
  const targets = page.locator('.milli-course-point-target');
  await expect(targets).toHaveCount(2);
  await targets.nth(0).click();
  await targets.nth(1).click();
  await expect(checkBtn).toBeEnabled();
  await checkBtn.click();

  await expect(page.getByText('Yep.', { exact: true })).toBeVisible();
  await expect(page.getByLabel(/15 experience points/)).toBeVisible();
  await page.screenshot({ path: '.logs/milli-course-step-1-checked.png', fullPage: true });

  const advanceSaved = page.waitForResponse(response =>
    response.url().endsWith('/course-progress') && response.request().postDataJSON().progress.step === 1);
  try {
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Coordinates of the peaks' })).toBeVisible();
  } finally {
    releaseCorrectSave();
  }
  expect((await advanceSaved).ok()).toBe(true);
  await page.reload();

  // Step 2 and earned XP survive reloading after a quick Continue.
  await expect(page.getByRole('heading', { name: 'Coordinates of the peaks' })).toBeVisible();
  await expect(page.getByLabel(/15 experience points/)).toBeVisible();
  await page.getByRole('button', { name: /Ready for question/ }).click();

  await page.getByRole('button', { name: '2', exact: true }).click();
  await page.getByRole('button', { name: '6', exact: true }).click();
  await page.getByRole('button', { name: 'Check', exact: true }).click();

  await expect(page.getByText('Yep.', { exact: true })).toBeVisible();
  await page.screenshot({ path: '.logs/milli-course-step-2-checked.png', fullPage: true });

  // Click Why? -> split explanation column appears with "Does that make sense?"
  await page.getByRole('button', { name: 'Why?', exact: true }).click();
  await expect(page.getByText(/The graph repeats every 4 years/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Yes', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Explain simpler', exact: true })).toBeVisible();
  await page.screenshot({ path: '.logs/milli-course-step-2-why-split.png', fullPage: true });

  const next = page.getByRole('button', { name: 'Continue', exact: true });
  await next.click();
  await readyBtn.click();
  await page.getByRole('button', { name: 't = 10', exact: true }).click();
  await checkBtn.click();
  await next.click();
  await readyBtn.click();
  await page.getByRole('button', { name: 'Day and night', exact: true }).click();
  await page.getByRole('button', { name: 'One planetary year', exact: true }).click();
  await checkBtn.click();
  await next.click();
  await readyBtn.click();
  await page.getByRole('button', { name: 'Mars is still on its first orbit.' }).click();
  await checkBtn.click();
  await next.click();
  await expect(page.getByRole('heading', { name: 'Quick recall' })).toBeVisible();
  expect(errors).toEqual([]);
});

test('notifies learner and switches to chat without browser fallback when AssemblyAI is unreachable', async ({ page }) => {
  await page.addInitScript(() => {
    (window as unknown as { __browserSpeechCalls: number }).__browserSpeechCalls = 0;
    if ('speechSynthesis' in window && window.speechSynthesis) {
      window.speechSynthesis.speak = () => {
        (window as unknown as { __browserSpeechCalls: number }).__browserSpeechCalls += 1;
      };
    }
  });

  await page.route('http://localhost:4000/v1/sessions/*/course-speech', async route => {
    await route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({
        code: 'SPEECH_FAILED',
        message: 'AssemblyAI speech is unreachable right now. Continue the lesson with chat.',
      }),
    });
  });

  await page.goto('/learn');
  await page.getByRole('button', { name: /^Live AI/ }).click();
  await page.getByRole('button', { name: /^The solar system/ }).click();
  await expect(page).toHaveURL(/\/learn\//);

  // Unreachable alert appears immediately and chat input opens automatically
  const alert = page.getByRole('alert').filter({ hasText: 'AssemblyAI speech is unreachable right now. Continue the lesson with chat.' });
  await expect(alert).toBeVisible();
  const chatInput = page.getByRole('textbox', { name: /Ask milli any question/ });
  await expect(chatInput).toBeVisible();

  // Confirm zero browser Web Speech fallback calls were made
  const browserCalls = await page.evaluate(() => (window as unknown as { __browserSpeechCalls: number }).__browserSpeechCalls);
  expect(browserCalls).toBe(0);
});

test('opens chat with slide animation, closes cleanly, and formats markdown in feedback bubbles', async ({ page }) => {
  await page.goto('/learn');
  await page.getByRole('button', { name: 'Offline demo', exact: true }).click();
  await page.getByRole('button', { name: /^The solar system/ }).click();
  await expect(page).toHaveURL(/\/learn\//);

  // The stage starts centered without is-split
  const stage = page.locator('.milli-course-stage');
  await expect(stage).toBeVisible();
  await expect(stage).not.toHaveClass(/is-split/);

  // Tap typing icon -> stage slides right (has-chat-open & is-split) and reveals tutor conversation panel
  await page.getByRole('button', { name: /Ask milli anything by typing/ }).click();
  await expect(stage).toHaveClass(/is-split/);
  await expect(stage).toHaveClass(/has-chat-open/);

  const tutorPanel = page.locator('.milli-course-chat-panel');
  await expect(tutorPanel).toBeVisible();
  await expect(tutorPanel.getByText('milli', { exact: true })).toBeVisible();

  // Close the chat panel using the X button
  await tutorPanel.getByRole('button', { name: 'Close tutor conversation panel' }).click();
  await expect(stage).not.toHaveClass(/is-split/);

  // Advance to practice, solve question, and verify bubble renders bold without literal asterisks
  await page.getByRole('button', { name: /Ready for question/ }).click();
  const targets = page.locator('.milli-course-point-target');
  await targets.nth(0).click();
  await targets.nth(1).click();
  await page.getByRole('button', { name: 'Check', exact: true }).click();

  const bubble = page.locator('.milli-course-floating-bubble');
  await expect(bubble).toBeVisible();
  const rawText = await bubble.innerText();
  expect(rawText).not.toContain('**');
});


test('learner chat stays readable and companion renders the accessible orb', async ({ page }) => {
  await page.goto('/learn');
  await page.getByRole('button', { name: 'Offline demo', exact: true }).click();
  await page.getByRole('button', { name: /^Photosynthesis/ }).click();
  await page.getByRole('button', { name: 'Ask milli for help' }).click();
  const input = page.getByPlaceholder('Ask milli anything or answer here…');
  await input.fill('How does **sunlight** help?');
  await input.press('Enter');
  const bubble = page.locator('.milli-course-chat-msg.is-learner .milli-course-chat-msg-bubble').last();
  await expect(bubble).toContainText('sunlight');
  const colors = await bubble.evaluate(el => ({
    background: getComputedStyle(el).backgroundColor,
    text: getComputedStyle(el.querySelector('p')!).color,
    bold: getComputedStyle(el.querySelector('strong')!).color,
  }));
  expect(colors.background).toBe('rgb(232, 247, 237)');
  expect(colors.text).toBe('rgb(20, 83, 45)');
  expect(colors.bold).toBe(colors.text);
  await expect(page.locator('.milli-mascot canvas').first()).toBeVisible();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(page.locator('.milli-mascot canvas').first()).toBeVisible();
});


test('accepts an accurate answer during teaching without forcing a repeat in practice', async ({ page }) => {
  await page.route('http://localhost:4000/v1/sessions/*/course-turn', async route => {
    const url = new URL(route.request().url()); url.port = '4100';
    const response = await route.fetch({ url: url.toString() }); const body = await response.json();
    body.reply = { ...body.reply, intent: 'spoken-answer', markStepSolved: true, advanceToPractice: false,
      spokenText: 'Right, the current needs a complete loop.', displayText: 'Right, the current needs a complete loop.', replies: ['Continue'] };
    await route.fulfill({ response, json: body });
  });
  await page.goto('/learn');
  await page.getByRole('button', { name: 'Offline demo', exact: true }).click();
  await page.getByRole('button', { name: /^Circuits/ }).click();
  await page.getByRole('button', { name: 'Ask milli for help' }).click();
  const input = page.getByRole('textbox', { name: /Ask milli any question/ });
  await input.fill('False, current needs a complete loop.'); await input.press('Enter');
  await expect(page.getByLabel(/15 experience points/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Ready for question' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Continue', exact: true }).last()).toBeVisible();
});


test('keeps the spoken follow-up question in conversation history', async ({ page }) => {
  const spoken = 'The battery pushes electrons that are already in the wire. A complete path lets those charges circulate through the bulb and return to the battery. Imagine the wire as a continuous track: opening the switch makes a gap, so charges cannot keep circulating. What happens to the bulb if we open that switch?';
  expect(spoken.length).toBeGreaterThan(280);
  await page.route('http://localhost:4000/v1/sessions/*/course-turn', async route => {
    const url = new URL(route.request().url()); url.port = '4100';
    const response = await route.fetch({ url: url.toString() }); const body = await response.json();
    body.reply = { ...body.reply, spokenText: spoken, displayText: spoken };
    await route.fulfill({ response, json: body });
  });
  await page.goto('/learn');
  await page.getByRole('button', { name: 'Offline demo', exact: true }).click();
  await page.getByRole('button', { name: /^Circuits/ }).click();
  await page.getByRole('button', { name: 'Ask milli for help' }).click();
  const saved = page.waitForRequest(r => r.url().endsWith('/course-progress') && r.postDataJSON().progress.history?.some((h: {text: string}) => h.text === spoken));
  const input = page.getByRole('textbox', { name: /Ask milli any question/ });
  await input.fill('Why does the loop matter?'); await input.press('Enter');
  await saved;
  await expect(page.locator('.milli-course-chat-thread')).toContainText('What happens to the bulb if we open that switch?');
});
