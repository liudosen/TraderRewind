import React from 'react'
import {
  LayoutDashboard,
  Database,
  PlayCircle,
  BookOpen,
  Settings,
  ChevronLeft,
  ChevronRight
} from 'lucide-react'
import { useAppStore, type PaneId } from '../../stores/app-store'
import { useT } from '../../i18n'
import type { MessageKey } from '../../i18n/messages'
import clsx from 'clsx'

const NAV_ITEMS: { id: PaneId; labelKey: MessageKey; icon: React.ReactNode }[] = [
  { id: 'hub', labelKey: 'nav.hub', icon: <LayoutDashboard size={18} /> },
  { id: 'data', labelKey: 'nav.data', icon: <Database size={18} /> },
  { id: 'training', labelKey: 'nav.training', icon: <PlayCircle size={18} /> },
  { id: 'journal', labelKey: 'nav.journal', icon: <BookOpen size={18} /> },
  { id: 'settings', labelKey: 'nav.settings', icon: <Settings size={18} /> }
]

export function Sidebar(): React.JSX.Element {
  const { activePane, setActivePane, sidebarCollapsed, toggleSidebar } = useAppStore()
  const { t } = useT()

  return (
    <aside
      className={clsx(
        'flex flex-col border-r border-[var(--border-subtle)] bg-[var(--surface-1)] transition-all duration-200',
        sidebarCollapsed ? 'w-[52px]' : 'w-[180px]'
      )}
    >
      {/* 品牌区已经挪到顶部 TitleBar，这里直接从导航开始 */}
      <nav className="flex-1 py-2 overflow-y-auto">
        {NAV_ITEMS.map((item) => (
          <button
            key={item.id}
            onClick={() => setActivePane(item.id)}
            className={clsx(
              'w-full flex items-center gap-2.5 px-3 py-2 text-[12px] transition-colors',
              activePane === item.id
                ? 'text-[var(--c-accent)] bg-[var(--c-accent-tint)]'
                : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-2)]'
            )}
          >
            <span className="shrink-0">{item.icon}</span>
            {!sidebarCollapsed && <span className="truncate">{t(item.labelKey)}</span>}
          </button>
        ))}
      </nav>

      {/* Collapse toggle */}
      <button
        onClick={toggleSidebar}
        title={sidebarCollapsed ? t('nav.expand') : t('nav.collapse')}
        className="flex items-center justify-center py-2.5 text-[var(--text-muted)] hover:text-[var(--text-primary)] border-t border-[var(--border-subtle)]"
      >
        {sidebarCollapsed ? <ChevronRight size={14} /> : <ChevronLeft size={14} />}
      </button>
    </aside>
  )
}
