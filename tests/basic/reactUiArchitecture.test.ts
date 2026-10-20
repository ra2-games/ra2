import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { expect, it } from 'vitest';

/** Prevent future features from reverting to multiple roots and manually constructed UI bridges. */
it('只有入口创建 React 根，普通 UI 与服务不拼 DOM', () => {
  const walk = (directory: string): string[] =>
    readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory()
        ? walk(resolve(directory, entry.name))
        : /\.tsx?$/.test(entry.name)
          ? [resolve(directory, entry.name)]
          : [],
    );
  const ui = walk(resolve('src/ui'));
  for (const file of ui) {
    const source = readFileSync(file, 'utf8');
    expect(source, file).not.toMatch(/\b(?:createRoot|flushSync|renderUi|clearUi)\s*\(/);
    if (/[/\\]components[/\\]/.test(file) || /(?:gameSourcePicker|runtimeToolbar)\.ts$/.test(file)) {
      expect(source, file).not.toMatch(
        /\b(?:getElementById|querySelector|querySelectorAll|createElement|replaceChildren|appendChild)\s*\(/,
      );
      expect(source, file).not.toMatch(/\.(?:innerHTML|textContent|hidden)\s*=/);
    }
  }
  expect(readFileSync('src/main.ts', 'utf8').match(/\bcreateRoot\s*\(/g)).toHaveLength(1);
});

it('按页面归属组织，shared 不反向依赖页面', () => {
  const root = resolve('src/ui');
  const walk = (directory: string): string[] =>
    readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory()
        ? walk(resolve(directory, entry.name))
        : /\.tsx?$/.test(entry.name)
          ? [resolve(directory, entry.name)]
          : [],
    );
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.isDirectory()) expect(['pages', 'shared'], entry.name).toContain(entry.name);
    else expect(entry.name).toBe('README.md');
  }
  for (const file of walk(resolve(root, 'shared'))) {
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(/['"]((?:\.{1,2}\/|\/src\/)[^'"\n]+)['"]/g)) {
      const dependency = match[1].startsWith('/src/') ? resolve(match[1].slice(1)) : resolve(dirname(file), match[1]);
      expect(dependency, `${file} → ${match[1]}`).not.toContain(`${sep}ui${sep}pages${sep}`);
    }
  }
});
