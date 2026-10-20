import { vi } from 'vitest';

// Existing UI assertions explicitly exercise Chinese; locale selection and English have separate coverage.
const original = globalThis.navigator ?? ({} as Navigator);
vi.stubGlobal(
  'navigator',
  new Proxy(original, {
    get(target, key) {
      if (key === 'languages') return ['zh-CN'];
      if (key === 'language') return 'zh-CN';
      return Reflect.get(target, key, target);
    },
  }),
);
