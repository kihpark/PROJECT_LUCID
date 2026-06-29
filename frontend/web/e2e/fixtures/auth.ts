import { test as base } from '@playwright/test';
import jwt from 'jsonwebtoken';

const PO_USER_ID = 'cb27c5a5-c71a-426f-a412-d6f3c0d2cd93';
const PO_KS = '4a3a8bb7-5f3f-4a44-bc2d-f8e296966b5b';

export const test = base.extend<{ authenticatedPage: import('@playwright/test').Page }>({
  authenticatedPage: async ({ page, context }, use) => {
    const token = jwt.sign(
      { sub: PO_USER_ID, exp: Math.floor(Date.now() / 1000) + 3600 },
      process.env.JWT_SECRET || 'dev-secret-change-me'
    );
    await context.addCookies([{
      name: 'lucid_jwt',
      value: token,
      domain: 'localhost',
      path: '/',
    }]);
    await use(page);
  },
});

export { expect } from '@playwright/test';
export { PO_KS, PO_USER_ID };
