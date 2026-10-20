import { expect, it } from 'vitest';
import { selectImportPaths } from '../../src/utils/archive/selectImportPaths';

const key = (path: string) => path.split('/').at(-1)!;
it('keeps the shallowest file authoritative in either order, including empty content', () => {
  const root = { path: 'Package/module.bin', bytes: new Uint8Array() };
  const editor = { path: 'Package/Editor/module.bin', bytes: Uint8Array.of(7) };
  for (const entries of [
    [root, editor],
    [editor, root],
    [editor, { ...editor, path: 'Package/Client/module.bin' }, root],
  ])
    expect(selectImportPaths(entries, (entry) => entry.path, key).get('module.bin')).toBe(root);
});
it('rejects equally scoped alternatives and retains strict duplicate rejection for flat add-ons', () => {
  expect(() => selectImportPaths(['A/module.bin', 'B/module.bin'], (path) => path, key)).toThrow('Ambiguous');
  expect(() => selectImportPaths(['module.bin', 'Editor/module.bin'], (path) => path, key, true)).toThrow(
    '压缩包存在同名文件：module.bin',
  );
});
