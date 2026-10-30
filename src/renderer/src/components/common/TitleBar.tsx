import React from 'react'
import clsx from 'clsx'
import { AlertCircle, ArrowDownToLine, Loader2 } from 'lucide-react'
import { Logo } from './Logo'
import { useT, useLocaleStore } from '../../i18n'
import { useAppStore } from '../../stores/app-store'
import { needsAttention, updatePercent, useUpdateStore } from '../../stores/update-store'
import { LOCALE_OPTIONS, type Locale } from '@shared/types/locale'

/**
 * 顶部标题栏（替代 Windows 原生那条白色标题栏）。
 *
 * 主进程用 `titleBarStyle: 'hidden'` + `titleBarOverlay` 把原生标题栏藏掉了，
 * 但保留系统绘制的三个窗口按钮 —— 它们悬浮在网页右上角，所以这里必须
 * 预留出那块宽度，否则内容会被最小化/最大化/关闭压住。
 *
 * 高度必须和主进程 titleBarOverlay.height 一致（36），改一边要同步另一边。
 */
const CAPTION_WIDTH = 138 // Windows 三个按钮的宽度，会随系统缩放变化
const isMac = typeof navigator !== 'undefined' && navigator.userAgent.includes('Mac')

export function TitleBar(): React.JSX.Element {
  const { t } = useT()
  const locale = useLocaleStore((s) => s.locale)
  const setLocale = useLocaleStore((s) => s.setLocale)

  return (
    <div
      className="title-bar flex shrink-0 items-center gap-2 border-b border-[var(--border-subtle)] bg-[var(--surface-1)]"
      style={{
        height: 36,
        // macOS 的红绿灯在左上角，反过来要给左边留位、右边不用留
        paddingLeft: isMac ? 78 : 12,
        paddingRight: isMac ? 12 : CAPTION_WIDTH
      }}
    >
      <Logo size={20} />
      <span className="truncate text-[12.5px] font-semibold tracking-[-0.01em] text-[var(--text-primary)]">
        TraderRewind
      </span>

      <div className="ml-auto flex items-center gap-2 pr-1">
        <UpdatePill />
        <div title={t('title.language')}>
          <LanguageToggle value={locale} onChange={(next) => void setLocale(next)} />
        </div>
      </div>
    </div>
  )
}

/**
 * 标题栏的更新提示。
 *
 * 只在这几种时候出现：查到新版 / 正在下载 / 下载完可以装 / 检查失败。
 * 平时（idle、检查中、已是最新）完全不占位置——标题栏本来就很挤。
 * 点它一律跳到「设置 → 通用 → 关于」，那里有版本明细和完整按钮。
 */
function UpdatePill(): React.JSX.Element | null {
  const { t } = useT()
  const state = useUpdateStore()
  const setActivePane = useAppStore((s) => s.setActivePane)
  const percent = updatePercent(state)

  if (!needsAttention(state) && state.phase !== 'installing') return null
  if (state.latestVersion && state.dismissedVersion === state.latestVersion) return null

  const label = (() => {
    switch (state.phase) {
      case 'available':
        return t('update.pillAvailable', { version: state.latestVersion ?? '' })
      case 'downloading':
        return percent != null
          ? t('update.pillDownloading', { percent })
          : t('update.pillDownloadingUnknown')
      case 'ready':
        return t('update.pillReady', { version: state.latestVersion ?? '' })
      case 'installing':
        return t('update.pillInstalling')
      default:
        return t('update.pillError')
    }
  })()

  const tone =
    state.phase === 'error'
      ? 'text-[var(--c-neg)] border-[var(--c-neg)]/40 bg-[var(--c-neg-tint)]'
      : state.phase === 'ready'
        ? 'text-[var(--c-pos)] border-[var(--c-pos)]/40 bg-[var(--c-pos-tint)]'
        : 'text-[var(--c-accent)] border-[var(--c-accent)]/40 bg-[var(--c-accent-tint)]'

  return (
    <button
      onClick={() => setActivePane('settings')}
      title={t('update.pillHint')}
      className={clsx(
        'flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[10.5px] font-medium transition-opacity hover:opacity-80',
        tone
      )}
    >
      {state.phase === 'downloading' ? (
        <Loader2 size={10} className="animate-spin" />
      ) : state.phase === 'error' ? (
        <AlertCircle size={10} />
      ) : (
        <ArrowDownToLine size={10} />
      )}
      <span className="max-w-[220px] truncate">{label}</span>
    </button>
  )
}

/**
 * 两段式语言切换。只有两种语言时，直接并排放比下拉菜单少一次点击，
 * 也能让人一眼看出「这软件支持英文」。
 */
function LanguageToggle({
  value,
  onChange
}: {
  value: Locale
  onChange: (next: Locale) => void
}): React.JSX.Element {
  return (
    <div
      data-lang-toggle="1"
      className="flex items-center gap-0.5 rounded-md border border-[var(--border-subtle)] p-0.5"
    >
      {LOCALE_OPTIONS.map((opt) => (
        <button
          key={opt.id}
          type="button"
          data-locale={opt.id}
          onClick={() => onChange(opt.id)}
          className={clsx(
            'rounded px-1.5 py-[1px] text-[10.5px] leading-none transition-colors',
            value === opt.id
              ? 'bg-[var(--c-accent-tint)] text-[var(--c-accent)]'
              : 'text-[var(--text-muted)] hover:text-[var(--text-primary)]'
          )}
          // 用各自的语言写，切错也能认回来
          title={opt.label}
        >
          {opt.id === 'zh' ? '中' : 'EN'}
        </button>
      ))}
    </div>
  )
}
