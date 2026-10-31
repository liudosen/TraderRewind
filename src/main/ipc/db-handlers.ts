// ============================================================
// TraderRewind — 数据库 IPC 处理器
// 行情库（market.db）与训练库（training.db）分别访问
// ============================================================

import { ipcMain } from 'electron'
import { IPC } from '@shared/constants/ipc'
import { getMarketDb, getTrainingDb } from '../db/connection'
import { loadSettings } from '../settings'
import { fmtTzDateTime, normalizeTimezone } from '@shared/types/timezone'
import { serializeTradeWindow } from '@shared/types/trade-window'
import { normalizeTags } from '@shared/types/trade-tags'

export function registerDbHandlers(): void {
  /** 行情库 */
  const m = () => getMarketDb()
  /** 训练库 */
  const t = () => getTrainingDb()

  // ----- 元数据（训练库） -----
  ipcMain.handle(IPC.DB_GET_META, (_e, key: string) => {
    const row = t().prepare('SELECT value FROM meta WHERE key = ?').get(key) as any
    return row?.value ?? null
  })

  ipcMain.handle(IPC.DB_SET_META, (_e, key: string, value: string) => {
    t().prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(key, value)
    return true
  })

  // ----- 训练统计（工作台） -----
  ipcMain.handle(IPC.DB_ADD_TRAIN_SECONDS, (_e, id: number, seconds: number) => {
    const sec = Math.round(Number(seconds))
    // 只认正的秒数：休眠恢复、时钟回拨之类算出来的怪值直接丢掉，别把累计值写坏
    if (!Number.isFinite(sec) || sec <= 0) return false
    t()
      .prepare('UPDATE sessions SET train_seconds = COALESCE(train_seconds, 0) + ? WHERE id = ?')
      .run(sec, id)
    return true
  })

  ipcMain.handle(IPC.DB_GET_TRAINING_STATS, () => {
    const num = (sql: string): number => Number((t().prepare(sql).get() as any)?.v ?? 0)
    return {
      // 各回测集「实际训练用时」之和（秒）
      trainSeconds: num('SELECT COALESCE(SUM(train_seconds), 0) AS v FROM sessions'),
      // 回测里下过的单：已平仓的 + 还拿在手上的持仓
      trades: num('SELECT COUNT(*) AS v FROM closed_trades') + num('SELECT COUNT(*) AS v FROM positions'),
      sessions: num('SELECT COUNT(*) AS v FROM sessions')
    }
  })

  // ----- 分组（行情库） -----
  ipcMain.handle(IPC.DB_LIST_GROUPS, () => {
    return m().prepare('SELECT * FROM groups ORDER BY name').all()
  })

  ipcMain.handle(IPC.DB_CREATE_GROUP, (_e, name: string, kind: string) => {
    const result = m()
      .prepare('INSERT INTO groups (name, kind, created_at) VALUES (?, ?, ?)')
      .run(name, kind, Date.now())
    return result.lastInsertRowid
  })

  ipcMain.handle(IPC.DB_RENAME_GROUP, (_e, id: number, name: string) => {
    m().prepare('UPDATE groups SET name = ? WHERE id = ?').run(name, id)
    return true
  })

  ipcMain.handle(IPC.DB_DELETE_GROUP, (_e, id: number) => {
    m().prepare('DELETE FROM groups WHERE id = ?').run(id)
    return true
  })

  // ----- 数据集（行情库） -----
  ipcMain.handle(IPC.DB_LIST_DATASETS, (_e, groupId?: number) => {
    if (groupId != null) {
      return m()
        .prepare('SELECT * FROM datasets WHERE group_id = ? ORDER BY symbol, timeframe')
        .all(groupId)
    }
    return m().prepare('SELECT * FROM datasets ORDER BY symbol, timeframe').all()
  })

  ipcMain.handle(IPC.DB_GET_DATASET, (_e, id: number) => {
    return m().prepare('SELECT * FROM datasets WHERE id = ?').get(id) ?? null
  })

  ipcMain.handle(IPC.DB_DELETE_DATASET, (_e, id: number) => {
    m().prepare('DELETE FROM datasets WHERE id = ?').run(id)
    return true
  })

  // ----- 会话（训练库） -----
  ipcMain.handle(IPC.DB_LIST_SESSIONS, () => {
    const rows = t()
      .prepare('SELECT * FROM sessions ORDER BY last_opened_at DESC')
      .all() as any[]
    if (rows.length === 0) return rows

    // 会话和数据集分库存储，这里补齐标的信息
    const ids = [...new Set(rows.map((r) => r.dataset_id).filter((v) => v != null))]
    const dsMap = new Map<number, any>()
    if (ids.length > 0) {
      const placeholders = ids.map(() => '?').join(',')
      const ds = m()
        .prepare(`SELECT id, symbol, timeframe, candle_count FROM datasets WHERE id IN (${placeholders})`)
        .all(...ids) as any[]
      for (const d of ds) dsMap.set(d.id, d)
    }

    return rows.map((r) => {
      const d = dsMap.get(r.dataset_id)
      return {
        ...r,
        dataset_symbol: d?.symbol ?? null,
        dataset_timeframe: d?.timeframe ?? null,
        dataset_bar_count: d?.candle_count ?? null
      }
    })
  })

  ipcMain.handle(IPC.DB_GET_SESSION, (_e, id: number) => {
    return t().prepare('SELECT * FROM sessions WHERE id = ?').get(id) ?? null
  })

  ipcMain.handle(IPC.DB_CREATE_SESSION, (_e, params: any) => {
    const now = Date.now()
    const initialBalance = params.initialBalance ?? 10000
    const result = t()
      .prepare(
        `INSERT INTO sessions
           (dataset_id, name, initial_balance, balance, lot_size,
            created_at, updated_at, last_opened_at, source,
            start_time, end_time, display_timeframe, risk_per_trade, tz, trade_window)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        params.datasetId,
        params.name,
        initialBalance,
        initialBalance,
        params.lotSize ?? 0.1,
        now,
        now,
        now,
        params.source ?? 'manual',
        params.startTime ?? null,
        params.endTime ?? null,
        params.displayTimeframe ?? 'M1',
        // 单笔风险：缺省按初始资金的 1%
        params.riskPerTrade ?? initialBalance * 0.01,
        // 建这个回测集时用的时区：之后从日志跳回 K 线都按它展示
        normalizeTimezone(params.timezone ?? loadSettings().timezone),
        // 交易时段：'HH:mm-HH:mm'，null / 无效值都当「全天不限」
        serializeTradeWindow(params.tradeWindow)
      )
    return result.lastInsertRowid
  })

  ipcMain.handle(IPC.DB_RENAME_SESSION, (_e, id: number, name: string) => {
    t().prepare('UPDATE sessions SET name = ?, updated_at = ? WHERE id = ?').run(name, Date.now(), id)
    return true
  })

  ipcMain.handle(IPC.DB_DELETE_SESSION, (_e, id: number) => {
    t().prepare('DELETE FROM sessions WHERE id = ?').run(id)
    return true
  })

  // ----- 回测集完成 -----
  ipcMain.handle(IPC.DB_COMPLETE_SESSION, (_e, id: number) => {
    const now = Date.now()
    t()
      .prepare(
        'UPDATE sessions SET completed_at = COALESCE(completed_at, ?), updated_at = ? WHERE id = ?'
      )
      .run(now, now, id)
    return now
  })

  // ----- 重置回测集：清空订单 + 游标归零 + 余额复位 -----
  ipcMain.handle(IPC.DB_RESET_SESSION, (_e, id: number, state: any) => {
    const db = t()
    const now = Date.now()
    const run = db.transaction(() => {
      db.prepare('DELETE FROM closed_trades WHERE session_id = ?').run(id)
      db.prepare('DELETE FROM positions WHERE session_id = ?').run(id)
      db.prepare('DELETE FROM pending_orders WHERE session_id = ?').run(id)
      const row = db.prepare('SELECT initial_balance FROM sessions WHERE id = ?').get(id) as any
      const initial = Number(row?.initial_balance) || 10000
      db.prepare(
        `UPDATE sessions SET
           current_index = ?, current_bar_time = ?, balance = ?,
           completed_at = NULL, updated_at = ?
         WHERE id = ?`
      ).run(state?.currentIndex ?? 0, state?.currentBarTime ?? null, initial, now, id)
      return initial
    })
    return run()
  })

  ipcMain.handle(IPC.DB_LIST_COMPLETED_SESSIONS, () => {    const rows = t()
      .prepare(
        `SELECT s.*,
                (SELECT COUNT(*) FROM closed_trades c WHERE c.session_id = s.id) AS trade_count,
                (SELECT COALESCE(SUM(c.profit), 0) FROM closed_trades c WHERE c.session_id = s.id) AS total_pnl,
                (SELECT COUNT(*) FROM closed_trades c WHERE c.session_id = s.id AND c.profit > 0) AS win_count
           FROM sessions s
          WHERE s.completed_at IS NOT NULL
          ORDER BY s.completed_at DESC`
      )
      .all() as any[]
    if (rows.length === 0) return rows

    const ids = [...new Set(rows.map((r) => r.dataset_id).filter((v) => v != null))]
    const dsMap = new Map<number, any>()
    if (ids.length > 0) {
      const placeholders = ids.map(() => '?').join(',')
      const ds = m()
        .prepare(
          `SELECT id, symbol, timeframe, candle_count FROM datasets WHERE id IN (${placeholders})`
        )
        .all(...ids) as any[]
      for (const d of ds) dsMap.set(d.id, d)
    }

    return rows.map((r) => {
      const d = dsMap.get(r.dataset_id)
      return {
        ...r,
        dataset_symbol: d?.symbol ?? null,
        dataset_timeframe: d?.timeframe ?? null,
        dataset_bar_count: d?.candle_count ?? null
      }
    })
  })

  ipcMain.handle(IPC.DB_SAVE_SESSION_STATE, (_e, id: number, state: any) => {
    if (state.displayTimeframe) {
      t()
        .prepare('UPDATE sessions SET display_timeframe = ? WHERE id = ?')
        .run(String(state.displayTimeframe), id)
    }
    t()
      .prepare(
        `UPDATE sessions SET
          current_index = ?, speed = ?, balance = ?,
          drawings_json = ?, indicators_json = ?, chart_view_json = ?,
          current_bar_time = ?, updated_at = ?
         WHERE id = ?`
      )
      .run(
        state.currentIndex ?? 0,
        state.speed ?? 1,
        state.balance ?? 0,
        state.drawingsJson ?? null,
        state.indicatorsJson ?? null,
        state.chartViewJson ?? null,
        state.currentBarTime ?? null,
        Date.now(),
        id
      )
    return true
  })

  // ----- 交易（训练库） -----
  ipcMain.handle(IPC.DB_APPEND_CLOSED_TRADE, (_e, trade: any) => {
    // 下单 / 关单时间按设置里的时区（默认 UTC+8）落一份可读时间，绝对时刻照旧存
    const tz = normalizeTimezone(loadSettings().timezone)
    const openLocal = Number.isFinite(trade.openTime) ? fmtTzDateTime(trade.openTime, tz) : null
    const closeLocal = Number.isFinite(trade.closeTime)
      ? fmtTzDateTime(trade.closeTime, tz)
      : null
    t()
      .prepare(
        `INSERT OR REPLACE INTO closed_trades
         (session_id, id, position_id, type, action, open_time, close_time, open_price, close_price,
          lot_size, profit, commission, notes, tags_json, symbol, swap_total, strategy_name, entry_reason,
          sl_at_close, tp_at_close, r_multiple, mae, mfe, initial_risk_amount, ticket_number, close_reason,
          tz, open_local, close_local)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        trade.sessionId, trade.id, trade.positionId, trade.type, trade.action,
        trade.openTime, trade.closeTime, trade.openPrice, trade.closePrice,
        trade.lotSize, trade.profit, trade.commission, trade.notes ?? null,
        trade.tagsJson ?? null, trade.symbol ?? null, trade.swapTotal ?? 0,
        trade.strategyName ?? null, trade.entryReason ?? null,
        trade.slAtClose ?? null, trade.tpAtClose ?? null, trade.rMultiple ?? null,
        trade.mae ?? null, trade.mfe ?? null, trade.initialRiskAmount ?? null,
        trade.ticketNumber ?? null, trade.closeReason ?? null,
        tz, openLocal, closeLocal
      )
    return true
  })

  ipcMain.handle(IPC.DB_LIST_CLOSED_TRADES, (_e, sessionId: number) => {
    return t()
      .prepare('SELECT * FROM closed_trades WHERE session_id = ? ORDER BY close_time ASC')
      .all(sessionId)
  })

  ipcMain.handle(IPC.DB_LIST_AGGREGATED_TRADES, (_e, _params: any) => {
    // TODO: 聚合 sessions + imported_trades
    return []
  })

  /**
   * 日志页里编辑一笔交易的「思路 / 备注」和标签。
   *
   * 只动 notes 与 tags_json 两列：成交价、盈亏、时间这些是回放当场算出来的，
   * 事后改就等于改成绩，一律不允许。两列一起写，避免「备注改了标签没改」的半截状态。
   */
  ipcMain.handle(
    IPC.DB_UPDATE_CLOSED_TRADE_META,
    (_e, sessionId: number, tradeId: string, meta: { note?: string | null; tags?: string[] }) => {
      const note = typeof meta?.note === 'string' ? meta.note : null
      const tags = normalizeTags(meta?.tags ?? [])
      const tagsJson = tags.length > 0 ? JSON.stringify(tags) : null
      const res = t()
        .prepare('UPDATE closed_trades SET notes = ?, tags_json = ? WHERE session_id = ? AND id = ?')
        .run(note, tagsJson, sessionId, tradeId)
      return res.changes > 0
    }
  )

  // ----- 账户（训练库） -----
  ipcMain.handle(IPC.DB_LIST_ACCOUNTS, () => {
    return t().prepare('SELECT * FROM accounts ORDER BY label').all()
  })

  ipcMain.handle(IPC.DB_CREATE_ACCOUNT, (_e, params: any) => {
    const result = t()
      .prepare(
        'INSERT INTO accounts (label, broker, platform, currency, created_at, account_type, server_timezone) VALUES (?, ?, ?, ?, ?, ?, ?)'
      )
      .run(
        params.label, params.broker ?? null, params.platform ?? 'mt5',
        params.currency ?? 'USD', Date.now(),
        params.accountType ?? 'fx_mt', params.serverTimezone ?? 'UTC'
      )
    return result.lastInsertRowid
  })

  ipcMain.handle(IPC.DB_DELETE_ACCOUNT, (_e, id: number) => {
    t().prepare('DELETE FROM accounts WHERE id = ?').run(id)
    return true
  })

  // ----- 日志（训练库） -----
  ipcMain.handle(IPC.DB_LIST_JOURNAL_NOTES, () => {
    return t().prepare('SELECT * FROM journal_notes ORDER BY updated_at DESC').all()
  })

  ipcMain.handle(IPC.DB_CREATE_JOURNAL_NOTE, (_e, params: any) => {
    const now = Date.now()
    const result = t()
      .prepare(
        'INSERT INTO journal_notes (kind, title, body, created_at, updated_at, ref_kind, ref_id, tags_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      )
      .run(
        params.kind ?? 'note', params.title, params.body ?? '',
        now, now, params.refKind ?? null, params.refId ?? null, params.tagsJson ?? null
      )
    return result.lastInsertRowid
  })

  ipcMain.handle(IPC.DB_UPDATE_JOURNAL_NOTE, (_e, id: number, params: any) => {
    t()
      .prepare('UPDATE journal_notes SET title = ?, body = ?, tags_json = ?, updated_at = ? WHERE id = ?')
      .run(params.title, params.body, params.tagsJson ?? null, Date.now(), id)
    return true
  })

  ipcMain.handle(IPC.DB_DELETE_JOURNAL_NOTE, (_e, id: number) => {
    t().prepare('DELETE FROM journal_notes WHERE id = ?').run(id)
    return true
  })

  // ----- K线数据（行情库） -----
  ipcMain.handle(IPC.DB_FETCH_BARS, (_e, datasetId: number, limit?: number) => {
    const max = Math.max(1, Math.min(50000, Number(limit) || 20000))
    return m()
      .prepare(
        'SELECT time, open, high, low, close, volume FROM candles WHERE dataset_id = ? ORDER BY time ASC LIMIT ?'
      )
      .all(datasetId, max)
  })

  ipcMain.handle(IPC.DB_GET_CANDLES_RANGE, (_e, datasetId: number, fromTime: number, toTime: number) => {
    // 上限 60 万根（约 1 年 1 分钟数据），防止一次拉爆内存
    const rows = m()
      .prepare(
        `SELECT time, open, high, low, close, volume
           FROM candles
          WHERE dataset_id = ? AND time >= ? AND time <= ?
          ORDER BY time
          LIMIT 600000`
      )
      .all(datasetId, fromTime, toTime) as any[]

    const buffer = new ArrayBuffer(rows.length * 48) // 6 个 float64
    const view = new Float64Array(buffer)
    rows.forEach((row, i) => {
      const base = i * 6
      view[base] = row.time
      view[base + 1] = row.open
      view[base + 2] = row.high
      view[base + 3] = row.low
      view[base + 4] = row.close
      view[base + 5] = row.volume
    })
    return { buffer, count: rows.length }
  })

  console.log('[IPC] Database handlers registered')
}
