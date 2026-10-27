<script setup>
/**
 * PlayerBar.vue —— 内置简易音频播放器
 * 直接消费 <audio> 的 currentTime/duration，支持拖动定位、音量、循环、上下曲。
 * 本地 wav/mp3（public/music 或 ObjectURL）与在线直链（Jamendo/Meting/NCM）都走同一通道。
 */
import { computed } from 'vue'
import { player, toggle, next, prev, seek, nudge, setVolume, toggleMute, setLoop } from '../composables/usePlayer'
import { session } from '../stores/session'
import { EMOTIONS } from '../config/emotions'

const emotion = computed(() => (session.snapshot ? EMOTIONS[session.snapshot.label] : null))
const pct = computed(() => (player.duration ? (player.time / player.duration) * 100 : 0))
const fmt = (s) => {
  if (!Number.isFinite(s) || s <= 0) return '0:00'
  const m = Math.floor(s / 60)
  const ss = Math.floor(s % 60)
  return `${m}:${String(ss).padStart(2, '0')}`
}

function onSeekClick(e) {
  const r = e.currentTarget.getBoundingClientRect()
  seek((e.clientX - r.left) / r.width)
}

const has = computed(() => !!player.current)
</script>

<template>
  <footer class="player" :style="emotion ? { '--emotion-color': emotion.color } : {}">
    <div class="row" style="min-width: 0">
      <div class="song-cover" style="width: 46px; height: 46px">
        <img v-if="player.current?.cover" :src="player.current.cover" alt="" />
        <span v-else>{{ emotion?.emoji || '🎵' }}</span>
      </div>
      <div style="min-width: 0">
        <div class="song-title">{{ has ? player.current.title : '未在播放' }}</div>
        <div class="song-artist">
          {{ has ? player.current.artist : '点左侧识别情绪 → 点歌单播放' }}
          <span v-if="has" class="chip" :class="player.current.source === 'local' ? 'local' : 'online'" style="margin-left: 6px">
            {{ player.current.source === 'local' ? '本地' : '在线' }}
          </span>
        </div>
        <div v-if="player.error" class="chip off" style="margin-top: 3px">{{ player.error }}</div>
      </div>
    </div>

    <div class="row" style="gap: 8px">
      <button class="btn btn-sm btn-ghost" :disabled="!session.songs.length" @click="prev" title="上一首">⏮</button>
      <button class="play-btn" @click="toggle" :title="player.playing ? '暂停' : '播放'">
        <span v-if="player.buffering" class="spinner" style="width: 18px; height: 18px; border-width: 2px" />
        <span v-else>{{ player.playing ? '⏸' : '▶' }}</span>
      </button>
      <button class="btn btn-sm btn-ghost" :disabled="!session.songs.length" @click="next()" title="下一首">⏭</button>
      <button class="btn btn-sm" :class="{ on: player.loop }" @click="setLoop(!player.loop)" title="单曲循环">🔁</button>
    </div>

    <div>
      <div class="seek" @click="onSeekClick">
        <div class="seek-track">
          <div class="seek-fill" :style="{ '--p': pct + '%' }" />
        </div>
      </div>
      <div class="row" style="justify-content: space-between">
        <span class="time">{{ fmt(player.time) }}</span>
        <span class="time">{{ has ? `${session.songs.findIndex((s) => s.song.id === player.current?.id) + 1}/${session.songs.length}` : '' }}</span>
        <span class="time">{{ fmt(player.duration) }}</span>
      </div>
    </div>

    <div class="row">
      <button class="btn btn-sm btn-ghost" @click="nudge(-5)">-5s</button>
      <button class="btn btn-sm btn-ghost" @click="nudge(5)">+5s</button>
      <button class="btn btn-sm btn-ghost" @click="toggleMute">{{ player.muted ? '🔇' : '🔊' }}</button>
      <input class="vol" type="range" min="0" max="1" step="0.01" :value="player.volume" @input="setVolume(Number($event.target.value))" />
    </div>
  </footer>
</template>

<style scoped>
img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  border-radius: 10px;
}
</style>
