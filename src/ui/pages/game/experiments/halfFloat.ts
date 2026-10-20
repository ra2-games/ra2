/** Input is RGB8 / 255; use a lookup table for correctly rounded half precision without per-frame float-bit conversions. */
const rgbHalf = Uint16Array.from({ length: 256 }, (_, value) => {
  if (!value) return 0;
  const f = value / 255,
    exponent = Math.floor(Math.log2(f));
  const significand = Math.round((f / 2 ** exponent - 1) * 1024);
  return ((exponent + 15) << 10) + significand;
});
export function halfRgbTensor(rgba: Uint8ClampedArray): Uint16Array {
  const count = rgba.length / 4,
    result = new Uint16Array(count * 3);
  for (let i = 0; i < count; i++) for (let c = 0; c < 3; c++) result[c * count + i] = rgbHalf[rgba[i * 4 + c]!]!;
  return result;
}
export function decodeHalf(data: Uint16Array): Float32Array {
  return Float32Array.from(data, (bits) => {
    const sign = bits & 0x8000 ? -1 : 1,
      exponent = (bits >>> 10) & 31,
      mantissa = bits & 1023;
    return (
      sign *
      (exponent === 31
        ? mantissa
          ? NaN
          : Infinity
        : exponent === 0
          ? mantissa * 2 ** -24
          : (1 + mantissa / 1024) * 2 ** (exponent - 15))
    );
  });
}
