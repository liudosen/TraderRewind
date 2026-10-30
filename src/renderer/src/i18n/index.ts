import { useMemo } from 'react'
import { create } from 'zustand'
import { DEFAULT_LOCALE, localeHtmlLang, normalizeLocale, type Locale } from '@shared/types/locale'
import { messages, type MessageKey } from './messages'

/** 组件外部（比如 TABS 常量表）要声明键名时用得上 */
export type { MessageKey }
export { translateLabel, instrumentLabel } from './labels'

/**
 * 界面语言状态。
 *
 * 语言是用户级设置，落在 settings.json（跟时区、标签库同一个地方），
 * 所以这儿只是内存里的镜像：load() 启动时读一次，setLocale() 写回去。
 */
interface LocaleState {
  locale: Locale
  /** 从主进程读回已保存的语言 */
  load: () => Promise<void>
  /** 切换语言：先更新界面，再异步落盘（不阻塞交互） */
  setLocale: (next: Locale) => Promise<void>
}

function applyHtmlLang(locale: Locale): void {
  if (typeof document !== 'undefined') document.documentElement.lang = localeHtmlLang(locale)
}

export const useLocaleStore = create<LocaleState>((set) => ({
  locale: DEFAULT_LOCALE,

  load: async () => {
    try {
      const remote = await window.api.getLocale()
      const next = normalizeLocale(remote)
      set({ locale: next })
      applyHtmlLang(next)
    } catch {
      // 读不到就用默认，界面不该因此挂掉
    }
  },

  setLocale: async (next) => {
    const locale = normalizeLocale(next)
    set({ locale })
    applyHtmlLang(locale)
    try {
      await window.api.setLocale(locale)
    } catch {
      // 落盘失败先不管，界面已经切了，下次启动会回到旧值
    }
  }
}))

/** 插值：把 {name} 换成 vars.name */
function interpolate(text: string, vars?: Record<string, string | number>): string {
  if (!vars) return text
  return text.replace(/\{(\w+)\}/g, (raw, key: string) =>
    key in vars ? String(vars[key]) : raw
  )
}

/**
 * 取翻译。英文缺条目时回落到中文 —— 宁可露出中文，也不要露出键名或空白。
 */
export function translate(
  locale: Locale,
  key: MessageKey,
  vars?: Record<string, string | number>
): string {
  const text = messages[locale]?.[key] ?? messages.zh[key] ?? key
  return interpolate(text, vars)
}

export interface Translator {
  (key: MessageKey, vars?: Record<string, string | number>): string
}

/**
 * 组件里用它拿翻译：
 *   const { t, locale } = useT()
 *   <h1>{t('hub.title')}</h1>
 * locale 变化会触发重渲染，所以切语言是即时生效的。
 */
export function useT(): { t: Translator; locale: Locale } {
  const locale = useLocaleStore((s) => s.locale)
  const t = useMemo<Translator>(
    () => (key, vars) => translate(locale, key, vars),
    [locale]
  )
  return { t, locale }
}
