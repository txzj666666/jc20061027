/**
 * setup-assets.mjs
 * ------------------------------------------------------------------
 * 把 face-api.js 运行时 + 预训练模型权重从 node_modules 复制到 public/，
 * 这样模型完全随项目本地分发，识别过程不请求任何远端服务。
 *
 *   node_modules/@vladmandic/face-api/dist/face-api.js  -> public/face-api/face-api.js
 *   node_modules/@vladmandic/face-api/model/*.json|.bin -> public/models/
 *
 * 需要手动下载模型时的镜像地址见 README「模型文件下载地址」。
 */
import { cpSync, existsSync, mkdirSync, readdirSync, copyFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '..')

// 只复制本项目用到的三个网络，避免 public/ 里塞进无用的 100MB+ 权重
const NEEDED_PREFIXES = [
  'tiny_face_detector_model', // 人脸检测（MobileNetV2-SSD 的轻量版）
  'face_expression_model', //  7 类表情分类器（本系统核心）
  'face_landmark_68_model' //  可选：68 点特征，用于人脸质量评估与对齐
]

const srcRoot = path.join(root, 'node_modules', '@vladmandic', 'face-api')
const srcModel = path.join(srcRoot, 'model')
const srcDist = path.join(srcRoot, 'dist', 'face-api.js')

const dstModelDir = path.join(root, 'public', 'models')
const dstLibDir = path.join(root, 'public', 'face-api')

if (!existsSync(srcRoot)) {
  console.warn('[setup] 未找到 @vladmandic/face-api，请先执行 npm install')
  process.exit(0)
}

mkdirSync(dstModelDir, { recursive: true })
mkdirSync(dstLibDir, { recursive: true })

// 1) 运行时库
const dstLib = path.join(dstLibDir, 'face-api.js')
if (existsSync(srcDist)) {
  copyFileSync(srcDist, dstLib)
  console.log(`[setup] face-api.js ${(statSync(srcDist).size / 1024 / 1024).toFixed(2)}MB -> public/face-api/`)
} else {
  console.warn('[setup] dist/face-api.js 缺失，将回退 CDN')
}

// 2) 模型权重（manifest.json + .bin）
let bytes = 0
let count = 0
for (const file of readdirSync(srcModel)) {
  // face_expression_model.bin / face_expression_model-weights_manifest.json -> face_expression_model
  const base = path.parse(file).name.replace(/-weights_manifest$/, '')
  if (!NEEDED_PREFIXES.includes(base)) continue
  const from = path.join(srcModel, file)
  const to = path.join(dstModelDir, file)
  copyFileSync(from, to)
  bytes += statSync(from).size
  count++
}
console.log(
  `[setup] ${count} 个模型文件 ${(bytes / 1024 / 1024).toFixed(1)}MB -> public/models/（浏览器本地推理，人脸数据不出机器）`
)
