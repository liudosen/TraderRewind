// K 线图（ReplayChart）与画线工具的文案。
export const zh = {
  // ── 右键「调整仓位」面板 ───────────────────────────
  'chart.adjustPosition': '调整仓位',
  'chart.sideBuy': '多',
  'chart.sideSell': '空',
  'chart.sideLotUnit': '{side} {lot} 手',
  'chart.lotAtMinimum': '这笔仓位已经是最小手数（{lot}），没有可减的余地。',
  'chart.reduceOneStep': '再减 0.01 手',
  'chart.increaseOneStep': '再加回 0.01 手（不会超过原仓）',
  'chart.lotShort': '手',
  'chart.closeQuarter': '平 1/4',
  'chart.closeHalf': '平 1/2',
  'chart.closeThreeQuarters': '平 3/4',
  'chart.closeLots': '平掉 {lot} 手',
  'chart.keepLots': '剩余 {lot} 手继续持有（止损止盈不变）',
  'chart.cancel': '取消',
  'chart.confirmReduce': '确认减仓',

  // ── 图上价格线的轴标签 ─────────────────────────────
  'chart.sideLotTag': '{side}{lot}',
  'chart.pendingBoth': '拖设 SL / TP（{profitSide}=止盈、{lossSide}=止损）',
  'chart.pendingSl': '拖设 SL（只能{lossSide}）',
  'chart.pendingTp': '拖设 TP（只能{profitSide}）',
  'chart.sideUp': '向上',
  'chart.sideDown': '向下',
  'chart.entryLineTitle': '开',
  'chart.exitLineTitle': '关',

  // ── 待确认下单票面 ────────────────────────────────
  'chart.pendingConfirm': '确认',
  'chart.pendingConfirmHint': '确认这笔订单（接着填备注和标签）；也可以直接再按一次 {key}',
  'chart.pendingCancelHint': '不下这笔',
  'chart.pendingLot': '{side} {lot} 手',
  'chart.pendingLotHint': '手数可调：↑ / ↓ 每次 0.01 手，按住 Shift 每次 0.10 手；金额会跟着重算',
  'chart.pendingNoSl': '未设止损',

  // ── 坐标轴刻度 ─────────────────────────────────────
  'chart.axisMonth': '{m}月',
  'chart.axisDay': '{d}日',

  // ── 画线右键菜单 / 文本输入 ────────────────────────
  'chart.textPlaceholder': '输入文字，回车确认',
  'chart.menuFallback': '画线',
  'chart.changeColor': '修改颜色',
  'chart.deleteDrawing': '删除画线',
  'chart.drawingTrend': '趋势线',
  'chart.drawingRay': '射线',
  'chart.drawingExtline': '延长线',
  'chart.drawingHline': '水平线',
  'chart.drawingVline': '垂直线',
  'chart.drawingPolyline': '折线',
  'chart.drawingFib': '斐波那契回撤',
  'chart.drawingRect': '矩形',
  'chart.drawingEllipse': '椭圆',
  'chart.drawingArrow': '箭头',
  'chart.drawingText': '文本',

  // ── 左上角拖动提示条 ───────────────────────────────
  'chart.hintDragToSet': '拖动开仓线设置',
  'chart.stopLoss': '止损',
  'chart.takeProfit': '止盈',
  'chart.hintBothNote': '（{profitSide}=止盈、{lossSide}=止损，拖过开仓价可互换）',
  'chart.hintAlready': '已有',
  'chart.hintDragOnly': '：拖动开仓线只能',
  'chart.hintSetSl': '{side}设止损',
  'chart.hintSetTp': '{side}设止盈',
  'chart.hintDrag': '拖动',
  'chart.hintAdjustNote': '线可上下调整 · 止损拖过成本价 = 移动止盈',
  'chart.hintMulti': '· 共 {n} 笔，拖哪条线就选中哪笔',
  'chart.hintReduce': '· 右键开仓线可减仓',
  /** 止损被拖到成本价的盈利侧时，线标签后面缀的字 */
  'chart.trailingStop': '移动止盈',

  /** 双周期：下方那个独立的小 K 线窗 */
  'chart.secondaryPane': '副周期',
  'chart.secondaryTfHint': '切换这个窗口显示的周期',
  'chart.secondaryClose': '关闭副周期窗口',
  'chart.secondaryEmpty': '这一段还没有足够的 K 线可聚合'
}

export const en: Record<keyof typeof zh, string> = {
  'chart.adjustPosition': 'Adjust position',
  'chart.sideBuy': 'Long',
  'chart.sideSell': 'Short',
  'chart.sideLotUnit': '{side} {lot} lots',
  'chart.lotAtMinimum':
    'This position is already at the minimum lot size ({lot}) — there is nothing left to reduce.',
  'chart.reduceOneStep': 'Reduce by 0.01 lot',
  'chart.increaseOneStep': 'Add 0.01 lot back (never above the original position)',
  'chart.lotShort': 'lots',
  'chart.closeQuarter': 'Close 1/4',
  'chart.closeHalf': 'Close 1/2',
  'chart.closeThreeQuarters': 'Close 3/4',
  'chart.closeLots': 'Close {lot} lots',
  'chart.keepLots': 'Keep {lot} lots open (stop-loss and take-profit unchanged)',
  'chart.cancel': 'Cancel',
  'chart.confirmReduce': 'Reduce',

  'chart.sideLotTag': '{side} {lot}',
  'chart.pendingBoth': 'Drag for SL / TP ({profitSide} = TP, {lossSide} = SL)',
  'chart.pendingSl': 'Drag SL ({lossSide} only)',
  'chart.pendingTp': 'Drag TP ({profitSide} only)',
  'chart.sideUp': 'up',
  'chart.sideDown': 'down',
  'chart.entryLineTitle': 'Entry',
  'chart.exitLineTitle': 'Exit',

  'chart.pendingConfirm': 'Confirm',
  'chart.pendingConfirmHint': 'Confirm this order (note and tags come next); or just press {key} again',
  'chart.pendingCancelHint': 'Skip this order',
  'chart.pendingLot': '{side} {lot} lots',
  'chart.pendingLotHint': 'Adjustable: ↑ / ↓ steps 0.01 lot, hold Shift for 0.10; the amount recalculates',
  'chart.pendingNoSl': 'No SL',

  'chart.axisMonth': '{m}',
  'chart.axisDay': '{d}',

  'chart.textPlaceholder': 'Type text, press Enter',
  'chart.menuFallback': 'Drawing',
  'chart.changeColor': 'Change colour',
  'chart.deleteDrawing': 'Delete drawing',
  'chart.drawingTrend': 'Trend line',
  'chart.drawingRay': 'Ray',
  'chart.drawingExtline': 'Extended line',
  'chart.drawingHline': 'Horizontal line',
  'chart.drawingVline': 'Vertical line',
  'chart.drawingPolyline': 'Polyline',
  'chart.drawingFib': 'Fib retracement',
  'chart.drawingRect': 'Rectangle',
  'chart.drawingEllipse': 'Ellipse',
  'chart.drawingArrow': 'Arrow',
  'chart.drawingText': 'Text',

  'chart.hintDragToSet': 'Drag the entry line to set',
  'chart.stopLoss': 'stop-loss',
  'chart.takeProfit': 'take-profit',
  'chart.hintBothNote':
    ' ({profitSide} = take-profit, {lossSide} = stop-loss; drag past entry to swap)',
  'chart.hintAlready': 'Already set:',
  'chart.hintDragOnly': ' — the entry line can only drag',
  'chart.hintSetSl': '{side} to set stop-loss',
  'chart.hintSetTp': '{side} to set take-profit',
  'chart.hintDrag': 'Drag',
  'chart.hintAdjustNote': ' lines up or down · stop past entry = trailing stop',
  'chart.hintMulti': '· {n} positions — drag a line to select it',
  'chart.hintReduce': '· Right-click the entry line to reduce',
  'chart.trailingStop': 'trailing',

  'chart.secondaryPane': 'Sub-period',
  'chart.secondaryTfHint': 'Change the period shown in this pane',
  'chart.secondaryClose': 'Close sub-period pane',
  'chart.secondaryEmpty': 'Not enough bars here to aggregate yet'
}
