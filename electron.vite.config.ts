import { resolve } from 'path'
import { readFileSync } from 'fs'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

/**
 * 版本号只有 package.json 一个来源。
 * 以前「设置 → 关于」里写死了一个字符串，跟 package.json 各说各话，
 * 打包出来的安装包版本和界面显示的版本对不上。这里注入进去，只留一处真相。
 */
const { version } = JSON.parse(readFileSync(resolve('package.json'), 'utf-8'))

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    define: {
      __APP_VERSION__: JSON.stringify(version)
    },
    resolve: {
      alias: {
        '@shared': resolve('src/shared')
      }
    },
    build: {
      rollupOptions: {
        input: {
          // 主进程入口
          index: resolve('src/main/index.ts'),
          // bi5 解压 worker（独立线程，避免解压占满主线程）
          'bi5-decode.worker': resolve('src/main/workers/bi5-decode.worker.ts')
        }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    define: {
      __APP_VERSION__: JSON.stringify(version)
    },
    resolve: {
      alias: {
        '@shared': resolve('src/shared')
      }
    }
  },
  renderer: {
    plugins: [react()],
    define: {
      __APP_VERSION__: JSON.stringify(version)
    },
    resolve: {
      alias: {
        '@': resolve('src/renderer/src'),
        '@shared': resolve('src/shared')
      }
    }
  }
})
