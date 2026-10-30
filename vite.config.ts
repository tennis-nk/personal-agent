import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { viteSingleFile } from 'vite-plugin-singlefile'

// https://vite.dev/config/
export default defineConfig({
  // 相对路径打包：构建产物里的 index.html 双击即可打开，不需要任何服务器。
  base: './',
  plugins: [react(), viteSingleFile()],
  build: {
    // 单机自用，产物就一个 HTML 文件，保留 sourcemap 没有意义。
    assetsInlineLimit: 100 * 1024 * 1024,
    cssCodeSplit: false,
    reportCompressedSize: false,
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
  },
  preview: {
    host: '127.0.0.1',
    port: 5173,
  },
})
