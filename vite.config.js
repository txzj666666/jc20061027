import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

/**
 * Vite 配置
 * ------------------------------------------------------------------
 * 1) 人脸/情绪推理 100% 在浏览器本地进行（face-api.js + TensorFlow.js），
 *    开发服务器不做任何图片转发，人脸数据不出本机。
 * 2) 下面两个 proxy 仅用于「在线歌曲 API」的跨域兜底：
 *    浏览器直连第三方音乐接口常被 CORS 拦截，dev 环境可改走本地代理。
 *    生产部署时把同样的规则配到 Nginx / CDN 即可。
 */
export default defineConfig({
  plugins: [vue()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    open: true,
    proxy: {
      // Meting 公网聚合接口（网易云/QQ/酷狗 搜索），可通过 /meting 前缀绕开 CORS
      '/meting': {
        target: 'https://api.injahow.cn',
        changeOrigin: true,
        // /meting/meting/?... -> https://api.injahow.cn/meting/?...
        rewrite: (p) => p.replace(/^\/meting/, '')
      },
      // 自建 NeteaseCloudMusicApi 时的代理（默认 http://127.0.0.1:3000）
      '/ncm': {
        target: 'http://127.0.0.1:3000',
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/ncm/, '')
      }
    }
  },
  build: {
    outDir: 'dist',
    // face-api.min 以 <script> 形式放在 public/ 下，不参与打包，因此主包很小
    chunkSizeWarningLimit: 1024
  }
})
