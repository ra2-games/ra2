import { readdirSync, readFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ts from 'typescript';
import { requireGameResources } from '../real-game/helpers/gameDir';

afterEach(() => vi.unstubAllEnvs());

/** Inspect syntax rather than comments/strings; bracket notation and chained modifiers count too. */
function disabledRegistrations(path: string, text: string): string[] {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  const offenders: string[] = [];
  const visit = (node: ts.Node): void => {
    const name = ts.isPropertyAccessExpression(node)
      ? node.name.text
      : ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression)
        ? node.argumentExpression.text
        : undefined;
    if (name && ['skip', 'skipIf', 'runIf', 'todo'].includes(name)) {
      // Preserve only the existing opt-in MOD suite, not arbitrary skips elsewhere in its file.
      const optionalMod =
        path === 'ra2/gonghui.test.ts' &&
        node.getText(source) === 'describe.runIf' &&
        ts.isCallExpression(node.parent) &&
        node.parent.arguments.length === 1 &&
        node.parent.arguments[0]!.getText(source) === 'requested';
      if (!optionalMod) {
        const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
        offenders.push(`${path}:${line}: ${name}`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return offenders;
}

describe('真实游戏资源准入', () => {
  // Use a file path as the directory to avoid accidentally matching a game installed on the development machine.
  const missingDirectory = fileURLToPath(new URL('./gameResourceGate.test.ts', import.meta.url));

  it.each(['ra2', 'yr'] as const)('%s 缺资源必须失败', (gameId) => {
    vi.stubEnv('VM_GAME_DIR', missingDirectory);
    expect(() => requireGameResources(gameId)).toThrow('真实游戏验收缺少');
  });

  it('没有任何开关能把缺资源降级为跳过', () => {
    vi.stubEnv('VM_GAME_DIR', missingDirectory);
    vi.stubEnv('VM_REQUIRE_GAME_RESOURCES', '');
    expect(() => requireGameResources('ra2')).toThrow('真实游戏验收缺少');
  });

  it.each([
    'describe.skipIf(missing)("game", () => {});',
    'describe.runIf(available)("game", () => {});',
    'it.skip("game", () => {});',
    'test["skip"]("game", () => {});',
    'it.skip.each([1])("game", () => {});',
    'test.todo("game");',
  ])('检测跳过方式：%s', (text) => {
    expect(disabledRegistrations('ra2/example.test.ts', text)).toHaveLength(1);
  });

  it('忽略注释和字符串，且共辉豁免仅限现有可选入口', () => {
    expect(disabledRegistrations('ra2/example.test.ts', '// it.skip()\nconst note = "runIf skipIf";')).toEqual([]);
    const optional = 'describe.runIf(requested)("mod", () => {});';
    expect(disabledRegistrations('ra2/gonghui.test.ts', optional)).toEqual([]);
    expect(disabledRegistrations('ra2/example.test.ts', optional)).toHaveLength(1);
    expect(disabledRegistrations('ra2/gonghui.test.ts', `${optional}\nit.skip("case");`)).toHaveLength(1);
  });

  it('真实游戏用例不得用条件跳过或待办隐藏失败，共辉可选入口除外', () => {
    const offenders = readdirSync('tests/real-game', { recursive: true, encoding: 'utf8' })
      .filter((entry) => ['.ts', '.tsx', '.mts', '.cts'].includes(extname(entry)))
      .flatMap((entry) =>
        disabledRegistrations(entry.replaceAll('\\', '/'), readFileSync(join('tests/real-game', entry), 'utf8')),
      );
    expect(offenders).toEqual([]);
  });
});
