import '@testing-library/jest-dom/vitest';
import { vi } from 'vitest';

// chrome.* API mocks. Tests override the stub methods as needed.
type AnyFn = (...args: unknown[]) => unknown;

interface FakeChrome {
  contextMenus: {
    create: AnyFn;
    removeAll: AnyFn;
    onClicked: { addListener: AnyFn; removeListener: AnyFn };
  };
  cookies: {
    get: AnyFn;
    set: AnyFn;
    onChanged: { addListener: AnyFn; removeListener: AnyFn };
  };
  storage: {
    local: { get: AnyFn; set: AnyFn; remove: AnyFn; clear: AnyFn };
    onChanged: { addListener: AnyFn };
  };
  runtime: {
    sendMessage: AnyFn;
    onMessage: { addListener: AnyFn; removeListener: AnyFn };
    onInstalled: { addListener: AnyFn };
    lastError: chrome.runtime.LastError | undefined;
  };
  tabs: {
    query: AnyFn;
    create: AnyFn;
    sendMessage: AnyFn;
  };
  scripting: {
    executeScript: AnyFn;
  };
}

const fakeChrome: FakeChrome = {
  contextMenus: {
    create: vi.fn(),
    removeAll: vi.fn((cb?: () => void) => cb && cb()),
    onClicked: { addListener: vi.fn(), removeListener: vi.fn() },
  },
  cookies: {
    get: vi.fn(),
    set: vi.fn(),
    onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
  },
  storage: {
    local: {
      get: vi.fn(),
      set: vi.fn(),
      remove: vi.fn(),
      clear: vi.fn(),
    },
    onChanged: { addListener: vi.fn() },
  },
  runtime: {
    sendMessage: vi.fn(),
    onMessage: { addListener: vi.fn(), removeListener: vi.fn() },
    onInstalled: { addListener: vi.fn() },
    lastError: undefined,
  },
  tabs: {
    query: vi.fn(),
    create: vi.fn(),
    sendMessage: vi.fn(),
  },
  scripting: {
    executeScript: vi.fn(),
  },
};

// Install onto globalThis BEFORE any module imports chrome.* references.
(globalThis as unknown as { chrome: FakeChrome }).chrome = fakeChrome;
