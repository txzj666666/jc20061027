/**
 * recommender.js —— 情绪 → 歌曲推荐算法
 * ==================================================================
 * 【算法定位】基于内容(content-based)的情绪匹配推荐，不依赖用户历史账号体系，
 * 因此离线可用、可解释（每首歌都能给出打分构成）。
 * 整体分三步：
 *
 *   Step 1  目标情绪向量构造（软混合）
 *   Step 2  逐曲打分（5 个可解释分量加权）
 *   Step 3  MMR 多样性重排 + 情绪调节轨迹 + 本地/在线混合配比
 *
 * ------------------------------------------------------------------
 * Step 1：目标情绪向量
 *   识别端给的是 7 维概率分布 p = S_t（EMA 平滑后），而不是硬标签。
 *   置信度不足（uncertain）时按 0.5:0.5 与 neutral 混合，做保守回退：
 *       p' = 0.5·p + 0.5·onehot(neutral)
 *   由 p' 直接算出连续目标量（Russell 环状模型坐标 + 目标 BPM）：
 *       valence*  = Σ p'_i · valence_i        arousal* = Σ p'_i · arousal_i
 *       bpm*      = 60 + (arousal*+1)/2 · 90  ∈ [60,150]
 *   情绪-曲风映射表 genres* 取主情绪 + 次情绪（p'_i ≥ 0.2）的曲风并集，
 *   这样「开心 0.6 / 惊讶 0.25」会同时带上流行电子和古典的检索词。
 *
 * Step 2：逐曲打分（权重见 config/app.js recommendConfig.weights）
 *   score = w1·MoodSim + w2·CircumplexSim + w3·EnergyFit
 *         + w4·Popularity + w5·Freshness
 *   ① MoodSim      = 0.7·cos(p', mood_s) + 0.3·GenreOverlap(genres*, genre_s)
 *                    —— 情绪隶属度向量余弦 + 标签交集重合度
 *      GenreOverlap = |命中曲风数| / min(|genres*|, |genre_s|)（大小写/子串容错）
 *   ② CircumplexSim = 1 − ‖(v*,a*)−(v_s,a_s)‖₂ / (2√2)
 *                    —— 效价/唤醒度双维欧氏距离，处理"标签不同但观感接近"的歌
 *   ③ EnergyFit     = 1 − min(1, |log₂(bpm_s / bpm*)|)
 *                    —— 用八度（倍频）作尺度，120BPM 推 60BPM 记 0 分
 *   ④ Popularity    = rating ∈ [0,1]（本地库人工/生成先验，在线结果按平台热度归一）
 *   ⑤ Freshness     = exp(−playCount/2)：刚播过的降权，避免列表反复出现同一首
 *   各项都归一到 [0,1]，权重和为 1，所以总分也在 [0,1]，便于 UI 显示"匹配度 xx%"。
 *   最后乘上「来源系数」：local = 1.00，online = 0.85。
 *   在线曲目的 mood/曲风是由检索词反推的（用"轻音乐"搜来的歌当然像轻音乐），
 *   存在循环论证偏差，因此统一打折 —— 这就是"本地库优先"的量化形式。
 *
 * Step 3：重排与混合
 *   a) MMR（Maximal Marginal Relevance）抗同质化：
 *        pick = argmax_{s∉S} [ λ·score(s) − (1−λ)·max_{s'∈S} sim(s,s') ]
 *        sim(s,s') = 0.5·cos(mood_s,mood_s') + 0.5·(1 − 环状距离/2√2)
 *   b) 音乐情绪调节轨迹（Musical Mood Regulation）：
 *        悲伤：列表内效价逐首 +0.06 抬升（先共情后振作）
 *        愤怒：唤醒度逐首回落（先宣泄后平复），实现方式是给后续槽位
 *              用"移动目标"重新打分，而不是简单插入固定曲目
 *   c) 混合配比（本地优先 + 在线补位）：
 *        slots = 12，localRatio = 0.7 → 8 本地 / 4 在线
 *        本地候选不足时把空槽让给在线；在线失败时全部回填本地；
 *        在线结果按"每 3 首插 1 首"的固定间隔穿插，避免整屏都是外链卡片；
 *        以 title+artist 归一化字符串做去重，本地已有同名歌不再出在线版本。
 */
import { EMOTIONS, EMOTION_ORDER } from '../config/emotions'
import { recommendConfig } from '../config/app'

const clamp = (v, a, b) => Math.min(b, Math.max(a, v))
const MAX_VA_DIST = 2 * Math.SQRT2 // 环状模型对角线长度，用于归一化距离

/** 概率分布 → 目标 BPM（唤醒度线性映射到 60~150） */
export function arousalToBpm(arousal) {
  return 60 + ((clamp(arousal, -1, 1) + 1) / 2) * 90
}

/** Step 1：由识别快照构造推荐目标 */
export function buildTarget(snapshot) {
  const p = snapshot.uncertain
    ? EMOTION_ORDER.map((k, i) => (k === 'neutral' ? snapshot.smoothed[i] * 0.5 + 0.5 : snapshot.smoothed[i] * 0.5))
    : snapshot.smoothed.slice()
  const norm = sum(p) || 1
  const vec = p.map((v) => v / norm)

  let valence = 0
  let arousal = 0
  vec.forEach((w, i) => {
    const e = EMOTIONS[EMOTION_ORDER[i]]
    valence += w * e.valence
    arousal += w * e.arousal
  })

  // 主情绪 + 权重 ≥ 0.2 的次情绪共同决定曲风与搜索词
  const active = EMOTION_ORDER.map((k, i) => ({ k, w: vec[i] }))
    .filter((x) => x.w >= 0.2)
    .sort((a, b) => b.w - a.w)
    .slice(0, 2)

  const genres = []
  const keywords = []
  for (const { k, w } of active) {
    for (const g of EMOTIONS[k].genres) genres.push({ g, w })
    for (const kw of EMOTIONS[k].keywords) keywords.push({ kw, w })
  }

  return {
    label: snapshot.label,
    vec,
    valence,
    arousal,
    bpm: arousalToBpm(arousal),
    intensity: snapshot.intensity,
    confidence: snapshot.confidence,
    uncertain: snapshot.uncertain,
    active: active.map((a) => a.k),
    genres,
    keywords: keywords.sort((a, b) => b.w - a.w).map((x) => x.kw),
    regulateSlope: recommendConfig.regulateSlope[snapshot.label] ?? 0
  }
}

function sum(v) {
  return v.reduce((a, b) => a + b, 0)
}

function cosine(a, b) {
  const d = dot(a, b)
  const na = Math.sqrt(dot(a, a))
  const nb = Math.sqrt(dot(b, b))
  return na && nb ? d / (na * nb) : 0
}

function dot(a, b) {
  let s = 0
  for (let i = 0; i < a.length; i++) s += a[i] * b[i]
  return s
}

/** 把歌曲的 mood 对象转成与 EMOTION_ORDER 对齐的向量 */
export function songMoodVector(song) {
  return EMOTION_ORDER.map((k) => Number(song.mood?.[k] ?? 0))
}

/** GenreOverlap：情绪曲风映射表 × 歌曲曲风标签 */
function genreOverlap(targetGenres, songGenres) {
  if (!targetGenres.length || !songGenres.length) return 0
  const songLow = songGenres.map((g) => String(g).toLowerCase().trim())
  let hit = 0
  let weightSum = 0
  let totalWeight = 0
  for (const { g, w } of targetGenres) {
    const gl = String(g).toLowerCase().trim()
    totalWeight += w
    // 子串双向匹配：'indie pop' 命中 'pop'，'轻音乐' 命中 '轻音乐/纯音乐'
    if (songLow.some((s) => s.includes(gl) || gl.includes(s))) {
      hit++
      weightSum += w
    }
  }
  const denom = Math.min(targetGenres.length, songGenres.length) || 1
  const overlap = Math.min(1, hit / denom)
  // 命中权重占比与命中数占比取均值，防止"命中一个大类词就满分"
  return (overlap + (totalWeight ? weightSum / totalWeight : 0)) / 2
}

function circumplexSim(tv, ta, sv, sa) {
  const d = Math.hypot(tv - sv, ta - sa)
  return clamp(1 - d / MAX_VA_DIST, 0, 1)
}

function energyFit(targetBpm, songBpm) {
  if (!songBpm || songBpm <= 0) return 0.5 // 未知 BPM 给中性分，不惩罚
  return clamp(1 - Math.min(1, Math.abs(Math.log2(songBpm / targetBpm))), 0, 1)
}

/**
 * 来源可信度系数（推荐权重策略的一部分）：
 * 在线接口的 mood/曲风标签是「用检索词反推」出来的，存在循环论证风险
 * （用"轻音乐"搜来的歌当然像轻音乐），因此统一打折，让本地已标注曲目优先。
 */
const SOURCE_BOOST = { local: 1, online: 0.85 }

/** Step 2：逐曲打分，返回总分 + 各分量（UI 用它显示"为什么推荐这首"） */
export function scoreSong(song, target, ctx = {}) {
  const w = recommendConfig.weights
  const sv = songMoodVector(song)
  const moodCos = cosine(target.vec, sv)
  const tagSim = genreOverlap(target.genres, song.genre)
  const parts = {
    mood: 0.7 * moodCos + 0.3 * tagSim,
    circumplex: circumplexSim(target.valence, target.arousal, song.valence, song.arousal),
    energy: energyFit(target.bpm, song.bpm),
    popularity: clamp(Number(song.rating ?? 0.5), 0, 1),
    freshness: Math.exp(-clamp(ctx.playCount?.[song.id] ?? 0, 0, 8) / 2)
  }
  const total =
    w.mood * parts.mood + w.circumplex * parts.circumplex + w.energy * parts.energy + w.popularity * parts.popularity + w.freshness * parts.freshness
  // 未标注曲目（在线结果 / 用户刚导入还没点情绪标签）轻微降权
  const penalty = song.source === 'online' && !song.annotated ? 0.9 : 1
  return { song, total: total * (SOURCE_BOOST[song.source] ?? 1) * penalty, parts }
}

/** 歌曲之间的相似度（MMR 用） */
function songSim(a, b) {
  const cos = cosine(songMoodVector(a), songMoodVector(b))
  const dist = Math.hypot(a.valence - b.valence, a.arousal - b.arousal)
  return 0.5 * cos + 0.5 * clamp(1 - dist / MAX_VA_DIST, 0, 1)
}

/**
 * Step 3a：MMR 重排
 * 目标带"调节轨迹"：悲伤/愤怒时第 j 个槽位用移动后的效价/唤醒目标重新打分，
 * 于是列表自然形成「先共情 → 后振作」的坡度。
 */
export function selectWithMMR(candidates, k, target, lambda = recommendConfig.mmrLambda) {
  const pool = candidates.slice()
  const picked = []
  const slope = target.regulateSlope

  while (picked.length < k && pool.length) {
    const step = picked.length
    const t = {
      ...target,
      valence: clamp(target.valence + slope * step, -1, 1),
      // 愤怒时同步压低唤醒度（先宣泄后平复）
      arousal: slope ? clamp(target.arousal + (target.label === 'angry' ? slope * 0.5 * step : 0), -1, 1) : target.arousal
    }
    t.bpm = arousalToBpm(t.arousal)

    let bestIdx = -1
    let bestScore = -Infinity
    for (let i = 0; i < pool.length; i++) {
      const cand = pool[i]
      const rel = scoreSong(cand.song, t).total
      const maxSim = picked.length ? Math.max(...picked.map((p) => songSim(p.song, cand.song))) : 0
      const mmr = lambda * rel - (1 - lambda) * maxSim
      if (mmr > bestScore) {
        bestScore = mmr
        bestIdx = i
      }
    }
    const chosen = pool.splice(bestIdx, 1)[0]
    picked.push({ ...chosen, total: chosen.total * (1 - 0.02 * step), mmr: bestScore, slotValence: t.valence })
  }
  return picked
}

/** title+artist 归一化去重键 */
function dedupeKey(song) {
  return `${String(song.title).toLowerCase().replace(/\s+/g, '')}|${String(song.artist).toLowerCase().replace(/\s+/g, '')}`
}

/**
 * Step 3c：本地优先 + 在线补位混合
 * @param {Array} localScored  本地候选（已 scoreSong）
 * @param {Array} onlineScored 在线候选
 * @param {object} target
 * @param {object} opts { slots, localRatio }
 */
export function mix(localScored, onlineScored, target, opts = {}) {
  const slots = opts.slots ?? recommendConfig.slots
  const localRatio = opts.localRatio ?? recommendConfig.localRatio
  const localQuota = Math.min(slots, Math.round(slots * localRatio))

  const pickedLocal = selectWithMMR(localScored, localQuota, target)
  const seen = new Set(pickedLocal.map((s) => dedupeKey(s.song)))
  const onlineFresh = onlineScored.filter((s) => !seen.has(dedupeKey(s.song)))
  // 剩余槽位全部交给在线（本地候选不足时 remain 自动变大，即为「在线补位」）
  const remain = slots - pickedLocal.length
  const pickedOnline = remain > 0 ? selectWithMMR(onlineFresh, remain, target) : []

  // 穿插排布：在线歌均匀散布在本地歌之间，避免整块堆在列表尾部
  const total = pickedLocal.length + pickedOnline.length
  const result = []
  let li = 0
  let oi = 0
  for (let pos = 0; pos < total; pos++) {
    const onlineAt = pickedOnline.length ? Math.round(((oi + 1) * total) / (pickedOnline.length + 1)) : Infinity
    if (pos === onlineAt && oi < pickedOnline.length) result.push(pickedOnline[oi++])
    else if (li < pickedLocal.length) result.push(pickedLocal[li++])
    else if (oi < pickedOnline.length) result.push(pickedOnline[oi++])
  }

  // 在线补位不足（接口不可用 / 关闭在线源）时，用本地次优曲目填满槽位
  if (result.length < slots) {
    const chosen = new Set(result.map((r) => r.song.id))
    const rest = localScored.filter((s) => !chosen.has(s.song.id))
    result.push(...selectWithMMR(rest, slots - result.length, target))
  }

  return result.slice(0, slots).map((r, i) => ({
    ...r,
    rank: i + 1,
    emotionLabel: target.label,
    // 推荐理由：把打分最高的两个分量翻译成中文说明
    why: explain(r, target)
  }))
}

const PART_LABEL = {
  mood: '情绪标签高度吻合',
  circumplex: '愉悦度/兴奋度接近',
  energy: '节奏(BPM)贴合当前状态',
  popularity: '曲目热度高',
  freshness: '你最近没听过'
}

function explain(scored, target) {
  const entries = Object.entries(scored.parts).map(([k, v]) => ({ k, v }))
  entries.sort((a, b) => b.v - a.v)
  const top = entries.filter((e) => e.v > 0.55).slice(0, 2)
  const base = top.length ? top.map((e) => PART_LABEL[e.k]) : []
  if (target.label === 'sad' && scored.slotValence > target.valence + 0.03) base.push('情绪调节：本曲效价更亮，用于逐步振作')
  if (target.label === 'angry') base.push('情绪引导：先宣泄后平复的排布')
  if (!base.length) base.push('综合评分入选')
  return base
}

export { dedupeKey }
