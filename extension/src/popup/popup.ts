/**
 * Popup entry point. Decides between logged-in and logged-out states
 * based on the lucid_jwt cookie (read via @/lib/auth.getAuth).
 */

import { getAuth, openLogin, WEB_BASE } from '@/lib/auth';

interface CaptureResultMessage {
  ok: boolean;
  job_id?: string;
  error?: string;
}

function el<T extends HTMLElement = HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing #${id}`);
  return node as T;
}

function renderLoggedOut(body: HTMLElement) {
  body.innerHTML = '';
  const row = document.createElement('div');
  row.className = 'row';
  const blurb = document.createElement('p');
  blurb.className = 'muted';
  blurb.textContent = 'Sign in on the web to start saving.';
  const btn = document.createElement('button');
  btn.className = 'primary';
  btn.textContent = 'Open lucid.app to log in';
  btn.addEventListener('click', () => {
    openLogin();
    window.close();
  });
  row.append(blurb, btn);
  body.appendChild(row);
}

function renderLoggedIn(
  body: HTMLElement,
  spaceId: string,
) {
  body.innerHTML = '';
  const row = document.createElement('div');
  row.className = 'row';

  const save = document.createElement('button');
  save.id = 'save-btn';
  save.className = 'primary';
  save.textContent = 'Save current page';
  save.addEventListener('click', () => onSave(save, body, spaceId));

  const pending = document.createElement('button');
  pending.className = 'link';
  pending.textContent = 'Open Pending Queue →';
  pending.addEventListener('click', () => {
    chrome.tabs.create({ url: `${WEB_BASE}/pending` });
    window.close();
  });

  const settings = document.createElement('button');
  settings.className = 'link';
  settings.textContent = 'Settings';
  settings.addEventListener('click', () => {
    chrome.tabs.create({ url: `${WEB_BASE}/?settings=1` });
    window.close();
  });

  row.append(save, pending, settings);
  body.appendChild(row);

  const result = document.createElement('div');
  result.id = 'capture-result';
  result.hidden = true;
  body.appendChild(result);
}

async function onSave(btn: HTMLButtonElement, body: HTMLElement, _spaceId: string) {
  btn.disabled = true;
  btn.textContent = 'Saving...';

  let activeTab: chrome.tabs.Tab | undefined;
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    activeTab = tabs[0];
  } catch {
    activeTab = undefined;
  }

  if (!activeTab?.url) {
    surfaceResult(body, false, 'No active tab.');
    btn.disabled = false;
    btn.textContent = 'Save current page';
    return;
  }

  try {
    const resp = (await chrome.runtime.sendMessage({
      type: 'capture',
      source_url: activeTab.url,
      source_type: 'web_article',
    })) as CaptureResultMessage;

    if (resp?.ok) {
      surfaceResult(body, true, `Saved as ${resp.job_id}`);
    } else {
      surfaceResult(body, false, resp?.error || 'capture failed');
    }
  } catch (err) {
    surfaceResult(body, false, (err as Error).message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Save current page';
  }
}

function surfaceResult(body: HTMLElement, ok: boolean, message: string) {
  let res = body.querySelector<HTMLElement>('#capture-result');
  if (!res) {
    res = document.createElement('div');
    res.id = 'capture-result';
    body.appendChild(res);
  }
  res.hidden = false;
  res.className = ok ? 'muted' : 'error';
  res.textContent = message;
}

async function boot() {
  const root = el('root');
  const body = el('body');
  const spaceLabel = el('space-name');

  try {
    const auth = await getAuth();
    root.dataset.state = auth ? 'ready' : 'logged_out';
    if (auth) {
      spaceLabel.hidden = false;
      spaceLabel.textContent = auth.spaceId.slice(0, 8);
      renderLoggedIn(body, auth.spaceId);
    } else {
      renderLoggedOut(body);
    }
  } catch {
    renderLoggedOut(body);
  }
}

boot();
