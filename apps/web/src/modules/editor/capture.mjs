import { chromium } from 'playwright';

const origin = process.env.EDITOR_ORIGIN || 'http://127.0.0.1:5184';
const ordinaryId = process.env.EDITOR_ORDINARY_ID;
const megaId = process.env.EDITOR_MEGA_ID;
const output = process.env.EDITOR_SCREENSHOTS;
if (!ordinaryId || !megaId || !output)
  throw new Error('Set EDITOR_ORDINARY_ID, EDITOR_MEGA_ID and EDITOR_SCREENSHOTS');

const browser = await chromium.launch({
  ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
    ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
    : {}),
  headless: true,
  args: ['--no-sandbox'],
});
const context = await browser.newContext({ viewport: { width: 1600, height: 1100 } });
const page = await context.newPage();
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
try {
  await page.goto(`${origin}/login`);
  await page.getByLabel('Электронная почта').fill('author@vsm.demo');
  await page.getByLabel('Пароль').fill('DemoTrain2026!');
  await page.getByRole('button', { name: 'Войти', exact: true }).click();
  await page.waitForURL('**/account');

  await page.goto(`${origin}/editor?scenario=${ordinaryId}`);
  await page.locator('.ed-graph-node-answer').first().waitFor();
  await page.locator('.ed-graph-node-answer').first().click();
  await page.screenshot({ path: `${output}/live-ordinary-readable.png` });
  await page.getByRole('button', { name: 'К узлу' }).click();
  await page.waitForTimeout(300);
  const viewport = page.locator('.react-flow__viewport');
  const before = await viewport.getAttribute('style');
  const title = await page.getByLabel('Заголовок').inputValue();
  await page.getByLabel('Заголовок').fill(`${title} `);
  const after = await viewport.getAttribute('style');
  if (before !== after) throw new Error('Form edit reset canvas viewport');
  await page.getByLabel('Заголовок').fill(title);
  await page.getByRole('button', { name: 'Показать всё' }).click();
  await page.waitForTimeout(300);

  await page.goto(`${origin}/editor?scenario=${megaId}`);
  await page.locator('.ed-graph-node-scenario').first().waitFor();
  await page.locator('.ed-graph-node-scenario').first().click();
  await page.screenshot({ path: `${output}/live-mega-readable.png` });
  if (errors.length) throw new Error(`Browser errors: ${errors.join('; ')}`);
  process.stdout.write('Editor screenshots captured; form edit kept manual viewport.\n');
} finally {
  await context.close();
  await browser.close();
}
