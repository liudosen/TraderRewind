// ============================================================
// TraderRewind — K 线数据集的 .db 导出 / 导入
//
// 导出：把选中的数据集（元数据 + K 线）写成一个**独立可携带的 sqlite 文件**，
//       别人拿到这个文件就能直接导入，不需要连你的行情库。
// 导入：把这样一个文件（或一份别人的行情库）里的数据集合并进本地行情库。
//
// 两边都用 sqlite 自己的 ATTACH + INSERT ... SELECT 搬运，不把几十万行
// 读进 JS 再写回去 —— 60 万根 K 线走 JS 循环要几十秒，走 sqlite 内部
// 拷贝是秒级。
// ============================================================

import Database from 'better-sqlite3'
import { existsSync, rmSync } from 'node:fs'
import { getMarketDb } from './connection'
import { ensureGroup, groupNameFor } from './dataset-repo'
import { dbPathFor } from '../settings'

/** 导出文件里的自描述标记，用来在导入时区分「我们的包」和「随便一个 .db」 */
export const EXPORT_FORMAT = 'traderrewind-kline'
export const EXPORT_FORMAT_VERSION = 1

export interface ExportResult {
  datasets: number
  bars: number
}

export interface ImportResult {
  /** 新建的数据集数 */
  added: number
  /** 合并进已有数据集的数量 */
  merged: number
  /** 写入 / 覆盖的 K 线根数 */
  bars: number
  /** 跳过并说明原因的数据集 */
  skipped: string[]
}

/**
 * 导出库的表结构。
 *
 * 故意去掉 REFERENCES 约束：单独一个 candles 表拿去给别的工具读时，
 * 外键只会碍事；导入端自己保证「先写 datasets 再写 candles」。
 * 字段名与主库完全一致，导入时可以一条 SELECT 直接对接。
 */
const EXPORT_SCHEMA = `
  CREATE TABLE export_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE datasets (
    id INTEGER PRIMARY KEY,
    group_id INTEGER,
    symbol TEXT NOT NULL,
    timeframe TEXT NOT NULL,
    timezone TEXT NOT NULL,
    first_time INTEGER NOT NULL,
    last_time INTEGER NOT NULL,
    candle_count INTEGER NOT NULL,
    source_filename TEXT,
    imported_at INTEGER NOT NULL,
    kind TEXT NOT NULL DEFAULT 'bar',
    market TEXT NOT NULL DEFAULT 'fx',
    source TEXT NOT NULL DEFAULT 'imported',
    cache_kind TEXT,
    link_to_dataset_id INTEGER,
    point_size REAL
  );
  CREATE TABLE candles (
    dataset_id INTEGER NOT NULL,
    time INTEGER NOT NULL,
    open REAL NOT NULL,
    high REAL NOT NULL,
    low REAL NOT NULL,
    close REAL NOT NULL,
    volume REAL NOT NULL,
    spread REAL,
    oi REAL,
    PRIMARY KEY (dataset_id, time)
  );
  CREATE TABLE candles_ladder (
    dataset_id INTEGER NOT NULL,
    timeframe TEXT NOT NULL,
    time INTEGER NOT NULL,
    open REAL NOT NULL,
    high REAL NOT NULL,
    low REAL NOT NULL,
    close REAL NOT NULL,
    volume REAL NOT NULL,
    oi REAL,
    spread REAL,
    PRIMARY KEY (dataset_id, timeframe, time)
  );
`

function tableExists(db: Database.Database, schema: string, table: string): boolean {
  const row = db
    .prepare(`SELECT 1 FROM ${schema}.sqlite_master WHERE type = 'table' AND name = ?`)
    .get(table)
  return !!row
}

function columnsOf(db: Database.Database, schema: string, table: string): Set<string> {
  const rows = db.prepare(`PRAGMA ${schema}.table_info(${table})`).all() as { name: string }[]
  return new Set(rows.map((r) => r.name))
}

/** 删掉目标文件及其 WAL 残留，避免拿到上次导出的旧内容 */
function resetFile(path: string): void {
  for (const suffix of ['', '-wal', '-shm']) {
    const p = path + suffix
    if (existsSync(p)) {
      try {
        rmSync(p, { force: true })
      } catch {
        // 文件被占用时下面的建库会直接报错，比静默继续好
      }
    }
  }
}

/**
 * 导出数据集到 targetPath。
 * @param ids null = 全部 K 线数据集；否则只导出这些 id
 */
export function exportKlineDb(
  ids: number[] | null,
  targetPath: string,
  appVersion: string
): ExportResult {
  const market = getMarketDb()
  const marketPath = dbPathFor('kline')

  resetFile(targetPath)
  const out = new Database(targetPath)
  try {
    out.pragma('journal_mode = DELETE')
    out.exec(EXPORT_SCHEMA)

    out.prepare('ATTACH DATABASE ? AS src').run(marketPath)
    try {
      // 只取 K 线类数据集：tick 数据体量是另一个量级，塞进包里没人传得动
      const filter =
        ids && ids.length > 0
          ? `AND id IN (${ids.map((n) => Math.floor(Number(n))).filter(Number.isFinite).join(',') || '-1'})`
          : ''
      const rows = out
        .prepare(
          `SELECT id, group_id, symbol, timeframe, timezone, first_time, last_time,
                  candle_count, source_filename, imported_at, kind, market, source,
                  cache_kind, link_to_dataset_id, point_size
             FROM src.datasets
            WHERE kind = 'bar' ${filter}
            ORDER BY id`
        )
        .all() as any[]

      if (rows.length === 0) throw new Error('没有可导出的 K 线数据集')

      const insertDataset = out.prepare(
        `INSERT INTO datasets
           (id, group_id, symbol, timeframe, timezone, first_time, last_time, candle_count,
            source_filename, imported_at, kind, market, source, cache_kind,
            link_to_dataset_id, point_size)
         VALUES (@id, @group_id, @symbol, @timeframe, @timezone, @first_time, @last_time,
                 @candle_count, @source_filename, @imported_at, @kind, @market, @source,
                 @cache_kind, @link_to_dataset_id, @point_size)`
      )

      let bars = 0
      const writeAll = out.transaction(() => {
        for (const r of rows) {
          insertDataset.run({
            id: r.id,
            group_id: r.group_id ?? null,
            symbol: r.symbol,
            timeframe: r.timeframe,
            timezone: r.timezone,
            first_time: r.first_time,
            last_time: r.last_time,
            candle_count: r.candle_count,
            source_filename: r.source_filename ?? null,
            imported_at: r.imported_at,
            kind: r.kind ?? 'bar',
            market: r.market ?? 'fx',
            source: r.source ?? 'imported',
            cache_kind: r.cache_kind ?? null,
            link_to_dataset_id: r.link_to_dataset_id ?? null,
            point_size: r.point_size ?? null
          })
        }

        // K 线照搬：dataset_id 在导出文件里就是原 id，导入时再重新映射
        bars += Number(
          out
            .prepare(
              `INSERT INTO candles
                 (dataset_id, time, open, high, low, close, volume, spread, oi)
               SELECT dataset_id, time, open, high, low, close, volume, spread, oi
                 FROM src.candles
                WHERE dataset_id IN (SELECT id FROM datasets)`
            )
            .run().changes
        )

        // 多周期阶梯表可能不存在（老库），有就一起带走
        if (tableExists(market, 'main', 'candles_ladder')) {
          out
            .prepare(
              `INSERT INTO candles_ladder
                 (dataset_id, timeframe, time, open, high, low, close, volume, oi, spread)
               SELECT dataset_id, timeframe, time, open, high, low, close, volume, oi, spread
                 FROM src.candles_ladder
                WHERE dataset_id IN (SELECT id FROM datasets)`
            )
            .run()
        }
      })
      writeAll()

      const setMeta = out.prepare('INSERT OR REPLACE INTO export_meta (key, value) VALUES (?, ?)')
      setMeta.run('format', EXPORT_FORMAT)
      setMeta.run('format_version', String(EXPORT_FORMAT_VERSION))
      setMeta.run('app_version', appVersion)
      setMeta.run('exported_at', String(Date.now()))
      setMeta.run('dataset_count', String(rows.length))
      setMeta.run('bar_count', String(bars))
      // 记下每行的品种，方便收到文件的人不打开库也知道里面是什么
      setMeta.run('symbols', JSON.stringify(rows.map((r) => `${r.symbol} ${r.timeframe}`)))

      return { datasets: rows.length, bars }
    } finally {
      try {
        out.prepare('DETACH DATABASE src').run()
      } catch {
        /* 忽略 */
      }
    }
  } finally {
    out.close()
  }
}

/** 读导出包的元信息，用于导入前校验与提示 */
function readSourceMeta(db: Database.Database, schema: string): Record<string, string> {
  if (!tableExists(db, schema, 'export_meta')) return {}
  const rows = db.prepare(`SELECT key, value FROM ${schema}.export_meta`).all() as {
    key: string
    value: string
  }[]
  return Object.fromEntries(rows.map((r) => [r.key, r.value]))
}

/**
 * 导入一个 .db 文件到本地行情库。
 *
 * 合并规则与下载一致：同 (symbol, timeframe, source, market) 视为同一个数据集。
 *
 * K 线按主键 (dataset_id, time) 做 INSERT OR REPLACE —— 也就是
 * **同一品种、同一时间戳的那一根 K 线，以导入文件里的为准，直接覆盖本地**。
 * 好处是：重复导入同一个包不会出现两份 EURUSD，时间区间重叠也只是替换重叠段，
 * 区间外的新数据照常追加；坏处是源文件里那根 K 线如果本身有错，会盖掉你原来的
 * 正确值 —— 这是「覆盖」这个语义本身决定的，不是实现取舍。
 */
export function importKlineDb(sourcePath: string): ImportResult {
  if (!existsSync(sourcePath)) throw new Error(`文件不存在：${sourcePath}`)

  // 先用只读连接验一遍：结构不对就当场说清楚，别把坏文件 ATTACH 进主库
  const probe = new Database(sourcePath, { readonly: true, fileMustExist: true })
  try {
    if (!tableExists(probe, 'main', 'datasets')) {
      throw new Error('这个文件不是 TraderRewind 的 K 线库（缺少 datasets 表）')
    }
    if (!tableExists(probe, 'main', 'candles')) {
      throw new Error('这个文件里没有 candles 表，无法导入 K 线')
    }
    const meta = readSourceMeta(probe, 'main')
    if (meta.format && meta.format !== EXPORT_FORMAT) {
      throw new Error(`不认识的数据包格式：${meta.format}`)
    }
    const ver = Number(meta.format_version ?? EXPORT_FORMAT_VERSION)
    if (Number.isFinite(ver) && ver > EXPORT_FORMAT_VERSION) {
      throw new Error(
        `这个包是更新版本导出的（v${ver}），当前程序只支持到 v${EXPORT_FORMAT_VERSION}，请先升级`
      )
    }
  } finally {
    probe.close()
  }

  const db = getMarketDb()
  db.prepare('ATTACH DATABASE ? AS src').run(sourcePath)
  try {
    const srcDatasetCols = columnsOf(db, 'src', 'datasets')
    const srcCandleCols = columnsOf(db, 'src', 'candles')
    const srcHasLadder = tableExists(db, 'src', 'candles_ladder')

    const rows = db
      .prepare(
        `SELECT id, symbol, timeframe, timezone, first_time, last_time, candle_count,
                source_filename, imported_at, kind, market, source, point_size
           FROM src.datasets
          WHERE kind = 'bar'`
      )
      .all() as any[]

    const findExisting = db.prepare(
      `SELECT id FROM datasets
        WHERE symbol = ? AND timeframe = ? AND source = ? AND market = ? AND kind = 'bar'`
    )
    const readPointSize = srcDatasetCols.has('point_size')

    const insertDataset = db.prepare(
      `INSERT INTO datasets
         (group_id, symbol, timeframe, timezone, first_time, last_time, candle_count,
          source_filename, imported_at, kind, market, source, point_size)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'bar', ?, ?, ?)`
    )

    // 源库可能缺 spread / oi（更早版本导出的），缺就补 NULL
    const selCandles = [
      'time',
      'open',
      'high',
      'low',
      'close',
      'volume',
      srcCandleCols.has('spread') ? 'spread' : 'NULL',
      srcCandleCols.has('oi') ? 'oi' : 'NULL'
    ].join(', ')

    const skipped: string[] = []
    let added = 0
    let merged = 0
    let bars = 0

    const runAll = db.transaction(() => {
      for (const r of rows) {
        const symbol = String(r.symbol ?? '').trim()
        const timeframe = String(r.timeframe ?? '').trim()
        if (!symbol || !timeframe) {
          skipped.push(`#${r.id} 缺少品种或周期`)
          continue
        }
        const market = String(r.market ?? 'fx')
        const source = String(r.source ?? 'imported')

        const groupId = ensureGroup(db, groupNameFor(source, market), 'source')

        let datasetId: number
        const hit = findExisting.get(symbol, timeframe, source, market) as { id: number } | undefined
        if (hit) {
          datasetId = hit.id
          merged++
        } else {
          const res = insertDataset.run(
            groupId,
            symbol,
            timeframe,
            String(r.timezone ?? 'UTC'),
            Number(r.first_time ?? 0),
            Number(r.last_time ?? 0),
            Number(r.candle_count ?? 0),
            r.source_filename ?? null,
            Date.now(),
            market,
            source,
            readPointSize ? (r.point_size ?? null) : null
          )
          datasetId = Number(res.lastInsertRowid)
          added++
        }

        bars += Number(
          db
            .prepare(
              `INSERT OR REPLACE INTO candles
                 (dataset_id, time, open, high, low, close, volume, spread, oi)
               SELECT ?, ${selCandles} FROM src.candles WHERE dataset_id = ?`
            )
            .run(datasetId, r.id).changes
        )

        if (srcHasLadder) {
          try {
            db.prepare(
              `INSERT OR REPLACE INTO candles_ladder
                 (dataset_id, timeframe, time, open, high, low, close, volume, oi, spread)
               SELECT ?, timeframe, time, open, high, low, close, volume, oi, spread
                 FROM src.candles_ladder WHERE dataset_id = ?`
            ).run(datasetId, r.id)
          } catch {
            /* 阶梯表结构不一致就跳过，主数据不受影响 */
          }
        }

        // 元数据按库里真实数据重算：合并后区间可能比两边都宽
        const stats = db
          .prepare(
            `SELECT MIN(time) AS first_time, MAX(time) AS last_time, COUNT(*) AS cnt
               FROM candles WHERE dataset_id = ?`
          )
          .get(datasetId) as { first_time: number | null; last_time: number | null; cnt: number }
        db.prepare(
          `UPDATE datasets SET first_time = ?, last_time = ?, candle_count = ?, imported_at = ?
            WHERE id = ?`
        ).run(
          stats.first_time ?? 0,
          stats.last_time ?? 0,
          stats.cnt,
          Date.now(),
          datasetId
        )
      }
    })
    runAll()

    return { added, merged, bars, skipped }
  } finally {
    try {
      db.prepare('DETACH DATABASE src').run()
    } catch {
      /* 忽略 */
    }
  }
}
