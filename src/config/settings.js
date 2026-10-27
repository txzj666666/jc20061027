/**
 * settings.js —— 参数持久化：把 4 个配置对象存进 localStorage，
 * 应用启动时 loadSettings() 回填，设置面板改动后 saveSettings()。
 */
import { faceConfig, trackerConfig, recommendConfig, onlineConfig, STORAGE_KEY } from './app'

export function loadSettings() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return
    const s = JSON.parse(raw)
    Object.assign(faceConfig, s.face || {})
    Object.assign(trackerConfig, s.tracker || {})
    // weights 是嵌套对象，需要单独合并
    Object.assign(recommendConfig, s.recommend || {})
    if (s.recommend?.weights) Object.assign(recommendConfig.weights, s.recommend.weights)
    Object.assign(onlineConfig, s.online || {})
  } catch (e) {
    console.warn('[settings] 读取本地配置失败，使用默认值：', e.message)
  }
}

export function saveSettings() {
  localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({
      face: { ...faceConfig },
      tracker: { ...trackerConfig },
      recommend: { ...recommendConfig },
      online: { ...onlineConfig }
    })
  )
}

export function resetSettings() {
  localStorage.removeItem(STORAGE_KEY)
}
