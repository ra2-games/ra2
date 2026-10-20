import { gameResourceExe } from '../helpers/gameDir';
import { existsSync, readFileSync } from 'node:fs';
import { describe } from 'vitest';
import { describeShortGameContract } from '../../helpers/shortGameContract';

const path = gameResourceExe('ra2');
// This instruction regression requires the original two-entry BaseUnit implementation; mismatched instructions fail the contract.
if (!existsSync(path)) throw new Error(`真实补丁验收缺少主程序 ${path}`);
const executable = readFileSync(path);
describe('RA2 原始指令与快速游戏补丁', () => {
  describeShortGameContract((address, size) => executable.subarray(address - 0x400000, address - 0x400000 + size));
});
