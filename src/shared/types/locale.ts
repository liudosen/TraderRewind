// ============================================================
// TraderRewind — 界面语言
// 目前只做「界面文案」的中英切换，行情数据、文件名、用户输入的内容都不动。
// 语言是用户级设置，存在 settings.json 里，跟着安装走。
// ============================================================

export type Locale = 'zh' | 'en'

/** 默认语言：中文 */
export const DEFAULT_LOCALE: Locale = 'zh'

export interface LocaleOption {
  id: Locale
  /** 列表里显示的名字（用各自的语言写，方便不看当前界面语言也能认出来） */
  label: string
}

export const LOCALE_OPTIONS: LocaleOption[] = [
  { id: 'zh', label: '简体中文' },
  { id: 'en', label: 'English' }
]

const VALID = new Set<string>(LOCALE_OPTIONS.map((o) => o.id))

/** 任意输入 → 合法语言，非法时回退中文 */
export function normalizeLocale(value: unknown): Locale {
  if (typeof value !== 'string') return DEFAULT_LOCALE
  const id = value.trim().toLowerCase()
  return VALID.has(id) ? (id as Locale) : DEFAULT_LOCALE
}

/** <html lang> 用的标签 */
export function localeHtmlLang(locale: Locale): string {
  return locale === 'en' ? 'en' : 'zh-CN'
}
