import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import sharp from 'sharp';
import { apiContext, demoLogin, timedScenario } from './fixtures';

test.describe.configure({ mode: 'serial' });
const screenshots = resolve(process.cwd(), 'docs/implementation/screenshots/frontend/real');
mkdirSync(screenshots, { recursive: true });

async function stable(page: Page, name: string, size: string) {
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth - innerWidth))
    .toBe(0);
  await page.screenshot({ path: resolve(screenshots, `${name}-${size}.png`), fullPage: true });
}

for (const role of ['student', 'author', 'admin'] as const) {
  test(`демо-вход ${role} отправляет настоящий login`, async ({ page }) => {
    const posts: unknown[] = [];
    page.on('request', (req) => {
      if (req.url().endsWith('/api/auth/login')) posts.push(req.postDataJSON());
    });
    await demoLogin(page, role);
    expect(posts).toHaveLength(1);
    expect(Object.keys(posts[0] as Record<string, unknown>).sort()).toEqual(['email', 'password']);
    if (role === 'student') {
      await page.goto('/editor');
      await expect(page.getByRole('heading', { name: 'Нет доступа' })).toBeVisible();
      await page.goto('/admin');
      await expect(page.getByRole('heading', { name: 'Нет доступа' })).toBeVisible();
    } else if (role === 'author') {
      await page.goto('/editor');
      await expect(page.getByRole('heading', { name: 'Редактор сценариев' })).toBeVisible();
      await page.goto('/admin');
      await expect(page.getByRole('heading', { name: 'Нет доступа' })).toBeVisible();
    } else {
      await page.goto('/admin');
      await expect(page.getByRole('heading', { name: 'Управление' })).toBeVisible();
    }
  });
}

test('имя в кабинете сохраняется, выход завершает сессию', async ({ page }) => {
  await demoLogin(page, 'student');
  await page.goto('/account');
  await page.getByRole('button', { name: 'Изменить имя' }).click();
  await page.getByLabel('Имя', { exact: true }).fill('Тестовый');
  await page.getByLabel('Фамилия', { exact: true }).fill('Проводник');
  await page.getByRole('button', { name: 'Сохранить' }).click();
  await expect(page.getByRole('heading', { name: 'Тестовый Проводник' })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Тестовый Проводник' })).toBeVisible();
  await page.getByRole('button', { name: 'Изменить имя' }).click();
  await page.getByLabel('Имя', { exact: true }).fill('Мария');
  await page.getByLabel('Фамилия', { exact: true }).fill('Светлова');
  await page.getByRole('button', { name: 'Сохранить' }).click();
  await page.getByRole('button', { name: 'Выйти' }).click();
  await expect(page.getByRole('heading', { name: 'Войти в систему' })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Войти в систему' })).toBeVisible();
});

for (const [size, width, height] of [
  ['desktop', 1440, 1000],
  ['mobile', 390, 844],
] as const) {
  test(`студент проходит сценарий и открывает разделы: ${size}`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto('/login');
    await expect(page.getByRole('heading', { name: 'Войти в систему' })).toBeVisible();
    await expect(page.getByLabel('Электронная почта')).toBeVisible();
    await expect(page.getByLabel('Пароль')).toBeVisible();
    await page.keyboard.press('Tab');
    await expect(page.getByLabel('Электронная почта')).toBeFocused();
    expect(
      await page
        .getByLabel('Электронная почта')
        .evaluate((element) => getComputedStyle(element).outlineStyle),
    ).toBe('solid');
    await stable(page, 'login', size);
    await demoLogin(page, 'student');
    if (size === 'mobile') {
      await page.getByRole('button', { name: 'Открыть меню' }).click();
      await expect(page.getByRole('navigation', { name: 'Основная навигация' })).toBeVisible();
      await page
        .getByRole('navigation', { name: 'Основная навигация' })
        .getByRole('link', { name: 'Кабинет', exact: true })
        .click();
    } else await page.goto('/account');
    await expect(page.getByRole('heading', { name: 'Личный кабинет' })).toBeVisible();
    await stable(page, 'account', size);
    const oldResults = (await (await page.request.get('/api/results')).json()) as { id: string }[];
    expect(oldResults.length).toBeGreaterThan(0);
    await page.goto(`/results/${oldResults[0].id}`);
    await expect(page.locator('.result-summary strong').first()).not.toContainText(
      /^(resolved|partial|timeout)$/,
    );
    await page.goto('/scenarios');
    await expect(page.getByRole('heading', { name: 'Сценарии', exact: true })).toBeVisible();
    await page.getByRole('searchbox', { name: 'Поиск' }).fill('Шум');
    await expect(page.locator('article').filter({ hasText: 'Шум в вагоне' })).toBeVisible();
    await expect(page.locator('article').filter({ hasText: 'Место и билет' })).toHaveCount(0);
    await page.getByRole('searchbox', { name: 'Поиск' }).clear();
    await page
      .locator('article')
      .filter({ hasText: 'Шум в вагоне' })
      .getByRole('button', { name: /Начать/ })
      .click();
    await expect(page).toHaveURL(/\/play\//);
    await expect(page.locator('.answers button')).toHaveCount(2);
    await stable(page, 'play', size);
    await page.locator('.answers button').first().click();
    await expect(page.getByRole('heading', { name: 'Уточнение решения' })).toBeVisible();
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Уточнение решения' })).toBeVisible();
    await page.locator('.answers button').first().click();
    await expect(page.getByRole('heading', { name: 'Тренировка завершена' })).toBeVisible();
    await expect(page.locator('.completion .outcome')).toHaveText('Согласованное решение');
    await page.getByRole('link', { name: /Полный разбор/ }).click();
    await expect(page.getByRole('heading', { name: 'Решения по шагам' })).toBeVisible();
    await expect(page.locator('.result-summary strong').first()).toHaveText(
      'Согласованное решение',
    );
    await stable(page, 'result', size);
    await page.goto('/progress?recent=1');
    await expect(page.getByRole('heading', { name: 'Прогресс' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'История результатов' })).toBeVisible();
    await stable(page, 'progress', size);
    await page.goto('/notifications');
    await expect(page.getByRole('heading', { name: 'Уведомления', exact: true })).toBeVisible();
    await stable(page, 'notifications', size);
    await page.goto('/team');
    await expect(page.getByRole('heading', { name: 'Моя бригада' })).toBeVisible();
    await stable(page, 'team', size);
    expect(errors).toEqual([]);
    await page.keyboard.press('Tab');
    expect(await page.evaluate(() => document.activeElement !== document.body)).toBeTruthy();
  });
  test(`редактор и управление доступны своим ролям: ${size}`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await demoLogin(page, 'author');
    await page.goto('/editor');
    await expect(page.getByRole('heading', { name: 'Редактор сценариев' })).toBeVisible();
    const editorShell = page.locator('.main-content:has(.ed-root)');
    await expect(editorShell).toBeVisible();
    expect(await editorShell.evaluate((element) => getComputedStyle(element).paddingLeft)).toBe(
      size === 'mobile' ? '10px' : '14px',
    );
    await stable(page, 'editor', size);
    expect((await page.request.post('/api/auth/logout')).ok()).toBeTruthy();
    await page.reload();
    await demoLogin(page, 'admin');
    await page.goto('/admin');
    await expect(page.getByRole('heading', { name: 'Управление' })).toBeVisible();
    await stable(page, 'admin', size);
    expect(errors).toEqual([]);
  });
}

const round4Screenshots = resolve(process.cwd(), 'docs/implementation/screenshots/ui-round4');
const heicFixture = resolve(process.cwd(), '.runtime/heic-fixture/example.heic');
mkdirSync(round4Screenshots, { recursive: true });

for (const [size, width, height] of [
  ['desktop', 1440, 1000],
  ['mobile', 390, 844],
] as const) {
  test(`аватар сохраняется во всех местах и удаляется: ${size}`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    const errors: string[] = [];
    const uploadHashes: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('request', (request) => {
      if (request.method() === 'PUT' && request.url().endsWith('/api/account/avatar')) {
        const body = request.postDataJSON() as { imageBase64: string };
        uploadHashes.push(
          createHash('sha256').update(Buffer.from(body.imageBase64, 'base64')).digest('hex'),
        );
      }
    });
    await demoLogin(page, 'student');
    await page.goto('/account');
    const fileInput = page.locator('#profile-avatar');
    await expect(page.locator('.avatar-editor')).not.toContainText('512 КБ');
    await expect(page.locator('.avatar-editor')).not.toContainText('256 × 256');
    await fileInput.setInputFiles({
      name: 'too-large.jpg',
      mimeType: 'image/jpeg',
      buffer: Buffer.alloc(25 * 1024 * 1024 + 1),
    });
    await expect(page.getByRole('alert')).toContainText('Фото слишком большое');
    await expect(page.getByRole('button', { name: 'Сохранить фото' })).toHaveCount(0);
    expect(uploadHashes).toHaveLength(0);

    const original = await sharp(randomBytes(2400 * 1800 * 3), {
      raw: { width: 2400, height: 1800, channels: 3 },
    })
      .jpeg({ quality: 90 })
      .toBuffer();
    expect(original.length).toBeGreaterThan(512 * 1024);
    await fileInput.setInputFiles({
      name: 'phone-photo.jpg',
      mimeType: 'image/jpeg',
      buffer: original,
    });
    const preview = page.getByAltText('Предпросмотр нового фото профиля');
    await expect(preview).toBeVisible();
    await expect(preview).toHaveJSProperty('naturalWidth', 1024);
    await expect(preview).toHaveJSProperty('naturalHeight', 768);
    await expect(preview).toHaveAttribute('src', /^data:image\/webp;base64,/);
    await page.getByRole('button', { name: 'Сохранить фото' }).click();
    await expect(page.locator('.avatar-editor [role="status"]')).toContainText(
      'Фото профиля сохранено',
    );
    expect(uploadHashes).toEqual([createHash('sha256').update(original).digest('hex')]);
    const me = (await (await page.request.get('/api/me')).json()) as {
      user: { avatarUrl?: string | null };
    };
    expect(me.user.avatarUrl).toMatch(/^\/api\/users\/.+\/avatar\?v=/);
    const avatar = await page.request.get(me.user.avatarUrl!);
    expect(avatar.ok()).toBeTruthy();
    expect(avatar.headers()['content-type']).toContain('image/webp');
    const normalized = await sharp(await avatar.body()).metadata();
    expect([normalized.format, normalized.width, normalized.height]).toEqual(['webp', 256, 256]);
    await expect(page.locator('.sidebar nav .avatar img')).toHaveCount(1);
    await expect(page.locator('.profile-panel .avatar img')).toHaveCount(1);
    const header = size === 'desktop' ? '.topbar' : '.mobile-header';
    await expect(page.locator(`${header} .profile-control img`)).toBeVisible();
    await page.goto('/progress');
    await page.locator(`${header} .profile-control`).click();
    await expect(page).toHaveURL(/\/account$/);
    await expect(page.getByRole('heading', { name: 'Личный кабинет' })).toBeVisible();
    await expect(page.locator('.profile-panel .avatar img')).toBeVisible();

    await fileInput.setInputFiles({
      name: 'broken.jpg',
      mimeType: 'image/jpeg',
      buffer: Buffer.from('broken image'),
    });
    await expect(page.getByRole('button', { name: 'Сохранить фото' })).toBeDisabled();
    await expect(page.getByRole('alert')).toBeVisible();
    const afterInvalid = (await (await page.request.get('/api/me')).json()) as {
      user: { avatarUrl?: string | null };
    };
    expect(afterInvalid.user.avatarUrl).toBe(me.user.avatarUrl);
    await page.getByRole('button', { name: 'Отменить выбор' }).click();
    await expect(page.locator('.profile-panel .avatar img')).toBeVisible();

    const tiff = await sharp({
      create: { width: 64, height: 96, channels: 3, background: '#39a572' },
    })
      .tiff()
      .toBuffer();
    await fileInput.setInputFiles({ name: 'portrait.tiff', mimeType: 'image/tiff', buffer: tiff });
    await expect(page.getByAltText('Предпросмотр нового фото профиля')).toBeVisible();
    await page.getByRole('button', { name: 'Отменить выбор' }).click();
    await expect(page.getByRole('button', { name: 'Сохранить фото' })).toHaveCount(0);
    await fileInput.setInputFiles({ name: 'portrait.tiff', mimeType: 'image/tiff', buffer: tiff });
    await page.getByRole('button', { name: 'Сохранить фото' }).click();
    await expect(page.locator('.avatar-editor [role="status"]')).toContainText(
      'Фото профиля сохранено',
    );
    expect(uploadHashes.at(-1)).toBe(createHash('sha256').update(tiff).digest('hex'));
    const afterTiff = (await (await page.request.get('/api/me')).json()) as {
      user: { avatarUrl?: string | null };
    };
    expect(afterTiff.user.avatarUrl).not.toBe(me.user.avatarUrl);
    const tiffAvatar = await page.request.get(afterTiff.user.avatarUrl!);
    const tiffNormalized = await sharp(await tiffAvatar.body()).metadata();
    expect([tiffNormalized.format, tiffNormalized.width, tiffNormalized.height]).toEqual([
      'webp',
      256,
      256,
    ]);
    await page.screenshot({
      path: resolve(round4Screenshots, `avatar-${size}.png`),
      fullPage: true,
    });
    await page.getByRole('button', { name: 'Удалить фото' }).click();
    await expect(page.locator('.avatar-editor [role="status"]')).toContainText(
      'Фото профиля удалено',
    );
    await expect(page.locator(`${header} .profile-control img`)).toHaveCount(0);
    await expect(page.locator('.sidebar nav .avatar img')).toHaveCount(0);
    await page.reload();
    await expect(page.locator('.profile-panel .avatar img')).toHaveCount(0);
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth - innerWidth))
      .toBe(0);
    expect(errors).toEqual([]);
  });

  test(`направления рейтинга показывают обе оценки: ${size}`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await demoLogin(page, 'student');
    await page.goto('/leaderboard');
    const metrics = page.getByRole('group', { name: 'Направление рейтинга' });
    for (const [id, label] of [
      ['overall', 'Общий'],
      ['service', 'Сервис'],
      ['safety', 'Безопасность'],
    ] as const) {
      await metrics.getByRole('button', { name: label }).click();
      await expect(metrics.getByRole('button', { name: label })).toHaveAttribute(
        'aria-pressed',
        'true',
      );
      const response = await page.request.get(
        `/api/leaderboard?scope=company&metric=${id}&offset=0&limit=25`,
      );
      expect(response.ok()).toBeTruthy();
      const data = (await response.json()) as {
        metric: string;
        me: { rank: number | null; servicePoints: number; safetyPoints: number } | null;
      };
      expect(data.metric).toBe(id);
      await expect(page.locator('.leaderboard-personal')).toContainText(
        data.me?.rank ? `№ ${data.me.rank}` : 'Пока без места',
      );
      if (data.me) {
        await expect(page.locator('.leaderboard-personal')).toContainText(
          `Сервис: ${data.me.servicePoints}`,
        );
        await expect(page.locator('.leaderboard-personal')).toContainText(
          `Безопасность: ${data.me.safetyPoints}`,
        );
      }
    }
    await page
      .getByRole('group', { name: 'Масштаб рейтинга' })
      .getByRole('button', { name: 'Бригада' })
      .click();
    await expect(
      page
        .getByRole('group', { name: 'Масштаб рейтинга' })
        .getByRole('button', { name: 'Бригада' }),
    ).toHaveAttribute('aria-pressed', 'true');
    if (size === 'mobile') await expect(page.locator('.mobile-ranking-card').first()).toBeVisible();
    else await expect(page.locator('.ranking-table tbody tr').first()).toBeVisible();
    await page.screenshot({
      path: resolve(round4Screenshots, `leaderboard-${size}.png`),
      fullPage: true,
    });
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth - innerWidth))
      .toBe(0);
    expect(errors).toEqual([]);
  });
}

test('HEIC фото загружается через кабинет и становится WebP', async ({ page }) => {
  test.skip(!existsSync(heicFixture), 'local HEIC fixture unavailable');
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await demoLogin(page, 'student');
  await page.goto('/account');
  await page.locator('#profile-avatar').setInputFiles({
    name: 'phone-photo.heic',
    mimeType: 'image/heic',
    buffer: readFileSync(heicFixture),
  });
  await expect(page.getByRole('button', { name: 'Сохранить фото' })).toBeEnabled();
  await page.getByRole('button', { name: 'Сохранить фото' }).click();
  await expect(page.locator('.avatar-editor [role="status"]')).toContainText(
    'Фото профиля сохранено',
  );
  const me = (await (await page.request.get('/api/me')).json()) as {
    user: { avatarUrl?: string | null };
  };
  const avatar = await page.request.get(me.user.avatarUrl!);
  expect(avatar.ok()).toBeTruthy();
  const info = await sharp(await avatar.body()).metadata();
  expect([info.format, info.width, info.height]).toEqual(['webp', 256, 256]);
  await page.getByRole('button', { name: 'Удалить фото' }).click();
  await expect(page.locator('.avatar-editor [role="status"]')).toContainText(
    'Фото профиля удалено',
  );
  expect(errors).toEqual([]);
});

test('верхний колокольчик показывает точный счётчик и обновляется после чтения', async ({
  page,
}) => {
  await demoLogin(page, 'student');
  const initial = (await (await page.request.get('/api/notifications/status')).json()) as {
    unreadCount: number;
  };
  expect(initial.unreadCount).toBeGreaterThan(0);
  const bell = page.locator('.topbar .header-bell');
  await expect(bell).toHaveAttribute(
    'aria-label',
    `Уведомления, непрочитанных: ${initial.unreadCount}`,
  );
  await expect(bell.locator('.unread-dot')).toBeVisible();
  await bell.click();
  await expect(page).toHaveURL(/\/notifications$/);
  await page.getByRole('button', { name: 'Отметить прочитанным' }).first().click();
  await expect(bell).toHaveAttribute(
    'aria-label',
    `Уведомления, непрочитанных: ${initial.unreadCount - 1}`,
  );
  await page.getByRole('button', { name: 'Прочитать все' }).click();
  await expect(bell).toHaveAttribute('aria-label', 'Уведомления, непрочитанных нет');
  await expect(bell.locator('.unread-dot')).toHaveCount(0);
  await page.goto('/account');
  await expect(page.locator('.feature-panel').filter({ hasText: 'Уведомления' })).toContainText(
    /Непрочитанные\s*0/,
  );
});

test('push-настройка отражает конфигурацию и service worker регистрируется без запроса разрешения', async ({
  page,
}) => {
  await demoLogin(page, 'student');
  await page.goto('/notifications');
  const config = (await (await page.request.get('/api/notifications/push')).json()) as {
    configured: boolean;
  };
  await expect(page.getByRole('heading', { name: 'Уведомления устройства' })).toBeVisible();
  if (config.configured) {
    if ((await page.evaluate(() => Notification.permission)) === 'denied') {
      await expect(page.locator('.push-settings')).toContainText('Уведомления запрещены');
      await expect(page.getByRole('button', { name: 'Включить уведомления' })).toHaveCount(0);
    } else {
      await expect(page.getByRole('button', { name: 'Включить уведомления' })).toBeVisible();
      await page.getByRole('button', { name: 'Не сейчас' }).click();
      await expect(page.getByRole('button', { name: 'Настроить push-уведомления' })).toBeVisible();
    }
  } else {
    await expect(page.locator('.push-settings')).toContainText(
      'Отправка на устройство пока не настроена',
    );
    await expect(page.getByRole('button', { name: 'Включить уведомления' })).toHaveCount(0);
  }
  const registered = await page.evaluate(async () => {
    const before = Notification.permission;
    const registration = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
    return {
      script: registration.active?.scriptURL || registration.installing?.scriptURL,
      before,
      after: Notification.permission,
    };
  });
  expect(registered.script).toContain('/sw.js');
  expect(registered.after).toBe(registered.before);
  const manifest = await page.request.get('/manifest.webmanifest');
  expect(manifest.ok()).toBeTruthy();
  expect((await manifest.json()).display).toBe('standalone');
});

test('при отключённом кабинете аватар читается, а колокольчик не запрашивает выключенный модуль', async ({
  page,
}) => {
  await demoLogin(page, 'admin');
  await page.goto('/account');
  const png = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 32;
    canvas.getContext('2d')!.fillRect(0, 0, 32, 32);
    return canvas.toDataURL('image/png').split(',')[1];
  });
  await page.locator('#profile-avatar').setInputFiles({
    name: 'profile.png',
    mimeType: 'image/png',
    buffer: Buffer.from(png, 'base64'),
  });
  await page.getByRole('button', { name: 'Сохранить фото' }).click();
  await expect(page.locator('.topbar .profile-control img')).toBeVisible();
  const admin = await apiContext('admin');
  try {
    await page.goto('/admin');
    await page.getByRole('switch', { name: /^Личный кабинет:/ }).click();
    await page.getByRole('switch', { name: /^Уведомления:/ }).click();
    await expect(page.locator('.topbar .profile-control')).not.toHaveAttribute('href');
    await expect(page.locator('.topbar .profile-control img')).toBeVisible();
    await expect(page.locator('.header-bell')).toHaveCount(0);
    const me = (await (await page.request.get('/api/me')).json()) as {
      user: { avatarUrl: string };
    };
    expect((await page.request.get(me.user.avatarUrl)).ok()).toBeTruthy();
    await page.goto('/account');
    await expect(page.locator('.status h1')).toContainText('временно недоступен');
    let statusCalls = 0;
    page.on('request', (request) => {
      if (request.url().endsWith('/api/notifications/status')) statusCalls++;
    });
    await page.goto('/admin');
    await page.reload();
    expect(statusCalls).toBe(0);
  } finally {
    await admin.patch('/api/modules/account', { data: { enabled: true } });
    await admin.patch('/api/modules/notifications', { data: { enabled: true } });
    await admin.delete('/api/account/avatar');
    await admin.dispose();
  }
});

type PushStubOptions = {
  permission: 'granted' | 'denied';
  existing?: boolean;
  invalidFirst?: boolean;
};

async function installPushStub(page: Page, options: PushStubOptions) {
  const endpoint = `https://fcm.googleapis.com/fcm/send/e2e-${crypto.randomUUID()}`;
  const p256dh = Buffer.from([4, ...Array.from({ length: 64 }, (_, index) => index + 1)]).toString(
    'base64url',
  );
  const auth = Buffer.from(Array.from({ length: 16 }, (_, index) => index + 1)).toString(
    'base64url',
  );
  await page.addInitScript(
    ({ endpoint, p256dh, auth, options }) => {
      const browser = window as typeof window & {
        __pushTest?: {
          current: PushSubscription | null;
          subscribeCalls: number;
          unsubscribeCalls: number;
        };
      };
      const state = {
        current: null as PushSubscription | null,
        subscribeCalls: 0,
        unsubscribeCalls: 0,
      };
      browser.__pushTest = state;
      const makeSubscription = (key: ArrayBuffer, invalid: boolean) =>
        ({
          endpoint,
          options: { applicationServerKey: key },
          toJSON: () => ({
            endpoint,
            keys: invalid ? { p256dh: 'bad', auth: 'bad' } : { p256dh, auth },
          }),
          unsubscribe: async () => {
            state.unsubscribeCalls++;
            state.current = null;
            return true;
          },
        }) as PushSubscription;
      if (options.existing) state.current = makeSubscription(new Uint8Array(65).buffer, false);
      Object.defineProperty(window, 'Notification', {
        configurable: true,
        value: {
          permission: options.permission,
          requestPermission: async () => options.permission,
        },
      });
      Object.defineProperty(ServiceWorkerRegistration.prototype, 'pushManager', {
        configurable: true,
        get() {
          return {
            getSubscription: async () => state.current,
            subscribe: async ({ applicationServerKey }: { applicationServerKey: BufferSource }) => {
              state.subscribeCalls++;
              const bytes = new Uint8Array(applicationServerKey as ArrayBuffer);
              state.current = makeSubscription(
                bytes.slice().buffer,
                !!options.invalidFirst && state.subscribeCalls === 1,
              );
              return state.current;
            },
          };
        },
      });
    },
    { endpoint, p256dh, auth, options },
  );
  return { endpoint, keys: { p256dh, auth } };
}

test.describe('push UI с одноразовым VAPID и управляемым browser provider', () => {
  test.skip(
    process.env.E2E_PUSH_EXPECT_CONFIGURED !== '1',
    'Нужен одноразовый VAPID в isolated API',
  );

  test('старая подписка не включается сама; по нажатию обновляется ключ и серверная привязка', async ({
    page,
  }) => {
    const { endpoint } = await installPushStub(page, { permission: 'granted', existing: true });
    let postCalls = 0;
    page.on('request', (request) => {
      if (
        request.url().endsWith('/api/notifications/push/subscriptions') &&
        request.method() === 'POST'
      )
        postCalls++;
    });
    await demoLogin(page, 'student');
    await page.goto('/notifications');
    await expect(page.locator('.push-settings')).toContainText(
      'На этом аккаунте уведомления для устройства пока не включены',
    );
    expect(postCalls).toBe(0);
    const before = await page.request.post('/api/notifications/push/subscriptions/status', {
      data: { endpoint },
    });
    expect((await before.json()).subscribed).toBe(false);
    await page.getByRole('button', { name: 'Включить уведомления' }).click();
    await expect(page.getByRole('button', { name: 'Отключить уведомления' })).toBeVisible();
    const state = await page.evaluate(() => (window as any).__pushTest);
    expect(state.subscribeCalls).toBe(1);
    expect(state.unsubscribeCalls).toBe(1);
    expect(postCalls).toBe(1);
    const linked = await page.request.post('/api/notifications/push/subscriptions/status', {
      data: { endpoint },
    });
    expect((await linked.json()).subscribed).toBe(true);
    await page.getByRole('button', { name: 'Отключить уведомления' }).click();
    await expect(page.getByRole('button', { name: 'Включить уведомления' })).toBeVisible();
    const unlinked = await page.request.post('/api/notifications/push/subscriptions/status', {
      data: { endpoint },
    });
    expect((await unlinked.json()).subscribed).toBe(false);
  });

  test('при запрете браузера серверная подписка не показывается включённой', async ({ page }) => {
    const { endpoint, keys } = await installPushStub(page, {
      permission: 'denied',
      existing: true,
    });
    await demoLogin(page, 'student');
    const saved = await page.request.post('/api/notifications/push/subscriptions', {
      data: { endpoint, keys },
    });
    expect(saved.ok()).toBeTruthy();
    await page.goto('/notifications');
    await expect(page.locator('.push-settings')).toContainText('Уведомления запрещены');
    await expect(page.getByRole('button', { name: 'Отключить уведомления' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Отключить подписку' })).toBeVisible();
  });

  test('ошибка POST подписки видна, повтор по нажатию проходит через настоящий API', async ({
    page,
  }) => {
    await installPushStub(page, { permission: 'granted', invalidFirst: true });
    await demoLogin(page, 'student');
    await page.goto('/notifications');
    const firstResponse = page.waitForResponse(
      (response) =>
        response.url().endsWith('/api/notifications/push/subscriptions') &&
        response.request().method() === 'POST',
    );
    await page.getByRole('button', { name: 'Включить уведомления' }).click();
    expect((await firstResponse).status()).toBe(400);
    await expect(page.locator('.push-settings [role="alert"]')).toContainText('Некорректные ключи');
    await expect(page.getByRole('button', { name: 'Включить уведомления' })).toBeVisible();
    await page.getByRole('button', { name: 'Включить уведомления' }).click();
    await expect(page.getByRole('button', { name: 'Отключить уведомления' })).toBeVisible();
    const state = await page.evaluate(() => (window as any).__pushTest);
    expect(state.subscribeCalls).toBe(2);
    expect(state.unsubscribeCalls).toBe(1);
  });
});

test('таймер обрабатывает истечение на сервере', async ({ page }) => {
  const scenario = await timedScenario();
  const student = await apiContext('student');
  const started = await student.post('/api/sessions', {
    data: { scenarioId: scenario.id, requestId: crypto.randomUUID() },
  });
  expect(started.status()).toBe(201);
  const session = (await started.json()) as { id: string };
  await student.dispose();
  await demoLogin(page, 'student');
  await page.goto(`/play/${session.id}`);
  await expect(page.getByRole('heading', { name: 'Тренировка завершена' })).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByText('Время истекло').first()).toBeVisible();
});

test('потерянный ответ сверяется с сервером без второго решения', async ({ page }) => {
  await demoLogin(page, 'student');
  await page.goto('/scenarios');
  await page
    .locator('article')
    .filter({ hasText: 'Шум в вагоне' })
    .getByRole('button', { name: /Начать/ })
    .click();
  await expect(page.locator('.answers button')).toHaveCount(2);
  let answerCalls = 0;
  await page.route('**/api/sessions/*/answer', async (route) => {
    answerCalls++;
    if (answerCalls === 1) {
      const response = await route.fetch();
      expect(response.ok()).toBeTruthy();
      await route.abort('failed');
    } else await route.continue();
  });
  await page.locator('.answers button').first().click();
  await expect(page.getByRole('alert')).toContainText('Не удалось подтвердить решение');
  await expect(page.locator('.answers button').first()).toBeDisabled();
  await page.getByRole('button', { name: 'Повторить действие' }).click();
  await expect(page.getByRole('heading', { name: 'Уточнение решения' })).toBeVisible();
  expect(answerCalls).toBe(1);
  await page.locator('.answers button').first().click();
  await expect(page.getByRole('heading', { name: 'Тренировка завершена' })).toBeVisible();
  expect(answerCalls).toBe(2);
});

test('уведомления отмечаются прочитанными, бригада меняет масштаб', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await demoLogin(page, 'student');
  await page.goto('/notifications');
  await expect(page.getByRole('heading', { name: 'Уведомления', exact: true })).toBeVisible();
  const unread = page.getByRole('button', { name: 'Отметить прочитанным' });
  await expect(unread.first()).toBeVisible({ timeout: 15_000 });
  const before = await page.locator('.notification.unread').count();
  expect(before).toBeGreaterThan(1);
  await unread.first().click();
  await expect(page.locator('.notification.unread')).toHaveCount(before - 1);
  await page.getByRole('button', { name: 'Прочитать все' }).click();
  await page.reload();
  await expect(page.locator('.notification.unread')).toHaveCount(0);
  await page.goto('/team');
  for (const scope of ['Бригада', 'Депо', 'Компания']) {
    await page.getByRole('button', { name: scope, exact: true }).click();
    await expect(page.getByRole('button', { name: scope, exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(page.locator('.ranking-table tbody tr').first()).toBeVisible();
  }
  expect(errors).toEqual([]);
});

test('модули отключаются, ядро и сохранённые данные работают, затем флаги восстановлены', async ({
  page,
}) => {
  await timedScenario();
  await demoLogin(page, 'admin');
  await expect
    .poll(async () => {
      const items = (await (await page.request.get('/api/notifications')).json()) as {
        title: string;
      }[];
      return items.some((item) => item.title === 'Новый сценарий');
    })
    .toBe(true);
  await page.goto('/admin');
  const ids = [
    'play',
    'editor',
    'notifications',
    'progress',
    'team',
    'account',
    'leaderboard',
  ] as const;
  const labels: Record<(typeof ids)[number], string> = {
    play: 'Игра',
    editor: 'Редактор',
    notifications: 'Уведомления',
    progress: 'Прогресс',
    team: 'Бригада',
    leaderboard: 'Лидерборд',
    account: 'Личный кабинет',
  };
  try {
    await page.getByRole('switch', { name: /Игра:/ }).click();
    await page.goto('/progress');
    await expect(page.getByRole('heading', { name: 'Прогресс' })).toBeVisible();
    await page.goto('/team');
    await expect(page.getByRole('heading', { name: 'Моя бригада' })).toBeVisible();
    await page.goto('/notifications');
    await expect(page.getByRole('heading', { name: 'Уведомления', exact: true })).toBeVisible();
    const scenarioNotice = page
      .locator('.notification')
      .filter({ hasText: 'Новый сценарий' })
      .first();
    await expect(scenarioNotice).toBeVisible();
    await expect(scenarioNotice.getByRole('link', { name: 'Открыть' })).toHaveCount(0);
    await page.goto('/scenarios');
    await expect(
      page.getByRole('heading', { name: /Сценарии.*временно недоступен/ }),
    ).toBeVisible();
    await page.goto('/admin');
    for (const id of ids.slice(1))
      await page.getByRole('switch', { name: new RegExp(`^${labels[id]}:`) }).click();
    await page.goto('/available');
    await expect(page.getByRole('heading', { name: 'Рабочее пространство' })).toBeVisible();
    await page.goto('/');
    await expect(page).toHaveURL(/\/available$/);
    await page.goto('/admin');
    await expect(page.getByRole('heading', { name: 'Управление' })).toBeVisible();
    for (const path of [
      '/account',
      '/scenarios',
      '/play/example',
      '/progress',
      '/results/example',
      '/notifications',
      '/team',
      '/leaderboard',
      '/editor',
    ]) {
      await page.goto(path);
      await expect(page.locator('.status h1')).toContainText('временно недоступен');
    }
  } finally {
    const admin = await apiContext('admin');
    try {
      for (const id of ids) await admin.patch(`/api/modules/${id}`, { data: { enabled: true } });
    } finally {
      await admin.dispose();
    }
  }
});

test('запоздалый реальный ответ старой сессии не показывается в новой', async ({ page }) => {
  const student = await apiContext('student');
  const catalog = (await (await student.get('/api/scenarios')).json()) as {
    id: string;
    title: string;
  }[];
  const old = catalog.find((s) => s.title === 'Место и билет')!;
  const next = catalog.find((s) => s.title === 'Шум в вагоне')!;
  const start = async (id: string) =>
    (
      await (
        await student.post('/api/sessions', {
          data: { scenarioId: id, requestId: crypto.randomUUID() },
        })
      ).json()
    ).id as string;
  const oldId = await start(old.id),
    nextId = await start(next.id);
  await student.dispose();
  await demoLogin(page, 'student');
  await page.route(`**/api/sessions/${oldId}`, async (route) => {
    await new Promise((r) => setTimeout(r, 1200));
    await route.continue();
  });
  await page.goto('/scenarios');
  await page.locator('.resume-item').filter({ hasText: old.title }).click();
  await expect(page.getByText('Восстанавливаем тренировку…')).toBeVisible();
  await page.getByRole('link', { name: 'Сценарии', exact: true }).first().click();
  await page.locator('.resume-item').filter({ hasText: next.title }).click();
  await expect(page.locator('.play-page h1')).toHaveText(next.title);
  await page.waitForTimeout(1400);
  await expect(page.locator('.play-page h1')).toHaveText(next.title);
  await expect(page.locator('.recent-feedback')).toHaveCount(0);
});

test('запоздалый ответ старого масштаба рейтинга не заменяет новый', async ({ page }) => {
  await demoLogin(page, 'student');
  await page.goto('/team');
  await expect(page.locator('.ranking-table caption')).toHaveText('Рейтинг: бригада');
  await page.route('**/api/team?scope=depot', async (route) => {
    await new Promise((done) => setTimeout(done, 1200));
    await route.continue();
  });
  await page.route('**/api/team?scope=company', async (route) => {
    await new Promise((done) => setTimeout(done, 600));
    await route.continue();
  });
  await page.getByRole('button', { name: 'Депо', exact: true }).click();
  await page.getByRole('button', { name: 'Компания', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Загружаем рейтинг');
  await expect(page.locator('.ranking-table')).toHaveCount(0);
  await expect(page.locator('.ranking-table caption')).toHaveText('Рейтинг: компания');
  await page.waitForTimeout(1400);
  await expect(page.locator('.ranking-table caption')).toHaveText('Рейтинг: компания');
});

test('администратор сохраняет роли и не может снять последнего администратора', async ({
  page,
}) => {
  await demoLogin(page, 'admin');
  await page.goto('/admin');
  const colleague = page.locator('.user-row').filter({ hasText: 'Даниил Ветров' });
  await colleague.getByLabel('Роль').selectOption('author');
  await expect(colleague.getByLabel('Роль')).toHaveValue('author');
  await page.reload();
  await expect(
    page.locator('.user-row').filter({ hasText: 'Даниил Ветров' }).getByLabel('Роль'),
  ).toHaveValue('author');
  await page
    .locator('.user-row')
    .filter({ hasText: 'Даниил Ветров' })
    .getByLabel('Роль')
    .selectOption('student');
  const lastAdmin = page.locator('.user-row').filter({ hasText: 'Елена Мирова' });
  await lastAdmin.getByLabel('Роль').selectOption('student');
  await expect(page.getByRole('alert')).toContainText(
    'Нельзя снять роль у последнего администратора',
  );
  await expect(lastAdmin.getByLabel('Роль')).toHaveValue('admin');
});

test('all catalog cards are equal and the formerly untimed scenario counts down on every step', async ({
  page,
}) => {
  await demoLogin(page, 'student');
  await page.goto('/scenarios');
  await expect(page.locator('.scenario-row').first()).toBeVisible();
  await expect(page.locator('.scenario-feature')).toHaveCount(0);
  await page
    .locator('article')
    .filter({ has: page.getByRole('heading', { name: 'Забытая вещь', exact: true }) })
    .getByRole('button', { name: /Начать/ })
    .click();
  await expect(page.locator('.timer')).toContainText('Осталось');
  const sessionId = page.url().split('/').at(-1)!;
  const first = await (await page.request.get(`/api/sessions/${sessionId}`)).json();
  expect(first.deadlineAt).toBeTruthy();
  await page.reload();
  await expect(page.locator('.timer')).toContainText('Осталось');
  const restored = await (await page.request.get(`/api/sessions/${sessionId}`)).json();
  expect(restored.deadlineAt).toBe(first.deadlineAt);
  await page.locator('.answers button').first().click();
  await expect(page.getByRole('heading', { name: 'Уточнение решения' })).toBeVisible();
  await expect(page.locator('.timer')).toContainText('Осталось');
  const next = await (await page.request.get(`/api/sessions/${sessionId}`)).json();
  expect(next.currentSituation.id).not.toBe(first.currentSituation.id);
  expect(Date.parse(next.deadlineAt)).toBeGreaterThan(Date.parse(first.deadlineAt));
});

const registrationScreenshots = resolve(
  process.cwd(),
  'docs/implementation/screenshots/registration-leaderboard',
);
mkdirSync(registrationScreenshots, { recursive: true });

for (const [size, width, height] of [
  ['desktop', 1440, 1000],
  ['mobile', 390, 844],
] as const) {
  test(`новый проводник регистрируется и сохраняет лучший результат: ${size}`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const email = `browser-${crypto.randomUUID()}@example.test`;
    const password = 'BrowserTesting2026!';
    await page.goto('/login');
    await page.getByRole('link', { name: 'Зарегистрироваться' }).click();
    await expect(page.getByRole('heading', { name: 'Регистрация проводника' })).toBeVisible();
    await page.getByLabel('Имя', { exact: true }).fill('Лидия');
    await page.getByLabel('Фамилия').fill('Тестовая');
    await page.getByLabel('Электронная почта').fill(email);
    await page.getByLabel('Пароль').fill('short');
    await page.getByRole('button', { name: 'Зарегистрироваться' }).click();
    await expect(page).toHaveURL(/\/register$/);
    await page.getByLabel('Пароль').fill(password);
    await stable(page, 'registration', size);
    await page.screenshot({
      path: resolve(registrationScreenshots, `register-${size}.png`),
      fullPage: true,
    });
    await page.getByRole('button', { name: 'Зарегистрироваться' }).click();
    await expect(page.getByRole('heading', { name: 'Личный кабинет' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Лидия Тестовая' })).toBeVisible();
    const me = await (await page.request.get('/api/me')).json();
    expect(me.user.role).toBe('student');
    expect(me.user.isDemo).toBe(false);
    const initial = await (await page.request.get('/api/progress')).json();
    expect([initial.xp, initial.ratingPoints, initial.completedSessions]).toEqual([0, 0, 0]);
    expect(initial.recommendations[0]).toContain('После первой тренировки');
    await page.goto('/editor');
    await expect(page.getByRole('heading', { name: 'Нет доступа' })).toBeVisible();
    await page.goto('/admin');
    await expect(page.getByRole('heading', { name: 'Нет доступа' })).toBeVisible();
    await page.goto('/account');
    await page.screenshot({
      path: resolve(registrationScreenshots, `account-${size}.png`),
      fullPage: true,
    });

    async function finishScenario() {
      await page.goto('/scenarios');
      await page
        .locator('article')
        .filter({ hasText: 'Шум в вагоне' })
        .getByRole('button', { name: /Начать/ })
        .click();
      await expect(page.locator('.answers button')).toHaveCount(2);
      await page.locator('.answers button').first().click();
      await expect(page.getByRole('heading', { name: 'Уточнение решения' })).toBeVisible();
      await page.locator('.answers button').first().click();
      await expect(page.getByRole('heading', { name: 'Тренировка завершена' })).toBeVisible();
    }
    await finishScenario();
    const first = await (await page.request.get('/api/progress')).json();
    expect(first.ratingPoints).toBeGreaterThan(0);
    expect(first.recommendations).not.toEqual(initial.recommendations);
    await page.goto('/progress');
    await expect(page.locator('.recommendations')).toContainText(first.recommendations[0]);
    await finishScenario();
    const repeated = await (await page.request.get('/api/progress')).json();
    expect(repeated.ratingPoints).toBe(first.ratingPoints);
    await expect
      .poll(async () => (await (await page.request.get('/api/progress')).json()).completedSessions)
      .toBe(2);
    await page.goto('/leaderboard');
    await expect(page.getByRole('heading', { name: 'Лидерборд' })).toBeVisible();
    await expect(page.locator('.leaderboard-personal')).toContainText(String(first.ratingPoints));
    const board = await (await page.request.get('/api/leaderboard')).json();
    expect(board.me.ratingPoints).toBe(first.ratingPoints);
    expect(board.me.countedScenarios).toBe(1);
    expect(
      board.members.every((member: { userId: string }) => !member.userId.startsWith('33333333')),
    ).toBe(true);
    await stable(page, 'leaderboard', size);
    await page.screenshot({
      path: resolve(registrationScreenshots, `leaderboard-${size}.png`),
      fullPage: true,
    });

    if (size === 'mobile') await page.getByRole('button', { name: 'Открыть меню' }).click();
    await page.getByRole('button', { name: 'Выйти' }).click();
    await page.goto('/register');
    await page.getByLabel('Имя', { exact: true }).fill('Лидия');
    await page.getByLabel('Фамилия').fill('Тестовая');
    await page.getByLabel('Электронная почта').fill(email.toUpperCase());
    await page.getByLabel('Пароль').fill(password);
    await page.getByRole('button', { name: 'Зарегистрироваться' }).click();
    await expect(page.getByRole('alert')).toContainText('уже зарегистрирован');
    await page.goto('/login');
    await page.getByLabel('Электронная почта').fill(email);
    await page.getByLabel('Пароль').fill(password);
    await page.getByRole('button', { name: 'Войти' }).click();
    await expect(page.getByRole('heading', { name: 'Лидия Тестовая' })).toBeVisible();
    expect((await (await page.request.get('/api/progress')).json()).ratingPoints).toBe(
      first.ratingPoints,
    );
    expect(errors).toEqual([]);
  });
}

for (const width of [1440, 390]) {
  test(`область аватара: drag, масштаб, сброс и серверные пиксели ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    await demoLogin(page, 'student');
    await page.goto('/account');
    const source = await sharp({
      create: { width: 900, height: 300, channels: 3, background: '#ff0000' },
    })
      .composite([
        {
          input: await sharp({
            create: { width: 450, height: 300, channels: 3, background: '#0000ff' },
          })
            .png()
            .toBuffer(),
          left: 450,
          top: 0,
        },
      ])
      .png()
      .toBuffer();
    await page
      .locator('#profile-avatar')
      .setInputFiles({ name: 'regions.png', mimeType: 'image/png', buffer: source });
    const frame = page.getByRole('group', { name: 'Область аватара' });
    await expect(frame).toBeVisible();
    const zoom = page.getByRole('slider', { name: 'Масштаб фото' });
    await zoom.fill('2');
    await expect(zoom).toHaveValue('2');
    await page.getByRole('button', { name: 'По центру', exact: true }).click();
    await expect(zoom).toHaveValue('1');
    await frame.scrollIntoViewIfNeeded();
    const box = (await frame.boundingBox())!;
    const x = box.x + box.width * 0.9,
      y = box.y + box.height / 2;
    if (width === 390) {
      const cdp = await page.context().newCDPSession(page);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [{ x: box.x + box.width * 0.1, y }],
      });
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await cdp.detach();
    } else {
      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width * 0.1, y, { steps: 8 });
      await page.mouse.up();
    }
    await frame.focus();
    await page.keyboard.press('ArrowLeft');
    const cropImage = page.getByAltText('Предпросмотр нового фото профиля');
    await expect
      .poll(() => cropImage.evaluate((el) => parseFloat((el as HTMLElement).style.left)))
      .toBeLessThan(-160);
    const dir = resolve(process.cwd(), 'docs/implementation/screenshots/avatar-crop');
    mkdirSync(dir, { recursive: true });
    await page.screenshot({ path: resolve(dir, `crop-${width}.png`), fullPage: true });
    await page.getByRole('button', { name: 'Сохранить фото' }).click();
    await expect(page.locator('.avatar-editor [role=status]')).toContainText('сохранено');
    const user = (await (await page.request.get('/api/me')).json()).user;
    const bytes = await (await page.request.get(user.avatarUrl)).body();
    const stats = await sharp(bytes).stats();
    expect(stats.channels[2].mean).toBeGreaterThan(230);
    expect(stats.channels[0].mean).toBeLessThan(25);
    await page.reload();
    await expect(page.locator('.profile-panel .avatar img')).toBeVisible();
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth - innerWidth))
      .toBe(0);
    await page.getByRole('button', { name: 'Удалить фото' }).click();
  });
}

test('отмена подготовки фото не возвращает устаревшее превью', async ({ page }) => {
  await demoLogin(page, 'student');
  await page.goto('/account');
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/api/account/avatar/preview', async (route) => {
    const response = await route.fetch();
    await wait;
    await route.fulfill({ response });
  });
  const photo = await sharp({
    create: { width: 50, height: 50, channels: 3, background: '#39a572' },
  })
    .png()
    .toBuffer();
  await page
    .locator('#profile-avatar')
    .setInputFiles({ name: 'wait.png', mimeType: 'image/png', buffer: photo });
  await expect(page.getByText('Готовим предпросмотр…')).toBeVisible();
  await page.getByRole('button', { name: 'Отменить выбор' }).click();
  const response = page.waitForResponse('**/api/account/avatar/preview');
  release();
  await response;
  await expect(page.getByRole('group', { name: 'Область аватара' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Сохранить фото' })).toHaveCount(0);
});
