declare module 'lzma' {
  interface LzmaModule {
    decompress(
      input: Buffer | Uint8Array | string,
      onFinish: (result: unknown, error: unknown) => void,
      onProgress?: (percent: number) => void
    ): void
    compress(
      input: Buffer | Uint8Array | string,
      mode: number,
      onFinish: (result: unknown, error: unknown) => void,
      onProgress?: (percent: number) => void
    ): void
  }
  const lzma: LzmaModule
  export default lzma
}
