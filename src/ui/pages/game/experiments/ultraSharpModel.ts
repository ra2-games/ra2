import { t } from '../../../shared/i18n/translate';
interface Field {
  number: number;
  wire: number;
  start: number;
  end: number;
}

/**
 * The official DepthToSpace shader passes inconsistent indices types to perm on Metal.
 * Move only final pixel shuffling to the CPU while retaining WebGPU convolutions; node names come from the verified model, never guesses.
 */
export function ultraSharpCompatibilityNodes(bytes: Uint8Array): string[] {
  const graph = fields(bytes, 0, bytes.length).find((field) => field.number === 7 && field.wire === 2);
  if (!graph) throw new Error(t('UltraSharp ONNX 缺少计算图'));
  const decoder = new TextDecoder();
  const names: string[] = [];
  for (const node of fields(bytes, graph.start, graph.end).filter((field) => field.number === 1 && field.wire === 2)) {
    const parts = fields(bytes, node.start, node.end);
    const text = (number: number) => {
      const part = parts.find((field) => field.number === number && field.wire === 2);
      return part ? decoder.decode(bytes.subarray(part.start, part.end)) : '';
    };
    if (text(4) === 'DepthToSpace') {
      const name = text(3);
      if (!name) throw new Error(t('UltraSharp 像素重排节点缺少名称'));
      names.push(name);
    }
  }
  if (names.length !== 1) throw new Error(t('UltraSharp 像素重排节点数量不匹配'));
  return names;
}

/** Walk only protobuf field boundaries, skipping large weight blocks; do not deserialize/re-encode the whole ONNX file. */
function fields(bytes: Uint8Array, start: number, end: number): Field[] {
  const result: Field[] = [];
  let offset = start;
  const varint = () => {
    let value = 0,
      shift = 0;
    while (offset < end && shift <= 49) {
      const byte = bytes[offset++]!;
      value += (byte & 127) * 2 ** shift;
      if (!(byte & 128)) return value;
      shift += 7;
    }
    throw new Error(t('ONNX 元数据 varint 越界'));
  };
  while (offset < end) {
    const tag = varint(),
      number = Math.floor(tag / 8),
      wire = tag & 7;
    let payload = offset;
    if (wire === 2) {
      const length = varint();
      payload = offset;
      offset += length;
    } else if (wire === 0) varint();
    else if (wire === 1) offset += 8;
    else if (wire === 5) offset += 4;
    else throw new Error(t('ONNX 元数据 wire 类型不支持'));
    if (number === 0 || offset > end) throw new Error(t('ONNX 元数据字段越界'));
    result.push({ number, wire, start: payload, end: offset });
  }
  return result;
}

/**
 * Validate the graph structure and fix two incorrect output dimension symbols. Identical input/output width/height names make WebGPU NHWC memory planning treat 1x and 4x as the same shape. Rename with equal-length text without changing weights, operators, input shapes, or disk files. Reject if the expected structure is absent.
 */
export function normalizeUltraSharpOutputShape(
  original: Uint8Array,
  profile: 'ultra4x' | 'apisr2x' = 'ultra4x',
): Uint8Array {
  const bytes = original.slice();
  const child = (parent: Field, number: number) => {
    const found = fields(bytes, parent.start, parent.end).filter(
      (field) => field.number === number && field.wire === 2,
    );
    if (found.length !== 1) throw new Error(t('UltraSharp ONNX 元数据结构不匹配'));
    return found[0]!;
  };
  const graph = child({ start: 0, end: bytes.length, number: 0, wire: 2 }, 7);
  const output = child(graph, 12);
  const decoder = new TextDecoder();
  const name = child(output, 1);
  if (decoder.decode(bytes.subarray(name.start, name.end)) !== (profile === 'ultra4x' ? 'output' : 'reconstruction'))
    throw new Error(t('超分 ONNX 输出名不匹配'));
  const shape = child(child(child(output, 2), 1), 2);
  const dims = fields(bytes, shape.start, shape.end).filter((field) => field.number === 1 && field.wire === 2);
  if (dims.length !== 4) throw new Error(t('UltraSharp ONNX 输出维数不匹配'));
  // APISR exports also reuse input dimension symbols, but H/W order differs from UltraSharp.
  const symbols =
    profile === 'ultra4x'
      ? ([
          [2, 'width', 'out_w'],
          [3, 'height', 'out_ht'],
        ] as const)
      : ([
          [2, 'height', 'out_ht'],
          [3, 'width', 'out_w'],
        ] as const);
  for (const [index, oldName, newName] of symbols) {
    const symbol = child(dims[index]!, 2);
    if (decoder.decode(bytes.subarray(symbol.start, symbol.end)) !== oldName)
      throw new Error(t('UltraSharp ONNX 输出尺寸符号不匹配'));
    bytes.set(new TextEncoder().encode(newName), symbol.start);
  }
  return bytes;
}
