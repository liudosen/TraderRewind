// ============================================================
// TraderRewind — 品牌图标生成
//
// 唯一真源：src/renderer/src/assets/logo.svg
// 产物：
//   build/icon.png        512×512，Linux / electron-builder 通用
//   build/icon.ico        Windows 多尺寸（16/24/32/48/64/128/256）
//   resources/icon.png    256×256，开发时给 BrowserWindow 当窗口图标
//
// 用法：npm run icons
// ============================================================
import sharp from 'sharp'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

const SRC = 'src/renderer/src/assets/logo.svg'
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]

const svg = readFileSync(SRC)

/**
 * 按目标尺寸渲染一帧 PNG。
 *
 * 先把 SVG 栅格成 4 倍大小再缩下来，而不是直接按目标尺寸栅格：
 * librsvg 在小尺寸下会丢掉不到 1px 的影线，缩小反而更接近「缩略图」的真实观感。
 */
async function render(size) {
  const big = await sharp(svg, { density: 384 })
    .resize(size * 4, size * 4, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer()
  return sharp(big).resize(size, size, { kernel: 'lanczos3' }).png().toBuffer()
}

/** 把若干 PNG 打包成一个 .ico（Vista 之后允许直接存 PNG 数据块） */
function buildIco(entries) {
  const count = entries.length
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0) // reserved
  header.writeUInt16LE(1, 2) // 1 = icon
  header.writeUInt16LE(count, 4)

  const dir = Buffer.alloc(16 * count)
  let offset = 6 + 16 * count
  entries.forEach((e, i) => {
    const p = i * 16
    // 256 要写成 0（字段只有一个字节）
    dir.writeUInt8(e.size >= 256 ? 0 : e.size, p)
    dir.writeUInt8(e.size >= 256 ? 0 : e.size, p + 1)
    dir.writeUInt8(0, p + 2) // 调色板色数
    dir.writeUInt8(0, p + 3) // reserved
    dir.writeUInt16LE(1, p + 4) // color planes
    dir.writeUInt16LE(32, p + 6) // bpp
    dir.writeUInt32LE(e.data.length, p + 8)
    dir.writeUInt32LE(offset, p + 12)
    offset += e.data.length
  })

  return Buffer.concat([header, dir, ...entries.map((e) => e.data)])
}

mkdirSync('build', { recursive: true })
mkdirSync('resources', { recursive: true })

// 512 主图
const png512 = await render(512)
writeFileSync('build/icon.png', png512)
writeFileSync('resources/icon.png', await render(256))

const entries = []
for (const size of ICO_SIZES) {
  entries.push({ size, data: await render(size) })
}
writeFileSync('build/icon.ico', buildIco(entries))

console.log('✓ build/icon.png      512×512')
console.log('✓ resources/icon.png  256×256')
console.log(`✓ build/icon.ico      ${ICO_SIZES.join('/')}`)
