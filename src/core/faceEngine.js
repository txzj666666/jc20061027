/**
 * faceEngine.js —— 本地人脸检测 + 7 类表情识别引擎封装
 * ==================================================================
 * 【使用的算法/模型（全部浏览器本地推理，人脸像素不发往任何服务器）】
 *
 * 1. 人脸检测：Tiny Face Detector（Garcia，MobileNetV2-SSD 的单尺度轻量版）
 *    权重：public/models/tiny_face_detector_model.bin（约 190KB）
 *    输入 320×320，输出人脸框 + 置信度 score ∈ [0,1]。
 *    选它的理由：WebGL 下单帧 5~15ms，可支撑 10fps 实时识别；
 *    精度不够时可一键切换 SSD MobileNetV1（README「模型升级」）。
 *
 * 2. 表情分类：Face Expression Network
 *    结构：MobileNet-V1( depthwise separable conv ) 主干 + 1 个全连接层，
 *          输入 64×64×1 灰度人脸裁剪图，输出 7 类 logits → softmax：
 *          neutral / happy / sad / angry / fearful / disgusted / surprised
 *    权重：public/models/face_expression_model.bin（约 320KB）
 *    训练数据：原始 face-api.js 使用 FER-2013 等公开表情数据集微调，
 *              官方报告 7 类 Top-1 约 65%~72%（FER-2013 SOTA 区间），
 *              因此本系统额外做了「多帧时序聚合 + 滞回判定」来补偿单帧误差，
 *              见 core/emotionTracker.js。
 *
 * 3. 68 点人脸关键点（可选，Face Landmark 68 Network）
 *    用途：绘制人脸轮廓 + 估算头部倾斜角，作为「有效帧」的质量门控之一。
 *
 * 推理管线（每一帧）：
 *   采集源(img/video/canvas)
 *     → 等比缩放(letterbox)到 320×320 工作画布
 *     → TinyFaceDetector 检测
 *     → 对每张人脸：按框裁剪 → 64×64 灰度 → ExpressionNet → softmax 概率向量
 *     → 质量门控（检测分 / 人脸面积占比 / 清晰度 / 倾斜角）
 *     → 送入时序聚合器
 */
import { reactive } from 'vue'
import { faceConfig } from '../config/app'
import { EMOTION_ORDER } from '../config/emotions'

const MODEL_BASE_URL = `${import.meta.env.BASE_URL || '/'}models`.replace(/\/+$/, '')

export const engine = reactive({
  status: 'idle', // idle | loading | ready | error
  progress: '',
  error: '',
  backend: '',
  deviceName: '',
  modelsLoaded: [],
  lastInferenceMs: 0,
  version: ''
})

/** 等待 index.html 里的 <script src="/face-api/face-api.js"> 就绪 */
function waitForFaceApi(timeout = 15000) {
  return new Promise((resolve, reject) => {
    if (window.faceapi) return resolve(window.faceapi)
    const t0 = performance.now()
    const timer = setInterval(() => {
      if (window.faceapi) {
        clearInterval(timer)
        resolve(window.faceapi)
      } else if (performance.now() - t0 > timeout) {
        clearInterval(timer)
        reject(new Error('face-api.js 未能加载：请确认已执行 npm run setup（public/face-api/face-api.js 是否存在）'))
      }
    }, 60)
  })
}

let faceapi = null
let detectOptions = null
let workCanvas = null // letterbox 后的 320×320 推理输入
let faceCanvas = null // 64×64 灰度：清晰度评估用
let landmarkNetReady = false

/** 后端选择：优先 WebGL（GPU 加速），不可用则 CPU。绝不使用远端服务。 */
async function pickBackend() {
  const tf = faceapi.tf
  const candidates = ['webgl', 'cpu']
  for (const name of candidates) {
    try {
      await tf.setBackend(name)
      await tf.ready()
      if (tf.getBackend() === name) {
        engine.backend = name
        const gl = name === 'webgl' ? document.createElement('canvas').getContext('webgl2') || document.createElement('canvas').getContext('webgl') : null
        const dbg = gl && gl.getExtension('WEBGL_debug_renderer_info')
        engine.deviceName = dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)).slice(0, 60) : name === 'webgl' ? 'WebGL' : 'CPU (JavaScript)'
        return
      }
    } catch (_) {
      /* 继续尝试下一个后端 */
    }
  }
  engine.backend = tf.getBackend?.() || 'unknown'
  engine.deviceName = engine.backend
}

/**
 * 加载模型权重（从本站 public/models/ 读取，即本地文件）
 * @param {{withLandmarks?:boolean}} opts
 */
export async function initModels(opts = {}) {
  if (engine.status === 'ready') return
  try {
    engine.status = 'loading'
    engine.error = ''
    engine.progress = '加载 face-api.js 运行时…'
    faceapi = await waitForFaceApi()
    engine.version = faceapi.version?.tfjs || 'face-api'

    engine.progress = '初始化推理后端…'
    await pickBackend()

    // 工作画布固定尺寸，避免每帧重建
    workCanvas = document.createElement('canvas')
    workCanvas.width = workCanvas.height = faceConfig.inputSize

    if (opts.withLandmarks) {
      engine.progress = '加载人脸检测模型 + 表情模型 + 关键点模型…'
      await faceapi.nets.faceLandmark68Net.loadFromUri(MODEL_BASE_URL)
      landmarkNetReady = true
    } else {
      engine.progress = '加载人脸检测模型 + 表情模型…'
    }

    await faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_BASE_URL)
    engine.modelsLoaded.push('tiny_face_detector')
    await faceapi.nets.faceExpressionNet.loadFromUri(MODEL_BASE_URL)
    engine.modelsLoaded.push('face_expression')
    if (landmarkNetReady) engine.modelsLoaded.push('face_landmark_68')

    detectOptions = new faceapi.TinyFaceDetectorOptions({
      inputSize: faceConfig.inputSize,
      scoreThreshold: faceConfig.scoreThreshold
    })

    // 预热：首次推理会触发 shader 编译，先跑一张纯色图，
    // 让后续 FPS / 耗时统计反映真实速度而不是冷启动
    engine.progress = '推理预热…'
    const ctx = workCanvas.getContext('2d')
    ctx.fillStyle = '#20242c'
    ctx.fillRect(0, 0, workCanvas.width, workCanvas.height)
    await faceapi.detectAllFaces(workCanvas, detectOptions).withFaceExpressions()

    engine.status = 'ready'
    engine.progress = '模型就绪'
  } catch (err) {
    engine.status = 'error'
    engine.error = err?.message || String(err)
    throw err
  }
}

/**
 * 把任意采集源等比绘制到正方形工作画布（letterbox，黑边补齐）。
 * 这样人脸框坐标与源图像坐标之间是仿射关系，映射回显示区域是确定的。
 */
function drawToWorkCanvas(source, srcW, srcH) {
  const S = faceConfig.inputSize
  const ctx = workCanvas.getContext('2d', { willReadFrequently: true })
  const scale = Math.min(S / srcW, S / srcH)
  const dw = srcW * scale
  const dh = srcH * scale
  const ox = (S - dw) / 2
  const oy = (S - dh) / 2
  ctx.fillStyle = '#000'
  ctx.fillRect(0, 0, S, S)
  ctx.drawImage(source, ox, oy, dw, dh)
  return { scale, ox, oy, dw, dh, S }
}

/**
 * 清晰度评估：对人脸区域做拉普拉斯算子方差（Variance of Laplacian）。
 * 方差越低越模糊。用于给「有效帧」加权，避免糊脸时乱给情绪结论。
 */
function blurScore(box) {
  const size = 64
  if (!faceCanvas) {
    faceCanvas = document.createElement('canvas')
    faceCanvas.width = faceCanvas.height = size
  }
  const fctx = faceCanvas.getContext('2d', { willReadFrequently: true })
  fctx.drawImage(workCanvas, box.x, box.y, box.width, box.height, 0, 0, size, size)
  const { data } = fctx.getImageData(0, 0, size, size)
  const gray = new Float32Array(size * size)
  for (let i = 0; i < data.length; i += 4) gray[i >> 2] = (data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114) / 255
  let sum = 0
  let sumSq = 0
  let n = 0
  // ∇²I = I(x-1,y)+I(x+1,y)+I(x,y-1)+I(x,y+1) - 4I(x,y)
  for (let y = 1; y < size - 1; y++) {
    for (let x = 1; x < size - 1; x++) {
      const i = y * size + x
      const lap = gray[i - 1] + gray[i + 1] + gray[i - size] + gray[i + size] - 4 * gray[i]
      sum += lap
      sumSq += lap * lap
      n++
    }
  }
  const variance = sumSq / n - (sum / n) ** 2
  return Math.min(1, variance / 0.05) // 归一化到 0~1，0.05 为经验满分方差
}

/** 参数面板改了 inputSize / scoreThreshold 后无需刷新页面即可生效 */
let optKey = ''
function ensureDetectOptions() {
  const key = `${faceConfig.inputSize}|${faceConfig.scoreThreshold}`
  if (key === optKey && detectOptions) return
  workCanvas.width = workCanvas.height = faceConfig.inputSize
  detectOptions = new faceapi.TinyFaceDetectorOptions({
    inputSize: faceConfig.inputSize,
    scoreThreshold: faceConfig.scoreThreshold
  })
  optKey = key
}

/**
 * 对一帧做完整推理
 * @param {HTMLImageElement|HTMLVideoElement|HTMLCanvasElement} source
 * @param {number} srcW 源图像固有宽度（video 用 videoWidth）
 * @param {number} srcH
 * @returns {{faces: Array, inferenceMs: number}}
 *   faces[i] = {
 *     box:      {x,y,width,height}  —— 源图像归一化坐标(0~1)，UI 乘显示尺寸即可
 *     score:    人脸检测置信度
 *     emotions: {neutral:..,happy:..,...} —— softmax 概率，和为 1
 *     quality:  {blur, tilt, areaRatio}
 *     landmarks: [[x,y],...] | null —— 源图像归一化坐标
 *   }
 */
export async function detectFaces(source, srcW, srcH) {
  if (engine.status !== 'ready' || !faceapi) throw new Error('模型尚未就绪')
  if (!srcW || !srcH) return { faces: [], inferenceMs: 0 }
  ensureDetectOptions()

  const t0 = performance.now()
  const tf = drawToWorkCanvas(source, srcW, srcH)
  const builder = faceapi
    .detectAllFaces(workCanvas, detectOptions)
    .withFaceExpressions()
  // 关键点网络启用时，需要在表达式任务之后再串接 landmark 任务（返回新的 thenable）
  const results = await (landmarkNetReady ? builder.withFaceLandmarks() : builder)

  const inferenceMs = performance.now() - t0
  engine.lastInferenceMs = inferenceMs

  const faces = (results || []).map((r) => {
    // face-api 在 TinyFaceDetector 下可能返回归一化坐标或工作画布像素坐标，两者都兼容
    const d = r.detection
    const box = d.box ?? d
    const px = {
      x: box.x <= 1.5 ? box.x * tf.S : box.x,
      y: box.y <= 1.5 ? box.y * tf.S : box.y,
      width: box.width <= 1.5 ? box.width * tf.S : box.width,
      height: box.height <= 1.5 ? box.height * tf.S : box.height
    }
    // 逆向 letterbox：工作画布像素 → 源图像归一化坐标
    const norm = {
      x: (px.x - tf.ox) / tf.dw,
      y: (px.y - tf.oy) / tf.dh,
      width: px.width / tf.dw,
      height: px.height / tf.dh
    }

    // 概率向量按 EMOTION_ORDER 重新取值（不依赖对象键序）
    const raw = r.expressions || d.expressions || {}
    const emotions = {}
    let sum = 0
    for (const k of EMOTION_ORDER) {
      const v = Number(raw[k] ?? 0)
      emotions[k] = v
      sum += v
    }
    if (sum > 0) for (const k of EMOTION_ORDER) emotions[k] /= sum // 数值兜底，保证是分布

    // 头部倾斜角（用双眼连线估算），±20° 以内认为姿态可用
    let tilt = 0
    let landmarks = null
    const lm = r.landmarks?.landmarks || r.landmarks
    if (lm && lm.length >= 68) {
      landmarks = lm.map((p) => ({
        x: (p.x * tf.S - tf.ox) / tf.dw,
        y: (p.y * tf.S - tf.oy) / tf.dh
      }))
      // 68 点里：左眼外角 36 / 右眼外角 45，内角 39 / 51
      const l = landmarks[36]
      const rr = landmarks[45]
      if (l && rr) tilt = (Math.atan2(l.y - rr.y, l.x - rr.x) * 180) / Math.PI
    }

    const areaRatio = Math.max(0, Math.min(1, norm.width * norm.height))
    return {
      box: norm,
      score: d.score ?? 0,
      emotions,
      landmarks,
      quality: {
        blur: blurScore(px, tf),
        tilt: Math.abs(tilt),
        areaRatio
      }
    }
  })

  // 面积最大的人脸作为主脸（离镜头最近的人通常是使用者本人）
  faces.sort((a, b) => b.quality.areaRatio * b.score - a.quality.areaRatio * a.score)
  return { faces, inferenceMs }
}

/** 质量门控：决定这一帧的情绪结果是否可信 */
export function frameUsable(face) {
  return (
    face.score >= faceConfig.minDetScore &&
    face.quality.areaRatio >= faceConfig.minFaceAreaRatio &&
    face.quality.blur >= 0.08 &&
    face.quality.tilt <= 35
  )
}

/** 供 UI 显示模型加载来源，强调"本地推理" */
export const modelBaseUrl = MODEL_BASE_URL
