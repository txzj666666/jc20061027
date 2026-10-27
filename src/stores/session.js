/**
 * session.js —— 全局会话状态（用 Vue reactive 做的轻量 store，不引入 Pinia）
 * 持有：识别结果 → 推荐目标 → 推荐列表 → 提示消息 → 播放计数
 */
import { reactive, computed, toRaw } from 'vue'
import { buildTarget, mix, scoreSong } from '../core/recommender'
import { searchByEmotion, resolveOnlineConfig } from '../core/onlineMusic'
import { localPool } from '../core/musicLibrary'
import { recommendConfig } from '../config/app'
import { EMOTIONS } from '../config/emotions'

export const session = reactive({
  // 识别侧
  snapshot: null, // EmotionTracker 的输出
  target: null, // buildTarget 的输出
  lastFaceAt: 0,
  // 推荐侧
  songs: [],
  recStatus: 'idle', // idle | scoring | fetching | ready | error
  recError: '',
  onlineStatus: 'idle', // idle | loading | ok | error | off
  onlineErrors: [],
  onlineCount: 0,
  recommendCount: 0,
  lastEmotion: '',
  lastRecommendAt: 0,
  // 播放计数（喂给 Freshness 分量）
  playCounts: {},
  // 全局提示
  toasts: []
})

export const dominantEmotion = computed(() => (session.snapshot ? EMOTIONS[session.snapshot.label] : null))

let toastSeq = 0
export function toast(text, type = 'info', ttl = 4200) {
  const id = ++toastSeq
  session.toasts.push({ id, text, type })
  setTimeout(() => {
    const i = session.toasts.findIndex((t) => t.id === id)
    if (i >= 0) session.toasts.splice(i, 1)
  }, ttl)
}

/**
 * 推荐主流程（被识别循环在情绪"确认切换"后调用，也支持手动重新推荐）
 * @param {object} snapshot EmotionTracker 快照
 * @param {object} opts { force: 忽略同一情绪缓存重新推荐 }
 */
let inflight = false
export async function recommend(snapshot, opts = {}) {
  if (!snapshot || !snapshot.facePresent) return
  // 并发保护：识别循环每帧都可能触发，上一次推荐没结束就直接跳过
  if (inflight) return
  const sameEmotion = session.lastEmotion === snapshot.label && !opts.force
  if (sameEmotion && session.songs.length && Date.now() - session.lastRecommendAt < 20000) return
  inflight = true
  session.lastEmotion = snapshot.label
  session.snapshot = snapshot
  const target = buildTarget(snapshot)
  session.target = target
  session.recStatus = 'scoring'
  session.recError = ''

  // ---- 本地候选池打分
  const ctx = { playCount: session.playCounts }
  const localScored = localPool().map((song) => scoreSong(toRaw(song), target, ctx))

  // ---- 在线候选池（异步，失败不影响本地推荐）
  let onlineScored = []
  const cfg = resolveOnlineConfig()
  if (cfg.provider !== 'off' && recommendConfig.onlineRatio > 0) {
    session.onlineStatus = 'loading'
    try {
      const { songs, errors } = await searchByEmotion(snapshot.label, target.active.filter((k) => k !== snapshot.label))
      onlineScored = songs.map((song) => scoreSong(toRaw(song), target, ctx))
      session.onlineErrors = errors
      session.onlineCount = songs.length
      session.onlineStatus = errors.length && !songs.length ? 'error' : 'ok'
      if (errors.length && songs.length) toast(`在线接口部分不可用：${errors[0]}`, 'warn')
    } catch (e) {
      session.onlineStatus = 'error'
      session.onlineErrors = [String(e.message || e)]
    }
  } else {
    session.onlineStatus = 'off'
  }

  // ---- 混排 + MMR
  const list = mix(localScored, onlineScored, target, {
    slots: opts.slots || recommendConfig.slots,
    localRatio: cfg.provider === 'off' ? 1 : recommendConfig.localRatio
  })

  if (!list.length) {
    session.recStatus = 'error'
    session.recError = '没有可推荐的歌曲：本地曲库为空且在线接口不可用。请执行 npm run music 生成本地曲库，或在设置里配置在线 API。'
    inflight = false
    toast(session.recError, 'error', 7000)
    return
  }

  session.songs = list
  session.recStatus = 'ready'
  session.recommendCount++
  session.lastRecommendAt = Date.now()
  inflight = false
}

session.lastRecommendAt = 0

export function markPlayed(songId) {
  session.playCounts[songId] = (session.playCounts[songId] || 0) + 1
}
