import { expect, test } from '@playwright/test';

test('a visitor joins the audio room, gifts, and breaks the wallet with x20', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByText('Desk camera')).toBeVisible();
  await expect(page.getByText('Late radio')).toBeVisible();
  await expect(page.getByText('starts when you open it')).toBeVisible();
  const who = page.locator('.who').first();
  await expect(who).toHaveText(/^guest-\d{4} · 1,000 coins$/);

  await page.getByRole('link', { name: /Late radio/ }).click();

  await expect(page.getByText('1 watching')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText(/^audio · my LiveKit server/)).toBeVisible();
  await expect(who).toHaveText(/ 1,000 coins$/);

  await page.getByRole('button', { name: /^Tea/ }).click();
  await expect(who).toHaveText(/ 990 coins$/);
  await expect(page.getByText(/guest-\d{4} sent Tea · 10/)).toBeVisible();

  await page.getByRole('button', { name: /^Clap/ }).click();
  await expect(who).toHaveText(/ 890 coins$/);

  await page.getByRole('button', { name: 'Send x20' }).click();
  const result = page.locator('.result');
  await expect(result).toHaveText(/^20 sent · \d+ ok · \d+ refused/);

  const [, ok, refused, balance] = (await result.textContent())!.match(
    /20 sent · (\d+) ok · (\d+) refused.* · balance (\d+)$/,
  )!.map((v, i) => (i ? Number(v) : v)) as [string, number, number, number];
  expect(ok + refused).toBe(20);
  // 890 left, 100 a tap: the wallet stops at 8 and the rest are refused.
  expect(ok).toBe(8);
  expect(balance).toBe(890 - ok * 100);
  await expect(who).toHaveText(new RegExp(` ${balance} coins$`));
  await expect(result).toContainText('not enough coins');

  await expect(page.getByText(/^1\. guest-\d{4}/)).toBeVisible({ timeout: 5_000 });
});

test('a refused join leaves chat and gifts switched off', async ({ page }) => {
  await page.route('**/api/rooms/*/join', (route) =>
    route.fulfill({ status: 409, json: { error: 'room is full' } }),
  );
  await page.goto('/');
  await page.getByRole('link', { name: /Late radio/ }).click();

  await expect(page.getByText('room is full')).toBeVisible();
  await expect(page.getByPlaceholder('Say something')).toBeDisabled();
  await expect(page.getByRole('button', { name: /^Tea/ })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Send x20' })).toBeDisabled();
});
