<script setup>
/**
 * CapturePanel.vue —— 采集区：图片 / 本地视频 / 实时摄像头 / 拍照 四种入口
 * 舞台用 object-fit: contain 显示源，人脸框画在独立的 overlay canvas 上，
 * 坐标换算与 faceEngine 的 letterbox 逆变换保持一致（源归一化坐标 → 显示像素）。
 */
import { ref, computed, reactive, watch, onMounted, onBeforeUnmount, nextTick } from 'vue'
import { recognition, useImageFile, useSampleImage, useVideoFile, openCamera, closeCamera, captureSnapshot, startContinuous, pauseRecognition, registerVideoElement, prepareModels, resetEmotion, analyzeStill } from '../composables/useRecognition'
import { engine } from '../core/faceEngine'
import { EMOTIONS } from '../config/emotions'
import { toast } from '../stores/session'

const stageRef = ref(null)
const videoRef = ref(null)
const imgRef = ref(null)
const overlayRef = ref(null)
const imageInput = ref(null)
const videoInput = ref(null)
const dragOver = ref(false)

const MODES = [
  { key: 'image', label: '上传图片', icon: '🖼️' },
  { key: 'video', label: '本地视频', icon: '🎬' },
  { key: 'camera', label: '实时摄像头', icon: '📹' },
  { key: 'snapshot', label: '拍照识别', icon: '📸' }
]

// public/samples 下的 6 张 AI 合成情绪人脸（豆包生成，非真人），点一下即可直接演示
const B = import.meta.env.BASE_URL || '/'
const SAMPLES = [
  { src: `${B}samples/emo-happy.png`, emotion: 'happy' },
  { src: `${B}samples/emo-sad.png`, emotion: 'sad' },
  { src: `${B}samples/emo-angry.png`, emotion: 'angry' },
  { src: `${B}samples/emo-surprised.png`, emotion: 'surprised' },
  { src: `${B}samples/emo-fearful.png`, emotion: 'fearful' },
  { src: `${B}samples/emo-disgusted.png`, emotion: 'disgusted' }
]
const sampleLabel = (s) => `${EMOTIONS[s.emotion].label}人脸`

/** 记录每张示例图「模型实际识别成了什么」，方便演示时挑一张会被认对的脸 */
const detected = reactive({})
watch(
  () => [recognition.stillUrl, recognition.snapshot],
  ([url, snap]) => {
    if (url && snap?.facePresent) detected[url] = { label: snap.label, conf: snap.confidence }
  },
  { flush: 'post' }
)

const mirrored = computed(() => recognition.mode === 'camera' && recognition.facingMode === 'user')
const showVideo = computed(() => recognition.mode === 'video' || recognition.mode === 'camera')
const showImage = computed(() => recognition.mode === 'image' || recognition.mode === 'snapshot')
const hasVisual = computed(() => (showVideo.value && recognition.hasSource) || (showImage.value && recognition.stillUrl))
const loading = computed(() => recognition.phase === 'loading' || engine.status === 'loading')
const loadingText = computed(() => engine.progress || '正在加载本地模型…')

function setMode(m) {
  if (recognition.mode === m) return
  recognition.mode = m
  // 切换采集方式时清掉上一次的错误提示，避免残留（如"没有摄像头"）
  recognition.error = ''
  recognition.cameraError = ''
  recognition.hint = ''
  if (m !== 'camera' && recognition.cameraStream) {
    closeCamera()
    if (videoRef.value) videoRef.value.srcObject = null
  }
  if (m === 'camera' && !recognition.cameraStream) {
    // 切到摄像头模式但还没开流：保持"待开启"状态，由用户点按钮触发（浏览器权限需用户手势）
    recognition.hasSource = false
  }
}

// ---------------------------------------------------------- 文件输入
function onPickImage(e) {
  const f = e.target.files?.[0]
  if (f) pickImage(f)
  e.target.value = ''
}

function pickImage(f) {
  if (!f.type.startsWith('image/')) {
    toast('请选择图片文件（jpg / png / webp）', 'warn')
    return
  }
  recognition.mode = 'image'
  useImageFile(f)
}

function onPickVideo(e) {
  const f = e.target.files?.[0]
  if (f) pickVideo(f)
  e.target.value = ''
}

function pickVideo(f) {
  if (!f.type.startsWith('video/')) {
    toast('请选择视频文件（mp4 / webm / mov）', 'warn')
    return
  }
  recognition.mode = 'video'
  useVideoFile(f)
  nextTick(() => {
    if (videoRef.value) videoRef.value.load()
  })
}

function onDrop(e) {
  dragOver.value = false
  const f = e.dataTransfer?.files?.[0]
  if (!f) return
  if (f.type.startsWith('image/')) pickImage(f)
  else if (f.type.startsWith('video/')) pickVideo(f)
  else toast('只支持拖入图片或视频文件', 'warn')
}

// ---------------------------------------------------------- 摄像头
async function toggleCamera() {
  if (recognition.cameraStream) {
    pauseRecognition()
    closeCamera()
    if (videoRef.value) videoRef.value.srcObject = null
    recognition.hasSource = false
    recognition.phase = 'idle'
    return
  }
  recognition.mode = 'camera'
  await nextTick()
  await openCamera(videoRef.value, { deviceId: recognition.deviceId, facingMode: recognition.facingMode })
}

function flipCamera() {
  recognition.facingMode = recognition.facingMode === 'user' ? 'environment' : 'user'
  recognition.deviceId = ''
  if (recognition.cameraStream) toggleCamera().then(() => toggleCamera())
}

async function pickDevice(e) {
  recognition.deviceId = e.target.value
  if (recognition.cameraStream) {
    closeCamera()
    recognition.hasSource = false
    await openCamera(videoRef.value, { deviceId: recognition.deviceId, facingMode: recognition.facingMode })
  }
}

function shoot() {
  if (!recognition.cameraStream) {
    toast('请先打开摄像头', 'warn')
    return
  }
  captureSnapshot(videoRef.value)
}

function onVideoReady() {
  if (recognition.mode !== 'video') return
  registerVideoElement(videoRef.value)
}

// ---------------------------------------------------------- 人脸框绘制
let ro = null
function drawOverlay() {
  const stage = stageRef.value
  const cv = overlayRef.value
  if (!stage || !cv) return
  const dpr = Math.min(2, window.devicePixelRatio || 1)
  const cw = stage.clientWidth
  const ch = stage.clientHeight
  if (cv.width !== Math.floor(cw * dpr) || cv.height !== Math.floor(ch * dpr)) {
    cv.width = Math.floor(cw * dpr)
    cv.height = Math.floor(ch * dpr)
  }
  const ctx = cv.getContext('2d')
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, cw, ch)

  const el = showVideo.value ? videoRef.value : imgRef.value
  const sw = el?.naturalWidth || el?.videoWidth || 0
  const sh = el?.naturalHeight || el?.videoHeight || 0
  if (!sw || !sh) return

  // contain 布局下的实际显示区域
  const scale = Math.min(cw / sw, ch / sh)
  const dw = sw * scale
  const dh = sh * scale
  const ox = (cw - dw) / 2
  const oy = (ch - dh) / 2

  recognition.faces.forEach((face, i) => {
    const x = ox + face.box.x * dw
    const y = oy + face.box.y * dh
    const w = face.box.width * dw
    const h = face.box.height * dh
    const top = Object.entries(face.emotions).sort((a, b) => b[1] - a[1])[0]
    const emo = EMOTIONS[top[0]]
    const color = emo?.color || '#7c5cff'
    const active = i === 0

    ctx.save()
    ctx.strokeStyle = color
    ctx.lineWidth = active ? 2.4 : 1.4
    ctx.globalAlpha = active ? 1 : 0.55
    // 四角括号式人脸框
    const c = Math.min(18, w * 0.22)
    ;[[x, y, 1, 1], [x + w, y, -1, 1], [x, y + h, 1, -1], [x + w, y + h, -1, -1]].forEach(([px, py, sx, sy]) => {
      ctx.beginPath()
      ctx.moveTo(px, py + sy * c)
      ctx.lineTo(px, py)
      ctx.lineTo(px + sx * c, py)
      ctx.stroke()
    })

    if (face.landmarks) {
      ctx.fillStyle = color
      ctx.globalAlpha = active ? 0.85 : 0.4
      for (const p of face.landmarks) {
        ctx.beginPath()
        ctx.arc(ox + p.x * dw, oy + p.y * dh, 1.1, 0, Math.PI * 2)
        ctx.fill()
      }
      ctx.globalAlpha = active ? 1 : 0.55
    }

    // 标签
    const text = `${emo?.emoji || ''} ${emo?.label || top[0]} ${(top[1] * 100).toFixed(0)}%`
    ctx.font = '600 12px system-ui, "Microsoft YaHei", sans-serif'
    const tw = ctx.measureText(text).width + 14
    const ty = Math.max(0, y - 22)
    ctx.globalAlpha = 1
    ctx.fillStyle = 'rgba(8,10,18,0.82)'
    ctx.beginPath()
    ctx.roundRect?.(x, ty, tw, 19, 6)
    if (ctx.roundRect) ctx.fill()
    else ctx.fillRect(x, ty, tw, 19)
    ctx.fillStyle = color
    ctx.fillText(text, x + 7, ty + 13.5)
    ctx.restore()
  })
}

watch(() => recognition.faces, drawOverlay, { flush: 'post' })
watch(() => recognition.mode, () => nextTick(drawOverlay))
watch(() => recognition.stillUrl, () => nextTick(drawOverlay))

onMounted(async () => {
  ro = new ResizeObserver(() => drawOverlay())
  if (stageRef.value) ro.observe(stageRef.value)
  await prepareModels().catch(() => {})
})

onBeforeUnmount(() => ro?.disconnect())
</script>

<template>
  <section class="card">
    <div class="card-title">
      <b>① 人脸采集</b>
      <div class="row" style="gap: 6px">
        <span class="badge" :class="engine.status === 'ready' ? 'ok' : engine.status === 'error' ? 'err' : 'warn'">
          <i class="dot" :class="{ live: engine.status === 'ready' }" />
          本地模型 · {{ engine.status === 'ready' ? engine.backend : engine.status }}
        </span>
        <span v-if="recognition.inferenceMs" class="badge">{{ recognition.inferenceMs.toFixed(0) }}ms</span>
      </div>
    </div>

    <div class="tabs">
      <button v-for="m in MODES" :key="m.key" class="tab" :class="{ active: recognition.mode === m.key }" @click="setMode(m.key)">
        {{ m.icon }} {{ m.label }}
      </button>
    </div>

    <div
      ref="stageRef"
      class="stage"
      style="margin-top: 12px"
      @dragover.prevent="dragOver = true"
      @dragleave="dragOver = false"
      @drop.prevent="onDrop"
    >
      <!-- 视频源：摄像头流 / 本地视频文件 -->
      <video
        v-show="showVideo"
        ref="videoRef"
        class="layer"
        :class="{ mirror: mirrored }"
        :src="recognition.mode === 'video' ? recognition.videoUrl : ''"
        playsinline
        muted
        :loop="recognition.mode === 'video'"
        :controls="recognition.mode === 'video'"
        @loadeddata="onVideoReady"
      />

      <!-- 图片源：上传的图片 / 拍照冻结帧 -->
      <img
        v-show="showImage"
        ref="imgRef"
        class="layer"
        :src="recognition.stillUrl"
        alt="人脸画面"
        @load="drawOverlay"
      />

      <canvas ref="overlayRef" class="overlay" :class="{ mirror: mirrored }" :style="mirrored ? { transform: 'scaleX(-1)' } : {}" />

      <!-- 空状态 / 拖放提示 -->
      <div v-if="!hasVisual && !loading" class="dropzone" :class="{ over: dragOver }">
        <div style="font-size: 34px">🙂</div>
        <div v-if="recognition.mode === 'image'">点击选择或拖入一张正脸照片，也可直接点下方 6 张情绪人脸</div>
        <div v-else-if="recognition.mode === 'video'">点击选择一个本地视频文件（mp4 / webm）</div>
        <div v-else-if="recognition.mode === 'camera'">点击下方「打开摄像头」，画面仅在本机处理</div>
        <div v-else>先打开摄像头，再点「📸 拍照识别」</div>
      </div>

      <!-- 加载中 -->
      <div v-if="loading" class="dropzone" style="border-style: solid; background: rgba(5, 7, 15, 0.72)">
        <div class="spinner" />
        <div>{{ loadingText }}</div>
        <div class="muted mono">{{ engine.progress }}</div>
      </div>

      <!-- 无人脸 / 质量不足提示 -->
      <div v-if="recognition.hint" style="position: absolute; left: 8px; right: 8px; bottom: 8px">
        <span class="badge warn" style="width: 100%; justify-content: center; padding: 7px">⚠️ {{ recognition.hint }}</span>
      </div>
      <div v-if="recognition.error || recognition.cameraError" style="position: absolute; left: 8px; right: 8px; bottom: 8px">
        <span class="badge err" style="width: 100%; justify-content: center; padding: 7px">❌ {{ recognition.error || recognition.cameraError }}</span>
      </div>
    </div>

    <!-- ------------------------------------------------ 操作条 -->
    <div class="row" style="margin-top: 12px">
      <template v-if="recognition.mode === 'image'">
        <button class="btn btn-primary" @click="imageInput.click()">📂 选择图片</button>
        <button class="btn" :disabled="!recognition.stillUrl" @click="analyzeStill(imgRef, recognition.sourceLabel)">🔁 重新识别</button>
        <span class="muted" style="font-size: 12px">或从下方情绪人脸库直接选一张演示</span>
      </template>

      <template v-else-if="recognition.mode === 'video'">
        <button class="btn btn-primary" @click="videoInput.click()">🎬 选择视频</button>
        <button class="btn" :disabled="!recognition.hasSource" @click="startContinuous()">▶ 连续识别</button>
        <button class="btn" :disabled="recognition.phase !== 'running'" @click="pauseRecognition()">⏸ 暂停</button>
      </template>

      <template v-else-if="recognition.mode === 'camera'">
        <button class="btn btn-primary" @click="toggleCamera">
          {{ recognition.cameraStream ? '⏹ 关闭摄像头' : '📹 打开摄像头' }}
        </button>
        <button class="btn" :disabled="!recognition.cameraStream" @click="startContinuous">▶ 连续识别</button>
        <button class="btn" :disabled="!recognition.cameraStream" @click="pauseRecognition">⏸ 暂停</button>
        <button class="btn" :disabled="!recognition.cameraStream" @click="shoot">📸 拍照识别</button>
        <button class="btn" @click="flipCamera">🔄 {{ recognition.facingMode === 'user' ? '前置' : '后置' }}</button>
        <select v-if="recognition.devices.length" style="width: auto" @change="pickDevice">
          <option value="">自动选择设备</option>
          <option v-for="(d, i) in recognition.devices" :key="d.deviceId" :value="d.deviceId">
            {{ d.label || `摄像头 ${i + 1}` }}
          </option>
        </select>
      </template>

      <template v-else>
        <button v-if="!recognition.cameraStream" class="btn btn-primary" @click="setMode('camera')">📹 打开摄像头</button>
        <button v-else class="btn btn-primary" @click="shoot">📸 重新拍照</button>
        <button class="btn" @click="setMode('camera')">↩ 回到实时画面</button>
      </template>

      <div class="spacer" />
      <button class="btn btn-ghost btn-sm" @click="resetEmotion">清空结果</button>
    </div>

    <!-- 情绪人脸预览库：6 张 AI 合成面孔，点击即送入识别流程；右下角标注模型实际识别结果 -->
    <div v-if="recognition.mode === 'image'" class="samples">
      <button
        v-for="s in SAMPLES"
        :key="s.src"
        class="sample"
        :class="{ active: recognition.stillUrl === s.src }"
        @click="useSampleImage(s.src, sampleLabel(s))"
      >
        <img :src="s.src" :alt="sampleLabel(s)" loading="lazy" />
        <span class="sample-cap">
          {{ EMOTIONS[s.emotion].emoji }} {{ EMOTIONS[s.emotion].label }}
        </span>
        <span v-if="detected[s.src]" class="sample-det" :class="{ hit: detected[s.src].label === s.emotion }">
          识别为 {{ EMOTIONS[detected[s.src].label].label }} {{ (detected[s.src].conf * 100).toFixed(0) }}%
        </span>
      </button>
    </div>

    <div class="row" style="margin-top: 10px; font-size: 12px; color: var(--text-faint)">
      <span class="badge">画面源：{{ recognition.sourceLabel || '—' }}</span>
      <span class="badge">人脸数：{{ recognition.faceCount }}</span>
      <span class="badge" :class="recognition.fps ? 'run' : ''">{{ recognition.fps }} FPS</span>
      <span class="badge">🔒 像素不出本机</span>
    </div>

    <input ref="imageInput" type="file" accept="image/*" style="display: none" @change="onPickImage" />
    <input ref="videoInput" type="file" accept="video/*" style="display: none" @change="onPickVideo" />
  </section>
</template>

<style scoped>
.samples {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(88px, 1fr));
  gap: 8px;
  margin-top: 12px;
}

.sample {
  position: relative;
  padding: 0;
  border: 1px solid var(--line);
  border-radius: 12px;
  overflow: hidden;
  background: rgba(255, 255, 255, 0.04);
  cursor: pointer;
  transition: transform 0.15s ease, border-color 0.15s ease, box-shadow 0.2s;
}

.sample:hover {
  transform: translateY(-2px);
  border-color: var(--brand-2);
  box-shadow: 0 10px 22px -14px #000;
}

.sample.active {
  border-color: var(--brand);
  box-shadow: inset 0 0 0 1px var(--brand);
}

.sample img {
  width: 100%;
  aspect-ratio: 3 / 4;
  object-fit: cover;
  display: block;
}

.sample-cap {
  display: block;
  font-size: 11.5px;
  padding: 4px 0 5px;
  color: var(--text-dim);
}

/* 模型对这张图的真实识别结果：与目标情绪一致时变绿 */
.sample-det {
  position: absolute;
  left: 4px;
  right: 4px;
  top: 4px;
  font-size: 10px;
  padding: 2px 5px;
  border-radius: 6px;
  background: rgba(8, 10, 18, 0.82);
  color: var(--warn);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.sample-det.hit {
  color: var(--ok);
}
</style>
