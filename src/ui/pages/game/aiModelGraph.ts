import { t } from '../../shared/i18n/translate';
import gan from './vendor/Anime4K_Upscale_GAN_x2_M.glsl?raw';

export interface AiPass {
  name: string;
  inputs: string[];
  uniforms: string[];
  scale: 1 | 2;
  shader: string;
}

/** Support only the repository's fixed GAN model; do not accept user shaders or arbitrary mpv directives. */
export function anime4kGanPasses(): AiPass[] {
  const blocks = gan.split('//!DESC ').slice(1);
  if (blocks.length !== 23) throw new Error(t('GAN 模型层数不符'));
  return blocks.map((block, index) => {
    const inputs = [...block.matchAll(/^\/\/!BIND (\w+)$/gm)].map((m) => m[1]!);
    const name = block.match(/^\/\/!SAVE (\w+)$/m)?.[1];
    if (!name || !inputs.length || inputs.length > 8 || !block.includes('#define'))
      throw new Error(t('GAN 模型绑定不符'));
    const uniforms = inputs.map((input) => `tex_${input}`);
    const final = index === blocks.length - 1;
    const samplers = inputs
      .map(
        (input, i) => `
      uniform sampler2D ${uniforms[i]};
      #define ${input}_pos uv
      ${
        final
          ? `#define ${input}_tex(p) texture(${uniforms[i]}, p)`
          : `#define ${input}_tex(p) texelFetch(${uniforms[i]}, clamp(ivec2((p) * vec2(textureSize(${uniforms[i]}, 0))), ivec2(0), textureSize(${uniforms[i]}, 0)-1), 0)`
      }
      // Model offsets increase from the image's top row; FBO offsets increase from the bottom. Do not round the final layer's half-pixel offsets.
      ${
        final
          ? `#define ${input}_texOff(p) ${input}_tex(uv + (p) * vec2(1.0, -1.0) / vec2(textureSize(${uniforms[i]}, 0)))`
          : `#define ${input}_texOff(p) texelFetch(${uniforms[i]}, clamp(ivec2(gl_FragCoord.xy) + ivec2((p) * vec2(1.0, -1.0)), ivec2(0), textureSize(${uniforms[i]}, 0)-1), 0)`
      }
    `,
      )
      .join('\n');
    return {
      name,
      inputs,
      uniforms,
      scale: final ? 2 : 1,
      shader: `#version 300 es
        precision highp float;
        in vec2 uv;
        out vec4 color;
        ${samplers}
        ${block.slice(block.indexOf('#define'))}
        void main() { color = hook(); }
      `,
    };
  });
}

/** A branched residual network cannot use simple double buffering; reuse textures after their last use to preserve still-needed features. */
export function planAiSurfaces(passes: readonly AiPass[]) {
  const lastUse = new Map<string, number>();
  passes.forEach((pass, index) => pass.inputs.forEach((name) => lastUse.set(name, index)));
  const slots = new Map<string, number>([['MAIN', 0]]);
  const aliveUntil: number[] = [];
  const inputs: number[][] = [],
    outputs: number[] = [];
  passes.forEach((pass, index) => {
    inputs.push(
      pass.inputs.map((name) => {
        const slot = slots.get(name);
        if (slot === undefined) throw new Error(t('AI 依赖尚未产生：{0}', name));
        return slot;
      }),
    );
    if (pass.scale === 2) {
      if (index !== passes.length - 1) throw new Error(t('仅支持最后一层放大'));
      outputs.push(-1);
      return;
    }
    let slot = aliveUntil.findIndex((end) => end < index);
    if (slot < 0) slot = aliveUntil.length;
    aliveUntil[slot] = lastUse.get(pass.name) ?? index;
    outputs.push(slot + 1);
    slots.set(pass.name, slot + 1);
  });
  const output = aliveUntil.length + 1;
  if (outputs.at(-1) !== -1) throw new Error(t('AI 模型缺少输出层'));
  outputs[outputs.length - 1] = output;
  return { inputs, outputs, featureCount: aliveUntil.length, output };
}
