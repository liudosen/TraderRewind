// ============================================================
// TraderRewind — 数据库 Schema 与迁移
//
// 拆分为两个独立数据库：
//   market.db   —— 行情数据（分组 / 数据集 / K 线 / Tick），目录可配置
//   training.db —— 训练与回测数据（会话 / 持仓 / 成交 / 日志 / 账户），目录可配置
//
// 跨库外键无法生效，training.db 中的 dataset_id 仅作普通列，完整性由应用层保证。
// ============================================================

import type Database from 'better-sqlite3'

/** 行情库迁移 */
const MARKET_MIGRATIONS: string[] = [
  `
  CREATE TABLE IF NOT EXISTS groups (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    kind TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`,
  `
  CREATE TABLE IF NOT EXISTS datasets (
    id INTEGER PRIMARY KEY,
    group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
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
    link_to_dataset_id INTEGER REFERENCES datasets(id) ON DELETE SET NULL,
    point_size REAL
  )`,
  `
  CREATE TABLE IF NOT EXISTS candles (
    dataset_id INTEGER NOT NULL REFERENCES datasets(id) ON DELETE CASCADE,
    time INTEGER NOT NULL,
    open REAL NOT NULL,
    high REAL NOT NULL,
    low REAL NOT NULL,
    close REAL NOT NULL,
    volume REAL NOT NULL,
    spread REAL,
    oi REAL,
    PRIMARY KEY (dataset_id, time)
  )`,
  `
  CREATE TABLE IF NOT EXISTS candles_ladder (
    dataset_id INTEGER NOT NULL REFERENCES datasets(id) ON DELETE CASCADE,
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
  )`,
  `
  CREATE TABLE IF NOT EXISTS ticks (
    dataset_id INTEGER NOT NULL REFERENCES datasets(id) ON DELETE CASCADE,
    time_ms INTEGER NOT NULL,
    bid REAL NOT NULL,
    ask REAL NOT NULL,
    volume REAL,
    flags INTEGER
  )`,
  `
  CREATE TABLE IF NOT EXISTS tick_files (
    dataset_id INTEGER NOT NULL REFERENCES datasets(id) ON DELETE CASCADE,
    archive_id TEXT NOT NULL,
    file_path TEXT NOT NULL,
    raw_sha256 TEXT NOT NULL,
    byte_size INTEGER NOT NULL,
    first_time INTEGER NOT NULL,
    last_time INTEGER NOT NULL,
    tick_count INTEGER NOT NULL,
    installed_at INTEGER NOT NULL,
    format_version INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (dataset_id, archive_id)
  )`,
  `
  CREATE TABLE IF NOT EXISTS dataset_download_gaps (
    dataset_id INTEGER NOT NULL REFERENCES datasets(id) ON DELETE CASCADE,
    from_time INTEGER NOT NULL,
    to_time INTEGER NOT NULL,
    last_error TEXT,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (dataset_id, from_time, to_time)
  )`
]

/** 训练 / 回测库迁移 */
const TRAINING_MIGRATIONS: string[] = [
  // 策略表先建：sessions.strategy_id 引用它
  `
  CREATE TABLE IF NOT EXISTS strategies (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    json_ast TEXT NOT NULL,
    dsl_text TEXT,
    status TEXT NOT NULL DEFAULT 'draft',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    last_run_at INTEGER,
    last_run_session_id INTEGER
  )`,
  `
  CREATE TABLE IF NOT EXISTS strategy_definitions (
    id TEXT PRIMARY KEY,
    definition_json TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `
  CREATE TABLE IF NOT EXISTS custom_indicators (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    source_code TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    error TEXT
  )`,
  `
  CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY,
    dataset_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    current_index INTEGER NOT NULL DEFAULT 0,
    speed REAL NOT NULL DEFAULT 1,
    skip_weekends INTEGER NOT NULL DEFAULT 1,
    display_timeframe TEXT,
    initial_balance REAL NOT NULL,
    balance REAL NOT NULL,
    lot_size REAL NOT NULL DEFAULT 0.1,
    drawings_json TEXT,
    indicators_json TEXT,
    chart_view_json TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    last_opened_at INTEGER NOT NULL,
    current_bar_time INTEGER,
    source TEXT NOT NULL DEFAULT 'manual',
    strategy_id INTEGER REFERENCES strategies(id) ON DELETE SET NULL,
    leverage INTEGER,
    spread_kind TEXT,
    account_currency TEXT,
    pip_size_points REAL,
    contract_size REAL,
    min_volume REAL,
    volume_step REAL,
    swap_long_points REAL,
    swap_short_points REAL,
    broker_spread_points INTEGER,
    broker_commission_kind TEXT,
    broker_commission_value REAL,
    broker_margin_rate REAL,
    broker_server_timezone TEXT NOT NULL DEFAULT 'UTC',
    blind_status INTEGER NOT NULL DEFAULT 0,
    rewinding_allowed INTEGER NOT NULL DEFAULT 1,
    ephemeral INTEGER NOT NULL DEFAULT 0,
    ticket_sequence INTEGER NOT NULL DEFAULT 0,
    performance_revision INTEGER NOT NULL DEFAULT 0
  )`,
  `
  CREATE TABLE IF NOT EXISTS session_symbols (
    session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    slot INTEGER NOT NULL CHECK (slot > 0),
    dataset_id INTEGER NOT NULL,
    symbol TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'reference' CHECK (role IN ('tradable', 'reference')),
    spread_points REAL,
    commission_kind TEXT,
    commission_value REAL,
    commission_close_today REAL,
    commission_close_yesterday REAL,
    margin_rate REAL,
    contract_size REAL,
    min_volume REAL,
    volume_step REAL,
    swap_long_points REAL,
    swap_short_points REAL,
    PRIMARY KEY (session_id, slot)
  )`,
  `
  CREATE TABLE IF NOT EXISTS positions (
    session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    id TEXT NOT NULL,
    type TEXT NOT NULL,
    open_time INTEGER NOT NULL,
    open_price REAL NOT NULL,
    lot_size REAL NOT NULL,
    current_lot_size REAL NOT NULL,
    stop_loss REAL,
    take_profit REAL,
    extras_json TEXT,
    swap_accrued REAL NOT NULL DEFAULT 0,
    last_swap_day_utc INTEGER,
    ticket_number INTEGER,
    PRIMARY KEY (session_id, id)
  )`,
  `
  CREATE TABLE IF NOT EXISTS pending_orders (
    session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    id TEXT NOT NULL,
    type TEXT NOT NULL,
    price REAL NOT NULL,
    lot_size REAL NOT NULL,
    stop_loss REAL,
    take_profit REAL,
    placed_at INTEGER NOT NULL,
    strategy_name TEXT,
    entry_reason TEXT,
    entry_checklist_json TEXT,
    symbol TEXT,
    ticket_number INTEGER,
    PRIMARY KEY (session_id, id)
  )`,
  `
  CREATE TABLE IF NOT EXISTS closed_trades (
    session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    id TEXT NOT NULL,
    position_id TEXT NOT NULL,
    type TEXT NOT NULL,
    action TEXT NOT NULL,
    open_time INTEGER NOT NULL,
    close_time INTEGER NOT NULL,
    open_price REAL NOT NULL,
    close_price REAL NOT NULL,
    lot_size REAL NOT NULL,
    profit REAL NOT NULL,
    commission REAL NOT NULL,
    notes TEXT,
    tags_json TEXT,
    screenshot TEXT,
    market_context TEXT,
    strategy_name TEXT,
    entry_reason TEXT,
    sl_at_close REAL,
    tp_at_close REAL,
    r_multiple REAL,
    symbol TEXT,
    swap_total REAL NOT NULL DEFAULT 0,
    opened_all_in INTEGER,
    close_reason TEXT,
    sl_widened INTEGER,
    was_add_on INTEGER,
    recorded_at INTEGER,
    risk_history_json TEXT,
    entry_checklist_json TEXT,
    mae REAL,
    mfe REAL,
    initial_risk_amount REAL,
    snapshot_hash TEXT,
    ticket_number INTEGER,
    PRIMARY KEY (session_id, id)
  )`,
  `
  CREATE TABLE IF NOT EXISTS session_cash_flows (
    session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    id TEXT NOT NULL,
    kind TEXT NOT NULL,
    time INTEGER NOT NULL,
    amount REAL NOT NULL,
    note TEXT,
    PRIMARY KEY (session_id, id)
  )`,
  `
  CREATE TABLE IF NOT EXISTS session_data_requirements (
    session_id INTEGER PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
    dataset_id INTEGER NOT NULL,
    dataset_source TEXT NOT NULL CHECK (dataset_source IN ('imported', 'system')),
    symbol TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('bar', 'tick')),
    timeframe TEXT NOT NULL,
    market TEXT NOT NULL,
    timezone TEXT NOT NULL,
    required_from INTEGER NOT NULL,
    required_to INTEGER NOT NULL,
    expected_count INTEGER NOT NULL,
    signature_kind TEXT NOT NULL,
    time_signature TEXT,
    status TEXT NOT NULL DEFAULT 'ok' CHECK (status IN ('ok', 'missing', 'mismatch')),
    checked_at INTEGER NOT NULL
  )`,
  `
  CREATE TABLE IF NOT EXISTS session_performance_snapshots (
    session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    timezone TEXT NOT NULL,
    algorithm_version INTEGER NOT NULL,
    source_revision INTEGER NOT NULL,
    snapshot_json TEXT NOT NULL,
    generated_at INTEGER NOT NULL,
    PRIMARY KEY (session_id, timezone)
  )`,
  `
  CREATE TABLE IF NOT EXISTS accounts (
    id INTEGER PRIMARY KEY,
    label TEXT NOT NULL UNIQUE,
    broker TEXT,
    platform TEXT NOT NULL,
    currency TEXT,
    created_at INTEGER NOT NULL,
    account_type TEXT NOT NULL DEFAULT 'fx_mt',
    server_timezone TEXT NOT NULL DEFAULT 'UTC',
    mt_login TEXT,
    mt_last_seen INTEGER
  )`,
  `
  CREATE TABLE IF NOT EXISTS account_events (
    id INTEGER PRIMARY KEY,
    account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    time INTEGER NOT NULL,
    amount REAL NOT NULL,
    note TEXT,
    source_file TEXT,
    broker_time INTEGER
  )`,
  `
  CREATE TABLE IF NOT EXISTS imported_trades (
    id INTEGER PRIMARY KEY,
    account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    ticket_id TEXT NOT NULL,
    symbol TEXT NOT NULL,
    type TEXT NOT NULL,
    open_time INTEGER NOT NULL,
    close_time INTEGER NOT NULL,
    open_price REAL NOT NULL,
    close_price REAL NOT NULL,
    volume REAL NOT NULL,
    stop_loss REAL,
    take_profit REAL,
    commission REAL NOT NULL DEFAULT 0,
    swap REAL NOT NULL DEFAULT 0,
    taxes REAL NOT NULL DEFAULT 0,
    profit REAL NOT NULL,
    hedge_to TEXT,
    hedge_from TEXT,
    notes TEXT,
    tags_json TEXT,
    reflection TEXT,
    source_file TEXT,
    imported_at INTEGER NOT NULL,
    mae REAL,
    mfe REAL,
    strategy_name TEXT,
    entry_reason TEXT,
    strategy_id INTEGER,
    ai_review_id INTEGER,
    checklist_completed_json TEXT,
    screenshot TEXT,
    trade_review_json TEXT,
    broker_open_time INTEGER,
    broker_close_time INTEGER,
    UNIQUE (account_id, ticket_id)
  )`,
  `
  CREATE TABLE IF NOT EXISTS futures_daily_summary (
    id INTEGER PRIMARY KEY,
    account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    trade_date TEXT NOT NULL,
    prev_balance REAL,
    net_deposit REAL,
    realized_pnl REAL,
    floating_pnl REAL,
    commission REAL,
    ending_balance REAL,
    equity REAL,
    cash REAL,
    margin_used REAL,
    available REAL,
    risk_ratio TEXT,
    source_file TEXT,
    imported_at INTEGER NOT NULL,
    UNIQUE (account_id, trade_date)
  )`,
  `
  CREATE TABLE IF NOT EXISTS futures_open_positions (
    id INTEGER PRIMARY KEY,
    account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    trade_date TEXT NOT NULL,
    symbol TEXT NOT NULL,
    fill_id TEXT NOT NULL,
    direction TEXT NOT NULL,
    volume REAL NOT NULL,
    price REAL NOT NULL,
    prev_settle REAL,
    today_settle REAL,
    float_pnl REAL,
    speculation TEXT,
    trading_code TEXT,
    source_file TEXT,
    imported_at INTEGER NOT NULL,
    UNIQUE (account_id, trade_date, fill_id, direction)
  )`,
  `
  CREATE TABLE IF NOT EXISTS cfmmc_period_end_lots (
    id INTEGER PRIMARY KEY,
    account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    period TEXT NOT NULL,
    symbol TEXT NOT NULL,
    direction TEXT NOT NULL,
    fill_id TEXT NOT NULL,
    volume REAL NOT NULL,
    open_price REAL NOT NULL,
    open_time INTEGER,
    open_commission REAL NOT NULL DEFAULT 0,
    source_file TEXT,
    imported_at INTEGER NOT NULL,
    UNIQUE (account_id, period, symbol, direction, fill_id)
  )`,
  `
  CREATE TABLE IF NOT EXISTS journal_notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL DEFAULT 'note',
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    ref_kind TEXT,
    ref_id TEXT,
    tags_json TEXT
  )`,
  `
  CREATE TABLE IF NOT EXISTS note_images (
    id TEXT PRIMARY KEY,
    note_id INTEGER,
    mime TEXT NOT NULL,
    bytes BLOB NOT NULL,
    byte_size INTEGER NOT NULL,
    width INTEGER,
    height INTEGER,
    created_at INTEGER NOT NULL,
    trade_uid TEXT
  )`,
  `
  CREATE TABLE IF NOT EXISTS note_templates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    body TEXT NOT NULL,
    scope TEXT NOT NULL DEFAULT 'entry',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `
  CREATE TABLE IF NOT EXISTS achievements (
    code TEXT PRIMARY KEY,
    tier TEXT NOT NULL,
    earned_at INTEGER NOT NULL,
    context_json TEXT
  )`,
  `
  CREATE TABLE IF NOT EXISTS s3_backup_settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    endpoint TEXT NOT NULL,
    region TEXT NOT NULL,
    bucket TEXT NOT NULL,
    prefix TEXT NOT NULL DEFAULT 'traderrewind',
    force_path_style INTEGER NOT NULL DEFAULT 0 CHECK (force_path_style IN (0, 1)),
    access_key_id TEXT NOT NULL,
    secret_access_key TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `
  CREATE TABLE IF NOT EXISTS persistence_resource_usage (
    table_name TEXT PRIMARY KEY,
    row_count INTEGER NOT NULL CHECK (row_count >= 0),
    total_bytes INTEGER NOT NULL CHECK (total_bytes >= 0),
    max_rows INTEGER NOT NULL CHECK (max_rows > 0),
    max_bytes INTEGER NOT NULL CHECK (max_bytes > 0),
    revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0)
  ) STRICT`,
  `
  CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`,
  // 训练会话的回测区间（旧库通过 ALTER 补齐）
  `ALTER TABLE sessions ADD COLUMN start_time INTEGER`,
  `ALTER TABLE sessions ADD COLUMN end_time INTEGER`,
  // 已废弃：成就系统不再需要
  `DROP TABLE IF EXISTS achievements`
]

/**
 * 幂等补列：不占用迁移版本号。
 * 用于给已存在的表加字段——ALTER 走 _migrations 很容易被版本号错位漏掉。
 */
function ensureColumn(
  db: Database.Database,
  table: string,
  column: string,
  decl: string
): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
  if (cols.some((c) => c.name === column)) return
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`)
  console.log(`[DB] ${table} 补充字段 ${column}`)
}

const MARKET_INDEXES = `
  CREATE INDEX IF NOT EXISTS idx_candles_dataset_time ON candles(dataset_id, time);
  CREATE INDEX IF NOT EXISTS idx_ticks_dataset_time ON ticks(dataset_id, time_ms);
  CREATE INDEX IF NOT EXISTS idx_datasets_symbol ON datasets(symbol);
  CREATE INDEX IF NOT EXISTS idx_datasets_group ON datasets(group_id);
`

const TRAINING_INDEXES = `
  CREATE INDEX IF NOT EXISTS idx_sessions_dataset ON sessions(dataset_id);
  CREATE INDEX IF NOT EXISTS idx_closed_trades_session ON closed_trades(session_id);
  CREATE INDEX IF NOT EXISTS idx_positions_session ON positions(session_id);
  CREATE INDEX IF NOT EXISTS idx_imported_trades_account ON imported_trades(account_id);
  CREATE INDEX IF NOT EXISTS idx_imported_trades_symbol ON imported_trades(symbol);
  CREATE INDEX IF NOT EXISTS idx_journal_notes_ref ON journal_notes(ref_kind, ref_id);
`

/** 行情库必需列 */
const MARKET_REQUIRED: Record<string, string[]> = {
  datasets: [
    'id', 'group_id', 'symbol', 'timeframe', 'timezone', 'first_time', 'last_time',
    'candle_count', 'kind', 'market', 'source', 'imported_at'
  ],
  candles: ['dataset_id', 'time', 'open', 'high', 'low', 'close', 'volume'],
  groups: ['id', 'name', 'kind', 'created_at']
}

/** 训练库必需列 */
const TRAINING_REQUIRED: Record<string, string[]> = {
  sessions: ['id', 'dataset_id', 'name', 'current_index', 'initial_balance', 'balance', 'completed_at'],
  closed_trades: ['session_id', 'id', 'profit', 'open_time', 'close_time', 'close_reason'],
  meta: ['key', 'value']
}

function applyMigrations(db: Database.Database, migrations: string[]): number {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      version INTEGER PRIMARY KEY,
      applied_at INTEGER NOT NULL
    )
  `)

  const applied = new Set(
    (db.prepare('SELECT version FROM _migrations').all() as { version: number }[]).map((r) => r.version)
  )
  const insert = db.prepare('INSERT INTO _migrations (version, applied_at) VALUES (?, ?)')

  let count = 0
  migrations.forEach((sql, index) => {
    const version = index + 1
    if (!applied.has(version)) {
      db.exec(sql)
      insert.run(version, Date.now())
      count++
    }
  })
  return count
}

function assertSchema(db: Database.Database, required: Record<string, string[]>, label: string): void {
  for (const [table, columns] of Object.entries(required)) {
    const info = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
    if (info.length === 0) {
      throw new Error(`[DB] ${label} 数据表 ${table} 不存在，数据库初始化失败`)
    }
    const existing = new Set(info.map((c) => c.name))
    const missing = columns.filter((c) => !existing.has(c))
    if (missing.length > 0) {
      throw new Error(
        `[DB] ${label} 数据表 ${table} 结构与程序不兼容（缺少字段：${missing.join(', ')}）。` +
          `请更换数据目录或删除该库文件后重启。`
      )
    }
  }
}

export function runMarketMigrations(db: Database.Database): void {
  const n = applyMigrations(db, MARKET_MIGRATIONS)
  db.exec(MARKET_INDEXES)
  assertSchema(db, MARKET_REQUIRED, '行情库')
  if (n > 0) console.log(`[DB] 行情库迁移完成，新增 ${n} 项`)
}

export function runTrainingMigrations(db: Database.Database): void {
  const n = applyMigrations(db, TRAINING_MIGRATIONS)
  // 回测集完成时间（幂等补列，不依赖迁移版本号）
  ensureColumn(db, 'sessions', 'completed_at', 'INTEGER')
  // 实际回测用时（秒）。只统计人真的坐在屏幕前练的那段时间，工作台的「回测总用时」靠它汇总
  ensureColumn(db, 'sessions', 'train_seconds', 'INTEGER NOT NULL DEFAULT 0')
  // 单笔风险（用于把每笔盈亏换算成 R）：建会话时由用户填写
  ensureColumn(db, 'sessions', 'risk_per_trade', 'REAL')
  // 订单记录时使用的时区，以及按该时区算好的可读时间（默认 UTC+8）
  // open_time / close_time 仍是绝对时刻（与 K 线时间轴同源），这三列只用于审计与展示
  ensureColumn(db, 'closed_trades', 'tz', 'TEXT')
  ensureColumn(db, 'closed_trades', 'open_local', 'TEXT')
  ensureColumn(db, 'closed_trades', 'close_local', 'TEXT')
  // 建会话时使用的时区：从日志跳回该会话的 K 线时按它展示
  ensureColumn(db, 'sessions', 'tz', 'TEXT')
  // 交易时段（'HH:mm-HH:mm'，空 = 全天不限）：时段外禁止开仓
  ensureColumn(db, 'sessions', 'trade_window', 'TEXT')
  db.exec(TRAINING_INDEXES)
  assertSchema(db, TRAINING_REQUIRED, '训练库')
  if (n > 0) console.log(`[DB] 训练库迁移完成，新增 ${n} 项`)
}

/** 行情库表（用于旧库迁移） */
export const MARKET_TABLES = [
  'groups', 'datasets', 'candles', 'candles_ladder', 'ticks', 'tick_files', 'dataset_download_gaps'
]

/** 训练库表（用于旧库迁移） */
export const TRAINING_TABLES = [
  'strategies', 'strategy_definitions', 'custom_indicators',
  'sessions', 'session_symbols', 'positions', 'pending_orders', 'closed_trades',
  'session_cash_flows', 'session_data_requirements', 'session_performance_snapshots',
  'accounts', 'account_events', 'imported_trades', 'futures_daily_summary',
  'futures_open_positions', 'cfmmc_period_end_lots',
  'journal_notes', 'note_images', 'note_templates',
  's3_backup_settings', 'persistence_resource_usage', 'meta'
]
