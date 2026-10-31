// ============================================================
// TraderRewind — 共享层标签的英译
//
// 指标名、时区名、配色预设、成本预设这些标签都住在 src/shared 里，
// 主进程和渲染进程共用，本身没有「语言」概念，也不该为了翻译被拆成键名
// （拆了主进程那边还要再拼回去）。
//
// 所以这里用「中文原文 → 英文」的映射：渲染时查一次，查不到就原样返回。
// 好处是漏翻顶多露出中文，不会露出键名；坏处是中文文案改了这里会失配，
// 所以共享层那些 label 别随便改字面。
// ============================================================

import type { Locale } from '@shared/types/locale'
import { splitSymbol } from '@shared/constants/catalog'

const enLabels: Record<string, string> = {
  // 图表配色预设
  '白灰涨跌（默认）': 'White / grey (default)',
  '红涨绿跌（中国习惯）': 'Red up, green down (China)',
  '绿涨红跌（欧美习惯）': 'Green up, red down (West)',
  浅色背景: 'Light background',
  深色背景: 'Dark background',

  // 十字线线型
  实线: 'Solid',
  点线: 'Dotted',
  虚线: 'Dashed',
  长虚线: 'Long dash',
  稀疏点线: 'Sparse dots',

  // 时区
  'UTC+8 北京时间（默认）': 'UTC+8 Beijing (default)',
  'UTC+0 格林威治': 'UTC+0 Greenwich',
  'UTC+1 柏林': 'UTC+1 Berlin',
  'UTC+3 莫斯科': 'UTC+3 Moscow',
  'UTC+4 迪拜': 'UTC+4 Dubai',
  'UTC-4 纽约（夏令时）': 'UTC-4 New York (DST)',
  'UTC-5 纽约（冬令时）': 'UTC-5 New York (winter)',
  'UTC-8 洛杉矶': 'UTC-8 Los Angeles',

  // 指标名
  'EMA 均线': 'EMA',
  'BOLL 布林带': 'Bollinger Bands',
  成交量: 'Volume',

  // 指标参数
  周期: 'Period',
  周期1: 'Period 1',
  周期2: 'Period 2',
  周期3: 'Period 3',
  倍数: 'Mult',
  快线: 'Fast',
  慢线: 'Slow',
  信号: 'Signal',

  // 颜色槽位
  上轨: 'Upper',
  中轨: 'Mid',
  下轨: 'Lower',
  线: 'Line',

  // 数据源
  '直接向本机 cTrader 桌面端内置的 MCP 服务要历史 K 线，数据来自你自己的经纪商，走本地回环、不需要代理。':
    'Pull historical candles straight from the MCP server built into your local cTrader desktop app — your own broker data over loopback, no proxy needed.',
  '需 cTrader 正在运行，且在「设置 → 应用程序 → MCP 设置」里勾选「启用 MCP 服务器」（默认端口 9876）':
    'cTrader must be running with "Enable MCP Server" ticked under Settings → Application → MCP Settings (default port 9876)',
  'cTrader 外汇': 'cTrader FX',
  'OKX 现货公开 K 线接口，直接返回 1 分钟蜡烛，无需本地聚合。':
    'OKX public spot kline API — returns 1-minute candles directly, no local aggregation needed.',
  '国内直连需要代理；1 分钟历史深度有限，越久越容易抓空':
    'Needs a proxy from mainland China; 1-minute history only goes back so far, older ranges often come back empty',
  'Binance 公共行情接口（data-api.binance.vision），同样直接返回 1 分钟蜡烛。':
    'Binance public market-data endpoint (data-api.binance.vision) — also returns 1-minute candles directly.',
  '国内直连需要代理；OKX 连不上时可以先用这个':
    'Needs a proxy from mainland China; use this one when OKX is unreachable',
  'OKX 加密': 'OKX crypto',
  'Binance 加密': 'Binance crypto',

  // 汇率来源说明
  '美元报价，无需换算': 'Quoted in USD — no conversion needed',
  '按该品种自身价格取倒数换算': 'Converted by inverting this symbol’s own price',
  '按本机美元直盘数据换算': 'Converted using local USD majors data',
  '按内置参考汇率换算（未下载对应美元直盘）':
    'Converted at the built-in reference rate (the matching USD major is not downloaded)',

  // 成本预设
  不计成本: 'No costs',
  '价差即盈亏，方便和裸策略对比': 'P&L is pure price action — handy against a raw strategy',
  零售账户: 'Retail account',
  机构账户: 'Institutional account',
  恶劣行情: 'Bad conditions',
  '$3.5/手/边 · 20 点滑点': '$3.5/lot/side · 20 pts slippage',
  '$2/手/边 · 10 点滑点': '$2/lot/side · 10 pts slippage',
  '$3.5/手/边 · 100 点滑点': '$3.5/lot/side · 100 pts slippage'
}

/**
 * 翻译共享层的中文标签。英文查不到就原样返回 —— 宁可露中文，也不要露键名。
 */
export function translateLabel(locale: Locale, zh: string): string {
  if (locale !== 'en') return zh
  return enLabels[zh] ?? zh
}

/**
 * 品种名：中文用目录里的「欧元/美元」，英文按行业习惯直接写「EUR/USD」。
 * 与其维护 22 条翻译，不如从代码拆 —— 交易员看英文界面时本来就只认代码。
 * 加密的代码长度不一（BTCUSDT / DOGEUSDT / BTC-USDT），统一交给 splitSymbol。
 */
export function instrumentLabel(locale: Locale, symbol: string, zhName: string): string {
  if (locale !== 'en') return zhName
  const { base, quote } = splitSymbol(symbol)
  return `${base}/${quote}`
}
