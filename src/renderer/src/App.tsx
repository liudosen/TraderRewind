import React, { useEffect } from 'react'
import { useAppStore } from './stores/app-store'
import { useChartThemeStore } from './stores/chart-theme-store'
import { useTimezoneStore } from './stores/timezone-store'
import { useLocaleStore } from './i18n'
import { useTrainingStore } from './stores/training-store'
import { Sidebar } from './components/common/Sidebar'
import { TitleBar } from './components/common/TitleBar'
import { HubPane } from './components/panels/HubPane'
import { DataSourcePanel } from './components/panels/DataSourcePanel'
import { TrainingPane } from './components/panels/TrainingPane'
import { JournalPane } from './components/panels/JournalPane'
import { SettingsPanel } from './components/panels/SettingsPanel'

export default function App(): React.JSX.Element {
  const activePane = useAppStore((s) => s.activePane)

  useEffect(() => {
    void useChartThemeStore.getState().load()
    void useTimezoneStore.getState().load()
    // 界面语言：先读回来，避免英文用户先闪一下中文
    void useLocaleStore.getState().load()
    // 指标是用户级配置：默认全关，用户改过就跨回测集通用
    void useTrainingStore.getState().loadIndicatorPrefs()
    // 标签库：下单浮窗里一键点亮的常用标签
    void useTrainingStore.getState().loadTagLibrary()
    // 交易成本模型（手续费 + 滑点）：下单/平仓时按它算成交价和佣金
    void useTrainingStore.getState().loadExecutionCost()
  }, [])

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-[#0b0b0b] text-neutral-200">
      <TitleBar />
      <div className="flex min-h-0 flex-1">
        <Sidebar />
        <main className="min-w-0 flex-1 overflow-hidden">
          {activePane === 'hub' && <HubPane />}
          {activePane === 'data' && <DataSourcePanel />}
          {activePane === 'training' && <TrainingPane />}
          {activePane === 'journal' && <JournalPane />}
          {activePane === 'settings' && <SettingsPanel />}
        </main>
      </div>
    </div>
  )
}
