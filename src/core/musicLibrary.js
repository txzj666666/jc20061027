/**
 * musicLibrary.js —— 本地歌曲库加载与运行时导入
 * ==================================================================
 * 数据来源（按优先级）：
 *  1) public/music/manifest.json  —— 随项目分发的曲库清单
 *     （`npm run music` 会生成 14 首可直接播放的演示音源）
 *  2) 用户在界面上「导入本地音频」动态加入的曲目（仅本次会话有效，
 *     因为浏览器 ObjectURL 不能跨刷新持久化；如需持久化请看 README 的
 *     File System Access / IndexedDB 方案）
 *
 * 每首歌的字段约定（推荐算法只依赖这些字段，见 core/recommender.js）：
 *   { id, url, title, artist, genre:[], mood:{happy:0.8,...},
 *     valence, arousal, bpm, rating, duration, source, cover, reason }
 */
import { reactive } from 'vue'

export const library = reactive({
  status: 'idle', // idle | loading | ready | error
  error: '',
  tracks: [],
  userTracks: [],
  loadedAt: 0
})

const BASE = import.meta.env.BASE_URL || '/'
const url = (p) => (p.startsWith('http') ? p : `${BASE}music/${String(p).replace(/^\/+/, '')}`)

/** 从文件名猜情绪：给导入的 mp3 一个可用的初始标签，用户可再手动修正 */
const FILENAME_HINTS = [
  { keys: ['happy', '欢快', '开心', 'summer', 'sunny', 'fun'], mood: 'happy' },
  { keys: ['sad', '悲伤', 'slow', 'rain', '夜', 'farewell'], mood: 'sad' },
  { keys: ['angry', '愤怒', 'rock', 'metal', 'rap', 'hiphop'], mood: 'angry' },
  { keys: ['fear', '恐惧', 'dark', '悬疑', 'thriller'], mood: 'fearful' },
  { keys: ['surprise', '惊讶', 'epic', 'trailer', '古典'], mood: 'surprised' },
  { keys: ['disgust', '厌恶', 'weird', '另类'], mood: 'disgusted' },
  { keys: ['lofi', '中性', 'normal', 'study', 'background', '纯音乐'], mood: 'neutral' }
]

function guessMoodFromName(name) {
  const low = name.toLowerCase()
  for (const hint of FILENAME_HINTS) {
    if (hint.keys.some((k) => low.includes(k.toLowerCase()))) return hint.mood
  }
  return null
}

/** 读取 manifest 并补齐默认值 */
export async function loadLocalLibrary() {
  if (library.status === 'loading') return
  library.status = 'loading'
  library.error = ''
  try {
    const res = await fetch(`${BASE}music/manifest.json`, { cache: 'no-store' })
    if (!res.ok) throw new Error(`manifest.json 请求失败（${res.status}）`)
    const json = await res.json()
    const tracks = (json.tracks || []).map((t) => normalizeTrack({ ...t, source: 'local' }))
    library.tracks = tracks
    library.status = 'ready'
    library.loadedAt = Date.now()
    return tracks
  } catch (err) {
    library.status = 'error'
    library.error = err.message
    // 没有清单也不致命：在线 API 仍可工作
    library.tracks = []
    return []
  }
}

export function normalizeTrack(t) {
  const mood = t.mood && typeof t.mood === 'object' ? t.mood : {}
  const sum = Object.values(mood).reduce((a, b) => a + Number(b || 0), 0)
  return {
    id: t.id || `${t.source || 'x'}-${Math.random().toString(36).slice(2, 8)}`,
    url: url(t.url || t.file || ''),
    title: t.title || '未知标题',
    artist: t.artist || '未知歌手',
    album: t.album || '',
    genre: Array.isArray(t.genre) ? t.genre : String(t.genre || '').split(/[,，/]/).filter(Boolean),
    // mood 归一化为情绪分布（缺失则退回「中性」）
    mood: sum > 0 ? Object.fromEntries(Object.entries(mood).map(([k, v]) => [k, Number(v) / sum])) : { neutral: 1 },
    valence: Number(t.valence ?? 0),
    arousal: Number(t.arousal ?? 0),
    bpm: Number(t.bpm ?? 0), // 0 = 未知，能量分量会退回中性 0.5 分而不误判
    bpmEnergy: Number(t.bpmEnergy ?? (Number(t.bpm) > 0 ? Math.min(1, Math.max(0, (Number(t.bpm) - 50) / 110)) : 0.5)),
    rating: Number(t.rating ?? 0.5),
    duration: Number(t.duration ?? 0),
    cover: t.cover || t.pic || t.album_image || '',
    lyric: t.lyric || t.lrc || '',
    source: t.source || 'local',
    provider: t.provider || '',
    reason: t.reason || '',
    annotated: t.annotated !== false && !!t.mood,
    playCount: 0
  }
}

/**
 * 导入本地音频文件（<input type=file multiple accept="audio/*">）
 * 用 <audio> 元素读出真实时长；情绪标签先按文件名猜，猜不到给 neutral。
 */
export async function importAudioFiles(files) {
  const out = []
  for (const f of Array.from(files)) {
    const t = normalizeTrack({
      id: `user-${f.name}-${f.size}`,
      url: URL.createObjectURL(f),
      title: f.name.replace(/\.[a-z0-9]+$/i, ''),
      artist: '本地导入',
      source: 'local',
      provider: 'file',
      rating: 0.6,
      annotated: false,
      mood: {}
    })
    t.duration = await probeDuration(t.url)
    const hint = guessMoodFromName(f.name)
    if (hint) {
      t.mood = { [hint]: 1 }
      t.annotated = true
    }
    out.push(t)
  }
  library.userTracks = [...library.userTracks, ...out]
  return out
}

function probeDuration(src) {
  return new Promise((resolve) => {
    const a = new Audio()
    const done = (v) => {
      a.removeEventListener('loadedmetadata', ok)
      resolve(v)
    }
    const ok = () => done(a.duration || 0)
    a.addEventListener('loadedmetadata', ok, { once: true })
    a.addEventListener('error', () => done(0), { once: true })
    setTimeout(() => done(a.duration || 0), 3000)
    a.preload = 'metadata'
    a.src = src
  })
}

/** 给用户手动修正导入曲目标签用（点击情绪芯片即写入） */
export function annotateTrack(track, emotionKey, weight = 1) {
  const target = [...library.tracks, ...library.userTracks].find((t) => t.id === track.id)
  if (!target) return
  target.mood = { [emotionKey]: weight }
  target.annotated = true
}

/** 推荐算法看到的完整本地候选池 */
export function localPool() {
  return [...library.tracks, ...library.userTracks]
}

export function allTracks() {
  return { local: localPool(), count: localPool().length }
}
