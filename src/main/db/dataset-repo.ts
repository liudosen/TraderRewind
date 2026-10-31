// ============================================================
// TraderRewind — 数据集仓储（下载结果落库）
// ============================================================

import { getMarketDb } from './connection'

export interface SaveBarsParams {
  symbol: string
  name: string
  timeframe: string
  market: string
  source: string
  timezone: string
  pointSize: number
  bars: Array<{
    time: number
    open: number
    high: number
    low: number
    close: number
    volume: number
  }>
}

/** 该数据源对应的分组名 */
function groupNameFor(source: string, market: string): string {
  if (source === 'ctrader') return 'cTrader 外汇'
  if (source === 'okx') return 'OKX 加密'
  if (source === 'binance') return 'Binance 加密'
  if (market === 'cn_futures') return '国内期货'
  if (market === 'us_futures') return '美盘期货'
  return '导入数据'
}

/** 获取或创建分组 */
function ensureGroup(db: any, name: string, kind: string): number {
  const existing = db.prepare('SELECT id FROM groups WHERE name = ?').get(name) as { id: number } | undefined
  if (existing) return existing.id
  const result = db
    .prepare('INSERT INTO groups (name, kind, created_at) VALUES (?, ?, ?)')
    .run(name, kind, Date.now())
  return Number(result.lastInsertRowid)
}

/**
 * 保存下载的 K 线。
 * - 同品种 + 同周期 + 同来源的数据集会被复用，K 线以 INSERT OR REPLACE 增量合并
 * - 保存后按实际库内数据重算 first_time / last_time / candle_count
 * @returns 数据集 ID
 */
export function saveDownloadedBars(params: SaveBarsParams): number {
  const db = getMarketDb()
  const { symbol, name, timeframe, market, source, timezone, pointSize, bars } = params

  if (bars.length === 0) {
    throw new Error('没有可保存的 K 线数据')
  }

  const groupId = ensureGroup(db, groupNameFor(source, market), 'source')

  let datasetId: number
  const existing = db
    .prepare(
      'SELECT id FROM datasets WHERE symbol = ? AND timeframe = ? AND source = ? AND market = ?'
    )
    .get(symbol, timeframe, source, market) as { id: number } | undefined

  const firstTime = bars[0].time
  const lastTime = bars[bars.length - 1].time

  if (existing) {
    datasetId = existing.id
    db.prepare(
      `UPDATE datasets
         SET group_id = ?, timezone = ?, source_filename = ?, imported_at = ?, point_size = ?
       WHERE id = ?`
    ).run(groupId, timezone, name, Date.now(), pointSize, datasetId)
  } else {
    const result = db
      .prepare(
        `INSERT INTO datasets
           (group_id, symbol, timeframe, timezone, first_time, last_time, candle_count,
            source_filename, imported_at, kind, market, source, point_size)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'bar', ?, ?, ?)`
      )
      .run(
        groupId,
        symbol,
        timeframe,
        timezone,
        firstTime,
        lastTime,
        bars.length,
        name,
        Date.now(),
        market,
        source,
        pointSize
      )
    datasetId = Number(result.lastInsertRowid)
  }

  // 批量写入（事务 + 预编译语句）
  const insert = db.prepare(
    `INSERT OR REPLACE INTO candles (dataset_id, time, open, high, low, close, volume)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  )

  const writeAll = db.transaction((rows: SaveBarsParams['bars']) => {
    for (const bar of rows) {
      insert.run(datasetId, bar.time, bar.open, bar.high, bar.low, bar.close, bar.volume)
    }
  })
  writeAll(bars)

  // 重算元数据
  const stats = db
    .prepare(
      'SELECT MIN(time) AS first_time, MAX(time) AS last_time, COUNT(*) AS cnt FROM candles WHERE dataset_id = ?'
    )
    .get(datasetId) as { first_time: number | null; last_time: number | null; cnt: number }

  db.prepare('UPDATE datasets SET first_time = ?, last_time = ?, candle_count = ? WHERE id = ?').run(
    stats.first_time ?? firstTime,
    stats.last_time ?? lastTime,
    stats.cnt,
    datasetId
  )

  return datasetId
}

/** 列出全部数据集（含分组名），供数据管理页展示 */
export function listDatasetsWithGroup(): any[] {
  const db = getMarketDb()
  return db
    .prepare(
      `SELECT d.*, g.name AS group_name, g.kind AS group_kind
         FROM datasets d
         LEFT JOIN groups g ON g.id = d.group_id
        ORDER BY d.imported_at DESC`
    )
    .all()
}

/** 删除数据集（K 线随外键级联删除） */
export function deleteDatasetById(id: number): void {
  const db = getMarketDb()
  db.prepare('DELETE FROM datasets WHERE id = ?').run(id)
}

/** 读取指定数据集在时间区间内的 K 线 */
export function readCandles(
  datasetId: number,
  fromTime: number,
  toTime: number
): Array<{ time: number; open: number; high: number; low: number; close: number; volume: number }> {
  const db = getMarketDb()
  return db
    .prepare(
      `SELECT time, open, high, low, close, volume
         FROM candles
        WHERE dataset_id = ? AND time >= ? AND time <= ?
        ORDER BY time ASC`
    )
    .all(datasetId, fromTime, toTime) as any[]
}
