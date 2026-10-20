import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import ts from 'typescript';
import { expect, it } from 'vitest';

/** Use the AST to check static/dynamic imports, re-exports, and type references without mistaking comments or ordinary strings for dependencies. */
function imports(source: string): string[] {
  const file = ts.createSourceFile('module.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const result: string[] = [];
  function visit(node: ts.Node): void {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      result.push(node.moduleSpecifier.text);
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments[0] &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      result.push(node.arguments[0].text);
    } else if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteral(node.argument.literal)
    ) {
      result.push(node.argument.literal.text);
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  return result;
}
/** String literals in code. The AST excludes comments, so explanatory prose is not treated as hardcoding. */
function stringLiterals(source: string): string[] {
  const file = ts.createSourceFile('module.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const result: string[] = [];
  function visit(node: ts.Node): void {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) result.push(node.text);
    ts.forEachChild(node, visit);
  }
  visit(file);
  return result;
}
function walk(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? walk(resolve(directory, entry.name))
      : /\.(mts|ts|tsx)$/.test(entry.name)
        ? [resolve(directory, entry.name)]
        : [],
  );
}
function dependency(file: string, specifier: string): string {
  if (specifier.startsWith('/src/')) return specifier.slice(1).split('?')[0]!;
  return specifier.startsWith('.')
    ? relative(resolve('.'), resolve(dirname(file), specifier))
        .replaceAll('\\', '/')
        .split('?')[0]!
    : specifier;
}

it('扫描器覆盖类型与动态导入，不误识别注释', () => {
  expect(
    imports(`import type { A } from '../../architecture/a'; export { b } from '../../architecture/b';
    const c = import('../../architecture/c'); type D = import('../../architecture/d').D; // import('../../architecture/fake')
    const text = "from '../../architecture/fake'";`),
  ).toEqual(['../../architecture/a', '../../architecture/b', '../../architecture/c', '../../architecture/d']);
});

it('通用 VM 不反向依赖游戏、应用、浏览器实现或 UI', () => {
  for (const file of walk(resolve('src/vm86')))
    for (const specifier of imports(readFileSync(file, 'utf8'))) {
      const target = dependency(file, specifier);
      expect(target, `${relative('.', file)} → ${specifier}`).not.toMatch(
        /^(?:src\/(?:games|app|adapter|resources|platform|ui|server)\/|react(?:\/|$)|react-dom(?:\/|$)|relay-package(?:\/|$)|@ra2vm\/control(?:\/|$))/,
      );
    }
});

it('通用层不按游戏资源键或 EXE 名分支', () => {
  // The generic shim only consumes capabilities declared by gameProfile: page-title keys, EXE names, and dedicated DLL names
  // belong to individual game modules. Such literals in vm86 code indicate a layering bypass (comments are excluded).
  const forbidden = /^(?:campaignmenu|mainmenu|gui:[a-z]+|game\.exe|gamemd\.exe|ra2(?:md)?\.exe|xwis\.dll)$/i;
  for (const file of walk(resolve('src/vm86')))
    for (const literal of stringLiterals(readFileSync(file, 'utf8')))
      expect(literal, `${relative('.', file)} 出现游戏标识字面量`).not.toMatch(forbidden);
});

it('RA2 不引用 YR，YR 只按登记继承 RA2 的公共表', () => {
  // YR = RA2 + additions: spreading RA2's shared ABI and shim profile into YR is registered inheritance.
  // A reverse dependency would bring gamemd.exe-specific addresses into game.exe patches and direct-page startup paths.
  for (const file of walk(resolve('src/games/ra2')))
    for (const specifier of imports(readFileSync(file, 'utf8')))
      expect(dependency(file, specifier), `${relative('.', file)} → ${specifier}`).not.toMatch(/^src\/games\/yr\//);
  for (const file of walk(resolve('src/games/yr')))
    for (const specifier of imports(readFileSync(file, 'utf8'))) {
      const target = dependency(file, specifier);
      // YR may inherit only RA2's shared ABI and shim profile. Other RA2 paths (direct-page startup,
      // patches, and probes) implement game.exe behavior and cannot be reused directly by gamemd.exe.
      if (target === 'src/games/ra2' || target.startsWith('src/games/ra2/'))
        expect(['src/games/ra2/abi', 'src/games/ra2/profile'], `${relative('.', file)} → ${specifier}`).toContain(
          target,
        );
    }
});

it('纯文件 provider 不依赖游戏识别、浏览器存储、VM 实现或 React', () => {
  for (const file of walk(resolve('src/resources/providers')))
    for (const specifier of imports(readFileSync(file, 'utf8'))) {
      const target = dependency(file, specifier);
      // Guest path algorithms are pure functions; providers should not import the Win32 facade or shim state to use them.
      expect(target, `${relative('.', file)} → ${specifier}`).toMatch(
        /^src\/(?:resources\/(?:contracts$|providers\/)|vm86\/paths$)/,
      );
    }
  expect(imports(readFileSync('src/resources/contracts.ts', 'utf8'))).toEqual([]);
});

it('浏览器文件实现和游戏识别不回到 adapter 聚合层，也不依赖 UI', () => {
  for (const root of ['src/platform/browser/files', 'src/resources/discovery']) {
    for (const file of walk(resolve(root)))
      for (const specifier of imports(readFileSync(file, 'utf8'))) {
        const target = dependency(file, specifier);
        expect(target, `${relative('.', file)} → ${specifier}`).not.toMatch(
          /^(?:src\/(?:adapter|ui|server)\/|react(?:\/|$))/,
        );
        if (root.endsWith('discovery')) expect(target).not.toMatch(/^src\/platform\//);
      }
  }
});

it('已迁出的聚合入口和游戏 ABI 不在通用层重建', () => {
  expect(existsSync('src/adapter/files.ts')).toBe(false);
  expect(readFileSync('src/vm86/win32.ts', 'utf8')).not.toMatch(
    /\b(?:RA2_ABI|YR_ABI|ra2Win32ArgBytes|yrWin32ArgBytes)\b/,
  );
  for (const file of walk(resolve('src')))
    for (const specifier of imports(readFileSync(file, 'utf8'))) {
      expect(dependency(file, specifier), file).not.toBe('src/adapter/files');
    }
});

it('会话控制与画面呈现不反向依赖 UI、具体游戏或模型实验', () => {
  for (const root of ['src/app/session', 'src/graphics']) {
    for (const file of walk(resolve(root)))
      for (const specifier of imports(readFileSync(file, 'utf8'))) {
        const target = dependency(file, specifier);
        expect(target, `${relative('.', file)} → ${specifier}`).not.toMatch(
          /^(?:src\/(?:ui|games|server)\/|react(?:\/|$)|onnxruntime-web(?:\/|$))/,
        );
      }
  }
  for (const file of walk(resolve('src/app/session')))
    for (const specifier of imports(readFileSync(file, 'utf8')))
      expect(dependency(file, specifier), `${relative('.', file)} → ${specifier}`).not.toMatch(
        /^src\/(?:adapter|platform)\//,
      );
  expect(existsSync('src/ui/pages/game/vmPageController.ts')).toBe(false);
});

it('VM 驱动只引用游戏来源类型，具体资源规则和 shim 由游戏组装层提供', () => {
  const path = resolve('src/adapter/vmCore.ts');
  const source = readFileSync(path, 'utf8');
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
  for (const specifier of imports(source)) {
    if (dependency(path, specifier).startsWith('src/games/')) {
      expect(dependency(path, specifier)).toBe('src/games/source');
      expect(
        file.statements.some(
          (node) =>
            ts.isImportDeclaration(node) &&
            ts.isStringLiteral(node.moduleSpecifier) &&
            node.moduleSpecifier.text === specifier &&
            node.importClause?.isTypeOnly,
        ),
      ).toBe(true);
    }
  }
  expect(source).not.toMatch(/withGameSpeedDefault|ra2NetworkEnabled|ra2NetworkRoom|ra2ExeHash|\/game\/ra2\//);
  for (const path of [
    'src/games/vmConfiguration.ts',
    'src/games/shared/vmConfiguration.ts',
    'src/games/shared/resourcePolicy.ts',
    'src/games/archivePolicy.ts',
  ]) {
    for (const specifier of imports(readFileSync(path, 'utf8'))) {
      expect(dependency(resolve(path), specifier)).not.toMatch(/^src\/(?:adapter|app|ui|server)\//);
    }
  }
});

it('relay package 不依赖应用，浏览器入口不能加载 Node 服务端', () => {
  const root = resolve('packages/relay');
  for (const file of walk(resolve(root, 'src')))
    for (const specifier of imports(readFileSync(file, 'utf8'))) {
      const target = dependency(file, specifier);
      if (specifier.startsWith('.')) {
        expect(target, `${file} → ${specifier}`).toMatch(/^packages\/relay\/src\//);
        if (file.includes('/client/') || file.includes('/network/')) {
          expect(target, `${file} → ${specifier}`).toMatch(/^packages\/relay\/src\/(?:client|network)\//);
        }
      } else {
        expect(target).not.toMatch(/^(?:src\/|ra2-vm$|relay-package(?:\/|$))/);
        if (file.includes('/client/') || file.includes('/network/')) {
          throw new Error(`浏览器与协议模块不能加载服务端依赖：${file} → ${specifier}`);
        }
      }
    }
});

it('通用工具不反向依赖业务与平台模块', () => {
  for (const file of walk(resolve('src/utils')))
    for (const specifier of imports(readFileSync(file, 'utf8'))) {
      const target = dependency(file, specifier);
      if (target.startsWith('src/')) expect(target, `${relative('.', file)} → ${specifier}`).toMatch(/^src\/utils\//);
    }
});

it('control skill is self-contained and its browser protocol has no Node dependencies', () => {
  const root = resolve('.agents/skills/ra2-battle-control');
  const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
  for (const file of walk(resolve(root, 'scripts')))
    for (const specifier of imports(readFileSync(file, 'utf8'))) {
      if (specifier.startsWith('.')) {
        const target = relative(root, resolve(dirname(file), specifier));
        expect(target, `${file} → ${specifier}`).not.toMatch(/^\.\.(?:\/|$)/);
      } else if (!specifier.startsWith('node:')) {
        const packageName = specifier.startsWith('@')
          ? specifier.split('/').slice(0, 2).join('/')
          : specifier.split('/')[0];
        expect(Object.keys(manifest.dependencies), `${file} → ${specifier}`).toContain(packageName);
      }
    }
  for (const entry of ['protocol', 'contracts'])
    expect(imports(readFileSync(resolve(root, `scripts/${entry}.ts`), 'utf8'))).toEqual([]);
});
