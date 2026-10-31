// ============================================================
// TraderRewind — 编辑一笔已平仓交易的「思路」和标签
//
// 日志页用：事后补写当时为什么进这一单、打上标签，方便以后按标签/时段复盘。
// 只改备注和标签，价格与盈亏是回放当场算出来的，一律不动。
// ============================================================

import React, { useEffect, useMemo, useRef, useState } from 'react'
import clsx from 'clsx'
import { X, Plus, Loader2 } from 'lucide-react'
import { useTrainingStore, MAX_TRADE_TAGS, MAX_TRADE_TAG_LEN, type ClosedTrade } from '../../stores/training-store'
import { formatPrice, formatSigned } from '../../utils/format'
import { tzPartsFromSec } from '@shared/types/timezone'
import { useT } from '../../i18n'

interface Props {
  trade: ClosedTrade
  /** 显示时区，和订单表口径一致 */
  tz: string
  onClose: () => void
  /** 返回 true 表示保存成功（对话框自己收），false 就留在原地 */
  onSave: (note: string | null, tags: string[]) => Promise<boolean>
}

export function TradeMetaDialog({ trade, tz, onClose, onSave }: Props): React.JSX.Element {
  const { t } = useT()
  const tagLibrary = useTrainingStore((s) => s.tagLibrary)

  const [note, setNote] = useState(trade.note ?? '')
  const [tags, setTags] = useState<string[]>(trade.tags)
  const [draft, setDraft] = useState('')
  const [editingTag, setEditingTag] = useState(false)
  const [saving, setSaving] = useState(false)
  const [failed, setFailed] = useState(false)

  const noteRef = useRef<HTMLTextAreaElement>(null)
  const tagInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    // 打开就把光标放到思路框：90% 的情况是来写备注的
    noteRef.current?.focus()
  }, [])

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
      <div className="flex w-full max-w-[520px] flex-col overflow-hidden rounded-xl border border-[var(--border-strong)] bg-[var(--surface-1)] shadow-2xl">
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
            rows={5}
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
    </div>
  )
}
