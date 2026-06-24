/**
 * feat/capture-job-tracker — extension-icon badge driven by the
 * persistent job tracker.
 *
 * The existing `flashBadge` (in context-menu.ts) writes a transient
 * ✓ / ! glyph for ~6s on every capture. This module writes a
 * NUMERIC count of (inflight + ready) jobs and is recomputed every
 * time tracker state changes. The two co-exist: flashBadge's ✓
 * lands first (immediate feedback), then `updateBadge()` overwrites
 * it with the number. After flashBadge's clear timer fires the
 * number still stays — which is the desired behavior (persistent,
 * not transient).
 *
 * When the user has switched the tracker off via the popup toggle
 * the badge is cleared regardless of state — "꺼짐" means don't show
 * me anything, including a residual counter.
 */

import { getJobs, summarizeJobs, getSettings } from './job-tracker';

// Teal accent matching the popup palette (--accent-cool).
export const BADGE_COLOR_ACTIVE = '#3fe0c6';

export async function updateBadge(): Promise<void> {
  try {
    const settings = await getSettings();
    if (!settings.trackingEnabled) {
      safeSetBadgeText('');
      return;
    }
    const jobs = await getJobs();
    const counts = summarizeJobs(jobs);
    // Badge surfaces "things you still need to look at" — inflight
    // (still working) + ready (completed but not yet reviewed).
    // Failed jobs are deliberately excluded: they're noise unless
    // the user opens the popup to act on them, and a stuck "12"
    // because of three old failures would erode trust in the
    // number itself.
    const n = counts.inflight + counts.ready;
    if (n <= 0) {
      safeSetBadgeText('');
      return;
    }
    safeSetBadgeText(String(n));
    safeSetBadgeColor(BADGE_COLOR_ACTIVE);
  } catch (err) {
    console.info('[lucid] updateBadge failed', err);
  }
}

function safeSetBadgeText(text: string): void {
  try {
    const action = (chrome as { action?: unknown }).action;
    if (!action || typeof (action as { setBadgeText?: unknown }).setBadgeText !== 'function') {
      return;
    }
    (chrome.action.setBadgeText as (
      d: chrome.action.BadgeTextDetails,
      cb?: () => void,
    ) => void)({ text }, () => undefined);
  } catch (err) {
    console.info('[lucid] setBadgeText failed', err);
  }
}

function safeSetBadgeColor(color: string): void {
  try {
    const action = (chrome as { action?: unknown }).action;
    if (
      !action
      || typeof (action as { setBadgeBackgroundColor?: unknown }).setBadgeBackgroundColor
        !== 'function'
    ) {
      return;
    }
    (chrome.action.setBadgeBackgroundColor as (
      d: chrome.action.BadgeBackgroundColorDetails,
      cb?: () => void,
    ) => void)({ color }, () => undefined);
  } catch (err) {
    console.info('[lucid] setBadgeBackgroundColor failed', err);
  }
}
