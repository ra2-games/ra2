import { describe, expect, it } from 'vitest';
import { createTranslator, localizeText, resolveLocale } from '../../src/ui/shared/i18n/translate';
import { englishMessages } from '../../src/ui/shared/i18n/messages';
import { runtimeEnglishMessages } from '../../src/ui/shared/i18n/runtimeMessages';

describe('UI language selection', () => {
  it.each([
    [['zh-CN'], 'zh-CN'],
    [['zh-TW', 'en-US'], 'zh-CN'],
    [['zh-Hant-HK'], 'zh-CN'],
    [['en-GB', 'zh-CN'], 'en'],
    [['fr-FR', 'zh-CN'], 'zh-CN'],
    [['fr-FR', 'de-DE'], 'en'],
    [[], 'en'],
  ] as const)('resolves %j to %s', (languages, expected) => {
    expect(resolveLocale(languages)).toBe(expected);
  });

  it('formats both languages and preserves opaque filenames and substitution characters', () => {
    const en = createTranslator('en');
    const zh = createTranslator('zh-CN');
    expect(en('选择文件…')).toBe('Select files…');
    expect(zh('选择文件…')).toBe('选择文件…');
    expect(en('正在读取 {0}…', '玩家{0}$&.mpr')).toBe('Reading 玩家{0}$&.mpr…');
    expect(zh('已暂存 {0} 个文件，点击应用后生效。', 3)).toBe('已暂存 3 个文件，点击应用后生效。');
  });

  it('localizes legacy progress and nested failures without changing unknown diagnostics', () => {
    expect(localizeText('后台资源加载失败：归档未能解出文件：玩家地图.mpr', 'en')).toBe(
      'Background resource loading failed: Could not extract archive file: 玩家地图.mpr',
    );
    expect(localizeText('PE 已解析：入口 0x785aa0，368 个 Win32 导入', 'en')).toBe(
      'PE parsed: entry 0x785aa0, 368 Win32 imports',
    );
    expect(localizeText('保存事务已中止', 'en')).toBe('Save transaction aborted');
    expect(localizeText('relay 必须使用 1–65535 的端口', 'en')).toBe('Relay port must be 1–65535');
    expect(localizeText('Error: 未知诊断 0x1234', 'en')).toBe('Error: 未知诊断 0x1234');
    expect(localizeText('保存事务已中止', 'zh-CN')).toBe('保存事务已中止');
  });

  it('keeps every catalog entry translated with the same interpolation slots', () => {
    const placeholders = (value: string) => [...value.matchAll(/\{\d+\}/g)].map((match) => match[0]).sort();
    for (const [source, translated] of Object.entries({ ...runtimeEnglishMessages, ...englishMessages })) {
      expect(translated, source).not.toMatch(/\p{Script=Han}/u);
      expect(placeholders(translated), source).toEqual(placeholders(source));
    }
  });
});
