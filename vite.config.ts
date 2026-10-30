import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { viteSingleFile } from 'vite-plugin-singlefile'

// 构建时间戳。双击打开的是本地文件，浏览器缓存特别容易让人对着旧页面调 bug，
// 页脚显示出来，一眼就能确认自己跑的是哪一版。
const buildTime = new Date().toLocaleString('zh-CN', { hour12: false })

// https://vite.dev/config/
export default defineConfig({
  // 相对路径打包：构建产物里的 index.html 双击即可打开，不需要任何服务器。
  base: './',
  define: {
    __BUILD_TIME__: JSON.stringify(buildTime),
  },
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
