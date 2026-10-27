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
/**
 * base 用相对路径 './'：构建产物里的资源引用变成 ./assets/xxx.js，
 * 这样同一份 dist 既能放在域名根目录，也能放在 GitHub Pages 的项目子路径
 * https://<user>.github.io/<repo>/ 下，不需要为每个仓库改配置。
 * 需要绝对路径时用 VITE_BASE 覆盖，例如 VITE_BASE=/jc20061027/ npm run build
 */
export default defineConfig({
  base: process.env.VITE_BASE || './',
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
