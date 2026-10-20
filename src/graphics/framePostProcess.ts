/** Run after the final color frame and before the independent cursor; never retain or modify guest-frame memory. */
export interface FramePostProcess {
  draw(width: number, height: number): void;
  destroy(): void;
}

export interface ColorPassOptions {
  vertex: string;
  fragment: string;
  colorSampler: string;
  linear?: boolean;
  /** Set effect parameters synchronously; reserve texture slot 0 for final color. The caller destroys its resources. */
  bind?: (gl: WebGL2RenderingContext, program: WebGLProgram) => void;
}

/**
 * Single-pass GLSL ES host. Copy final color on the GPU first, supporting existing AI output and cached redraws.
 * Adds one color copy per frame; this is an integration baseline without FBO fusion or performance optimization.
 */
export class ColorPostProcess implements FramePostProcess {
  private program: WebGLProgram | null = null;
  private texture: WebGLTexture | null = null;
  private vao: WebGLVertexArrayObject | null = null;
  private width = 0;
  private height = 0;
  private destroyed = false;

  constructor(
    private readonly gl: WebGL2RenderingContext,
    private readonly options: ColorPassOptions,
  ) {
    const shaders: WebGLShader[] = [];
    try {
      const program = gl.createProgram();
      if (!program) throw new Error('无法创建后处理程序');
      this.program = program;
      for (const [type, source] of [
        [gl.VERTEX_SHADER, options.vertex],
        [gl.FRAGMENT_SHADER, options.fragment],
      ] as const) {
        const shader = gl.createShader(type);
        if (!shader) throw new Error('无法创建后处理 shader');
        shaders.push(shader);
        gl.shaderSource(shader, source);
        gl.compileShader(shader);
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS))
          throw new Error(gl.getShaderInfoLog(shader) ?? '后处理编译失败');
        gl.attachShader(program, shader);
      }
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS))
        throw new Error(gl.getProgramInfoLog(program) ?? '后处理链接失败');
      this.texture = gl.createTexture();
      this.vao = gl.createVertexArray();
      if (!this.texture || !this.vao) throw new Error('无法创建后处理资源');
    } catch (error) {
      this.destroy();
      throw error;
    } finally {
      for (const shader of shaders) gl.deleteShader(shader);
    }
  }

  draw(width: number, height: number): void {
    if (this.destroyed) return;
    const { gl } = this;
    // Use a separate VAO for effects and restore shared bindings to avoid contaminating indexed/integer textures or the next frame.
    const previousVao = gl.getParameter(gl.VERTEX_ARRAY_BINDING) as WebGLVertexArrayObject | null;
    const previousActive = gl.getParameter(gl.ACTIVE_TEXTURE) as number;
    gl.activeTexture(gl.TEXTURE0);
    const previousTexture = gl.getParameter(gl.TEXTURE_BINDING_2D) as WebGLTexture | null;
    try {
      gl.bindTexture(gl.TEXTURE_2D, this.texture);
      if (width !== this.width || height !== this.height) {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB8, width, height, 0, gl.RGB, gl.UNSIGNED_BYTE, null);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, this.options.linear ? gl.LINEAR : gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, this.options.linear ? gl.LINEAR : gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        this.width = width;
        this.height = height;
      }
      gl.copyTexSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 0, 0, width, height);
      gl.bindVertexArray(this.vao);
      gl.useProgram(this.program);
      gl.uniform1i(gl.getUniformLocation(this.program!, this.options.colorSampler), 0);
      this.options.bind?.(gl, this.program!);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    } finally {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, previousTexture);
      gl.activeTexture(previousActive);
      gl.bindVertexArray(previousVao);
    }
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.gl.deleteProgram(this.program);
    this.gl.deleteTexture(this.texture);
    this.gl.deleteVertexArray(this.vao);
  }
}
