/**
 * onlineMusic.js —— 在线歌曲 API 适配层
 * ==================================================================
 * 统一接口：searchByEmotion(emotionKey, target) → Song[]
 * 三个 provider，任选其一，失败自动降级到「只用本地库」：
 *
 * ① jamendo（默认，推荐）
 *    官方开放 API，浏览器可直接跨域调用（CORS 友好），返回 30 秒合法试听 mp3。
 *    申请：https://www.jamendo.com/settings/api （免费，填个应用名即可拿到 client_id）
 *    文档：https://dev.jamendo.com/doc/api/
 *    GET https://api.jamendo.com/v3.0/tracks/?client_id=XX&format=json&limit=20
 *        &tag=<mood 标签>&audio=mp3205&order=mooddesc
 *    返回字段：name / artist_name / album_image / audio(直链) / duration / tags
 *
 * ② meting（中文华语曲库，走聚合代理）
 *    Meting 聚合接口（网易云 / QQ / 酷狗 / 酷我 四源），公网公共实例：
 *      https://api.injahow.cn/meting/    https://meting.qjqq.cn/
 *    公网实例常因 CORS 或限流失败，因此 dev 环境优先走 vite.config.js 里的
 *    `/meting` 代理（服务端转发，不受浏览器 CORS 限制）；
 *    生产部署请把同一条反代规则配到 Nginx。
 *    GET /meting/meting/?server=netease&type=search&id=<关键词>&text=1&limit=20
 *
 * ③ ncm（自建 NeteaseCloudMusicApi，功能最完整、可拿歌词）
 *    npm i -g ncm-api 或 docker run -p 3000:3000 binwiederhier/ncm-api
 *    GET /ncm/search/get?keywords=XX&limit=20 → 再用 outer/url 拼直链
 *    注意：VIP/版权歌曲可能没有可播直链，前端会标记为「不可播」并跳过。
 *
 * 缓存：同一 provider+情绪的结果缓存 recommendConfig.onlineCacheTtl（默认 5 分钟）
 */
import { onlineConfig, recommendConfig } from '../config/app'
import { EMOTIONS } from '../config/emotions'
import { normalizeTrack } from './musicLibrary'

const cache = new Map() // key -> {at, songs}

function withTimeout(promise, ms) {
  return Promise.race([promise, new Promise((_, rej) => setTimeout(() => rej(new Error(`请求超时（${ms}ms）`)), ms))])
}

async function getJSON(url, opts = {}) {
  const res = await withTimeout(fetch(url, { ...opts, signal: opts.signal }), onlineConfig.timeoutMs)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const text = await res.text()
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`接口返回非 JSON（可能被 CORS 拦截或需要登录）：${text.slice(0, 80)}`)
  }
}

/** Jamendo 的 mood 标签体系 → 7 类情绪 */
const JAMENDO_TAGS = {
  neutral: ['relaxing', 'calm', 'acoustic'],
  happy: ['happy', 'funny', 'feelgood', 'uplifting'],
  sad: ['sad', 'melancholic', 'sentimental'],
  angry: ['aggressive', 'energetic', 'powerful'],
  fearful: ['dark', 'suspense', 'mysterious'],
  disgusted: ['weird', 'strange', 'quirky'],
  surprised: ['epic', 'dramatic', 'unexpected']
}

/** 把在线接口返回的标签文本转成本系统的情绪隶属度向量（供 MMR/打分使用） */
function tagsToMood(tags, emotionKey) {
  const mood = { [emotionKey]: 0.7 }
  const low = (tags || []).map((t) => String(t).toLowerCase())
  for (const [key, list] of Object.entries(JAMENDO_TAGS)) {
    if (key === emotionKey) continue
    if (low.some((t) => list.some((tag) => t.includes(tag)))) mood[key] = (mood[key] || 0) + 0.2
  }
  return mood
}

async function searchJamendo(emotionKey, limit) {
  const cfg = onlineConfig
  if (!cfg.jamendoClientId) throw new Error('未配置 Jamendo client_id（点右上角「设置」填入，免费申请）')
  const tag = JAMENDO_TAGS[emotionKey]?.[0] || 'relaxing'
  const u = new URL('https://api.jamendo.com/v3.0/tracks/')
  u.search = new URLSearchParams({
    client_id: cfg.jamendoClientId,
    format: 'json',
    limit: String(Math.min(limit, 50)),
    tag,
    audio: 'mp3205', // 只要 320kbps 的 mp3 直链
    order: 'mooddesc',
    fullname: 1
  }).toString()
  const json = await getJSON(u.toString())
  const list = json.response || []
  return list
    .filter((t) => t.audio)
    .map((t, i) =>
      normalizeTrack({
        id: `jamendo-${t.id}`,
        url: t.audio,
        title: t.name,
        artist: t.artist_name,
        album: t.album_name,
        cover: t.album_image,
        duration: t.duration,
        genre: (t.tags || []).slice(0, 4),
        // Jamendo 不返回 bpm/效价，用曲风标签 + 平台热度近似
        bpm: 0,
        valence: EMOTIONS[emotionKey].valence * 0.7,
        arousal: EMOTIONS[emotionKey].arousal * 0.7,
        mood: tagsToMood(t.tags, emotionKey),
        rating: Math.min(1, 0.35 + (t.popularity || 0) / 100),
        source: 'online',
        provider: 'jamendo',
        lyric: '',
        annotated: true,
        homepage: t.shareurl,
        reason: `Jamendo 标签「${tag}」匹配 ${EMOTIONS[emotionKey].label} 情绪`
      })
    )
}

async function searchMeting(emotionKey, limit) {
  const cfg = onlineConfig
  const kw = EMOTIONS[emotionKey].keywords[0] || EMOTIONS[emotionKey].label
  const bases = [cfg.metingBaseUrl, ...cfg.metingFallbackUrls].filter(Boolean)
  let lastErr
  for (const base of bases) {
    const sep = base.includes('?') ? '&' : '?'
    const url = `${base}${sep}server=${cfg.metingServer}&type=search&id=${encodeURIComponent(kw)}&text=1&limit=${limit}`
    try {
      const json = await getJSON(url)
      const arr = Array.isArray(json) ? json : json.data || json.song || json.result || []
      const songs = arr
        .filter((s) => s && (s.url || s.song || s.link))
        .map((s, i) =>
          normalizeTrack({
            id: `meting-${cfg.metingServer}-${s.id || s.url || i}`,
            url: s.url || s.song || s.link,
            title: s.title || s.name || s.song || '未知',
            artist: s.author || s.artist || s.singer || '未知',
            album: s.album || '',
            cover: s.pic || s.cover || s.img,
            lyric: s.lrc || s.lyric || '',
            duration: s.time || s.duration || 0,
            // 不把检索词伪装成歌曲自身曲风：genre 留空，曲风标签由 reason 说明
            genre: [],
            valence: EMOTIONS[emotionKey].valence * 0.8,
            arousal: EMOTIONS[emotionKey].arousal * 0.8,
            mood: { [emotionKey]: 0.75, neutral: 0.25 },
            rating: 0.62,
            source: 'online',
            provider: 'meting',
            annotated: true,
            reason: `按「${kw}」在 ${cfg.metingServer} 检索命中`
          })
        )
      if (songs.length) return songs
      lastErr = new Error('接口返回空列表')
    } catch (e) {
      lastErr = e
    }
  }
  throw lastErr || new Error('Meting 接口全部不可用')
}

async function searchNcm(emotionKey, limit) {
  const cfg = onlineConfig
  const kw = EMOTIONS[emotionKey].keywords[0] || EMOTIONS[emotionKey].label
  const url = `${cfg.ncmBaseUrl}/search/get?keywords=${encodeURIComponent(kw)}&limit=${limit}`
  const json = await getJSON(url)
  const songs = json?.result?.songs || []
  return songs
    .filter((s) => s.id)
    .map((s) =>
      normalizeTrack({
        id: `ncm-${s.id}`,
        // outer/url 是网易云公开外链，会 302 到真实音频；VIP 歌曲可能失败
        url: `https://music.163.com/song/media/outer/url?id=${s.id}.mp3`,
        title: s.name,
        artist: (s.artists || []).map((a) => a.name).join(' / '),
        album: s.album?.name,
        cover: s.album?.picUrl,
        duration: (s.duration || 0) / 1000,
        genre: [],
        valence: EMOTIONS[emotionKey].valence * 0.8,
        arousal: EMOTIONS[emotionKey].arousal * 0.8,
        mood: { [emotionKey]: 0.75, neutral: 0.25 },
        rating: 0.65,
        source: 'online',
        provider: 'ncm',
        annotated: true,
        homepage: `https://music.163.com/#/song?id=${s.id}`,
        reason: `网易云搜索「${kw}」结果`
      })
    )
}

const PROVIDERS = { jamendo: searchJamendo, meting: searchMeting, ncm: searchNcm, off: async () => [] }

/** onlineConfig 是被 settings.js 从 localStorage 回填过的 reactive 对象，这里直接引用 */
export function resolveOnlineConfig() {
  return onlineConfig
}

/**
 * 主入口：按当前情绪（含次情绪）拉取在线歌曲
 * @param {string} emotionKey 主情绪
 * @param {string[]} extraKeys 次情绪（软混合带来的第二个检索词）
 * @returns {Promise<{songs: Array, errors: string[], provider: string}>}
 */
export async function searchByEmotion(emotionKey, extraKeys = [], limit = recommendConfig.maxOnlineFetch) {
  const cfg = resolveOnlineConfig()
  const ttl = cfg.onlineCacheTtl || recommendConfig.onlineCacheTtl
  const key = `${cfg.provider}|${emotionKey}|${extraKeys.join(',')}`
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < ttl) return { songs: hit.songs, errors: hit.errors, provider: cfg.provider }

  const fn = PROVIDERS[cfg.provider] || PROVIDERS.off
  const errors = []
  let songs = []
  try {
    songs = await fn(emotionKey, Math.ceil(limit * 0.7))
    // 次情绪再补一小批，让列表不完全被同一个检索词垄断
    for (const ek of extraKeys.slice(0, 1)) {
      try {
        songs = songs.concat(await fn(ek, Math.ceil(limit * 0.3)))
      } catch (e) {
        errors.push(`${EMOTIONS[ek]?.label ?? ek}: ${e.message || e}`)
      }
    }
  } catch (e) {
    errors.push(String(e.message || e))
  }

  songs = dedupe(songs)
  cache.set(key, { at: Date.now(), songs, errors })
  return { songs, errors, provider: cfg.provider }
}

/** 同一首歌可能因为多关键词检索重复出现 */
function dedupe(songs) {
  const seen = new Set()
  return songs.filter((s) => {
    const k = `${String(s.title).toLowerCase()}|${String(s.artist).toLowerCase()}`
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
}

export function clearOnlineCache() {
  cache.clear()
}
