/**
 * emotionTracker.js —— 情绪时序聚合与稳定判定算法
 * ==================================================================
 * 【要解决的问题】
 * face-api 的表情网络是「单帧静态分类」，FER-2013 水平下单帧 Top-1 只有
 * 65%~72%，且摄像头每帧光照/微表情变化都会让 top-1 标签来回跳变。
 * 直接把第 N 帧的 argmax 丢给推荐系统，会出现「列表每 200ms 换一次」的
 * 灾难体验。因此这里加一层轻量时序滤波器：
 *
 【算法流程（每帧）】
 *  1) 有效帧门控：无人脸 / 检测分过低 / 脸太小 / 模糊 / 大侧脸 → 丢弃该帧
 *     （由 faceEngine.frameUsable 判定），并累加 missCount。
 *  2) 指数滑动平均 EMA（IIR 一阶低通）：
 *        S_t = (1 - α) · S_{t-1} + α · P_t   ，α = trackerConfig.emaAlpha
 *     P_t ∈ R^7 为当前帧 softmax 概率。EMA 等效于对最近 1/α ≈ 3 帧加权，
 *     比算术平均更跟手，又比单帧稳定；随后对 S_t 重新归一化保持分布性质。
 *  3) 滞回（Schmitt 触发器思想）切换判定：
 *        候选 c = argmax(S_t)
 *        仅当 S_t[c] ≥ S_t[L] + margin(c,L) 连续满足 stableFrames 帧
 *        才把确认标签 L 从旧值切到 c。
 *     margin 由 config/emotions.js 的「易混淆情绪对」表给出，
 *     混淆对（如 惊讶↔恐惧）额外降低 0.02，减少抖动死锁。
 *  4) 置信度：
 *        conf = S_t[L] · 0.65 + mean(检测分) · 0.2 + mean(清晰度) · 0.15
 *     conf < minConfidence 时标记 uncertain=true，推荐环节会把该次识别
 *     的结果与 neutral 按 0.5:0.5 混合，避免"完全没把握却硬推"。
 *  5) 强度（情绪浓淡）：1 - S_t[neutral]，用于 UI 的「强烈/轻微」文案
 *     以及推荐时的 energy 上限（轻度开心 → 不必上夜店神曲）。
 *
 * 输出 distribution（平滑后的 7 维概率分布）而不是硬标签，
 * 让推荐算法可以做「多情绪软混合」（见 core/recommender.js）。
 */
import { trackerConfig } from '../config/app'
import { EMOTION_ORDER, confusionTolerance } from '../config/emotions'

export class EmotionTracker {
  constructor(cfg = trackerConfig) {
    this.cfg = cfg
    this.reset()
  }

  reset() {
    this.smoothed = null // 7 维 EMA 状态
    this.committed = 'neutral' // 当前确认标签（滞回状态机的状态）
    this.candidate = null
    this.candidateStreak = 0
    this.frames = 0 // 参与聚合的有效帧数
    this.missCount = 0
    this.scoreSum = 0
    this.blurSum = 0
    this.window = [] // 近邻帧的 (检测分, 清晰度)
    this.history = [] // [{t, probs:[7], label}] 供曲线绘制
    this.lastUpdateAt = 0
  }

  /**
   * 输入一帧
   * @param {object|null} face  faceEngine 输出的主人脸（null 表示这帧没脸/不可用）
   * @param {number} ts        performance.now()
   * @returns {object} 状态快照
   */
  push(face, ts = performance.now()) {
    if (!face) {
      this.missCount++
      // 缓慢衰减，使 UI 上"残留情绪"在约 2 秒内自然回落
      if (this.smoothed) this.smoothed = this.normalize(this.smoothed.map((v) => v * 0.96))
      return this.snapshot(ts, false)
    }
    this.missCount = 0

    const p = EMOTION_ORDER.map((k) => face.emotions[k] ?? 0)
    const a = this.cfg.emaAlpha
    if (!this.smoothed) {
      this.smoothed = p.slice()
    } else {
      // S_t = (1-α)S_{t-1} + α·P_t
      this.smoothed = this.normalize(this.smoothed.map((s, i) => (1 - a) * s + a * p[i]))
    }

    this.frames++
    this.pushMetric(face)
    this.pushHistory(ts)
    this.decide()
    return this.snapshot(ts, true)
  }

  normalize(v) {
    const s = v.reduce((x, y) => x + y, 0) || 1
    return v.map((x) => x / s)
  }

  pushMetric(face) {
    this.window.push({ score: face.score, blur: face.quality.blur })
    if (this.window.length > 20) this.window.shift()
  }

  pushHistory(ts) {
    const top = this.maxIndex(this.smoothed)
    this.history.push({ t: ts, probs: this.smoothed.slice(), label: EMOTION_ORDER[top] })
    if (this.history.length > this.cfg.bufferSize) this.history.shift()
  }

  maxIndex(v) {
    let best = 0
    for (let i = 1; i < v.length; i++) if (v[i] > v[best]) best = i
    return best
  }

  /** 滞回判定：新标签必须"明显且持续"地胜出才允许切换 */
  decide() {
    const S = this.smoothed
    const c = this.maxIndex(S)
    const cKey = EMOTION_ORDER[c]
    const lKey = this.committed
    const li = EMOTION_ORDER.indexOf(lKey)
    const margin = this.cfg.switchMargin - confusionTolerance(cKey, lKey)

    if (cKey === lKey) {
      this.candidate = cKey
      this.candidateStreak++
      return
    }
    if (S[c] >= S[li] + margin) {
      if (this.candidate === cKey) this.candidateStreak++
      else {
        this.candidate = cKey
        this.candidateStreak = 1
      }
      if (this.candidateStreak >= this.cfg.stableFrames) {
        this.committed = cKey // 确认切换
      }
    } else {
      this.candidate = lKey
      this.candidateStreak = 0
    }
  }

  snapshot(ts, facePresent) {
    const S = this.smoothed || EMOTION_ORDER.map(() => 1 / 7)
    const li = EMOTION_ORDER.indexOf(this.committed)
    const mean = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0)
    const avgScore = mean(this.window.map((w) => w.score))
    const avgBlur = mean(this.window.map((w) => w.blur))

    // conf = 0.65·平滑概率 + 0.20·检测置信度 + 0.15·清晰度
    const confidence = S[li] * 0.65 + avgScore * 0.2 + avgBlur * 0.15

    // 排序后的概率分布，UI 直接渲染
    const distribution = EMOTION_ORDER.map((k, i) => ({ key: k, prob: S[i] })).sort((a, b) => b.prob - a.prob)

    return {
      facePresent,
      frames: this.frames,
      missCount: this.missCount,
      label: this.committed,
      labelProb: S[li],
      // 未确认满 stableFrames 帧时视为"过渡中"
      settled: this.candidateStreak >= this.cfg.stableFrames || this.frames < this.cfg.stableFrames,
      confidence,
      uncertain: confidence < this.cfg.minConfidence,
      intensity: 1 - S[EMOTION_ORDER.indexOf('neutral')],
      smoothed: S.slice(),
      distribution,
      secondProb: distribution[1]?.prob ?? 0,
      avgDetScore: avgScore,
      avgBlur,
      history: this.history.slice(-24),
      ts
    }
  }

  /**
   * 单帧模式（图片上传 / 拍照）没有时序可用，
   * 这里把单帧结果折算成同一套输出结构，推荐逻辑无需分叉。
   */
  static fromSingleFrame(face) {
    const S = EMOTION_ORDER.map((k) => face.emotions[k] ?? 0)
    const sum = S.reduce((a, b) => a + b, 0) || 1
    const norm = S.map((v) => v / sum)
    const top = norm.indexOf(Math.max(...norm))
    const label = EMOTION_ORDER[top]
    const second = [...norm].sort((a, b) => b - a)[1] ?? 0
    const confidence = norm[top] * 0.65 + face.score * 0.2 + face.quality.blur * 0.15
    return {
      facePresent: true,
      frames: 1,
      label,
      labelProb: norm[top],
      settled: true,
      confidence,
      uncertain: confidence < trackerConfig.minConfidence,
      intensity: 1 - norm[0], // norm[0] 即 neutral
      smoothed: norm,
      distribution: EMOTION_ORDER.map((k, i) => ({ key: k, prob: norm[i] })).sort((a, b) => b.prob - a.prob),
      secondProb: second,
      avgDetScore: face.score,
      avgBlur: face.quality.blur,
      history: [{ t: performance.now(), probs: norm.slice(), label }],
      missCount: 0,
      ts: performance.now()
    }
  }
}
