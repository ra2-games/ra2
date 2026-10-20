import { ColorPostProcess, type FramePostProcess } from '../framePostProcess';

export interface LaserInputs {
  /** The caller must supply this explicitly; without game data, only pass colors through. */
  inGame: boolean;
  topMask: { width: number; height: number; rgba: Float32Array };
  distortion: { width: number; height: number; rgba: Float32Array };
}

/**
 * Accept output from an independent external FX compiler; do not bundle/distribute third-party effect sources.
 * Support only the research baseline LaserBlit entry/layout, not a general ReShade compiler.
 */
export function createReshadeLaser(
  gl: WebGL2RenderingContext,
  source: string,
  inputs: () => LaserInputs | null,
): FramePostProcess {
  for (const marker of [
    'ENTRY_POINT_F_PostProcessVS',
    'ENTRY_POINT_F_pmain',
    'V_ReShade_BackBuffer',
    'V_ReShade_TopMask',
    'V_Distort',
  ]) {
    if (!source.includes(marker)) throw new Error(`不支持的 LaserBlit 编译输出：缺少 ${marker}`);
  }
  let adapted = source
    .replace(/layout\(std140, column_major, binding = 0\)/g, 'layout(std140)')
    .replace(/layout\(binding = \d+\) /g, '')
    .replace(/layout\(location = 0\) (out vec2|in vec2)/g, '$1')
    .replace(/_out_param2|_in_param0/g, 'v_texcoord')
    .replace('uint _param0 = gl_VertexID;', 'uint _param0 = uint(gl_VertexID);');
  // FX color coordinates start at the top; textures copied from the default framebuffer start at the bottom.
  adapted = adapted
    .replace(/texture\(V_ReShade_BackBuffer, /g, 'readFrameColor(')
    .replace(
      'uniform sampler2D V_ReShade_BackBuffer;',
      'uniform sampler2D V_ReShade_BackBuffer;\nvec4 readFrameColor(vec2 p) { return texture(V_ReShade_BackBuffer, vec2(p.x, 1.0-p.y)); }',
    );
  const shader = (entry: string) =>
    `#version 300 es\nprecision highp float;\nprecision highp int;\n#define ENTRY_POINT_${entry}\n${adapted}`;
  const textures: WebGLTexture[] = [];
  const uniform = gl.createBuffer();
  let pass: ColorPostProcess | undefined;
  let destroyed = false;
  const cleanup = () => {
    if (destroyed) return;
    destroyed = true;
    pass?.destroy();
    gl.deleteBuffer(uniform);
    textures.forEach((t) => gl.deleteTexture(t));
  };
  try {
    if (!uniform) throw new Error('无法创建 LaserBlit 参数缓冲');
    for (let i = 0; i < 2; i++) {
      const texture = gl.createTexture();
      if (!texture) throw new Error('无法创建 LaserBlit 输入纹理');
      textures.push(texture);
    }
    const neutral = { width: 1, height: 1, rgba: new Float32Array([0.5, 0.5, 0, 1]) };
    const mask = { width: 1, height: 1, rgba: new Float32Array([1, 0, 0, 1]) };
    pass = new ColorPostProcess(gl, {
      vertex: shader('F_PostProcessVS'),
      fragment: shader('F_pmain'),
      colorSampler: 'V_ReShade_BackBuffer',
      bind(gl, program) {
        const data = inputs();
        gl.bindBuffer(gl.UNIFORM_BUFFER, uniform);
        gl.bufferData(gl.UNIFORM_BUFFER, new Int32Array([data?.inGame ? 1 : 0, 0, 0, 0]), gl.DYNAMIC_DRAW);
        gl.uniformBlockBinding(program, gl.getUniformBlockIndex(program, '_Globals'), 0);
        gl.bindBufferBase(gl.UNIFORM_BUFFER, 0, uniform);
        const entries = [data?.topMask ?? mask, data?.distortion ?? neutral];
        entries.forEach((entry, i) => {
          if (entry.rgba.length !== entry.width * entry.height * 4) throw new Error('LaserBlit 纹理尺寸不匹配');
          gl.activeTexture(gl.TEXTURE4 + i);
          gl.bindTexture(gl.TEXTURE_2D, textures[i]);
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, entry.width, entry.height, 0, gl.RGBA, gl.FLOAT, entry.rgba);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        });
        gl.uniform1i(gl.getUniformLocation(program, 'V_ReShade_TopMask'), 4);
        gl.uniform1i(gl.getUniformLocation(program, 'V_Distort'), 5);
      },
    });
    return { draw: (w, h) => pass!.draw(w, h), destroy: cleanup };
  } catch (error) {
    cleanup();
    throw error;
  }
}
