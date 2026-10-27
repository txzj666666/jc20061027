<script setup>
/**
 * SongList.vue —— 推荐结果列表（含匹配度分解与推荐理由）
 */
import { ref, computed } from 'vue'
import { session, toast } from '../stores/session'
import { playSong, player } from '../composables/usePlayer'
import { importAudioFiles, annotateTrack, library, localPool } from '../core/musicLibrary'
import { EMOTIONS } from '../config/emotions'
import { recommendConfig } from '../config/app'

const filter = ref('all')
const fileInput = ref(null)
const emotion = computed(() => (session.snapshot ? EMOTIONS[session.snapshot.label] : null))

const shown = computed(() => {
  const list = session.songs
  if (filter.value === 'all') return list
  return list.filter((s) => (filter.value === 'local' ? s.song.source === 'local' : s.song.source === 'online'))
})

const localCount = computed(() => localPool().length)
const onlineCount = computed(() => session.songs.filter((s) => s.song.source === 'online').length)

async function onImport(e) {
  const files = e.target.files
  if (!files?.length) return
  const added = await importAudioFiles(files)
  toast(`已导入 ${added.length} 首本地音频${added.some((a) => !a.annotated) ? '，其中部分需要在列表里点情绪标签标注' : ''}`, 'info')
  e.target.value = ''
}

/** 未标注的导入曲目：提供一键标注芯片（见模板中的 annotateTrack 按钮） */
</script>

<template>
  <section class="card card-fill" :style="emotion ? { '--emotion-color': emotion.color } : {}">
    <div class="card-title">
      <b>③ 情绪歌单</b>
      <div class="row" style="gap: 6px">
        <span v-if="session.recStatus === 'scoring'" class="badge run"><i class="dot live" />正在打分排序…</span>
        <span v-else-if="session.onlineStatus === 'loading'" class="badge run"><i class="dot live" />拉取在线曲目…</span>
        <span v-else-if="session.recStatus === 'error'" class="badge err">{{ session.recError }}</span>
        <span v-else class="badge ok">本地 {{ localCount }} / 在线 {{ onlineCount }}</span>
      </div>
    </div>

    <div class="row" style="margin-bottom: 10px">
      <button class="btn btn-sm" :class="{ on: filter === 'all' }" @click="filter = 'all'">全部</button>
      <button class="btn btn-sm" :class="{ on: filter === 'local' }" @click="filter = 'local'">仅本地</button>
      <button class="btn btn-sm" :class="{ on: filter === 'online' }" @click="filter = 'online'">仅在线</button>
      <div class="spacer" />
      <button class="btn btn-sm btn-ghost" @click="fileInput.click()">➕ 导入本地音频</button>
      <input ref="fileInput" type="file" accept="audio/*" multiple style="display: none" @change="onImport" />
    </div>

    <div v-if="session.recError" class="badge err" style="margin-bottom: 10px; width: 100%; padding: 8px; text-align: left; white-space: normal">
      {{ session.recError }}
    </div>
    <div v-if="session.onlineErrors.length" class="badge warn" style="margin-bottom: 10px; width: 100%; padding: 8px; text-align: left; white-space: normal">
      在线源提示：{{ session.onlineErrors.join(' ; ') }} —— 已自动降级为「本地曲库优先」
    </div>

    <!-- 空态 -->
    <div v-if="!session.songs.length && session.recStatus !== 'scoring'" class="muted" style="text-align: center; padding: 34px 10px; font-size: 13px">
      还没有歌单。<br />
      识别到情绪后会自动生成（本地 {{ recommendConfig.localRatio * 100 }}% + 在线
      {{ recommendConfig.onlineRatio * 100 }}%）。
      <div v-if="!library.tracks.length" style="margin-top: 10px">
        本地曲库为空：请先执行 <code class="mono">npm run music</code> 生成演示音源。
      </div>
    </div>

    <div v-else class="list" style="display: flex; flex-direction: column; gap: 8px; overflow: auto; min-height: 0">
      <TransitionGroup name="list">
        <div
          v-for="item in shown"
          :key="item.song.id"
          class="song-item"
          :class="{ disabled: item.song.unplayable, playing: player.current?.id === item.song.id }"
          @click="!item.song.unplayable && playSong(item.song, item.rank - 1)"
        >
          <div class="song-cover">
            <img v-if="item.song.cover" :src="item.song.cover" alt="" loading="lazy" @error="item.song.cover = ''" />
            <span v-else>{{ emotion?.emoji || '🎵' }}</span>
          </div>

          <div style="min-width: 0">
            <div class="song-title">
              {{ item.rank }}. {{ item.song.title }}
              <span v-if="item.song.unplayable" class="chip off">不可播</span>
            </div>
            <div class="song-artist">{{ item.song.artist }} · {{ item.song.album || '—' }}</div>
            <div class="chips">
              <span class="chip" :class="item.song.source === 'local' ? 'local' : 'online'">
                {{ item.song.source === 'local' ? '本地' : `在线·${item.song.provider}` }}
              </span>
              <span v-for="g in item.song.genre.slice(0, 2)" :key="g" class="chip">{{ g }}</span>
              <span v-if="item.song.bpm" class="chip">{{ item.song.bpm }} BPM</span>
              <span v-if="!item.song.annotated" class="chip warn">未标注</span>
            </div>
            <!-- 打分最高的两个分量 → 可解释推荐理由 -->
            <div class="muted" style="font-size: 11px; margin-top: 3px">{{ item.why.join(' · ') }}</div>
            <!-- 未标注曲目的一键情绪标注 -->
            <div v-if="!item.song.annotated" class="row" style="gap: 4px; margin-top: 5px">
              <button
                v-for="k in ['happy', 'sad', 'neutral', 'angry']"
                :key="k"
                class="btn btn-sm"
                style="padding: 2px 7px; font-size: 11px"
                @click.stop="annotateTrack(item.song, k)"
              >
                {{ EMOTIONS[k].emoji }}
              </button>
            </div>
          </div>

          <div class="match">
            <b>{{ (item.total * 100).toFixed(0) }}%</b>
            <small>匹配度</small>
            <div class="bar" style="width: 62px; margin-top: 4px">
              <i :style="{ width: (item.total * 100).toFixed(0) + '%', '--c': emotion?.color || '#7c5cff' }" />
            </div>
          </div>
        </div>
      </TransitionGroup>
    </div>
  </section>
</template>

<style scoped>
.song-cover img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

.chip.warn {
  color: var(--warn);
}
</style>
