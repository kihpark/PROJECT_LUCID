/**
 * feat/hearth-oracle-merge — /assistant is absorbed into HEARTH (the /home
 * sphere + search bar). This page now redirects to /home so any deep links
 * (bookmarks, old nav, third-party references) land on the new entry hub.
 *
 * The redirect is server-side (Next 15 `redirect()`), which fires before
 * client hydration. Authenticated check is no longer needed here — the
 * /home page handles its own auth via AppShell + the home redirect logic.
 */
import { redirect } from 'next/navigation';

export default function AssistantPage(): never {
  redirect('/home');
}
