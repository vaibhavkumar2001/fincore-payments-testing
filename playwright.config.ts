import { defineConfig } from '@playwright/test';
import dotenv from 'dotenv';

dotenv.config();

export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: [['html', { open: 'never' }], ['list']],
  use: {
    baseURL: process.env.API_BASE_URL || 'http://localhost:3000',
    extraHTTPHeaders: { Accept: 'application/json' },
  },
  // Starts the API for the tests. The database must already be running (npm run db:up)
  webServer: {
    command: 'npm run start',
    url: 'http://localhost:3000/health',
    reuseExistingServer: true,
    timeout: 30_000,
  },
});