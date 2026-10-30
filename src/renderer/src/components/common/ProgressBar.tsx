import React from 'react'
import clsx from 'clsx'

interface ProgressBarProps {
  /** 0-100 */
  percent: number
  /** 高度类，默认 h-1.5 */
  className?: string
  /** 条纹动画（下载中） */
  animated?: boolean
  tone?: 'accent' | 'positive' | 'negative' | 'muted'
}

const TONE_CLASS: Record<string, string> = {
  accent: 'bg-[var(--c-accent)]',
  positive: 'bg-[var(--c-pos)]',
  negative: 'bg-[var(--c-neg)]',
  muted: 'bg-neutral-600'
}

export function ProgressBar({
  percent,
  className,
  animated = false,
  tone = 'accent'
}: ProgressBarProps): React.JSX.Element {
  const clamped = Math.max(0, Math.min(100, Number.isFinite(percent) ? percent : 0))
  return (
    <div
      className={clsx(
        'w-full overflow-hidden rounded-full bg-[var(--surface-4)]',
        className ?? 'h-1.5'
      )}
      role="progressbar"
      aria-valuenow={Math.round(clamped)}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <div
        className={clsx(
          'h-full rounded-full transition-[width] duration-200 ease-out',
          TONE_CLASS[tone],
          animated && 'progress-stripes'
        )}
        style={{ width: `${clamped}%` }}
      />
    </div>
  )
}
