<script setup>
/**
 * EmotionPanel.vue —— 情绪识别结果面板
 * 展示：主情绪 + 置信度圆环 + 7 类概率条（EMA 平滑后）+ 概率堆叠历史曲线 + 诊断量
 */
import { computed, ref, watch, onMounted, nextTick } from 'vue'
import { recognition, reroll } from '../composables/useRecognition'
import { session, recommend } from '../stores/session'
import { EMOTIONS, EMOTION_ORDER } from '../config/emotions'
import { trackerConfig } from '../config/app'

const snap = computed(() => recognition.snapshot)
const ringPct = computed(() => Math.round((snap.value?.confidence ?? 0) * 100))
const sparkRef = ref(null)

const statusText = computed(() => {
  if (!snap.value) return '等待采集'
  if (!snap.value.facePresent) return '暂未捕捉到有效人脸'
  if (snap.value.uncertain) return '结果置信度偏低（已按中性保守推荐）'
  if (!snap.value.settled) return '情绪切换观察中（滞回判定未满足）'
  return '情绪已确认'
})

const emotionColor = computed(() => (snap.value ? EMOTIONS[snap.value.label].color : '#7c5cff'))

/** 概率堆叠面积图：横轴为最近 24 个采样帧，纵轴为 7 类概率堆叠 */
function drawSpark() {
  const cv = sparkRef.value
  if (!cv) return
  const dpr = Math.min(2, window.devicePixelRatio || 1)
  const w = cv.clientWidth
  const h = cv.clientHeight
  if (!w || !h) return
  cv.width = w * dpr
  cv.height = h * dpr
  const ctx = cv.getContext('2d')
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, w, h)

  const hist = snap.value?.history || []
  if (hist.length < 2) {
    ctx.fillStyle = 'rgba(255,255,255,0.16)'
    ctx.font = '11px system-ui'
    ctx.fillText('连续识别后显示情绪概率时序演化', 10, h / 2 + 4)
    return
  }
  const n = hist.length
  const step = w / (n - 1)
  let acc = new Array(n).fill(0)
  for (const key of EMOTION_ORDER) {
    const i = EMOTION_ORDER.indexOf(key)
    ctx.beginPath()
    ctx.moveTo(0, h - acc[0] * h)
    for (let j = 0; j < n; j++) ctx.lineTo(j * step, h - (acc[j] + hist[j].probs[i]) * h)
    for (let j = n - 1; j >= 0; j--) ctx.lineTo(j * step, h - acc[j] * h)
    ctx.closePath()
    ctx.fillStyle = EMOTIONS[key].color + 'cc'
    ctx.fill()
    acc = acc.map((v, j) => v + hist[j].probs[i])
  }
  // 当前确认标签的时间线游标
  ctx.strokeStyle = 'rgba(255,255,255,.55)'
  ctx.setLineDash([3, 3])
  ctx.beginPath()
  ctx.moveTo(w - 1, 0)
  ctx.lineTo(w - 1, h)
  ctx.stroke()
  ctx.setLineDash([])
}

watch(() => snap.value?.history?.length, () => nextTick(drawSpark))
onMounted(drawSpark)
</script>

<template>
  <section class="card">
    <div class="card-title">
      <b>② 情绪识别结果</b>
      <span class="badge" :class="snap?.uncertain ? 'warn' : snap?.facePresent ? 'ok' : ''">
        <i class="dot" :class="{ live: recognition.phase === 'running' }" />{{ statusText }}
      </span>
    </div>

    <div v-if="!snap" class="muted" style="padding: 22px 6px; text-align: center; font-size: 13px">
      还没有识别结果。<br />请在左侧选择图片或打开摄像头。
    </div>

    <template v-else>
      <div class="emotion-hero">
        <div class="ring" :style="{ '--p': ringPct, '--emotion-color': emotionColor }">
          <span>{{ EMOTIONS[snap.label].emoji }}</span>
        </div>
        <div>
          <div class="emotion-name" :style="{ color: emotionColor }">{{ EMOTIONS[snap.label].label }}</div>
          <div class="emotion-sub">
            {{ EMOTIONS[snap.label].en }} · 置信度 {{ (snap.confidence * 100).toFixed(1) }}% · 强度
            {{ (snap.intensity * 100).toFixed(0) }}%
          </div>
          <div class="row" style="margin-top: 6px; gap: 5px">
            <span class="badge">帧数 {{ snap.frames }}</span>
            <span class="badge">检测 {{ (snap.avgDetScore * 100).toFixed(0) }}%</span>
            <span class="badge">清晰度 {{ (snap.avgBlur * 100).toFixed(0) }}%</span>
          </div>
        </div>
      </div>

      <div style="margin-top: 12px">
        <div
          v-for="d in snap.distribution"
          :key="d.key"
          class="prob-row"
          :class="{ top: d.key === snap.label }"
        >
          <span class="name">
            <span :style="{ color: EMOTIONS[d.key].color }">{{ EMOTIONS[d.key].emoji }}</span>
            {{ EMOTIONS[d.key].label }}
          </span>
          <span class="bar">
            <i :style="{ width: (d.prob * 100).toFixed(1) + '%', '--c': EMOTIONS[d.key].color }" />
          </span>
          <span class="mono" style="text-align: right; color: var(--text-dim)">{{ (d.prob * 100).toFixed(0) }}%</span>
        </div>
      </div>

      <canvas ref="sparkRef" class="spark" style="margin-top: 10px" />
      <div class="muted mono" style="margin-top: 4px">
        ↑ 概率堆叠时序图（EMA α={{ trackerConfig.emaAlpha }}，连续 {{ trackerConfig.stableFrames }} 帧才确认切换）
      </div>

      <div class="card" style="padding: 10px 12px; margin-top: 12px; background: rgba(124,92,255,.08)">
        <div style="font-size: 12.5px; line-height: 1.6">
          <b :style="{ color: emotionColor }">推荐策略：</b>{{ EMOTIONS[snap.label].strategy }}
          <div class="muted" style="margin-top: 4px">
            目标情绪向量（软混合）：
            <span class="mono">{{ snap.smoothed.map((v, i) => EMOTION_ORDER[i].slice(0, 3) + ':' + v.toFixed(2)).join('  ') }}</span>
          </div>
          <div class="muted" style="margin-top: 2px">
            环状模型目标：效价 {{ session.target?.valence?.toFixed(2) }} / 唤醒度 {{ session.target?.arousal?.toFixed(2) }} · 目标 BPM
            {{ Math.round(session.target?.bpm ?? 0) }}
          </div>
        </div>
      </div>

      <div class="row" style="margin-top: 12px">
        <button class="btn btn-primary btn-sm" :disabled="!snap.facePresent" @click="recommend(snap, { force: true })">
          🎯 按当前情绪推荐
        </button>
        <button class="btn btn-sm" :disabled="!session.songs.length" @click="reroll">🎲 换一批</button>
      </div>
    </template>
  </section>
</template>
