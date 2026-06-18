import { defineManifest } from '@crxjs/vite-plugin';

// Sprint 2A PR-2A-1 — Lucid Chrome Extension Manifest V3.
//
// `host_permissions` includes the local web app (localhost:3000) so the
// service worker can read the `lucid_jwt` cookie via chrome.cookies API
// (DR-068). Production builds will add `https://*.lucid.app/*` here.
export default defineManifest({
  manifest_version: 3,
  name: 'Lucid',
  description: 'Own what you know.',
  version: '0.1.0',
  action: {
    default_popup: 'src/popup/popup.html',
    default_icon: {
      '16': 'public/icons/icon-16.png',
      '48': 'public/icons/icon-48.png',
      '128': 'public/icons/icon-128.png',
    },
  },
  background: {
    service_worker: 'src/background/service-worker.ts',
    type: 'module',
  },
  permissions: [
    'storage', 'cookies', 'contextMenus', 'activeTab', 'tabs', 'scripting',
    // B-45-fix2: when the in-page toast can't be delivered (content
    // script absent / CSP-blocked / inert tab), fall back to a system
    // notification + extension-icon badge so the user always knows
    // whether the capture succeeded.
    'notifications',
  ],
  host_permissions: ['http://localhost:3000/*', 'http://localhost:8000/*'],
  content_scripts: [
    {
      matches: ['<all_urls>'],
      js: ['src/content/toast.ts'],
      // CSS is injected by toast.ts via an inline <style> tag because
      // @crxjs/vite-plugin v2 beta leaves the source-tree path in the
      // emitted manifest (`src/content/toast.css`), which Chrome can't
      // resolve in dist/. Inline injection also eliminates the
      // unstyled-flash race at document_end.
      run_at: 'document_end',
    },
  ],
  icons: {
    '16': 'public/icons/icon-16.png',
    '48': 'public/icons/icon-48.png',
    '128': 'public/icons/icon-128.png',
  },
});
