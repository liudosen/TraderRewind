import React, { useEffect, useRef, useState } from 'react'
import clsx from 'clsx'
import { SlidersHorizontal, X } from 'lucide-react'
import {
  EXECUTION_COST_PRESETS,
  commissionPerSide,
  fmtExecutionCost,
  hasExecutionCost,
  pointOfDigits,
  slippagePrice,
  type CommissionMode,
  type ExecutionCost
} from '@shared/types/execution-cost'
import { formatPrice, formatSigned } from '../../utils/format'
import { useT, translateLabel } from '../../i18n'

/**
 * 下单条上的「交易成本」卡片：显示当前的手续费 / 滑点，点开可以改。
 *
 * 为什么做成下单条上的一张卡而不是塞进设置页：
 * 回测时最常做的对比就是「这笔单子在真实成本下还赚不赚」，
 * 放在下单按钮旁边才能随时开关、随时看估算。
 */
interface Props {
  cost: ExecutionCost
  onChange: (cost: ExecutionCost) => void
  /** 当前品种报价精度（把「点」换算成价格） */
  digits: number
  /** 每手合约量（算名义价值 / 滑点金额） */
  contractSize: number
  /** 当前价（算估算成本用） */
  price: number | null
  /** 当前手数 */
  lot: number
  /**
   * 报价货币 → 账户货币（美元）的汇率。
   * 滑点金额、百分比佣金都是「报价货币金额」，USDJPY / 交叉盘必须折成美元才是真钱。
   */
  quoteRate?: number
}

export function ExecutionCostCard({
  cost,
  onChange,
  digits,
  contractSize,
  price,
  lot,
  quoteRate = 1
}: Props): React.JSX.Element {
  const { t, locale } = useT()
  const [open, setOpen] = useState(false)
  const boxRef = useRef<HTMLDivElement>(null)
  const on = hasExecutionCost(cost)

  // 点外部 / Esc 收起
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const point = pointOfDigits(digits)
  /** 1 个「点」换算成价格后的小数位数：黄金 3 位就是 0.001 */
  const slipPrice = slippagePrice(cost, digits)
  const commissionSide = commissionPerSide(cost, lot, contractSize, price ?? 0, quoteRate)
  // 滑点 × 手数 × 合约量是报价货币金额，再乘汇率才是美元
  const slipMoney = slipPrice * lot * contractSize * quoteRate
  const roundTrip = commissionSide * 2 + slipMoney * 2

  const patch = (p: Partial<ExecutionCost>): void => onChange({ ...cost, ...p })

  return (
    <div ref={boxRef} className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title={t('cost.hint')}
        className={clsx(
          'flex h-full items-center gap-2.5 rounded-md border px-2.5 py-1.5 text-left transition-colors',
          open
            ? 'border-[var(--c-accent)] bg-[var(--surface-3)]'
            : 'border-[var(--border-subtle)] bg-[var(--surface-2)] hover:border-[var(--border-strong)]'
        )}
      >
        <SlidersHorizontal
          size={12}
          className={on ? 'text-[var(--c-accent)]' : 'text-[var(--text-faint)]'}
        />
        {on ? (
          <>
            <div className="flex flex-col">
              <span className="font-mono text-[11.5px] leading-tight tabular-nums text-[var(--text-primary)]">
                {cost.commissionMode === 'percent'
                  ? `${cost.commissionRate}%`
                  : `$${cost.commissionRate}`}
              </span>
              <span className="text-[9.5px] leading-tight text-[var(--text-faint)]">
                {cost.commissionMode === 'percent'
                  ? t('cost.commission')
                  : t('cost.commissionPerLot')}
              </span>
            </div>
            <div className="flex flex-col">
              <span
                className={clsx(
                  'font-mono text-[11.5px] leading-tight tabular-nums',
                  cost.slippagePoints > 0 ? 'text-[var(--text-primary)]' : 'text-[var(--text-faint)]'
                )}
              >
                {cost.slippagePoints > 0 ? cost.slippagePoints : '--'}
              </span>
              <span className="text-[9.5px] leading-tight text-[var(--text-faint)]">
                {t('cost.slippage')}
              </span>
            </div>
          </>
        ) : (
          <div className="flex flex-col">
            <span className="text-[11px] leading-tight text-[var(--text-faint)]">
              {t('cost.disabled')}
            </span>
            <span className="text-[9.5px] leading-tight text-[var(--text-faint)]">
              {t('cost.badge')}
            </span>
          </div>
        )}
      </button>

      {open && (
        /**
         * z 必须高过 lightweight-charts 的副图分隔条（那是一根横跨整个图表、
         * `z-index: 50` 的 9px 透明拖拽条）：否则它不仅会画在面板上面，
         * 还会把区域内的点击全部吞掉 —— 面板里的按钮就点不动了。
         */
        <div className="absolute bottom-full right-0 z-[60] mb-2 w-[302px] rounded-lg border border-[var(--border-strong)] bg-[var(--surface-1)] p-2.5 text-left shadow-2xl">
          <div className="mb-2 flex items-center gap-1.5">
            <SlidersHorizontal size={11} className="text-[var(--c-accent)]" />
            <span className="text-[11.5px] font-medium text-[var(--text-primary)]">
              {t('cost.title')}
            </span>
            <span className="text-[9.5px] text-[var(--text-faint)]">{t('cost.scope')}</span>
            <button
              type="button"
              onClick={() => setOpen(false)}
              title={t('cost.collapse')}
              className="ml-auto rounded p-[1px] text-[var(--text-faint)] hover:text-[var(--text-primary)]"
            >
              <X size={11} />
            </button>
          </div>

          {/* 手续费 */}
          <div className="mb-1.5 rounded-md border border-[var(--border-subtle)] p-1.5">
            <div className="mb-1 flex items-center gap-1.5">
              <span className="text-[10.5px] text-[var(--text-secondary)]">
                {t('cost.commissionLabel')}
              </span>
              <div className="ml-auto flex overflow-hidden rounded border border-[var(--border-subtle)]">
                {(
                  [
                    { key: 'perLot', label: t('cost.perLot') },
                    { key: 'percent', label: t('cost.percentOfNotional') }
                  ] as { key: CommissionMode; label: string }[]
                ).map((m) => (
                  <button
                    key={m.key}
                    type="button"
                    onClick={() => patch({ commissionMode: m.key })}
                    className={clsx(
                      'px-1.5 py-[2px] text-[9.5px] transition-colors',
                      cost.commissionMode === m.key
                        ? 'bg-[var(--c-accent-tint)] text-[var(--c-accent)]'
                        : 'text-[var(--text-faint)] hover:text-[var(--text-secondary)]'
                    )}
                  >
                    {m.label}
                  </button>
                ))}
              </div>
            </div>
            <div className="flex items-center gap-1.5">
              <input
                type="number"
                min={0}
                step={cost.commissionMode === 'percent' ? 0.005 : 0.5}
                value={cost.commissionRate}
                onChange={(e) => patch({ commissionRate: Number(e.target.value) })}
                className="h-6 w-full min-w-0 rounded border border-[var(--border-subtle)] bg-[var(--surface-0)] px-1.5 font-mono text-[11px] text-[var(--text-primary)] outline-none focus:border-[var(--c-accent)]"
              />
              <span className="shrink-0 text-[9.5px] text-[var(--text-faint)]">
                {cost.commissionMode === 'percent'
                  ? t('cost.perSidePercent')
                  : t('cost.perLotPerSide')}
              </span>
            </div>
            <p className="mt-1 text-[9px] leading-relaxed text-[var(--text-faint)]">
              {t('cost.perSideNote')}
            </p>
          </div>

          {/* 滑点 */}
          <div className="mb-1.5 rounded-md border border-[var(--border-subtle)] p-1.5">
            <div className="mb-1 flex items-center gap-1.5">
              <span className="text-[10.5px] text-[var(--text-secondary)]">
                {t('cost.slippage')}
              </span>
              <span className="ml-auto text-[9px] text-[var(--text-faint)]">
                {t('cost.slippagePointEq', { v: point.toFixed(digits) })}
              </span>
            </div>
            <div className="flex items-center gap-1.5">
              <input
                type="number"
                min={0}
                step={5}
                value={cost.slippagePoints}
                onChange={(e) => patch({ slippagePoints: Number(e.target.value) })}
                className="h-6 w-full min-w-0 rounded border border-[var(--border-subtle)] bg-[var(--surface-0)] px-1.5 font-mono text-[11px] text-[var(--text-primary)] outline-none focus:border-[var(--c-accent)]"
              />
              <span className="shrink-0 text-[9.5px] text-[var(--text-faint)]">
                {t('cost.points')}
              </span>
            </div>
            <div className="mt-1 flex items-center gap-1">
              {[0, 10, 20, 50, 100].map((v) => (
                <button
                  key={v}
                  type="button"
                  onClick={() => patch({ slippagePoints: v })}
                  className={clsx(
                    'rounded border px-1 py-[1px] text-[9px] tabular-nums transition-colors',
                    cost.slippagePoints === v
                      ? 'border-[var(--c-accent)] bg-[var(--c-accent-tint)] text-[var(--c-accent)]'
                      : 'border-[var(--border-subtle)] text-[var(--text-faint)] hover:text-[var(--text-secondary)]'
                  )}
                >
                  {v}
                </button>
              ))}
              <span className="ml-auto text-[9px] text-[var(--text-faint)]">
                = {formatPrice(slipPrice, digits)}
              </span>
            </div>
            <p className="mt-1 text-[9px] leading-relaxed text-[var(--text-faint)]">
              {t('cost.slippageNote')}
            </p>
          </div>

          {/* 预设 */}
          <div className="mb-1.5 flex flex-wrap items-center gap-1">
            <span className="text-[9.5px] text-[var(--text-muted)]">{t('cost.presets')}</span>
            {EXECUTION_COST_PRESETS.map((p) => {
              const active =
                p.cost.commissionMode === cost.commissionMode &&
                p.cost.commissionRate === cost.commissionRate &&
                p.cost.slippagePoints === cost.slippagePoints
              return (
                <button
                  key={p.key}
                  type="button"
                  title={translateLabel(locale, p.desc)}
                  onClick={() => onChange({ ...p.cost })}
                  className={clsx(
                    'rounded border px-1.5 py-[1px] text-[9.5px] transition-colors',
                    active
                      ? 'border-[var(--c-accent)] bg-[var(--c-accent-tint)] text-[var(--c-accent)]'
                      : 'border-[var(--border-subtle)] text-[var(--text-secondary)] hover:border-[var(--border-strong)]'
                  )}
                >
                  {translateLabel(locale, p.label)}
                </button>
              )
            })}
          </div>

          {/* 实时估算 */}
          <div className="rounded-md border border-[var(--border-subtle)] bg-[var(--surface-0)] px-1.5 py-1">
            <div className="mb-0.5 text-[9px] text-[var(--text-faint)]">
              {t('cost.estimateAt', {
                lot: lot.toFixed(2),
                price: price != null ? ` · ${formatPrice(price, digits)}` : ''
              })}
            </div>
            <div className="flex items-baseline justify-between gap-2 font-mono text-[10px] tabular-nums text-[var(--text-secondary)]">
              <span>
                {t('cost.commissionPerSide', { v: formatSigned(-commissionSide) })}
                <span className="text-[var(--text-faint)]">
                  {t('cost.roundTripOf', { v: formatSigned(-commissionSide * 2) })}
                </span>
              </span>
            </div>
            <div className="mt-0.5 flex items-baseline justify-between gap-2 font-mono text-[10px] tabular-nums text-[var(--text-secondary)]">
              <span>
                {t('cost.slippagePerSide', { v: formatSigned(-slipMoney) })}
                <span className="text-[var(--text-faint)]">
                  {t('cost.roundTripOf', { v: formatSigned(-slipMoney * 2) })}
                </span>
              </span>
            </div>
            <div className="mt-1 flex items-baseline justify-between border-t border-[var(--border-subtle)] pt-1 text-[10px]">
              <span className="text-[var(--text-faint)]">{t('cost.roundTrip')}</span>
              <span className="font-mono font-semibold tabular-nums text-[var(--text-primary)]">
                {formatSigned(-roundTrip)}
              </span>
            </div>
          </div>

          {!on && (
            <p className="mt-1.5 text-[9px] leading-relaxed text-[var(--text-faint)]">
              {t('cost.noCost')}
            </p>
          )}
          <p className="mt-1 text-[9px] leading-relaxed text-[var(--text-faint)]">
            {t('cost.footer', { summary: fmtExecutionCost(cost, locale) })}
          </p>
        </div>
      )}
    </div>
  )
}
