import type { Page } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

const EVIDENCE_DIR = path.join(__dirname, '../../playwright-evidence');

export async function captureEvidence(
  page: Page,
  testName: string,
  label: string,
): Promise<string> {
  if (!fs.existsSync(EVIDENCE_DIR)) {
    fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  }
  const safeName = `${testName}__${label}`.replace(/[^a-z0-9_-]+/gi, '_');
  const filepath = path.join(EVIDENCE_DIR, `${safeName}.png`);
  await page.screenshot({ path: filepath, fullPage: true });
  console.log(`[evidence] ${filepath}`);
  return filepath;
}
