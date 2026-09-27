import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import setup from '../tests/e2e/global-setup.ts';

// Use the same isolated PostgreSQL/API/web/worker fixture as portal E2E.
const screenshotDir = 'docs/implementation/screenshots/editor-round4';
mkdirSync(screenshotDir, { recursive: true });
const cleanup = await setup();
try {
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['apps/web/src/modules/editor/live-smoke.mjs'], {
      stdio: 'inherit',
      env: {
        ...process.env,
        EDITOR_ORIGIN: process.env.E2E_BASE_URL || 'http://127.0.0.1:5192',
        EDITOR_SCREENSHOTS: screenshotDir,
      },
    });
    child.on('error', reject);
    child.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error('Editor live suite failed: ' + code)),
    );
  });
} finally {
  await cleanup?.();
}
