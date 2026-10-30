// ============================================================
// TraderRewind — LZMA 解压封装
// Dukascopy 的 .bi5 文件是 LZMA(alone) 压缩
// 使用纯 JS 实现（lzma npm），避免原生模块编译问题
// ============================================================

import lzma from 'lzma'

function toBuffer(result: unknown): Buffer {
  if (Buffer.isBuffer(result)) return result
  // lzma 包在 Node 下解压结果是「字节数字数组」
  if (Array.isArray(result)) return Buffer.from(result as number[])
  if (result instanceof ArrayBuffer) return Buffer.from(result)
  if (ArrayBuffer.isView(result)) {
    return Buffer.from(result.buffer, result.byteOffset, result.byteLength)
  }
  if (typeof result === 'string') return Buffer.from(result, 'binary')
  throw new Error('LZMA_UNEXPECTED_RESULT')
}

/**
 * 解压 LZMA(alone) 数据
 */
export function decompressLzma(input: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    if (input.length === 0) {
      resolve(Buffer.alloc(0))
      return
    }
    try {
      // lzma 包在 Node 下为回调风格：decompress(buffer, onFinish)
      ;(lzma as any).decompress(input, (result: unknown, error: unknown) => {
        if (error) {
          reject(error instanceof Error ? error : new Error(String(error)))
          return
        }
        try {
          resolve(toBuffer(result))
        } catch (e) {
          reject(e)
        }
      })
    } catch (e) {
      reject(e)
    }
  })
}
