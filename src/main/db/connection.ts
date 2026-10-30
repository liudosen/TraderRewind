// ============================================================
// TraderRewind — 数据库连接管理（行情库 / 训练库 双库）
// ============================================================

import Database from 'better-sqlite3'
import { app } from 'electron'
import { existsSync, mkdirSync, renameSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { dbPathFor, type StorageKind } from '../settings'
import {
  MARKET_TABLES,
  TRAINING_TABLES,
  runMarketMigrations,
  runTrainingMigrations
} from './schema'

let marketDb: Database.Database | null = null
let trainingDb: Database.Database | null = null

export function getMarketDb(): Database.Database {
  if (!marketDb) throw new Error('行情库未初始化')
  return marketDb
}

export function getTrainingDb(): Database.Database {
  if (!trainingDb) throw new Error('训练库未初始化')
  return trainingDb
}

function openDb(filePath: string): Database.Database {
  mkdirSync(dirname(filePath), { recursive: true })
  const db = new Database(filePath)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  db.pragma('synchronous = NORMAL')
  return db
}

export function openDatabaseKind(kind: StorageKind): void {
  if (kind === 'kline') {
    marketDb = openDb(dbPathFor('kline'))
    runMarketMigrations(marketDb)
  } else {
    trainingDb = openDb(dbPathFor('training'))
    runTrainingMigrations(trainingDb)
  }
}

export function closeDatabaseKind(kind: StorageKind): void {
  if (kind === 'kline') {
    marketDb?.close()
    marketDb = null
  } else {
    trainingDb?.close()
    trainingDb = null
  }
}

export function initDatabases(): void {
  migrateLegacyIfNeeded()

  const klinePath = dbPathFor('kline')
  const trainingPath = dbPathFor('training')

  marketDb = openDb(klinePath)
  runMarketMigrations(marketDb)

  trainingDb = openDb(trainingPath)
  runTrainingMigrations(trainingDb)

  console.log('[DB] 行情库:', klinePath)
  console.log('[DB] 训练库:', trainingPath)
}

export function closeDatabases(): void {
  marketDb?.close()
  marketDb = null
  trainingDb?.close()
  trainingDb = null
  console.log('[DB] 已关闭')
}

/**
 * 旧版本使用单库 traderrewind.db，这里自动拆分到两个新库。
 * 迁移完成后把原文件重命名，避免重复迁移。
 */
function migrateLegacyIfNeeded(): void {
  const legacy = join(app.getPath('userData'), 'traderrewind.db')
  if (!existsSync(legacy)) return

  const klinePath = dbPathFor('kline')
  const trainingPath = dbPathFor('training')
  const needKline = !existsSync(klinePath)
  const needTraining = !existsSync(trainingPath)
  if (!needKline && !needTraining) return

  console.log('[DB] 检测到旧版单库，开始拆分迁移…')
  try {
    if (needKline) {
      const m = openDb(klinePath)
      runMarketMigrations(m)
      copyTables(m, legacy, MARKET_TABLES)
      m.close()
    }
    if (needTraining) {
      const t = openDb(trainingPath)
      runTrainingMigrations(t)
      copyTables(t, legacy, TRAINING_TABLES)
      t.close()
    }

    // 连 WAL/SHM 一起改名，避免残留文件影响后续打开
    for (const suffix of ['', '-wal', '-shm']) {
      const src = legacy + suffix
      if (existsSync(src)) {
        try {
          renameSync(src, src + '.migrated')
        } catch {
          // 忽略单个文件重命名失败
        }
      }
    }
    console.log('[DB] 旧库拆分完成，原文件已重命名为 *.migrated')
  } catch (e) {
    console.error('[DB] 旧库拆分失败，将以空库启动：', e)
  }
}

function copyTables(target: Database.Database, legacyPath: string, tables: string[]): void {
  target.prepare('ATTACH DATABASE ? AS legacy').run(legacyPath)
  try {
    for (const table of tables) {
      try {
        const exists = target
          .prepare("SELECT 1 FROM legacy.sqlite_master WHERE type = 'table' AND name = ?")
          .get(table)
        if (!exists) continue
        target
          .prepare(`INSERT OR REPLACE INTO main."${table}" SELECT * FROM legacy."${table}"`)
          .run()
      } catch (e) {
        console.warn('[DB] 迁移跳过表', table, (e as Error).message)
      }
    }
  } finally {
    try {
      target.prepare('DETACH DATABASE legacy').run()
    } catch {
      // 忽略
    }
  }
}
