import React, { useEffect, useState } from 'react'
import { useAppStore } from '../../stores/app-store'
import { formatSpentTime } from '../../utils/format'
import { useT } from '../../i18n'
import { Database, PlayCircle, BookOpen, Layers, Clock, Crosshair } from 'lucide-react'

export function HubPane(): React.JSX.Element {
  const setActivePane = useAppStore((s) => s.setActivePane)
  const { t, locale } = useT()

  const [datasetCount, setDatasetCount] = useState(0)
  const [sessionCount, setSessionCount] = useState(0)
  const [trainSeconds, setTrainSeconds] = useState(0)
  const [tradeCount, setTradeCount] = useState(0)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const [datasets, sessions, stats] = await Promise.all([
          window.api.listDownloadedDatasets(),
          window.api.listSessions(),
          window.api.getTrainingStats()
        ])
        if (cancelled) return
        setDatasetCount((datasets ?? []).length)
        setSessionCount((sessions ?? []).length)
        setTrainSeconds(Number((stats as any)?.trainSeconds ?? 0))
        setTradeCount(Number((stats as any)?.trades ?? 0))
      } catch {
        // 忽略
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <div className="h-full overflow-y-auto p-6">
      {/* 欢迎区 */}
      <div className="mb-8">
        <h1 className="text-[22px] font-semibold text-[var(--text-primary)] tracking-tight">
          {t('hub.title')}
        </h1>
        <p className="text-[12px] text-[var(--text-muted)] mt-1">{t('hub.subtitle')}</p>
      </div>

      {/* 快速入口 */}
      <div className="grid grid-cols-3 gap-4 mb-8">
        <QuickCard
          icon={<Database size={20} />}
          title={t('hub.quick.download')}
          desc={t('hub.quick.downloadDesc')}
          onClick={() => setActivePane('data')}
        />
        <QuickCard
          icon={<PlayCircle size={20} />}
          title={t('hub.quick.training')}
          desc={t('hub.quick.trainingDesc')}
          onClick={() => setActivePane('training')}
        />
        <QuickCard
          icon={<BookOpen size={20} />}
          title={t('hub.quick.journal')}
          desc={t('hub.quick.journalDesc')}
          onClick={() => setActivePane('journal')}
        />
      </div>

      {/* 我的统计 */}
      <div className="mb-3 flex items-baseline gap-2">
        <h2 className="text-[13px] font-medium text-[var(--text-primary)]">{t('hub.stats.title')}</h2>
        <span className="text-[11px] text-[var(--text-muted)]">{t('hub.stats.cumulative')}</span>
      </div>
      <div className="grid grid-cols-2 xl:grid-cols-4 gap-3">
        <StatCard
          label={t('hub.stats.totalTime')}
          // 汇总卡上「0 分钟」比「--」更容易理解：这确实就是他目前的累计
          value={trainSeconds > 0 ? formatSpentTime(trainSeconds, locale) : t('hub.stats.zeroTime')}
          icon={<Clock size={16} />}
          accent
        />
        <StatCard
          label={t('hub.stats.trades')}
          value={String(tradeCount)}
          unit={t('hub.unit.trades')}
          icon={<Crosshair size={16} />}
          accent
        />
        <StatCard
          label={t('hub.stats.sessions')}
          value={String(sessionCount)}
          unit={t('hub.unit.sessions')}
          icon={<PlayCircle size={16} />}
        />
        <StatCard
          label={t('hub.stats.datasets')}
          value={String(datasetCount)}
          unit={t('hub.unit.datasets')}
          icon={<Layers size={16} />}
        />
      </div>
      <p className="mt-3 text-[11px] text-[var(--text-muted)] leading-relaxed max-w-[640px]">
        {t('hub.timeHint')}
      </p>

      {/* 空状态提示 */}
      {datasetCount === 0 && (
        <div className="mt-8 text-center py-12 border border-dashed border-[var(--border-subtle)] rounded-xl">
          <p className="text-[13px] text-[var(--text-muted)]">{t('hub.empty')}</p>
        </div>
      )}
    </div>
  )
}

function QuickCard({
  icon,
  title,
  desc,
  onClick
}: {
  icon: React.ReactNode
  title: string
  desc: string
  onClick: () => void
}): React.JSX.Element {
  return (
    <button
      onClick={onClick}
      className="flex flex-col items-start gap-2 p-4 rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-1)] hover:border-[var(--border-strong)] transition-colors text-left"
    >
      <div className="w-9 h-9 rounded-lg bg-[var(--c-accent-tint)] flex items-center justify-center text-[var(--c-accent)]">
        {icon}
      </div>
      <div>
        <div className="text-[13px] font-medium text-[var(--text-primary)]">{title}</div>
        <div className="text-[11px] text-[var(--text-muted)] mt-0.5">{desc}</div>
      </div>
    </button>
  )
}

function StatCard({
  label,
  value,
  unit,
  icon,
  accent = false
}: {
  label: string
  value: string
  unit?: string
  icon: React.ReactNode
  /** 用户自己的训练数据，给一点强调色，跟「资源数量」区分开 */
  accent?: boolean
}): React.JSX.Element {
  return (
    <div className="flex items-center gap-3 p-4 rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-1)]">
      <div
        className={
          accent
            ? 'w-8 h-8 rounded-lg bg-[var(--c-accent-tint)] flex items-center justify-center text-[var(--c-accent)]'
            : 'w-8 h-8 rounded-lg bg-[var(--surface-3)] flex items-center justify-center text-[var(--text-muted)]'
        }
      >
        {icon}
      </div>
      <div className="min-w-0">
        <div className="text-[18px] font-semibold text-[var(--text-primary)] leading-tight truncate">
          {value}
          {unit && <span className="text-[12px] font-normal text-[var(--text-muted)] ml-1">{unit}</span>}
        </div>
        <div className="text-[10px] text-[var(--text-muted)] uppercase tracking-wider">{label}</div>
      </div>
    </div>
  )
}
