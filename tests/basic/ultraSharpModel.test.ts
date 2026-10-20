import '../helpers/chineseLocale';
import { expect, it } from 'vitest';
import {
  normalizeUltraSharpOutputShape,
  ultraSharpCompatibilityNodes,
} from '../../src/ui/pages/game/experiments/ultraSharpModel';

const encode = (text: string) => [...new TextEncoder().encode(text)];
const varint = (value: number): number[] =>
  value > 127 ? [(value & 127) | 128, ...varint(Math.floor(value / 128))] : [value];
const field = (number: number, bytes: number[]): number[] => [
  ...varint(number * 8 + 2),
  ...varint(bytes.length),
  ...bytes,
];
const valueInfo = (name: string, width: string, height: string) => [
  ...field(1, encode(name)),
  ...field(
    2,
    field(1, [
      8,
      1,
      ...field(2, [
        ...field(1, field(2, encode('batch_size'))),
        ...field(1, [8, 3]),
        ...field(1, field(2, encode(width))),
        ...field(1, field(2, encode(height))),
      ]),
    ]),
  ),
];
const model = (width = 'width', height = 'height') =>
  new Uint8Array(
    field(7, [
      ...field(5, encode('假权重，包含 width 和 height 也不得修改')),
      ...field(11, valueInfo('input', 'width', 'height')),
      ...field(12, valueInfo('output', width, height)),
    ]),
  );

it('只改输出的两个维度符号，输入、权重和原始缓冲不变', () => {
  const original = model();
  expect(normalizeUltraSharpOutputShape(original)).toEqual(model('out_w', 'out_ht'));
  expect(original).toEqual(model());
});
it('拒绝不同签名、重复修正、截断和越界 protobuf', () => {
  expect(() => normalizeUltraSharpOutputShape(model('other'))).toThrow('符号');
  expect(() => normalizeUltraSharpOutputShape(model('out_w', 'out_ht'))).toThrow('符号');
  expect(() => normalizeUltraSharpOutputShape(model().subarray(0, 25))).toThrow('越界');
  expect(() => normalizeUltraSharpOutputShape(new Uint8Array([58, 255]))).toThrow('越界');
});
it('APISR 单独校验输出名称及 H/W 顺序，不接受 UltraSharp 签名', () => {
  const apisr = (h: string, w: string) =>
    new Uint8Array(
      field(7, [
        ...field(11, valueInfo('pixel_values', 'height', 'width')),
        ...field(12, valueInfo('reconstruction', h, w)),
      ]),
    );
  const original = apisr('height', 'width');
  expect(normalizeUltraSharpOutputShape(original, 'apisr2x')).toEqual(apisr('out_ht', 'out_w'));
  expect(original).toEqual(apisr('height', 'width'));
  expect(() => normalizeUltraSharpOutputShape(model(), 'apisr2x')).toThrow('输出名');
});

it('Metal 兼容仅指定具名 DepthToSpace 节点，不把卷积交给 CPU', () => {
  const node = (name: string, op: string) => field(1, [...field(3, encode(name)), ...field(4, encode(op))]);
  const bytes = new Uint8Array(field(7, [...node('conv', 'Conv'), ...node('shuffle', 'DepthToSpace')]));
  expect(ultraSharpCompatibilityNodes(bytes)).toEqual(['shuffle']);
  expect(() => ultraSharpCompatibilityNodes(new Uint8Array(field(7, node('', 'DepthToSpace'))))).toThrow('名称');
  expect(() => ultraSharpCompatibilityNodes(new Uint8Array(field(7, node('conv', 'Conv'))))).toThrow('数量');
});
