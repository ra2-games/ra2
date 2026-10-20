import { posix, win32 } from 'node:path';
import { expect, it } from 'vitest';
import { isArchiveTargetWithinRoot } from '../../scripts/resources/archivePath';

const cases = [
  {
    name: 'POSIX 路径',
    path: posix,
    root: '/tmp/game',
    target: '/tmp/game/data/rules.ini',
    expected: true,
  },
  {
    name: 'POSIX 根目录本身',
    path: posix,
    root: '/tmp/game',
    target: '/tmp/game',
    expected: false,
  },
  {
    name: 'POSIX 同名前缀目录',
    path: posix,
    root: '/tmp/game',
    target: '/tmp/games/data/rules.ini',
    expected: false,
  },
  {
    name: 'POSIX 父目录逃逸',
    path: posix,
    root: '/tmp/game',
    target: '/tmp/outside.ini',
    expected: false,
  },
  {
    name: 'Windows 合法子路径',
    path: win32,
    root: 'C:\\tmp\\game',
    target: 'C:\\tmp\\game\\data\\rules.ini',
    expected: true,
  },
  {
    name: 'Windows 根目录本身',
    path: win32,
    root: 'C:\\tmp\\game',
    target: 'C:\\tmp\\game',
    expected: false,
  },
  {
    name: 'Windows 同名前缀目录',
    path: win32,
    root: 'C:\\tmp\\game',
    target: 'C:\\tmp\\games\\data\\rules.ini',
    expected: false,
  },
  {
    name: 'Windows 父目录逃逸',
    path: win32,
    root: 'C:\\tmp\\game',
    target: 'C:\\tmp\\outside.ini',
    expected: false,
  },
  {
    name: 'Windows 跨盘符绝对路径',
    path: win32,
    root: 'C:\\tmp\\game',
    target: 'D:\\tmp\\outside.ini',
    expected: false,
  },
] as const;

it.each(cases)('归档目标边界：$name', ({ path, root, target, expected }) => {
  expect(isArchiveTargetWithinRoot(root, target, path)).toBe(expected);
});
