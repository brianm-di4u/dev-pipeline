import { defineConfig } from '@playwright/test';

const PORT = 4173;

export default defineConfig({
  testDir: './e2e',
  forbidOnly: Boolean(process.env.CI),
  reporter: [['list']],
  use: { baseURL: `http://127.0.0.1:${PORT}`, screenshot: 'on' },
  webServer: {
    command: 'node src/server.ts',
    url: `http://127.0.0.1:${PORT}/health`,
    env: { PORT: String(PORT) },
    reuseExistingServer: !process.env.CI,
  },
});
