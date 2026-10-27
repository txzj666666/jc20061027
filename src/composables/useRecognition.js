/**
 * useRecognition.js —— 四种采集方式 + 识别循环的调度中枢
 * ==================================================================
 * mode:
 *   'image'    上传静态图片（单帧分析）
 *   'video'    播放本地视频文件（连续帧分析，与摄像头同一套时序聚合）
 *   'camera'   实时摄像头（getUserMedia 连续帧）
 *   'snapshot' 摄像头拍照 → 冻结成静态图单帧分析
 *
 * 隐私边界：source 元素自始至终只在浏览器内存里，
 * detectFaces() 把像素喂给本地 WebGL 模型，全站没有任何一处
 * 把 imageData / blob 通过 fetch 发出去（在线 API 只发文字关键词）。
 */
import { reactive } from 'vue'
import { detectFaces, frameUsable, engine, initModels } from '../core/faceEngine'
import { EmotionTracker } from '../core/emotionTracker'
import { faceConfig } from '../config/app'
import { recommend, session, toast } from '../stores/session'
import { EMOTIONS } from '../config/emotions'

export const recognition = reactive({
  mode: 'camera',
  phase: 'idle', // idle | loading | running | paused | error | done
  status: 'idle', // idle | noface | weakface | ok
  error: '',
  hint: '',
  faces: [],
  snapshot: null,
  fps: 0,
  inferenceMs: 0,
  sourceLabel: '',
  hasSource: false,
  stillUrl: '', // 图片/拍照的展示地址
  videoUrl: '', // 本地视频文件的 ObjectURL
  faceCount: 0,
  cameraStream: null,
  cameraError: '',
  devices: [],
  deviceId: '',
  facingMode: 'user'
})

const tracker = new EmotionTracker()
let sourceEl = null // 当前用于推理的 HTMLImageElement | HTMLVideoElement
let rafId = 0
let lastAt = 0
let busy = false
let fpsWindow = []
let lastCommitted = ''

// ------------------------------------------------------------ 模型准备
export async function prepareModels(withLandmarks = faceConfig.withLandmarks) {
  if (engine.status === 'ready') return
  recognition.phase = 'loading'
  recognition.error = ''
  try {
    await initModels({ withLandmarks })
    recognition.phase = recognition.hasSource ? 'running' : 'idle'
  } catch (e) {
    recognition.phase = 'error'
    recognition.error = e.message || String(e)
    toast(`模型加载失败：${recognition.error}`, 'error', 8000)
    throw e
  }
}

// ------------------------------------------------------------ 循环控制
function loop() {
  rafId = requestAnimationFrame(loop)
  if (recognition.phase !== 'running' || busy || !sourceEl) return
  const now = performance.now()
  if (now - lastAt < faceConfig.intervalMs) return
  lastAt = now
  runFrame(now)
}

async function runFrame(now) {
  busy = true
  try {
    const w = sourceEl.naturalWidth || sourceEl.videoWidth || sourceEl.width
    const h = sourceEl.naturalHeight || sourceEl.videoHeight || sourceEl.height
    const { faces, inferenceMs } = await detectFaces(sourceEl, w, h)
    recognition.faces = faces
    recognition.faceCount = faces.length
    recognition.inferenceMs = inferenceMs

    fpsWindow.push(now)
    fpsWindow = fpsWindow.filter((t) => now - t < 1000)
    recognition.fps = fpsWindow.length

    const best = faces[0]
    const usable = best && frameUsable(best) ? best : null
    const snap = tracker.push(usable, now)
    recognition.snapshot = snap
    session.snapshot = snap
    session.lastFaceAt = usable ? now : session.lastFaceAt

    if (!faces.length) {
      recognition.status = 'noface'
      recognition.hint = '未检测到人脸：请把脸正对镜头、保证光线充足且充满画面中央'
    } else if (!usable) {
      recognition.status = 'weakface'
      recognition.hint = qualityHint(best)
    } else {
      recognition.status = 'ok'
      recognition.hint = ''
      // 情绪被"确认切换"时才触发推荐，避免列表抖动
      if (snap.settled && snap.label !== lastCommitted) {
        lastCommitted = snap.label
        recommend(snap)
      }
    }
  } catch (e) {
    recognition.phase = 'error'
    recognition.error = String(e.message || e)
  } finally {
    busy = false
  }
}

/** 把质量门控失败的原因翻译成人话 */
function qualityHint(face) {
  if (!face) return '未检测到人脸'
  if (face.score < faceConfig.minDetScore) return '人脸不够清晰/完整，请靠近一点'
  if (face.quality.areaRatio < faceConfig.minFaceAreaRatio) return '人脸在画面中太小，请靠近镜头'
  if (face.quality.blur < 0.08) return '画面模糊，请对焦或提高光线'
  if (face.quality.tilt > 35) return '侧脸/低头角度过大，请正对镜头'
  return '当前帧可信度不足，已跳过'
}

function startLoop() {
  stopLoop()
  recognition.phase = 'running'
  lastAt = 0
  fpsWindow = []
  rafId = requestAnimationFrame(loop)
}

function stopLoop() {
  if (rafId) cancelAnimationFrame(rafId)
  rafId = 0
  recognition.phase = recognition.hasSource ? 'paused' : 'idle'
}

export function pauseRecognition() {
  stopLoop()
  recognition.faces = []
}

// ------------------------------------------------------------ 静态单帧
/**
 * 图片 / 拍照共用：单帧识别 → 直接用同一套输出结构喂给推荐
 */
export async function analyzeStill(el, label) {
  recognition.phase = 'loading'
  clearDiagnostics()
  try {
    if (engine.status !== 'ready') await initModels({ withLandmarks: faceConfig.withLandmarks })
    const w = el.naturalWidth || el.videoWidth || el.width
    const h = el.naturalHeight || el.videoHeight || el.height
    const { faces, inferenceMs } = await detectFaces(el, w, h)
    recognition.faces = faces
    recognition.faceCount = faces.length
    recognition.inferenceMs = inferenceMs
    recognition.fps = 0
    sourceEl = el

    if (!faces.length) {
      recognition.status = 'noface'
      recognition.hint = '这张图片里没有检测到人脸，换一张正脸、光线好的照片试试'
      recognition.phase = 'done'
      toast('未检测到人脸', 'warn')
      return
    }
    const best = faces[0]
    const snap = EmotionTracker.fromSingleFrame(best)
    recognition.snapshot = snap
    session.snapshot = snap
    recognition.status = frameUsable(best) ? 'ok' : 'weakface'
    if (recognition.status === 'weakface') recognition.hint = qualityHint(best)
    recognition.phase = 'done'
    recognition.sourceLabel = label
    lastCommitted = snap.label
    await recommend(snap, { force: true })
  } catch (e) {
    recognition.phase = 'error'
    recognition.error = String(e.message || e)
    toast(`识别失败：${recognition.error}`, 'error', 7000)
  }
}

// ------------------------------------------------------------ 采集源接入
/** 换数据源时清掉上一轮的报错，避免"没有摄像头"这类提示残留 */
function clearDiagnostics() {
  recognition.error = ''
  recognition.cameraError = ''
  recognition.hint = ''
}

/** 把当前用于推理的元素登记为数据源（img / video 通用） */
function registerSource(el, { label = '' } = {}) {
  clearDiagnostics()
  sourceEl = el
  recognition.hasSource = true
  if (label) recognition.sourceLabel = label
  tracker.reset()
  lastCommitted = ''
  recognition.faces = []
}

export function useImageFile(file) {
  const url = URL.createObjectURL(file)
  releaseStill()
  recognition.stillUrl = url
  recognition.hasSource = true
  recognition.mode = 'image'
  recognition.sourceLabel = file.name
  const img = new Image()
  img.onload = () => analyzeStill(img, file.name)
  img.onerror = () => {
    recognition.phase = 'error'
    recognition.error = '图片解码失败，请换 jpg/png/webp 格式'
  }
  img.src = url
}

/** 内置示例照片（public/samples/，无摄像头也能立刻体验识别） */
export function useSampleImage(src, label) {
  recognition.mode = 'image'
  releaseStill()
  recognition.stillUrl = src
  recognition.hasSource = true
  recognition.sourceLabel = label
  const img = new Image()
  img.onload = () => analyzeStill(img, label)
  img.onerror = () => {
    recognition.phase = 'error'
    recognition.error = '示例图片加载失败，请确认 public/samples/ 是否存在'
  }
  img.src = src
}

export function useVideoFile(file) {
  const url = URL.createObjectURL(file)
  stopLoop()
  recognition.hasSource = true
  recognition.mode = 'video'
  recognition.stillUrl = ''
  recognition.videoUrl = url
  recognition.sourceLabel = file.name
  // CapturePanel 里的 <video :src="recognition.videoUrl"> 触发 loadeddata 后
  // 会自动调用 registerVideoElement() 并开始连续识别
}

/** CapturePanel 的 <video> 元素就绪后调用 */
export function registerVideoElement(el) {
  el.play().catch(() => {})
  registerSource(el, { label: recognition.sourceLabel })
  startContinuous()
}

export async function startContinuous() {
  await prepareModels()
  if (!sourceEl) {
    recognition.error = '还没有可用的画面源，请先选择图片或打开摄像头'
    return
  }
  tracker.reset()
  lastCommitted = ''
  startLoop()
}

// ------------------------------------------------------------ 摄像头
export async function listCameras() {
  try {
    const devs = await navigator.mediaDevices.enumerateDevices()
    recognition.devices = devs.filter((d) => d.kind === 'videoinput')
  } catch {
    recognition.devices = []
  }
}

export async function openCamera(videoEl, { deviceId = '', facingMode = recognition.facingMode } = {}) {
  if (!navigator.mediaDevices?.getUserMedia) {
    recognition.cameraError = '当前浏览器不支持 getUserMedia（需 https 或 localhost 环境）'
    toast(recognition.cameraError, 'error', 6000)
    return false
  }
  recognition.phase = 'loading'
  recognition.cameraError = ''
  closeCamera()
  const constraints = {
    audio: false,
    video: {
      width: { ideal: 640 },
      height: { ideal: 480 },
      ...(deviceId ? { deviceId: { exact: deviceId } } : { facingMode })
    }
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia(constraints)
    recognition.cameraStream = stream
    videoEl.srcObject = stream
    await videoEl.play()
    registerSource(videoEl, { label: deviceId || facingMode === 'environment' ? '后置摄像头' : '前置摄像头' })
    recognition.mode = 'camera'
    await startContinuous()
    await listCameras()
    return true
  } catch (e) {
    const map = {
      NotAllowedError: '摄像头权限被拒绝：请在浏览器地址栏左侧把权限改成「允许」',
      NotFoundError: '没有可用的摄像头设备',
      NotReadableError: '摄像头被其他程序占用（微信/钉钉/Zoom 等），请先关闭它们',
      OverconstrainedError: '请求的分辨率不被设备支持，已改用默认参数重试'
    }
    recognition.cameraError = map[e.name] || `${e.name}: ${e.message}`
    recognition.phase = 'error'
    toast(`打开摄像头失败：${recognition.cameraError}`, 'error', 8000)
    if (e.name === 'OverconstrainedError') {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: true })
        videoEl.srcObject = stream
        await videoEl.play()
        registerSource(videoEl, { label: '默认摄像头' })
        await startContinuous()
        return true
      } catch (_) {
        /* 兜底也失败则保持错误态 */
      }
    }
    return false
  }
}

export function closeCamera() {
  if (recognition.cameraStream) {
    recognition.cameraStream.getTracks().forEach((t) => t.stop())
    recognition.cameraStream = null
  }
}

/**
 * 拍照：从当前摄像头画面截一帧成静态图，走单帧识别
 */
export function captureSnapshot(videoEl) {
  if (!videoEl?.videoWidth) {
    toast('请先打开摄像头再拍照', 'warn')
    return
  }
  const c = document.createElement('canvas')
  c.width = videoEl.videoWidth
  c.height = videoEl.videoHeight
  const ctx = c.getContext('2d')
  // 前置摄像头画面是镜像显示的，截图同样镜像回去，保证"看到即拍到"
  if (recognition.facingMode === 'user' && !recognition.deviceId) {
    ctx.translate(c.width, 0)
    ctx.scale(-1, 1)
  }
  ctx.drawImage(videoEl, 0, 0)
  const url = c.toDataURL('image/jpeg', 0.92)
  pauseRecognition()
  recognition.mode = 'snapshot'
  recognition.stillUrl = url
  recognition.sourceLabel = `拍照 ${new Date().toLocaleTimeString('zh-CN')}`
  const img = new Image()
  img.onload = () => analyzeStill(img, recognition.sourceLabel)
  img.src = url
}

function releaseStill() {
  if (recognition.stillUrl?.startsWith('blob:')) URL.revokeObjectURL(recognition.stillUrl)
  recognition.stillUrl = ''
}

export function resetEmotion() {
  tracker.reset()
  lastCommitted = ''
  recognition.snapshot = null
  recognition.faces = []
  session.snapshot = null
  session.target = null
  session.songs = []
  session.recStatus = 'idle'
}

/** 手动"重新推荐一次"（同一情绪下想换一批歌） */
export function reroll() {
  if (session.snapshot) recommend({ ...session.snapshot }, { force: true })
  else toast('还没有识别结果，先做一次人脸采集', 'warn')
}

export function emotionOf(key) {
  return EMOTIONS[key]
}

/** App.vue 卸载时调用：停止循环、关闭摄像头、释放 ObjectURL */
export function disposeRecognition() {
  stopLoop()
  closeCamera()
  releaseStill()
  if (recognition.videoUrl?.startsWith('blob:')) URL.revokeObjectURL(recognition.videoUrl)
  recognition.videoUrl = ''
}
