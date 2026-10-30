import React from 'react'
import logoUrl from '../../assets/logo.svg'

/**
 * TraderRewind 品牌标识。
 *
 * 图形本体是一份 SVG（src/renderer/src/assets/logo.svg），
 * 打包用的 build/icon.ico / icon.png 也由同一份文件生成（见 scripts/make-icons.mjs）——
 * 以后换品牌只改那一个文件，界面和安装包不会走散。
 */
export function Logo({
  size = 28,
  className
}: {
  size?: number
  className?: string
}): React.JSX.Element {
  return (
    <img
      src={logoUrl}
      width={size}
      height={size}
      alt="TraderRewind"
      draggable={false}
      // 图标自带圆角底板，不用再套 rounded，否则会多一层裁切
      className={className}
      style={{ width: size, height: size }}
    />
  )
}
