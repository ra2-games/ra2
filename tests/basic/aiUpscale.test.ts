import '../helpers/chineseLocale';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { AiUpscale, anime4kConvolutionShaders } from '../../src/ui/pages/game/aiUpscale';
import { aiUpscaleEnabled, spatialUpscaleEnabled } from '../../src/ui/pages/game/spatialUpscale';
import { anime4kGanPasses, planAiSurfaces } from '../../src/ui/pages/game/aiModelGraph';

describe('AI 超分开关与模型', () => {
  it('GAN-M 使用 23 层完整分支网络，最后一层直接重建 RGB', () => {
    const passes = anime4kGanPasses();
    expect(passes).toHaveLength(23);
    expect(passes.at(-1)?.scale).toBe(2);
    expect(passes.at(-1)?.shader).toContain('return result + MAIN_tex(MAIN_pos)');
    expect(Math.max(...passes.map((p) => p.inputs.length))).toBe(8);
    expect(passes[0]!.shader).toContain('texelFetch');
    expect(passes.at(-1)!.shader).toContain('texture(tex_conv0ups');
    const bytes = readFileSync(
      new URL('../../src/ui/pages/game/vendor/Anime4K_Upscale_GAN_x2_M.glsl', import.meta.url),
    );
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(
      '8a1d33fddc8939c1e0eb4d6ad6a7baf653dd420d6b713e385b7c73be90d9affe',
    );
  });

  it('纹理复用不会覆盖任何残差分支，也不让 pass 读写同一附件', () => {
    const passes = anime4kGanPasses(),
      plan = planAiSurfaces(passes);
    const contents = new Map([[0, 'MAIN']]);
    passes.forEach((pass, i) => {
      expect(plan.inputs[i]!.map((slot) => contents.get(slot))).toEqual(pass.inputs);
      expect(plan.inputs[i]).not.toContain(plan.outputs[i]);
      contents.set(plan.outputs[i]!, pass.name);
    });
    expect(plan.featureCount).toBeLessThan(22);
    expect(plan.outputs.at(-1)).toBe(plan.output);
    expect(() => planAiSurfaces([{ ...passes[0]!, inputs: ['missing'] }])).toThrow('依赖尚未产生');
  });
  it('AI 和 bicubic 开关相互独立，默认都关闭', () => {
    expect(aiUpscaleEnabled('?sr=ai')).toBe(true);
    expect(spatialUpscaleEnabled('?sr=ai')).toBe(false);
    expect(aiUpscaleEnabled('?sr=1')).toBe(false);
    for (const search of ['', '?sr=0', '?sr=true']) expect(aiUpscaleEnabled(search)).toBe(false);
  });

  it('四层完整卷积都有入口，适配器不遗留 mpv 采样符号', () => {
    const shaders = anime4kConvolutionShaders();
    expect(shaders).toHaveLength(4);
    for (const shader of shaders) {
      expect(shader).toContain('vec4 hook()');
      expect(shader).toContain('void main()');
      expect(shader).not.toMatch(/\w+_texOff/);
    }
    expect(shaders.map((shader) => [...shader.matchAll(/mat4\(/g)].length)).toEqual([9, 18, 18, 18]);
  });

  it('保留上游权重和 MIT 声明，防止误将模型改为假残差', () => {
    const model = readFileSync(
      new URL('../../src/ui/pages/game/vendor/Anime4K_Upscale_CNN_x2_S.glsl', import.meta.url),
    );
    expect(model.toString()).toContain('Copyright (c) 2019-2021 bloc97');
    expect(createHash('sha256').update(model).digest('hex')).toBe(
      '4c53ec2e287908f7ee7bcb266b0170421626d663576468b7d7dafc62962649a4',
    );
  });

  it('未放大时不创建资源；缺少浮点附件明确回退，不重复尝试', () => {
    const gl = {
      MAX_TEXTURE_SIZE: 1,
      FRAMEBUFFER: 2,
      getParameter: vi.fn(() => 8192),
      getExtension: vi.fn(() => null),
      bindFramebuffer: vi.fn(),
      createProgram: vi.fn(),
    };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const ai = new AiUpscale(gl as unknown as WebGL2RenderingContext);
      expect(ai.prepare(800, 600, 800, 600)).toBe(false);
      expect(gl.getExtension).not.toHaveBeenCalled();
      expect(ai.prepare(800, 600, 1600, 1200)).toBe(false);
      expect(ai.status).toContain('缺少浮点渲染附件');
      expect(ai.prepare(800, 600, 1600, 1200)).toBe(false);
      expect(gl.getExtension).toHaveBeenCalledOnce();
      expect(gl.createProgram).not.toHaveBeenCalled();
      ai.destroy();
      ai.destroy();
    } finally {
      warn.mockRestore();
    }
  });

  it('超出显存/尺寸预算不编译，销毁后不再创建资源', () => {
    const gl = { MAX_TEXTURE_SIZE: 1, getParameter: vi.fn(() => 4096), getExtension: vi.fn() };
    const ai = new AiUpscale(gl as unknown as WebGL2RenderingContext);
    expect(ai.prepare(3840, 2160, 7680, 4320)).toBe(false);
    expect(ai.status).toContain('超出尺寸预算');
    expect(gl.getExtension).not.toHaveBeenCalled();
    ai.destroy();
    expect(ai.prepare(800, 600, 1600, 1200)).toBe(false);
    expect(gl.getExtension).not.toHaveBeenCalled();
  });
});
