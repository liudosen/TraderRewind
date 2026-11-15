// ============================================================
// TraderRewind — 编辑一笔已平仓交易的「思路」和标签
//
// 日志页用：事后补写当时为什么进这一单、打上标签，方便以后按标签/时段复盘。
// 只改备注和标签，价格与盈亏是回放当场算出来的，一律不动。
//
// 另外带一份「交易截图」：图上截一张这笔单子的 K 线（开平仓线 + 交易连线），
// 图片存进这笔交易的附件里。截图是即时保存的，备注 / 标签仍然点「保存」才落库。
// ============================================================

import React, { useEffect, useMemo, useRef, useState } from 'react'
import clsx from 'clsx'
import { Camera, Eye, ImagePlus, Loader2, Plus, Trash2, X } from 'lucide-react'
import {
  useTrainingStore,
  MAX_TRADE_TAGS,
  MAX_TRADE_TAG_LEN,
  type ClosedTrade
} from '../../stores/training-store'
import { formatPrice, formatSigned } from '../../utils/format'
import { tzPartsFromSec } from '@shared/types/timezone'
import { useT } from '../../i18n'
import { TradeSnapshotDialog, type TradeShotPayload } from '../chart/TradeSnapshotDialog'

/** 一笔交易的一张截图（dataUrl 是懒加载的，列表先用元信息占位） */
interface TradeShotMeta {
  id: string
  width: number | null
  height: number | null
  byteSize: number
  createdAt: number
  dataUrl?: string
}

interface Props {
  trade: ClosedTrade
  /** 显示时区，和订单表口径一致 */
  tz: string
  /** 交易所属回测集 / 行情数据集；给了才显示「截图」 */
  sessionId?: number | null
  datasetId?: number | null
  /** 会话显示周期，截图图表的默认周期 */
  timeframe?: string | null
  onClose: () => void
  /** 返回 true 表示保存成功（对话框自己收），false 就留在原地 */
  onSave: (note: string | null, tags: string[]) => Promise<boolean>
}

export function TradeMetaDialog({
  trade,
  tz,
  sessionId,
  datasetId,
  timeframe,
  onClose,
  onSave
}: Props): React.JSX.Element {
  const { t } = useT()
  const tagLibrary = useTrainingStore((s) => s.tagLibrary)

  const [note, setNote] = useState(trade.note ?? '')
  const [tags, setTags] = useState<string[]>(trade.tags)
  const [draft, setDraft] = useState('')
  const [editingTag, setEditingTag] = useState(false)
  const [saving, setSaving] = useState(false)
  const [failed, setFailed] = useState(false)

  /** 截图：列表 + 预览 + 删除确认 + 图表弹窗 */
  const canShots = sessionId != null && datasetId != null
  const [shots, setShots] = useState<TradeShotMeta[]>([])
  const [shotsLoading, setShotsLoading] = useState(false)
  const [shotOpen, setShotOpen] = useState(false)
  const [preview, setPreview] = useState<TradeShotMeta | null>(null)
  const [deleteAsk, setDeleteAsk] = useState<string | null>(null)

  const noteRef = useRef<HTMLTextAreaElement>(null)
  const tagInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    // 打开就把光标放到思路框：90% 的情况是来写备注的
    noteRef.current?.focus()
  }, [])

  /** 拉截图列表；图片本身按 id 逐张取，列表不必等所有图都到齐 */
  useEffect(() => {
    if (!canShots) return
    let alive = true
    setShotsLoading(true)
    void (async () => {
      try {
        const metas = (await window.api.listTradeScreenshots(
          sessionId as number,
          trade.id
        )) as TradeShotMeta[]
        if (!alive) return
        setShots(metas.map((m) => ({ ...m, dataUrl: undefined })))
        for (const meta of metas) {
          let img: any = null
          try {
            img = await window.api.getTradeScreenshot(meta.id)
          } catch {
            // 单张读失败（库被换了 / 主进程报错）不该把整组截图清空
            continue
          }
          if (!alive) return
          if (img?.base64) {
            const src = `data:${img.mime};base64,${img.base64}`
            setShots((prev) => prev.map((s) => (s.id === meta.id ? { ...s, dataUrl: src } : s)))
          }
        }
      } catch {
        if (alive) setShots([])
      } finally {
        if (alive) setShotsLoading(false)
      }
    })()
    return () => {
      alive = false
    }
  }, [canShots, sessionId, trade.id])

  // 看大图时 Esc 只关大图，别把整个编辑框也关了（捕获阶段先拦下来）
  useEffect(() => {
    if (!preview) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      setPreview(null)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [preview])

  /** 图表里截好一张：立即落库，然后把它放进列表 */
  const addShot = async (shot: TradeShotPayload): Promise<boolean> => {
    if (sessionId == null) return false
    try {
      const res = await window.api.addTradeScreenshot({
        sessionId,
        tradeId: trade.id,
        dataUrl: shot.dataUrl,
        width: shot.width,
        height: shot.height
      })
      if (!res?.ok) return false
      const meta = res.shot as Omit<TradeShotMeta, 'dataUrl'>
      setShots((prev) => [...prev, { ...meta, dataUrl: shot.dataUrl }])
      setShotOpen(false)
      return true
    } catch {
      return false
    }
  }

  const removeShot = async (id: string): Promise<void> => {
    try {
      const ok = await window.api.deleteTradeScreenshot(id)
      if (ok) {
        setShots((prev) => prev.filter((s) => s.id !== id))
        setPreview((cur) => (cur?.id === id ? null : cur))
      }
    } finally {
      setDeleteAsk(null)
    }
  }

  /** 库里没有、但这笔单已经打上的标签也要显示（老数据 / 从别处导进来的） */
  const chips = useMemo(() => {
    const extra = tags.filter((x) => !tagLibrary.includes(x))
    return [...tagLibrary, ...extra]
  }, [tagLibrary, tags])

  const toggleTag = (tag: string): void => {
    setTags((prev) => {
      if (prev.includes(tag)) return prev.filter((x) => x !== tag)
      return prev.length >= MAX_TRADE_TAGS ? prev : [...prev, tag]
    })
  }

  const commitDraft = (): void => {
    const value = draft.trim()
    setDraft('')
    setEditingTag(false)
    if (!value) return
    setTags((prev) =>
      prev.includes(value) || prev.length >= MAX_TRADE_TAGS ? prev : [...prev, value]
    )
  }

  const submit = async (): Promise<void> => {
    if (saving) return
    setSaving(true)
    setFailed(false)
    const ok = await onSave(note.trim() ? note.trim() : null, tags)
    setSaving(false)
    if (ok) onClose()
    else setFailed(true)
  }

  const stamp = (ts: number): string => {
    const p = tzPartsFromSec(ts, tz)
    const n = (v: number): string => String(v).padStart(2, '0')
    return `${n(p.month)}-${n(p.day)} ${n(p.hour)}:${n(p.minute)}`
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onMouseDown={(e) => {
        // 点遮罩关闭；点面板内部不关
        if (e.target === e.currentTarget) onClose()
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') onClose()
      }}
    >
      <div className="flex max-h-[92vh] w-full max-w-[560px] flex-col overflow-hidden rounded-xl border border-[var(--border-strong)] bg-[var(--surface-1)] shadow-2xl">
        {/* 头部：这笔单的「身份证」，确认没点错行 */}
        <div className="flex shrink-0 items-start gap-2 border-b border-[var(--border-subtle)] px-3.5 py-2.5">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              <span className="text-[13.5px] font-semibold text-[var(--text-primary)]">
                {t('tradeEdit.title')}
              </span>
              <span
                className={clsx(
                  'rounded px-1 py-px text-[10px] font-medium',
                  trade.side === 'buy'
                    ? 'bg-[var(--c-neg-tint)] text-[var(--c-neg)]'
                    : 'bg-[var(--c-pos-tint)] text-[var(--c-pos)]'
                )}
              >
                {trade.side === 'buy' ? t('report.side.long') : t('report.side.short')}
              </span>
              <span className="font-mono text-[10.5px] text-[var(--text-faint)]">
                {trade.lot.toFixed(2)} {t('report.col.lots')}
              </span>
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 font-mono text-[10.5px] text-[var(--text-muted)]">
              <span>
                {stamp(trade.entryTime)} → {stamp(trade.exitTime)}
              </span>
              <span className="text-[var(--text-faint)]">·</span>
              <span>
                {formatPrice(trade.entryPrice, trade.digits)} →{' '}
                {formatPrice(trade.exitPrice, trade.digits)}
              </span>
              <span className="text-[var(--text-faint)]">·</span>
              <span className={trade.pnl >= 0 ? 'text-[var(--c-neg)]' : 'text-[var(--c-pos)]'}>
                {formatSigned(trade.pnl)}
              </span>
            </div>
          </div>
          <button
            onClick={onClose}
            className="rounded p-1 text-[var(--text-muted)] transition-colors hover:bg-[var(--surface-3)] hover:text-[var(--text-primary)]"
          >
            <X size={15} />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {/* 思路 */}
          <div className="px-3.5 pt-2.5">
            <label className="mb-1 block text-[10.5px] font-medium uppercase tracking-[0.1em] text-[var(--text-faint)]">
              {t('tradeEdit.note')}
            </label>
            <textarea
              ref={noteRef}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                  e.preventDefault()
                  void submit()
                }
              }}
              rows={4}
              placeholder={t('tradeEdit.notePlaceholder')}
              className="w-full resize-none rounded-md border border-[var(--border-subtle)] bg-[var(--surface-2)] px-2.5 py-2 text-[12px] leading-relaxed text-[var(--text-primary)] outline-none placeholder:text-[var(--text-faint)] focus:border-[var(--c-accent)]"
            />
          </div>

          {/* 标签 */}
          <div className="px-3.5 pb-2 pt-2">
            <div className="mb-1 flex items-center gap-2">
              <span className="text-[10.5px] font-medium uppercase tracking-[0.1em] text-[var(--text-faint)]">
                {t('tradeEdit.tags')}
              </span>
              <span className="text-[10px] text-[var(--text-faint)]">
                {t('tradeEdit.tagsHint', { max: MAX_TRADE_TAGS })}
              </span>
              {tags.length > 0 && (
                <span className="ml-auto font-mono text-[9.5px] text-[var(--text-faint)]">
                  {tags.length}/{MAX_TRADE_TAGS}
                </span>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              {chips.map((tag) => {
                const on = tags.includes(tag)
                const inLibrary = tagLibrary.includes(tag)
                return (
                  <button
                    key={tag}
                    onClick={() => toggleTag(tag)}
                    className={clsx(
                      'inline-flex items-center gap-1 rounded border px-1.5 py-[2px] text-[10.5px] leading-none transition-colors',
                      on
                        ? 'border-[var(--c-accent)] bg-[var(--c-accent-tint)] text-[var(--c-accent)]'
                        : 'border-dashed border-[var(--border-strong)] text-[var(--text-muted)] hover:border-[var(--c-accent)] hover:text-[var(--c-accent)]',
                      // 已经打上的非库标签用实线，提示它是这笔单自己的
                      on && !inLibrary && 'border-solid'
                    )}
                  >
                    {tag}
                    {on && <X size={9} />}
                  </button>
                )
              })}

              {editingTag ? (
                <input
                  ref={tagInputRef}
                  autoFocus
                  value={draft}
                  maxLength={MAX_TRADE_TAG_LEN}
                  onChange={(e) => setDraft(e.target.value)}
                  onBlur={commitDraft}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      e.stopPropagation()
                      commitDraft()
                    } else if (e.key === 'Escape') {
                      e.stopPropagation()
                      setDraft('')
                      setEditingTag(false)
                    }
                  }}
                  placeholder={t('settings.tags.placeholder')}
                  className="w-[84px] rounded border border-[var(--c-accent)] bg-[var(--surface-2)] px-1.5 py-[2px] text-[10.5px] leading-none text-[var(--text-primary)] outline-none placeholder:text-[var(--text-faint)]"
                />
              ) : tags.length < MAX_TRADE_TAGS ? (
                <button
                  onClick={() => setEditingTag(true)}
                  title={t('settings.tags.add', { max: MAX_TRADE_TAGS })}
                  className="inline-flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded border border-dashed border-[var(--border-strong)] text-[var(--text-faint)] transition-colors hover:border-[var(--c-accent)] hover:text-[var(--c-accent)]"
                >
                  <Plus size={11} />
                </button>
              ) : null}
            </div>
          </div>

          {/* 截图：图表截下来的 K 线，直接作为这笔交易的附件 */}
          {canShots && (
            <div className="mx-3.5 mb-1 mt-1 border-t border-[var(--border-subtle)] pb-2 pt-2.5">
              <div className="mb-1.5 flex flex-wrap items-center gap-2">
                <span className="text-[10.5px] font-medium uppercase tracking-[0.1em] text-[var(--text-faint)]">
                  {t('tradeShot.section')}
                </span>
                <span className="text-[10px] text-[var(--text-faint)]">
                  {t('tradeShot.addHint')}
                </span>
                <button
                  onClick={() => setShotOpen(true)}
                  className="ml-auto flex items-center gap-1 rounded-md border border-[var(--c-accent)] bg-[var(--c-accent-tint)] px-2 py-0.5 text-[10.5px] font-medium text-[var(--c-accent)] transition-colors hover:bg-[var(--c-accent)] hover:text-white"
                >
                  <Camera size={11} />
                  {t('tradeShot.add')}
                </button>
              </div>

              {shotsLoading ? (
                <div className="flex items-center gap-1.5 py-3 text-[11px] text-[var(--text-faint)]">
                  <Loader2 size={12} className="animate-spin" />
                  {t('tradeShot.listLoading')}
                </div>
              ) : shots.length === 0 ? (
                <button
                  onClick={() => setShotOpen(true)}
                  className="flex w-full flex-col items-center gap-1 rounded-md border border-dashed border-[var(--border-strong)] py-4 text-[11px] text-[var(--text-faint)] transition-colors hover:border-[var(--c-accent)] hover:text-[var(--c-accent)]"
                >
                  <ImagePlus size={18} />
                  <span>{t('tradeShot.empty')}</span>
                  <span className="text-[10px] opacity-80">{t('tradeShot.emptyHint')}</span>
                </button>
              ) : (
                <div className="grid grid-cols-3 gap-2">
                  {shots.map((shot) => (
                    <div
                      key={shot.id}
                      className="group relative aspect-[16/10] overflow-hidden rounded-md border border-[var(--border-subtle)] bg-black"
                    >
                      {shot.dataUrl ? (
                        <img
                          src={shot.dataUrl}
                          alt=""
                          className="h-full w-full cursor-zoom-in object-contain"
                          onClick={() => setPreview(shot)}
                        />
                      ) : (
                        <div className="flex h-full items-center justify-center text-[var(--text-faint)]">
                          <Loader2 size={12} className="animate-spin" />
                        </div>
                      )}
                      <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/70 via-transparent to-transparent opacity-0 transition-opacity group-hover:opacity-100" />
                      {shot.width && shot.height && (
                        <span className="pointer-events-none absolute left-1 top-1 rounded bg-black/60 px-1 py-px font-mono text-[9px] text-white/70">
                          {shot.width}×{shot.height}
                        </span>
                      )}
                      <div className="absolute right-1 top-1 flex gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                        <button
                          onClick={() => setPreview(shot)}
                          title={t('tradeShot.view')}
                          className="rounded bg-black/65 p-1 text-white/85 transition-colors hover:text-white"
                        >
                          <Eye size={11} />
                        </button>
                        <button
                          onClick={() => setDeleteAsk(shot.id)}
                          title={t('tradeShot.delete')}
                          className="rounded bg-black/65 p-1 text-white/85 transition-colors hover:text-[var(--c-neg)]"
                        >
                          <Trash2 size={11} />
                        </button>
                      </div>
                      {deleteAsk === shot.id && (
                        <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 bg-black/80 px-1 text-center">
                          <span className="text-[10px] leading-tight text-white/90">
                            {t('tradeShot.deleteConfirm')}
                          </span>
                          <div className="flex gap-1">
                            <button
                              onClick={() => void removeShot(shot.id)}
                              className="rounded bg-[var(--c-neg)] px-1.5 py-0.5 text-[9.5px] text-white"
                            >
                              {t('tradeShot.delete')}
                            </button>
                            <button
                              onClick={() => setDeleteAsk(null)}
                              className="rounded border border-white/25 px-1.5 py-0.5 text-[9.5px] text-white/75"
                            >
                              {t('tradeEdit.cancel')}
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        {/* 底部 */}
        <div className="flex shrink-0 items-center gap-2 border-t border-[var(--border-subtle)] px-3.5 py-2.5">
          <span className="text-[10px] text-[var(--text-faint)]">{t('tradeEdit.hint')}</span>
          {failed && (
            <span className="text-[10.5px] text-[var(--c-pos)]">{t('tradeEdit.failed')}</span>
          )}
          <button
            onClick={onClose}
            className="ml-auto rounded-md border border-[var(--border-subtle)] px-2.5 py-1 text-[12px] text-[var(--text-secondary)] transition-colors hover:border-[var(--border-strong)] hover:text-[var(--text-primary)]"
          >
            {t('tradeEdit.cancel')}
          </button>
          <button
            onClick={() => void submit()}
            disabled={saving}
            className="flex items-center gap-1.5 rounded-md border border-[var(--c-accent)] bg-[var(--c-accent-tint)] px-3 py-1 text-[12px] font-medium text-[var(--c-accent)] transition-colors hover:bg-[var(--c-accent)] hover:text-white disabled:opacity-60"
          >
            {saving && <Loader2 size={11} className="animate-spin" />}
            {saving ? t('tradeEdit.saving') : t('tradeEdit.save')}
          </button>
        </div>
      </div>

      {/* 图表截图 */}
      {shotOpen && canShots && (
        <TradeSnapshotDialog
          trade={trade}
          datasetId={datasetId as number}
          timeframe={timeframe ?? null}
          tz={tz}
          onClose={() => setShotOpen(false)}
          onCapture={addShot}
        />
      )}

      {/* 大图预览 */}
      {preview?.dataUrl && (
        <div
          className="fixed inset-0 z-[70] flex items-center justify-center bg-black/85 p-6"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setPreview(null)
          }}
        >
          <img
            src={preview.dataUrl}
            alt=""
            className="max-h-full max-w-full rounded-lg border border-white/10 shadow-2xl"
          />
          <button
            onClick={() => setPreview(null)}
            className="absolute right-5 top-5 rounded-full bg-black/60 p-2 text-white/80 transition-colors hover:text-white"
          >
            <X size={18} />
          </button>
        </div>
      )}
    </div>
  )
}
