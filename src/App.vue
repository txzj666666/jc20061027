<script setup>
/**
 * App.vue —— 页面骨架
 * 布局：顶部状态条 / 三栏主区（采集 → 情绪 → 歌单）/ 底部播放器
 */
import { onMounted } from 'vue'
import CapturePanel from './components/CapturePanel.vue'
import EmotionPanel from './components/EmotionPanel.vue'
import SongList from './components/SongList.vue'
import PlayerBar from './components/PlayerBar.vue'
import SettingsDrawer from './components/SettingsDrawer.vue'
import { loadSettings } from './config/settings'
import { loadLocalLibrary, library } from './core/musicLibrary'
import { engine } from './core/faceEngine'
import { session } from './stores/session'
import { EMOTIONS } from './config/emotions'

onMounted(async () => {
  loadSettings() // 回填上次调过的参数
  await loadLocalLibrary() // 读取 public/music/manifest.json
})
</script>

<template>
  <div class="app-shell">
    <!-- -------------------------------------------------- 顶部状态条 -->
    <header class="app-header">
      <i class="logo-dot" />
      <div class="brand">
        FaceTunes
        <small>人脸情绪识别 · 歌曲推荐</small>
      </div>

      <span class="badge ok" title="模型与推理全部在本机浏览器完成，人脸像素不会上传">
        🔒 本地推理<template v-if="engine.backend"> · {{ engine.backend }}</template>
      </span>
      <span v-if="session.snapshot" class="badge" :style="{ color: EMOTIONS[session.snapshot.label].color }">
        {{ EMOTIONS[session.snapshot.label].emoji }} {{ EMOTIONS[session.snapshot.label].label }}
        {{ (session.snapshot.confidence * 100).toFixed(0) }}%
      </span>
      <span v-if="library.error" class="badge err" title="本地曲库清单读取失败">曲库: {{ library.error }}</span>

      <div class="spacer" />
      <span class="muted mono">Vue 3 + Vite + face-api.js</span>
      <SettingsDrawer />
    </header>

    <!-- -------------------------------------------------- 三栏主区 -->
    <main class="app-main">
      <div class="col">
        <CapturePanel />
      </div>
      <div class="col">
        <EmotionPanel />
      </div>
      <div class="col col-songs">
        <SongList />
      </div>
    </main>

    <!-- -------------------------------------------------- 底部播放器 -->
    <PlayerBar />

    <!-- -------------------------------------------------- 全局提示 -->
    <div class="toast-stack">
      <TransitionGroup name="fade">
        <div v-for="t in session.toasts" :key="t.id" class="toast" :class="t.type">{{ t.text }}</div>
      </TransitionGroup>
    </div>
  </div>
</template>

<style scoped>
.app-header {
  flex-wrap: wrap;
}
</style>
