/// <reference types="vite/client" />

declare global {
  interface Window {
    api: import('../../../preload/index').Api
  }
}

export {}
