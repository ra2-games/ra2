import { englishMessages } from './messages';
import { runtimeEnglishMessages } from './runtimeMessages';

export type UiLocale = 'en' | 'zh-CN';
export type MessageKey = keyof typeof englishMessages;
const allMessages: Readonly<Record<string, string>> = { ...runtimeEnglishMessages, ...englishMessages };
const runtimePatterns = Object.entries(runtimeEnglishMessages)
  .filter(([key]) => /\{\d+\}/.test(key))
  .sort(([left], [right]) => right.replace(/\{\d+\}/g, '').length - left.replace(/\{\d+\}/g, '').length)
  .map(([key, translation]) => {
    const slots: number[] = [];
    const pattern = key
      .split(/(\{\d+\})/)
      .map((part) => {
        if (/^\{\d+\}$/.test(part)) {
          slots.push(Number(part.slice(1, -1)));
          return '([\\s\\S]*?)';
        }
        return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      })
      .join('');
    return { pattern: new RegExp(`^${pattern}$`), translation, slots };
  });

/** Prefer the first supported browser language; all Chinese variants use Simplified Chinese. */
export function resolveLocale(languages: readonly string[]): UiLocale {
  for (const language of languages) {
    const primary = language.trim().toLowerCase().split(/[-_]/)[0];
    if (primary === 'zh') return 'zh-CN';
    if (primary === 'en') return 'en';
  }
  return 'en';
}

/** Resolve once at startup; experimental Workers then inherit their owning page's locale. */
export let uiLocale = resolveLocale(
  typeof navigator === 'undefined' ? [] : navigator.languages?.length ? navigator.languages : [navigator.language],
);

export function createTranslator(locale: UiLocale) {
  return (key: MessageKey, ...values: readonly unknown[]): string => {
    const template = locale === 'en' ? englishMessages[key] : key;
    return template.replace(/\{(\d+)\}/g, (placeholder, index: string) =>
      Number(index) < values.length ? localizeText(String(values[Number(index)]), locale) : placeholder,
    );
  };
}

let translate = createTranslator(uiLocale);

export function t(key: MessageKey, ...values: readonly unknown[]): string {
  return translate(key, ...values);
}

/** Initialize before the first model task because WorkerNavigator may differ from the page. */
export function initializeWorkerLocale(locale: UiLocale): void {
  uiLocale = locale === 'zh-CN' ? 'zh-CN' : 'en';
  translate = createTranslator(uiLocale);
}

/** Localize catalog metadata at the presentation boundary without coupling game definitions to the UI. */
export function localizeLabel(value: string): string {
  return uiLocale === 'en' && Object.hasOwn(allMessages, value) ? allMessages[value]! : value;
}

/** Adapt existing diagnostic text only at the UI boundary; unknown details and filenames stay intact. */
export function localizeText(value: string, locale: UiLocale = uiLocale, depth = 0): string {
  if (locale !== 'en' || depth > 6 || !/\p{Script=Han}/u.test(value)) return value;
  if (Object.hasOwn(allMessages, value)) return allMessages[value]!;
  if (value.startsWith('Error: ')) return `Error: ${localizeText(value.slice(7), locale, depth + 1)}`;
  for (const { pattern, translation, slots } of runtimePatterns) {
    const match = pattern.exec(value);
    if (!match) continue;
    const values = new Map(slots.map((slot, index) => [slot, match[index + 1]!]));
    return translation.replace(/\{(\d+)\}/g, (placeholder, index: string) =>
      values.has(Number(index)) ? localizeText(values.get(Number(index))!, locale, depth + 1) : placeholder,
    );
  }
  if (value.includes('\n'))
    return value
      .split('\n')
      .map((line) => localizeText(line, locale, depth + 1))
      .join('\n');
  return value;
}
