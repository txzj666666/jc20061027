/**
 * usePlayer.js —— 内置简易播放器（HTML5 <audio> 封装）
 * 支持本地文件（ObjectURL / public 下的 wav、mp3）与在线直链（Jamendo/Meting 等）。
 * 关键点：
 *  - 在线直链可能 403/超时（版权或防盗链），这里做「标记不可播 + 自动跳下一首」，
 *    最多连续跳 5 首，避免死循环。
 *  - <audio> 默认不发 CORS 头，直链播放不受跨域限制；但要显示波形/歌词需 crossorigin。
 */
import { reactive, readonly } from 'vue'
import { session, markPlayed, toast } from '../stores/session'
export const player = reactive({
  current: null,
  index: -1,
  playing: false,
  time: 0,
  duration: 0,
  volume: 0.85,
  muted: false,
  loop: false,
  error: '',
  buffering: false,
  skipStreak: 0
})

let audio = null

function ensureAudio() {
  if (audio) return audio
  audio = new Audio()
  audio.preload = 'metadata'
  audio.volume = player.volume
  audio.addEventListener('timeupdate', () => {
    player.time = audio.currentTime
  })
  audio.addEventListener('loadedmetadata', () => {
    player.duration = Number.isFinite(audio.duration) ? audio.duration : player.current?.duration || 0
    player.buffering = false
  })
  audio.addEventListener('waiting', () => (player.buffering = true))
  audio.addEventListener('playing', () => {
    player.buffering = false
    player.playing = true
  })
  audio.addEventListener('pause', () => (player.playing = false))
  audio.addEventListener('ended', () => {
    if (player.loop) {
      audio.currentTime = 0
      audio.play().catch(() => {})
    } else next()
  })
  audio.addEventListener('error', () => {
    player.playing = false
    player.buffering = false
    const s = player.current
    if (s) {
      s.unplayable = true
      player.error = `${s.title}：音频源无法播放（可能是外链失效/需要会员）`
      toast(player.error, 'warn')
    }
    // 自动跳过不可播曲目，连续失败上限 5 次
    if (player.skipStreak < 5) {
      player.skipStreak++
      setTimeout(() => next(true), 700)
    } else {
      toast('多首在线曲目无法播放，建议在设置里切换在线源或使用本地曲库', 'error', 6000)
    }
  })
  return audio
}

export function playSong(song, index) {
  const a = ensureAudio()
  if (!song) return
  player.skipStreak = 0
  player.error = ''
  player.current = song
  player.index = index ?? session.songs.findIndex((s) => s.song.id === song.id)
  a.src = song.url
  a.volume = player.muted ? 0 : player.volume
  markPlayed(song.id)
  a.play()
    .then(() => {
      player.playing = true
    })
    .catch((err) => {
      // Safari/Chrome 会在非用户手势下拦截自动播放
      player.playing = false
      player.error = String(err.message || err)
      if (err.name !== 'NotAllowedError') toast(`无法播放：${player.error}`, 'error')
    })
}

export function toggle() {
  const a = ensureAudio()
  if (!player.current) {
    if (session.songs.length) playSong(session.songs[0].song, 0)
    return
  }
  if (player.playing) a.pause()
  else a.play().catch(() => {})
}

export function next(auto = false) {
  if (!session.songs.length) return
  const i = (player.index + 1) % session.songs.length
  if (auto && session.songs[i]?.unplayable) {
    player.skipStreak++
    if (player.skipStreak > 5) return
  }
  playSong(session.songs[i].song, i)
}

export function prev() {
  if (!session.songs.length) return
  const i = (player.index - 1 + session.songs.length) % session.songs.length
  playSong(session.songs[i].song, i)
}

export function seek(ratio) {
  const a = ensureAudio()
  if (!player.duration) return
  a.currentTime = Math.max(0, Math.min(player.duration, ratio * player.duration))
}

export function nudge(seconds) {
  const a = ensureAudio()
  a.currentTime = Math.max(0, a.currentTime + seconds)
}

export function setVolume(v) {
  player.volume = v
  player.muted = v === 0
  if (audio) audio.volume = v
  if (audio) audio.muted = v === 0
}

export function toggleMute() {
  player.muted = !player.muted
  if (audio) audio.muted = player.muted
}

export function setLoop(v) {
  player.loop = v
  if (audio) audio.loop = v
}

export function stopPlayback() {
  const a = ensureAudio()
  a.pause()
  a.removeAttribute('src')
  a.load()
  player.playing = false
  player.current = null
  player.time = 0
  player.duration = 0
}

export function usePlayer() {
  ensureAudio()
  return { player, playSong, toggle, next, prev, seek, nudge, setVolume, toggleMute, setLoop, stopPlayback }
}

export const playerState = readonly(player)
