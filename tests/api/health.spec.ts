import { test, expect } from '@playwright/test';

test('health endpoint reports the API and database as up @smoke', async ({ request }) => {
    const response = await request.get('/health');
    expect(response.status()).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok', db: 'up' });
});