/// <reference types="vite/client" />

declare global {
  /**
   * 由 electron.vite.config.ts 从 package.json 注入，构建期替换成字面量。
   * 界面上任何要显示版本号的地方都读这个常量，不要另写字符串。
   */
  const __APP_VERSION__: string

  interface Window {
    api: import('../../../preload/index').Api
  }
}

export {}
