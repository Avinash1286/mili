import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type TestInfo } from '@playwright/test';

export async function audit(page: Page, info: TestInfo, name: string) {
  const result = await new AxeBuilder({ page }).exclude('nextjs-portal')
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();
  await info.attach(`${name}-axe`, { body: JSON.stringify(result, null, 2), contentType: 'application/json' });
  await info.attach(`${name}-screenshot`, { body: await page.screenshot({ fullPage: true }), contentType: 'image/png' });
  expect(result.violations.map(({ id, help, nodes }) => ({ id, help, targets: nodes.map(node => node.target) }))).toEqual([]);
  // Generic containers with ARIA labels are reported for manual review by axe,
  // but our UI can give those named groups an explicit supported role.
  expect(result.incomplete.filter(rule => rule.id === 'aria-prohibited-attr').map(rule => rule.nodes.map(node => node.target))).toEqual([]);
}

export async function sampleLesson(page: Page) {
  await page.goto('/learn/new');
  await page.getByRole('button', { name: 'Guided sample', exact: true }).click();
  await page.getByRole('combobox', { name: 'Sample topic', exact: true }).selectOption('fractions');
  await page.getByRole('button', { name: 'Start my lesson', exact: true }).click();
  await expect(page).toHaveURL(/\/learn\/[a-f0-9-]{36}$/);
  await expect(page.getByRole('heading', { name: 'Let’s see the bigger picture.', exact: true })).toBeVisible();
  return page.url().split('/').at(-1)!;
}
