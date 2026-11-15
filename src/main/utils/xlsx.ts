// ============================================================
// TraderRewind — 极简 .xlsx 生成器
//
// 只服务一个需求：把一张二维表写成 Excel 能直接打开的 .xlsx。
// 不引入 SheetJS / ExcelJS：这里只需要「字符串 / 数字 + 表头样式 + 冻结首行
// + 可选的单元格图片」，一个 ZIP + SpreadsheetML 写入器就够了。
//
// 只支持单 sheet；图片是浮在单元格上的 PNG（交易截图），带可选外链。
// ============================================================

import { deflateRawSync } from 'node:zlib'

export type XlsxCell = string | number | null | undefined

/** 一张塞进单元格里的图片（目前只用于交易截图，PNG） */
export interface XlsxImage {
  /** PNG 字节 */
  data: Buffer
  /** 锚点单元格（0 起） */
  col: number
  row: number
  /** 原图尺寸，用来等比缩放 */
  width: number
  height: number
  /** 点击图片时打开的外部地址（相对 xlsx 的路径） */
  hyperlink?: string
  /** 图片名 / 替代文本 */
  name?: string
}

/** 放在单元格里的图片（Excel 365 / WPS 的「嵌入单元格」） */
export interface XlsxCellImage {
  data: Buffer
  /** 0 起的列 / 行 */
  col: number
  row: number
}

export interface XlsxSheet {
  /** sheet 名（非法字符会被替换，最长 31） */
  name: string
  /** 第一行当表头，加粗 + 灰底 */
  rows: XlsxCell[][]
  /** 每列宽度（字符数），缺省 14 */
  columnWidths?: number[]
  /** 浮在单元格上的图片 */
  images?: XlsxImage[]
  /** 真正嵌在单元格里的图片：WPS 双击可放大，带原生关闭 */
  cellImages?: XlsxCellImage[]
  /** 可选的大图 sheet：缩略图点开后跳到这里的原尺寸图 */
  snapshotSheet?: XlsxSnapshotSheet
}

/** 「交易截图」大图页：一行一张图，A1 是返回明细的链接 */
export interface XlsxSnapshotSheet {
  name: string
  images: XlsxImage[]
}

const XML_HEADER = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'

/** XML 1.0 不允许的控制字符直接丢掉（保留 tab / 换行 / 回车，其余照原样） */
function escapeXml(text: string): string {
  return text
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

/** 0 → A、25 → Z、26 → AA */
function colName(index: number): string {
  let n = index + 1
  let out = ''
  while (n > 0) {
    const rem = (n - 1) % 26
    out = String.fromCharCode(65 + rem) + out
    n = Math.floor((n - 1) / 26)
  }
  return out
}

export function sanitizeSheetName(name: string): string {
  const cleaned = name.replace(/[\\/?*[\]:]/g, ' ').trim()
  return (cleaned || 'Sheet1').slice(0, 31)
}

const STYLES_XML = `${XML_HEADER}
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <fonts count="2">
    <font><sz val="11"/><color rgb="FF262626"/><name val="Calibri"/></font>
    <font><b/><sz val="11"/><color rgb="FF262626"/><name val="Calibri"/></font>
  </fonts>
  <fills count="3">
    <fill><patternFill patternType="none"/></fill>
    <fill><patternFill patternType="gray125"/></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFF2F2F2"/><bgColor indexed="64"/></patternFill></fill>
  </fills>
  <borders count="2">
    <border><left/><right/><top/><bottom/><diagonal/></border>
    <border>
      <left style="thin"><color rgb="FFD9D9D9"/></left>
      <right style="thin"><color rgb="FFD9D9D9"/></right>
      <top style="thin"><color rgb="FFD9D9D9"/></top>
      <bottom style="thin"><color rgb="FFD9D9D9"/></bottom>
      <diagonal/>
    </border>
  </borders>
  <cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
  <cellXfs count="3">
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
    <xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1">
      <alignment horizontal="center" vertical="center"/>
    </xf>
    <xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1">
      <alignment vertical="center"/>
    </xf>
  </cellXfs>
  <cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`

/** crc32（ZIP 必需） */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(buf: Buffer): number {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

interface ZipEntry {
  name: string
  data: Buffer
}

/** DOS 日期时间（1980 起）。用当前时间，Excel 里看到的就是导出时刻 */
function dosDateTime(date: Date): { time: number; date: number } {
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2)
  const d = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()
  return { time, date: d }
}

/** 最小 ZIP：deflate + 无加密、无 zip64（表格远达不到 4GB） */
function zip(entries: ZipEntry[]): Buffer {
  const { time, date } = dosDateTime(new Date())
  const localParts: Buffer[] = []
  const centralParts: Buffer[] = []
  let offset = 0

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, 'utf8')
    const raw = entry.data
    const compressed = deflateRawSync(raw)
    const crc = crc32(raw)

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6) // bit 11：文件名按 UTF-8
    local.writeUInt16LE(8, 8) // deflate
    local.writeUInt16LE(time, 10)
    local.writeUInt16LE(date, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(compressed.length, 18)
    local.writeUInt32LE(raw.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    local.writeUInt16LE(0, 28)
    localParts.push(local, nameBuf, compressed)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4) // version made by
    central.writeUInt16LE(20, 6) // version needed
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt16LE(8, 10)
    central.writeUInt16LE(time, 12)
    central.writeUInt16LE(date, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(compressed.length, 20)
    central.writeUInt32LE(raw.length, 24)
    central.writeUInt16LE(nameBuf.length, 28)
    central.writeUInt16LE(0, 30) // extra
    central.writeUInt16LE(0, 32) // comment
    central.writeUInt16LE(0, 34) // disk start
    central.writeUInt16LE(0, 36) // internal attrs
    central.writeUInt32LE(0, 38) // external attrs
    central.writeUInt32LE(offset, 42)
    centralParts.push(central, nameBuf)

    offset += local.length + nameBuf.length + compressed.length
  }

  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(0, 4)
  eocd.writeUInt16LE(0, 6)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(centralSize, 12)
  eocd.writeUInt32LE(offset, 16)
  eocd.writeUInt16LE(0, 20)

  return Buffer.concat([...localParts, ...centralParts, eocd])
}

function cellXml(ref: string, value: XlsxCell, style: number): string {
  if (value == null || value === '') return `<c r="${ref}" s="${style}"/>`
  if (typeof value === 'number' && Number.isFinite(value)) {
    return `<c r="${ref}" s="${style}"><v>${value}</v></c>`
  }
  return `<c r="${ref}" s="${style}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(String(value))}</t></is></c>`
}

const EMU_PER_PX = 9525
/** 带截图的交易行统一高度（pt）；缩略图按这个高度等比缩放 */
const IMAGE_ROW_HEIGHT_PT = 110
/** 「交易截图」大图页：一行一张图，列宽和行高给足 */
const SNAPSHOT_COL_WIDTH = 130
const SNAPSHOT_ROW_HEIGHT_PT = 460

/** 内部 sheet 名在超链接里的写法：含空格等特殊字符时用单引号包起来 */
export function quoteSheetName(name: string): string {
  return /^[\p{L}\p{N}_]+$/u.test(name) ? name : `'${name.replace(/'/g, "''")}'`
}

/**
 * 把截图浮在单元格里。
 *
 * 一个 oneCellAnchor 就够：锚在单元格左上角，偏移量用来居中，ext 是显示尺寸。
 * 图片可以带一个内部超链接（跳到「交易截图」大图页），不依赖任何外部文件。
 */
function drawingXml(
  images: XlsxImage[],
  columnWidths: number[] | undefined,
  rowHeightPt: number,
  defaultColWidth: number
): string {
  const anchors = images.map((img, i) => {
    const colWidth =
      columnWidths?.[img.col] && columnWidths[img.col] > 0
        ? columnWidths[img.col]
        : defaultColWidth
    const cellW = Math.round(colWidth * 7 + 5)
    const cellH = Math.round((rowHeightPt * 4) / 3)
    const pad = 6
    const maxW = Math.max(20, cellW - pad * 2)
    const maxH = Math.max(20, cellH - pad * 2)
    const scale = Math.min(
      maxW / Math.max(1, img.width),
      maxH / Math.max(1, img.height),
      1
    )
    const w = Math.max(1, Math.round(img.width * scale))
    const h = Math.max(1, Math.round(img.height * scale))
    const offX = Math.round((cellW - w) / 2) * EMU_PER_PX
    const offY = Math.round((cellH - h) / 2) * EMU_PER_PX
    const cx = w * EMU_PER_PX
    const cy = h * EMU_PER_PX
    const link = img.hyperlink
      ? `<a:hlinkClick r:id="rIdLink${i + 1}"/>`
      : ''
    return `<xdr:oneCellAnchor>
      <xdr:from><xdr:col>${img.col}</xdr:col><xdr:colOff>${offX}</xdr:colOff><xdr:row>${img.row}</xdr:row><xdr:rowOff>${offY}</xdr:rowOff></xdr:from>
      <xdr:ext cx="${cx}" cy="${cy}"/>
      <xdr:pic>
        <xdr:nvPicPr>
          <xdr:cNvPr id="${i + 1}" name="Snapshot ${i + 1}" descr="${escapeXml(img.name ?? '')}">${link}</xdr:cNvPr>
          <xdr:cNvPicPr><a:picLocks noChangeAspect="1"/></xdr:cNvPicPr>
        </xdr:nvPicPr>
        <xdr:blipFill>
          <a:blip r:embed="rIdImg${i + 1}"/>
          <a:stretch><a:fillRect/></a:stretch>
        </xdr:blipFill>
        <xdr:spPr>
          <a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>
          <a:prstGeom prst="rect"><a:avLst/></a:prstGeom>
        </xdr:spPr>
      </xdr:pic>
      <xdr:clientData/>
    </xdr:oneCellAnchor>`
  })

  return `${XML_HEADER}
<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  ${anchors.join('\n  ')}
</xdr:wsDr>`
}

function drawingRelsXml(images: XlsxImage[], mediaStart: number): string {
  const imageRels = images
    .map(
      (_img, i) =>
        `<Relationship Id="rIdImg${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image${mediaStart + i}.png"/>`
    )
    .join('')
  const linkRels = images
    .map((img, i) => {
      if (!img.hyperlink) return ''
      const internal = img.hyperlink.startsWith('#')
      const target = internal
        ? escapeXml(img.hyperlink)
        : escapeXml(encodeURI(img.hyperlink))
      return `<Relationship Id="rIdLink${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="${target}"${
        internal ? '' : ' TargetMode="External"'
      }/>`
    })
    .join('')
  return `${XML_HEADER}
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${imageRels}${linkRels}</Relationships>`
}

const RICH_VALUE_TYPES_XML = `${XML_HEADER}
<rvTypesInfo xmlns="http://schemas.microsoft.com/office/spreadsheetml/2017/richdata2" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" mc:Ignorable="x" xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><global><keyFlags><key name="_Self"><flag name="ExcludeFromFile" value="1"/><flag name="ExcludeFromCalcComparison" value="1"/></key><key name="_DisplayString"><flag name="ExcludeFromCalcComparison" value="1"/></key><key name="_Flags"><flag name="ExcludeFromCalcComparison" value="1"/></key><key name="_Format"><flag name="ExcludeFromCalcComparison" value="1"/></key><key name="_SubLabel"><flag name="ExcludeFromCalcComparison" value="1"/></key><key name="_Attribution"><flag name="ExcludeFromCalcComparison" value="1"/></key><key name="_Icon"><flag name="ExcludeFromCalcComparison" value="1"/></key><key name="_Display"><flag name="ExcludeFromCalcComparison" value="1"/></key><key name="_CanonicalPropertyNames"><flag name="ExcludeFromCalcComparison" value="1"/></key><key name="_ClassificationId"><flag name="ExcludeFromCalcComparison" value="1"/></key></keyFlags></global></rvTypesInfo>`

/**
 * 生成 Excel 365 / WPS「嵌入单元格图片」需要的 rich data + metadata。
 *
 * 这套结构是 Excel 的 Place in Cell 格式（XlsxWriter 的 embed_image 同款）：
 * 单元格本身是 t="e" 的 #VALUE! + vm 元数据，图片内容放在 richValueRel；
 * WPS 双击单元格图片会弹出原生大图预览（右上角关闭），不再依赖超链接或外部文件。
 */
function cellImageParts(
  cellImages: XlsxCellImage[],
  mediaStart: number
): {
  rels: string
  richValueRel: string
  richValues: string
  structure: string
  metadata: string
} {
  const count = cellImages.length
  const imageRels = cellImages
    .map(
      (_img, i) =>
        `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image${mediaStart + i}.png"/>`
    )
    .join('')
  const rels = `${XML_HEADER}
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${imageRels}</Relationships>`

  const relsXml = cellImages
    .map((_img, i) => `<rel r:id="rId${i + 1}"/>`)
    .join('')
  const richValueRel = `${XML_HEADER}
<richValueRels xmlns="http://schemas.microsoft.com/office/spreadsheetml/2022/richvaluerel" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">${relsXml}</richValueRels>`

  const richValues = cellImages
    .map(
      (_img, i) => `<rv s="0"><v>${i}</v><v>5</v></rv>`
    )
    .join('')
  const richValuesXml = `${XML_HEADER}
<rvData xmlns="http://schemas.microsoft.com/office/spreadsheetml/2017/richdata" count="${count}">${richValues}</rvData>`

  const structure = `${XML_HEADER}
<rvStructures xmlns="http://schemas.microsoft.com/office/spreadsheetml/2017/richdata" count="1"><s t="_localImage"><k n="_rvRel:LocalImageIdentifier" t="i"/><k n="CalcOrigin" t="i"/></s></rvStructures>`

  const futureBlocks = cellImages
    .map(
      (_img, i) =>
        `<bk><extLst><ext uri="{3e2802c4-a4d2-4d8b-9148-e3be6c30e623}"><xlrd:rvb i="${i}"/></ext></extLst></bk>`
    )
    .join('')
  const valueBlocks = cellImages
    .map((_img, i) => `<bk><rc t="1" v="${i}"/></bk>`)
    .join('')
  const metadata = `${XML_HEADER}
<metadata xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:xlrd="http://schemas.microsoft.com/office/spreadsheetml/2017/richdata"><metadataTypes count="1"><metadataType name="XLRICHVALUE" minSupportedVersion="120000" copy="1" pasteAll="1" pasteValues="1" merge="1" splitFirst="1" rowColShift="1" clearFormats="1" clearComments="1" assign="1" coerce="1"/></metadataTypes><futureMetadata name="XLRICHVALUE" count="${count}">${futureBlocks}</futureMetadata><valueMetadata count="${count}">${valueBlocks}</valueMetadata></metadata>`

  return {
    rels,
    richValueRel,
    richValues: richValuesXml,
    structure,
    metadata
  }
}

export function buildXlsx(sheet: XlsxSheet): Buffer {
  const rows = sheet.rows.length > 0 ? sheet.rows : [['']]
  const images = sheet.images ?? []
  const cellImages = sheet.cellImages ?? []
  const snapshot = sheet.snapshotSheet
  const snapshotImages = snapshot?.images ?? []
  const hasSnapshot = !!snapshot && snapshotImages.length > 0
  // 不用 Math.max(...rows.map(...))：成交记录上万条时会直接爆参数栈
  let colCount = 1
  for (const row of rows) {
    if (row.length > colCount) colCount = row.length
  }
  for (const img of images) {
    if (img.col + 1 > colCount) colCount = img.col + 1
  }
  for (const img of cellImages) {
    if (img.col + 1 > colCount) colCount = img.col + 1
  }
  const lastRef = `${colName(colCount - 1)}${rows.length}`
  const sheetName = sanitizeSheetName(sheet.name)
  let snapshotName = hasSnapshot ? sanitizeSheetName(snapshot!.name) : null
  if (snapshotName && snapshotName === sheetName) {
    snapshotName = sanitizeSheetName(`${sheetName} 2`)
  }
  const imageRows = new Set([
    ...images.map((img) => img.row),
    ...cellImages.map((img) => img.row)
  ])
  const cellImageByPos = new Map<string, number>()
  cellImages.forEach((img, i) => cellImageByPos.set(`${img.row}:${img.col}`, i))

  const cols = Array.from({ length: colCount }, (_, i) => {
    const width = sheet.columnWidths?.[i] && sheet.columnWidths[i] > 0 ? sheet.columnWidths[i] : 14
    return `<col min="${i + 1}" max="${i + 1}" width="${width}" customWidth="1"/>`
  }).join('')

  const rowsXml = rows
    .map((row, r) => {
      // 第 1 行固定是表头；数据行统一带细边框
      const style = r === 0 ? 1 : 2
      const cells = Array.from({ length: colCount }, (_, c) => {
        const cellImageIndex = cellImageByPos.get(`${r}:${c}`)
        if (cellImageIndex != null) {
          return `<c r="${colName(c)}${r + 1}" s="${style}" t="e" vm="${cellImageIndex + 1}"><v>#VALUE!</v></c>`
        }
        return cellXml(`${colName(c)}${r + 1}`, row[c], style)
      }).join('')
      const height =
        r === 0
          ? ' ht="20" customHeight="1"'
          : imageRows.has(r)
            ? ` ht="${IMAGE_ROW_HEIGHT_PT}" customHeight="1"`
            : ''
      return `<row r="${r + 1}"${height}>${cells}</row>`
    })
    .join('')

  const sheetXml = `${XML_HEADER}
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"${images.length > 0 ? ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"' : ''}>
  <dimension ref="A1:${lastRef}"/>
  <sheetViews>
    <sheetView tabSelected="1" workbookViewId="0">
      <pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>
      <selection pane="bottomLeft" activeCell="A2" sqref="A2"/>
    </sheetView>
  </sheetViews>
  <sheetFormatPr defaultRowHeight="15"/>
  <cols>${cols}</cols>
  <sheetData>${rowsXml}</sheetData>
  <autoFilter ref="A1:${lastRef}"/>
  ${images.length > 0 ? '<drawing r:id="rId1"/>' : ''}
</worksheet>`

  const sheetRelsXml = `${XML_HEADER}
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing1.xml"/>
</Relationships>`

  const drawing = images.length > 0
    ? drawingXml(images, sheet.columnWidths, IMAGE_ROW_HEIGHT_PT, 14)
    : ''
  const drawingRels = images.length > 0 ? drawingRelsXml(images, 1) : ''

  const hasCellImages = cellImages.length > 0
  const cellMediaStart = 1 + images.length + snapshotImages.length
  const richParts = hasCellImages ? cellImageParts(cellImages, cellMediaStart) : null

  /** 大图页：A1 是「返回明细」链接，下面一行一张原尺寸截图 */
  let snapshotXml = ''
  let snapshotRelsXml = ''
  let snapshotDrawing = ''
  let snapshotDrawingRels = ''
  const backLabel = `← ${sheetName}`
  if (hasSnapshot && snapshotName) {
    const snapshotRows = [
      `<row r="1" ht="24" customHeight="1">${cellXml('A1', backLabel, 1)}</row>`,
      ...snapshotImages.map((_img, i) => {
        const r = 2 + i
        return `<row r="${r}" ht="${SNAPSHOT_ROW_HEIGHT_PT}" customHeight="1">${cellXml(
          `A${r}`,
          '',
          2
        )}</row>`
      })
    ].join('')
    snapshotXml = `${XML_HEADER}
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <dimension ref="A1:A${1 + snapshotImages.length}"/>
  <sheetViews><sheetView workbookViewId="0"/></sheetViews>
  <sheetFormatPr defaultRowHeight="15"/>
  <cols><col min="1" max="1" width="${SNAPSHOT_COL_WIDTH}" customWidth="1"/></cols>
  <sheetData>${snapshotRows}</sheetData>
  <hyperlinks><hyperlink ref="A1" location="${escapeXml(
    quoteSheetName(sheetName)
  )}!A1" display="${escapeXml(backLabel)}"/></hyperlinks>
  <drawing r:id="rId1"/>
</worksheet>`
    snapshotRelsXml = `${XML_HEADER}
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing2.xml"/>
</Relationships>`
    snapshotDrawing = drawingXml(
      snapshotImages,
      [SNAPSHOT_COL_WIDTH],
      SNAPSHOT_ROW_HEIGHT_PT,
      SNAPSHOT_COL_WIDTH
    )
    snapshotDrawingRels = drawingRelsXml(snapshotImages, 1 + images.length)
  }

  const sheetEntriesXml = hasSnapshot
    ? `<sheet name="${escapeXml(sheetName)}" sheetId="1" r:id="rId1"/><sheet name="${escapeXml(
        snapshotName!
      )}" sheetId="2" r:id="rId2"/>`
    : `<sheet name="${escapeXml(sheetName)}" sheetId="1" r:id="rId1"/>`
  const workbookXml = `${XML_HEADER}
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets>${sheetEntriesXml}</sheets>
</workbook>`

  const relStart = hasSnapshot ? 4 : 3
  const cellRelXml = hasCellImages
    ? `<Relationship Id="rId${relStart}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sheetMetadata" Target="metadata.xml"/>
  <Relationship Id="rId${relStart + 1}" Type="http://schemas.microsoft.com/office/2022/10/relationships/richValueRel" Target="richData/richValueRel.xml"/>
  <Relationship Id="rId${relStart + 2}" Type="http://schemas.microsoft.com/office/2017/06/relationships/rdRichValue" Target="richData/rdrichvalue.xml"/>
  <Relationship Id="rId${relStart + 3}" Type="http://schemas.microsoft.com/office/2017/06/relationships/rdRichValueStructure" Target="richData/rdrichvaluestructure.xml"/>
  <Relationship Id="rId${relStart + 4}" Type="http://schemas.microsoft.com/office/2017/06/relationships/rdRichValueTypes" Target="richData/rdRichValueTypes.xml"/>`
    : ''
  const workbookRelsXml = `${XML_HEADER}
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
  ${
    hasSnapshot
      ? '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/>'
      : ''
  }
  <Relationship Id="${hasSnapshot ? 'rId3' : 'rId2'}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
  ${cellRelXml}
</Relationships>`

  const rootRelsXml = `${XML_HEADER}
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`

  const hasImages = images.length > 0 || hasSnapshot || hasCellImages
  const contentTypesXml = `${XML_HEADER}
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  ${hasImages ? '<Default Extension="png" ContentType="image/png"/>' : ''}
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  ${
    hasSnapshot
      ? '<Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
      : ''
  }
  <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
  ${
    images.length > 0
      ? '<Override PartName="/xl/drawings/drawing1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>'
      : ''
  }
  ${
    hasSnapshot
      ? '<Override PartName="/xl/drawings/drawing2.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>'
      : ''
  }
  ${
    hasCellImages
      ? `<Override PartName="/xl/metadata.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheetMetadata+xml"/>
  <Override PartName="/xl/richData/rdRichValueTypes.xml" ContentType="application/vnd.ms-excel.rdrichvaluetypes+xml"/>
  <Override PartName="/xl/richData/rdrichvalue.xml" ContentType="application/vnd.ms-excel.rdrichvalue+xml"/>
  <Override PartName="/xl/richData/rdrichvaluestructure.xml" ContentType="application/vnd.ms-excel.rdrichvaluestructure+xml"/>
  <Override PartName="/xl/richData/richValueRel.xml" ContentType="application/vnd.ms-excel.richvaluerel+xml"/>`
      : ''
  }
</Types>`

  const entries: ZipEntry[] = [
    { name: '[Content_Types].xml', data: Buffer.from(contentTypesXml, 'utf8') },
    { name: '_rels/.rels', data: Buffer.from(rootRelsXml, 'utf8') },
    { name: 'xl/workbook.xml', data: Buffer.from(workbookXml, 'utf8') },
    { name: 'xl/_rels/workbook.xml.rels', data: Buffer.from(workbookRelsXml, 'utf8') },
    { name: 'xl/styles.xml', data: Buffer.from(STYLES_XML, 'utf8') },
    { name: 'xl/worksheets/sheet1.xml', data: Buffer.from(sheetXml, 'utf8') }
  ]
  if (images.length > 0) {
    entries.push(
      { name: 'xl/worksheets/_rels/sheet1.xml.rels', data: Buffer.from(sheetRelsXml, 'utf8') },
      { name: 'xl/drawings/drawing1.xml', data: Buffer.from(drawing, 'utf8') },
      { name: 'xl/drawings/_rels/drawing1.xml.rels', data: Buffer.from(drawingRels, 'utf8') }
    )
    images.forEach((img, i) => {
      entries.push({ name: `xl/media/image${i + 1}.png`, data: img.data })
    })
  }
  if (hasSnapshot && snapshotName) {
    entries.push(
      { name: 'xl/worksheets/sheet2.xml', data: Buffer.from(snapshotXml, 'utf8') },
      { name: 'xl/worksheets/_rels/sheet2.xml.rels', data: Buffer.from(snapshotRelsXml, 'utf8') },
      { name: 'xl/drawings/drawing2.xml', data: Buffer.from(snapshotDrawing, 'utf8') },
      {
        name: 'xl/drawings/_rels/drawing2.xml.rels',
        data: Buffer.from(snapshotDrawingRels, 'utf8')
      }
    )
    snapshotImages.forEach((img, i) => {
      entries.push({ name: `xl/media/image${1 + images.length + i}.png`, data: img.data })
    })
  }
  if (hasCellImages && richParts) {
    entries.push(
      { name: 'xl/metadata.xml', data: Buffer.from(richParts.metadata, 'utf8') },
      { name: 'xl/richData/richValueRel.xml', data: Buffer.from(richParts.richValueRel, 'utf8') },
      {
        name: 'xl/richData/_rels/richValueRel.xml.rels',
        data: Buffer.from(richParts.rels, 'utf8')
      },
      { name: 'xl/richData/rdrichvalue.xml', data: Buffer.from(richParts.richValues, 'utf8') },
      { name: 'xl/richData/rdrichvaluestructure.xml', data: Buffer.from(richParts.structure, 'utf8') },
      {
        name: 'xl/richData/rdRichValueTypes.xml',
        data: Buffer.from(RICH_VALUE_TYPES_XML, 'utf8')
      }
    )
    cellImages.forEach((img, i) => {
      entries.push({ name: `xl/media/image${cellMediaStart + i}.png`, data: img.data })
    })
  }
  return zip(entries)
}
