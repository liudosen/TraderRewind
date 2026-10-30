import React, { useEffect, useRef, useState } from 'react'
import {
  FolderOpen,
  FolderCog,
  HardDrive,
  Loader2,
  CheckCircle2,
  AlertCircle,
  RotateCcw,
  Plus,
  X,
  Tag,
  Settings2,
  Clock,
  CandlestickChart,
  Activity
} from 'lucide-react'
import clsx from 'clsx'
import { formatBytes } from '../../utils/format'
import { useT, useLocaleStore, translateLabel, type MessageKey } from '../../i18n'
import { useChartThemeStore } from '../../stores/chart-theme-store'
import { useTimezoneStore } from '../../stores/timezone-store'
import { useTrainingStore } from '../../stores/training-store'
import { indicatorTitle } from '@shared/utils/indicators'
import { MAX_TAG_LIBRARY, MAX_TRADE_TAG_LEN } from '@shared/types/trade-tags'
import {
  DEFAULT_TIMEZONE,
  TIMEZONE_OPTIONS,
  fmtTzDateTimeFromMs
} from '@shared/types/timezone'
import { LOCALE_OPTIONS } from '@shared/types/locale'
import {
  CROSSHAIR_STYLES,
  THEME_PRESETS,
  type CrosshairStyle
} from '@shared/types/chart-theme'

/** 设置页的分栏：配置项太多，按类型切成 Tab */
type TabId = 'general' | 'trading' | 'chart' | 'indicator'

const TAB_STORE_KEY = 'rw.settings.tab'

const TABS: {
  id: TabId
  labelKey: MessageKey
  descKey: MessageKey
  icon: React.ComponentType<{ size?: number | string; className?: string }>
}[] = [
  { id: 'general', labelKey: 'settings.tab.general', descKey: 'settings.tab.generalDesc', icon: Settings2 },
  { id: 'trading', labelKey: 'settings.tab.trading', descKey: 'settings.tab.tradingDesc', icon: Clock },
  { id: 'chart', labelKey: 'settings.tab.chart', descKey: 'settings.tab.chartDesc', icon: CandlestickChart },
  {
    id: 'indicator',
    labelKey: 'settings.tab.indicator',
    descKey: 'settings.tab.indicatorDesc',
    icon: Activity
  }
]

interface StorageInfo {
  klineDir: string
  trainingDir: string
  klineDbPath: string
  trainingDbPath: string
  klineDbSize: number
  trainingDbSize: number
  userDataDir: string
}

type Kind = 'kline' | 'training'

export function SettingsPanel(): React.JSX.Element {
  const { t } = useT()
  const locale = useLocaleStore((s) => s.locale)
  const setLocale = useLocaleStore((s) => s.setLocale)

  const chartTheme = useChartThemeStore((s) => s.theme)
  const patchTheme = useChartThemeStore((s) => s.patch)
  const resetTheme = useChartThemeStore((s) => s.reset)

  /** 当前 Tab：记住上次停在哪一页，下次进来直接定位 */
  const [tab, setTab] = useState<TabId>(() => {
    try {
      const saved = localStorage.getItem(TAB_STORE_KEY)
      return TABS.some((x) => x.id === saved) ? (saved as TabId) : 'general'
    } catch {
      return 'general'
    }
  })
  useEffect(() => {
    try {
      localStorage.setItem(TAB_STORE_KEY, tab)
    } catch {
      // 隐私模式下写不了，忽略
    }
  }, [tab])

  const timezone = useTimezoneStore((s) => s.timezone)
  const setTimezone = useTimezoneStore((s) => s.setTimezone)
  const [now, setNow] = useState(() => Date.now())

  /** 指标是用户级配置：默认全关，用户调过后所有回测集通用 */
  const indicatorPrefs = useTrainingStore((s) => s.indicatorPrefs)
  const clearIndicators = useTrainingStore((s) => s.clearIndicators)

  const overlayNames = indicatorPrefs.overlays
    .map((inst) => indicatorTitle(inst.id, inst.params))
    .join('、')
  const subPaneNames = indicatorPrefs.subPanes
    .map((inst) => indicatorTitle(inst.id, inst.params))
    .join('、')
  const noIndicator =
    indicatorPrefs.overlays.length === 0 && indicatorPrefs.subPanes.length === 0

  /** 标签库：下单备注浮窗里可一键点亮的常用标签 */
  const tagLibrary = useTrainingStore((s) => s.tagLibrary)
  const setTagLibrary = useTrainingStore((s) => s.setTagLibrary)
  const [tagInputOpen, setTagInputOpen] = useState(false)
  const [tagDraft, setTagDraft] = useState('')
  const tagInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (tagInputOpen) tagInputRef.current?.focus()
  }, [tagInputOpen])

  const commitTag = (): void => {
    const value = tagDraft.trim().slice(0, MAX_TRADE_TAG_LEN)
    setTagDraft('')
    setTagInputOpen(false)
    if (!value || tagLibrary.includes(value) || tagLibrary.length >= MAX_TAG_LIBRARY) return
    setTagLibrary([...tagLibrary, value])
  }

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [])

  const [info, setInfo] = useState<StorageInfo | null>(null)
  const [busy, setBusy] = useState<Kind | null>(null)
  const [notice, setNotice] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)

  const loadInfo = async (): Promise<void> => {
    try {
      const data = (await window.api.getStorageInfo()) as StorageInfo
      setInfo(data)
    } catch (e: any) {
      setNotice({ kind: 'err', text: e?.message ?? String(e) })
    }
  }

  useEffect(() => {
    void loadInfo()
  }, [])

  const changeDir = async (kind: Kind): Promise<void> => {
    setNotice(null)
    try {
      const picked = await window.api.chooseStorageDir(kind)
      if (!picked) return
      setBusy(kind)
      const res: any = await window.api.setStorageDir(kind, picked)
      setBusy(null)
      if (res?.ok) {
        setInfo(res as StorageInfo)
        setNotice({
          kind: 'ok',
          text: res.copied
            ? t('settings.storage.copied', { dir: picked })
            : t('settings.storage.switched', { dir: picked })
        })
      } else {
        setNotice({ kind: 'err', text: res?.error ?? t('settings.storage.failed') })
      }
    } catch (e: any) {
      setBusy(null)
      setNotice({ kind: 'err', text: e?.message ?? String(e) })
    }
  }

  return (
    <div className="h-full overflow-y-auto p-6">
      <h1 className="mb-1 text-[18px] font-semibold text-[var(--text-primary)]">{t('settings.title')}</h1>
      <p className="mb-4 text-[11.5px] text-[var(--text-muted)]">
        {t((TABS.find((x) => x.id === tab) ?? TABS[0]).descKey)}
      </p>

      {/* ── 分类 Tab ── */}
      <div className="mb-5 flex items-stretch gap-1 border-b border-[var(--border-subtle)]">
        {TABS.map((item) => {
          const active = item.id === tab
          const Icon = item.icon
          const desc = t(item.descKey)
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => setTab(item.id)}
              title={desc}
              className={clsx(
                '-mb-px flex items-center gap-1.5 border-b-2 px-3 py-2 text-[12px] transition-colors',
                active
                  ? 'border-[var(--c-accent)] font-medium text-[var(--text-primary)]'
                  : 'border-transparent text-[var(--text-muted)] hover:text-[var(--text-primary)]'
              )}
            >
              <Icon
                size={13}
                className={active ? 'text-[var(--c-accent)]' : 'text-[var(--text-faint)]'}
              />
              {t(item.labelKey)}
            </button>
          )
        })}
      </div>

      {notice && (
        <div
          className={clsx(
            'mb-5 flex w-full items-start gap-2 rounded-md border px-3 py-2 text-[11.5px]',
            notice.kind === 'ok'
              ? 'border-[var(--c-pos)]/40 bg-[var(--c-pos-tint)] text-[var(--c-pos)]'
              : 'border-[var(--c-neg)]/40 bg-[var(--c-neg-tint)] text-[var(--c-neg)]'
          )}
        >
          {notice.kind === 'ok' ? (
            <CheckCircle2 size={13} className="mt-0.5 shrink-0" />
          ) : (
            <AlertCircle size={13} className="mt-0.5 shrink-0" />
          )}
          <span className="break-all">{notice.text}</span>
        </div>
      )}

      <div className="w-full">
        {/* ── 数据存储（通用） ─────────────────── */}
        <section className={clsx('mb-6', tab !== 'general' && 'hidden')}>
          <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--text-muted)]">
            {t('settings.storage.title')}
          </h2>

          <div className="grid gap-3 lg:grid-cols-2">
            <StorageCard
              icon={<HardDrive size={15} />}
              badge={t('settings.storage.klineBadge')}
              description={t('settings.storage.klineDesc')}
              dir={info?.klineDir ?? t('settings.storage.loading')}
              dbPath={info?.klineDbPath}
              dbSize={info?.klineDbSize}
              busy={busy === 'kline'}
              disabled={busy !== null}
              onChange={() => void changeDir('kline')}
              onReveal={() => void window.api.revealStorageDir('kline')}
            />

            <StorageCard
              icon={<FolderCog size={15} />}
              badge={t('settings.storage.trainingBadge')}
              description={t('settings.storage.trainingDesc')}
              dir={info?.trainingDir ?? t('settings.storage.loading')}
              dbPath={info?.trainingDbPath}
              dbSize={info?.trainingDbSize}
              busy={busy === 'training'}
              disabled={busy !== null}
              onChange={() => void changeDir('training')}
              onReveal={() => void window.api.revealStorageDir('training')}
            />
          </div>

          <p className="mt-2.5 text-[10.5px] leading-relaxed text-[var(--text-faint)]">
            {t('settings.storage.hint')}
          </p>
        </section>

        {/* ── 外观（通用） ─────────────────────── */}
        <div className={clsx('mb-6', tab !== 'general' && 'hidden')}>
          <Section title={t('settings.appearance.title')} cols={2}>
            <Row label={t('settings.appearance.theme')} value={t('settings.appearance.themeDark')} />
            {/* 语言放在设置页里，跟标题栏右上角的切换按钮是同一份状态 */}
            <div className="flex items-center justify-between gap-4 px-4 py-2.5">
              <span className="shrink-0 text-[12px] text-[var(--text-secondary)]">
                {t('settings.appearance.language')}
              </span>
              <div className="flex items-center gap-1">
                {LOCALE_OPTIONS.map((o) => {
                  const active = o.id === locale
                  return (
                    <button
                      key={o.id}
                      type="button"
                      onClick={() => void setLocale(o.id)}
                      className={clsx(
                        'rounded border px-2 py-0.5 text-[10.5px] transition-colors',
                        active
                          ? 'border-[var(--c-accent)] bg-[var(--c-accent-tint)] text-[var(--c-accent)]'
                          : 'border-[var(--border-subtle)] text-[var(--text-secondary)] hover:border-[var(--c-accent)] hover:text-[var(--c-accent)]'
                      )}
                    >
                      {o.label}
                    </button>
                  )
                })}
              </div>
            </div>
          </Section>
        </div>

        {/* ── 时间与时区（交易） ────────────────── */}
        <section className={clsx('mb-6', tab !== 'trading' && 'hidden')}>
          <div className="mb-3 flex items-center gap-2">
            <h2 className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--text-muted)]">
              {t('settings.tz.title')}
            </h2>
            <span className="text-[10px] text-[var(--text-faint)]">{t('settings.tz.hint')}</span>
            {timezone !== DEFAULT_TIMEZONE && (
              <button
                onClick={() => void setTimezone(DEFAULT_TIMEZONE)}
                className="ml-auto inline-flex items-center gap-1 rounded border border-[var(--border-subtle)] px-2 py-0.5 text-[10.5px] text-[var(--text-secondary)] transition-colors hover:border-[var(--border-strong)] hover:text-[var(--text-primary)]"
              >
                <RotateCcw size={10} />
                {t('settings.tz.reset')}
              </button>
            )}
          </div>

          <div className="divide-y divide-[var(--border-subtle)] overflow-hidden rounded-lg border border-[var(--border-subtle)]">
            <div className="flex flex-wrap items-center gap-1.5 px-4 py-2.5">
              <span className="mr-1 w-16 shrink-0 text-[12px] text-[var(--text-secondary)]">
                {t('settings.tz.label')}
              </span>
              {TIMEZONE_OPTIONS.map((o) => {
                const active = o.id === timezone
                return (
                  <button
                    key={o.id}
                    onClick={() => void setTimezone(o.id)}
                    className={clsx(
                      'rounded border px-2 py-0.5 text-[10.5px] transition-colors',
                      active
                        ? 'border-[var(--c-accent)] bg-[var(--c-accent-tint)] text-[var(--c-accent)]'
                        : 'border-[var(--border-subtle)] text-[var(--text-secondary)] hover:border-[var(--c-accent)] hover:text-[var(--c-accent)]'
                    )}
                  >
                    {translateLabel(locale, o.label)}
                  </button>
                )
              })}
            </div>

            <div className="flex items-center justify-between gap-4 px-4 py-2.5">
              <span className="shrink-0 text-[12px] text-[var(--text-secondary)]">
                {t('settings.tz.now')}
              </span>
              <span className="font-mono text-[12px] tabular-nums text-[var(--text-primary)]">
                {fmtTzDateTimeFromMs(now, timezone)}
              </span>
            </div>

            <div className="px-4 py-2.5">
              <p className="text-[10.5px] leading-relaxed text-[var(--text-faint)]">
                {t('settings.tz.note')}
              </p>
            </div>
          </div>
        </section>

        {/* ── 指标 ─────────────────────────────── */}
        <section className={clsx('mb-6', tab !== 'indicator' && 'hidden')}>
          <div className="mb-3 flex items-center gap-2">
            <h2 className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--text-muted)]">
              {t('settings.indicator.title')}
            </h2>
            <span className="text-[10px] text-[var(--text-faint)]">{t('settings.indicator.hint')}</span>
            {!noIndicator && (
              <button
                onClick={() => clearIndicators()}
                className="ml-auto inline-flex items-center gap-1 rounded border border-[var(--border-subtle)] px-2 py-0.5 text-[10.5px] text-[var(--text-secondary)] transition-colors hover:border-[var(--border-strong)] hover:text-[var(--text-primary)]"
              >
                <RotateCcw size={10} />
                {t('settings.indicator.turnOffAll')}
              </button>
            )}
          </div>

          <div className="grid grid-cols-1 gap-px overflow-hidden rounded-lg border border-[var(--border-subtle)] bg-[var(--border-subtle)] md:grid-cols-2 [&>*]:bg-[var(--surface-1)]">
            <div className="flex items-center justify-between gap-4 px-4 py-2.5">
              <span className="shrink-0 text-[12px] text-[var(--text-secondary)]">
                {t('settings.indicator.overlay')}
              </span>
              <span
                className={clsx(
                  'truncate text-right text-[12px]',
                  noIndicator ? 'text-[var(--text-faint)]' : 'text-[var(--text-primary)]'
                )}
              >
                {overlayNames || t('settings.indicator.none')}
              </span>
            </div>
            <div className="flex items-center justify-between gap-4 px-4 py-2.5">
              <span className="shrink-0 text-[12px] text-[var(--text-secondary)]">
                {t('settings.indicator.subPane')}
              </span>
              <span
                className={clsx(
                  'truncate text-right text-[12px]',
                  indicatorPrefs.subPanes.length > 0
                    ? 'text-[var(--text-primary)]'
                    : 'text-[var(--text-faint)]'
                )}
              >
                {subPaneNames || t('settings.indicator.hidden')}
              </span>
            </div>
          </div>

          <p className="mt-2.5 text-[10.5px] leading-relaxed text-[var(--text-faint)]">
            {t('settings.indicator.note')}
          </p>
        </section>

        {/* ── 交易标签（交易） ─────────────────── */}
        <section className={clsx('mb-6', tab !== 'trading' && 'hidden')}>
          <div className="mb-3 flex items-center gap-2">
            <h2 className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--text-muted)]">
              {t('settings.tags.title')}
            </h2>
            <span className="text-[10px] text-[var(--text-faint)]">{t('settings.tags.hint')}</span>
            {tagLibrary.length > 0 && (
              <button
                onClick={() => setTagLibrary([])}
                className="ml-auto inline-flex items-center gap-1 rounded border border-[var(--border-subtle)] px-2 py-0.5 text-[10.5px] text-[var(--text-secondary)] transition-colors hover:border-[var(--border-strong)] hover:text-[var(--text-primary)]"
              >
                <RotateCcw size={10} />
                {t('settings.tags.clear')}
              </button>
            )}
          </div>

          <div className="rounded-lg border border-[var(--border-subtle)] px-4 py-2.5">
            <div className="flex flex-wrap items-center gap-1.5">
              <Tag size={11} className="shrink-0 text-[var(--text-faint)]" />

              {tagLibrary.map((tag) => (
                <span
                  key={tag}
                  className="inline-flex items-center gap-1 rounded border border-[var(--border-subtle)] bg-[var(--surface-2)] px-1.5 py-[2px] text-[11px] leading-none text-[var(--text-secondary)]"
                >
                  {tag}
                  <button
                    onClick={() => setTagLibrary(tagLibrary.filter((x) => x !== tag))}
                    title={t('settings.tags.remove')}
                    className="text-[var(--text-faint)] transition-colors hover:text-[var(--c-neg)]"
                  >
                    <X size={9} />
                  </button>
                </span>
              ))}

              {tagInputOpen ? (
                <input
                  ref={tagInputRef}
                  value={tagDraft}
                  maxLength={MAX_TRADE_TAG_LEN}
                  onChange={(e) => setTagDraft(e.target.value)}
                  onBlur={commitTag}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      commitTag()
                    } else if (e.key === 'Escape') {
                      setTagDraft('')
                      setTagInputOpen(false)
                    }
                  }}
                  placeholder={t('settings.tags.placeholder')}
                  className="w-[84px] rounded border border-[var(--c-accent)] bg-[var(--surface-2)] px-1.5 py-[2px] text-[11px] leading-none text-[var(--text-primary)] outline-none placeholder:text-[var(--text-faint)]"
                />
              ) : tagLibrary.length < MAX_TAG_LIBRARY ? (
                <button
                  onClick={() => setTagInputOpen(true)}
                  title={t('settings.tags.add', { max: MAX_TAG_LIBRARY })}
                  className="inline-flex h-[19px] w-[19px] shrink-0 items-center justify-center rounded border border-dashed border-[var(--border-strong)] text-[var(--text-faint)] transition-colors hover:border-[var(--c-accent)] hover:text-[var(--c-accent)]"
                >
                  <Plus size={11} />
                </button>
              ) : null}

              {tagLibrary.length === 0 && !tagInputOpen && (
                <span className="text-[10.5px] text-[var(--text-faint)]">{t('settings.tags.empty')}</span>
              )}
            </div>

            <p className="mt-2 text-[10.5px] leading-relaxed text-[var(--text-faint)]">
              {t('settings.tags.note')}
            </p>
          </div>
        </section>

        {/* ── 图表外观（图表） ─────────────────── */}
        <section className={clsx('mb-6', tab !== 'chart' && 'hidden')}>
          <div className="mb-3 flex items-center gap-2">
            <h2 className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--text-muted)]">
              {t('settings.chart.title')}
            </h2>
            <span className="text-[10px] text-[var(--text-faint)]">{t('settings.chart.hint')}</span>
            <button
              onClick={resetTheme}
              className="ml-auto inline-flex items-center gap-1 rounded border border-[var(--border-subtle)] px-2 py-0.5 text-[10.5px] text-[var(--text-secondary)] transition-colors hover:border-[var(--border-strong)] hover:text-[var(--text-primary)]"
            >
              <RotateCcw size={10} />
              {t('settings.chart.reset')}
            </button>
          </div>

          <div className="grid grid-cols-1 gap-px overflow-hidden rounded-lg border border-[var(--border-subtle)] bg-[var(--border-subtle)] md:grid-cols-2 2xl:grid-cols-3 [&>*]:bg-[var(--surface-1)]">
            {/* 预设 */}
            <div className="flex flex-wrap items-center gap-1.5 px-4 py-2.5 col-span-full">
              <span className="mr-1 text-[12px] text-[var(--text-secondary)]">
                {t('settings.chart.presets')}
              </span>
              {THEME_PRESETS.map((p) => (
                <button
                  key={p.id}
                  onClick={() => patchTheme(p.patch)}
                  className="rounded border border-[var(--border-subtle)] px-2 py-0.5 text-[10.5px] text-[var(--text-secondary)] transition-colors hover:border-[var(--c-accent)] hover:text-[var(--c-accent)]"
                >
                  {translateLabel(locale, p.label)}
                </button>
              ))}
            </div>

            <ColorRow
              label={t('settings.chart.upColor')}
              value={chartTheme.upColor}
              onChange={(v) => patchTheme({ upColor: v })}
            />
            <ColorRow
              label={t('settings.chart.downColor')}
              value={chartTheme.downColor}
              onChange={(v) => patchTheme({ downColor: v })}
            />
            <ColorRow
              label={t('settings.chart.background')}
              value={chartTheme.background}
              onChange={(v) => patchTheme({ background: v })}
            />
            <ColorRow
              label={t('settings.chart.textColor')}
              value={chartTheme.textColor}
              onChange={(v) => patchTheme({ textColor: v })}
            />

            <ToggleRow
              label={t('settings.chart.gridVisible')}
              checked={chartTheme.gridVisible}
              onChange={(v) => patchTheme({ gridVisible: v })}
            />
            <ColorRow
              label={t('settings.chart.gridColor')}
              value={chartTheme.gridColor}
              onChange={(v) => patchTheme({ gridColor: v })}
            />

            <ColorRow
              label={t('settings.chart.crosshairColor')}
              value={chartTheme.crosshairColor}
              onChange={(v) => patchTheme({ crosshairColor: v })}
            />

            <div className="flex items-center justify-between gap-4 px-4 py-2.5">
              <span className="shrink-0 text-[12px] text-[var(--text-secondary)]">
                {t('settings.chart.crosshairStyle')}
              </span>
              <select
                value={chartTheme.crosshairStyle}
                onChange={(e) =>
                  patchTheme({ crosshairStyle: Number(e.target.value) as CrosshairStyle })
                }
                className="rounded border border-[var(--border-subtle)] bg-[var(--surface-2)] px-2 py-1 text-[11px] text-[var(--text-primary)] outline-none focus:border-[var(--c-accent)]"
              >
                {CROSSHAIR_STYLES.map((o) => (
                  <option key={o.value} value={o.value}>
                    {translateLabel(locale, o.label)}
                  </option>
                ))}
              </select>
            </div>

            <div className="flex items-center justify-between gap-4 px-4 py-2.5">
              <span className="shrink-0 text-[12px] text-[var(--text-secondary)]">
                {t('settings.chart.crosshairWidth')}
              </span>
              <div className="flex items-center gap-1">
                {[1, 2].map((w) => (
                  <button
                    key={w}
                    onClick={() => patchTheme({ crosshairWidth: w as 1 | 2 })}
                    className={clsx(
                      'rounded border px-2 py-0.5 text-[10.5px] transition-colors',
                      chartTheme.crosshairWidth === w
                        ? 'border-[var(--c-accent)] bg-[var(--c-accent-tint)] text-[var(--c-accent)]'
                        : 'border-[var(--border-subtle)] text-[var(--text-secondary)]'
                    )}
                  >
                    {w}px
                  </button>
                ))}
              </div>
            </div>

            <ToggleRow
              label={t('settings.chart.crosshairLabels')}
              checked={chartTheme.crosshairLabels}
              onChange={(v) => patchTheme({ crosshairLabels: v })}
            />
            <ToggleRow
              label={t('settings.chart.crosshairMagnet')}
              checked={chartTheme.crosshairMagnet}
              onChange={(v) => patchTheme({ crosshairMagnet: v })}
            />
            <ToggleRow
              label={t('settings.chart.showWick')}
              checked={chartTheme.showWick}
              onChange={(v) => patchTheme({ showWick: v })}
            />
            <ToggleRow
              label={t('settings.chart.showBorder')}
              checked={chartTheme.showBorder}
              onChange={(v) => patchTheme({ showBorder: v })}
              full
            />
          </div>
        </section>

        {/* ── 关于（通用） ─────────────────────── */}
        <div className={clsx('mb-6', tab !== 'general' && 'hidden')}>
          <Section title={t('settings.about.title')} cols={2}>
            <Row label={t('settings.about.version')} value="0.2.0" />
            <Row label={t('settings.about.license')} value="MIT License" />
            <Row
              label={t('settings.about.dataDir')}
              value={info?.userDataDir ?? '--'}
              mono
              full
            />
          </Section>
        </div>
      </div>
    </div>
  )
}

function StorageCard({
  icon,
  badge,
  description,
  dir,
  dbPath,
  dbSize,
  busy,
  disabled,
  onChange,
  onReveal
}: {
  icon: React.ReactNode
  badge: string
  description: string
  dir: string
  dbPath?: string
  dbSize?: number
  busy: boolean
  disabled: boolean
  onChange: () => void
  onReveal: () => void
}): React.JSX.Element {
  const { t } = useT()
  return (
    <div className="rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-1)] p-3.5">
      <div className="flex items-start gap-3">
        <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-[var(--c-accent-tint)] text-[var(--c-accent)]">
          {icon}
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-[12px] font-semibold text-[var(--text-primary)]">{badge}</span>
            {dbSize != null && (
              <span className="rounded-full bg-[var(--surface-3)] px-1.5 py-px font-mono text-[9px] text-[var(--text-secondary)]">
                {formatBytes(dbSize)}
              </span>
            )}
          </div>
          <p className="mt-0.5 text-[10.5px] text-[var(--text-muted)]">{description}</p>

          <div className="mt-2 rounded-md border border-[var(--border-subtle)] bg-[var(--surface-0)] px-2.5 py-1.5">
            <div className="break-all font-mono text-[10.5px] leading-relaxed text-[var(--text-secondary)]">
              {dir}
            </div>
            {dbPath && (
              <div className="mt-0.5 break-all font-mono text-[9.5px] text-[var(--text-faint)]">
                {t('settings.storage.dbFile')}
                {dbPath}
              </div>
            )}
          </div>
        </div>

        <div className="flex shrink-0 flex-col gap-1.5">
          <button
            onClick={onChange}
            disabled={disabled}
            className="inline-flex items-center justify-center gap-1.5 rounded-md bg-[var(--c-accent)] px-2.5 py-1 text-[11px] font-medium text-white transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {busy ? <Loader2 size={11} className="animate-spin" /> : <FolderCog size={11} />}
            {t('settings.storage.change')}
          </button>
          <button
            onClick={onReveal}
            className="inline-flex items-center justify-center gap-1.5 rounded-md border border-[var(--border-subtle)] px-2.5 py-1 text-[11px] text-[var(--text-secondary)] transition hover:border-[var(--border-strong)] hover:text-[var(--text-primary)]"
          >
            <FolderOpen size={11} />
            {t('settings.storage.reveal')}
          </button>
        </div>
      </div>
    </div>
  )
}

function ColorRow({
  label,
  value,
  onChange
}: {
  label: string
  value: string
  onChange: (v: string) => void
}): React.JSX.Element {
  const hex = /^#[0-9a-f]{6}$/i.test(value) ? value : '#ffffff'
  return (
    <div className="flex items-center justify-between gap-4 px-4 py-2">
      <span className="shrink-0 text-[12px] text-[var(--text-secondary)]">{label}</span>
      <div className="flex items-center gap-1.5">
        <input
          type="color"
          value={hex}
          onChange={(e) => onChange(e.target.value)}
          className="h-5 w-7 cursor-pointer rounded border border-[var(--border-subtle)] bg-transparent p-0"
        />
        <input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          spellCheck={false}
          className="w-[124px] rounded border border-[var(--border-subtle)] bg-[var(--surface-2)] px-2 py-0.5 font-mono text-[10.5px] text-[var(--text-primary)] outline-none focus:border-[var(--c-accent)]"
        />
      </div>
    </div>
  )
}

function ToggleRow({
  label,
  checked,
  onChange,
  full
}: {
  label: string
  checked: boolean
  onChange: (v: boolean) => void
  /** 在 2 列栅格里独占整行，用于补齐末行 */
  full?: boolean
}): React.JSX.Element {
  return (
    <label
      className={clsx(
        'flex cursor-pointer items-center justify-between gap-4 px-4 py-2',
        full && 'col-span-full'
      )}
    >
      <span className="text-[12px] text-[var(--text-secondary)]">{label}</span>
      <button
        type="button"
        onClick={() => onChange(!checked)}
        className={clsx(
          'relative h-4 w-8 shrink-0 rounded-full transition-colors',
          checked ? 'bg-[var(--c-accent)]' : 'bg-[var(--surface-4)]'
        )}
      >
        <span
          className={clsx(
            'absolute top-0.5 h-3 w-3 rounded-full bg-white transition-all',
            checked ? 'left-[18px]' : 'left-0.5'
          )}
        />
      </button>
    </label>
  )
}

function Section({
  title,
  children,
  cols = 1
}: {
  title: string
  children: React.ReactNode
  /** 宽屏下的列数：2 列时用 1px 网格线拼接，避免整行左右两端拉到很远 */
  cols?: 1 | 2
}): React.JSX.Element {
  return (
    <div>
      <h2 className="mb-3 text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--text-muted)]">
        {title}
      </h2>
      <div
        className={clsx(
          'overflow-hidden rounded-lg border border-[var(--border-subtle)]',
          cols === 2
            ? 'grid grid-cols-1 gap-px bg-[var(--border-subtle)] md:grid-cols-2 [&>*]:bg-[var(--surface-1)]'
            : 'divide-y divide-[var(--border-subtle)]'
        )}
      >
        {children}
      </div>
    </div>
  )
}

function Row({
  label,
  value,
  mono,
  full
}: {
  label: string
  value: string
  mono?: boolean
  /** 在 2 列栅格里独占整行（长路径用） */
  full?: boolean
}): React.JSX.Element {
  return (
    <div
      className={clsx(
        'flex items-center justify-between gap-4 px-4 py-2.5',
        full && 'col-span-full'
      )}
    >
      <span className="shrink-0 text-[12px] text-[var(--text-secondary)]">{label}</span>
      <span
        className={clsx(
          'truncate text-right text-[12px] text-[var(--text-primary)]',
          mono && 'font-mono text-[10.5px]'
        )}
        title={value}
      >
        {value}
      </span>
    </div>
  )
}
