<script setup>
/**
 * SettingsDrawer.vue —— 参数面板：在线 API / 识别超参 / 推荐权重 / 本地曲库
 * 所有输入直接 v-model 绑定到 config/app.js 的 reactive 配置对象，
 * 点「保存」写入 localStorage，刷新后自动 loadSettings() 回填。
 */
import { ref, computed } from 'vue'
import { faceConfig, trackerConfig, recommendConfig, onlineConfig } from '../config/app'
import { saveSettings, resetSettings } from '../config/settings'
import { engine } from '../core/faceEngine'
import { library, loadLocalLibrary } from '../core/musicLibrary'
import { searchByEmotion, clearOnlineCache } from '../core/onlineMusic'
import { toast, session, recommend } from '../stores/session'

const open = ref(false)
const testing = ref(false)
const weightSum = computed(() => Object.values(recommendConfig.weights).reduce((a, b) => a + b, 0))

function save() {
  saveSettings()
  toast('参数已保存（inputSize / 关键点模型改动需刷新页面生效）', 'ok')
  open.value = false
}

async function testOnline() {
  testing.value = true
  try {
    const { songs, errors, provider } = await searchByEmotion(session.snapshot?.label || 'happy', [])
    if (songs.length) toast(`✓ ${provider} 可用，返回 ${songs.length} 首：${songs[0].title}`, 'ok', 6000)
    else toast(`✗ ${provider} 未返回结果：${errors.join(' / ') || '空列表'}`, 'error', 8000)
  } catch (e) {
    toast(`✗ 测试失败：${e.message}`, 'error', 8000)
  } finally {
    testing.value = false
  }
}

async function reloadLibrary() {
  const t = await loadLocalLibrary()
  toast(`本地曲库已重新加载：${t.length} 首`, 'ok')
}

function defaults() {
  resetSettings()
  toast('已恢复默认参数，刷新页面生效', 'info')
}
</script>

<template>
  <button class="btn btn-sm" @click="open = !open">⚙️ 设置</button>

  <!-- 必须 Teleport 到 body：.app-header 上的 backdrop-filter 会成为 fixed 后代的包含块，
       导致抽屉的 top/bottom 相对头部计算而塌成 2px 高 -->
  <Teleport defer to="body">
    <Transition name="fade">
      <aside v-if="open" class="drawer">
      <div class="drawer-head">
        <b>系统设置</b>
        <button class="btn btn-sm btn-ghost" @click="open = false">✕</button>
      </div>

      <div class="drawer-body">
        <section>
          <h4>① 在线歌曲 API</h4>
          <label class="field">数据源</label>
          <select v-model="onlineConfig.provider">
            <option value="jamendo">Jamendo 官方 API（免费 client_id，30s 试听）</option>
            <option value="meting">Meting 聚合接口（华语，走代理绕 CORS）</option>
            <option value="ncm">自建 NeteaseCloudMusicApi（localhost:3000）</option>
            <option value="off">关闭在线源（仅本地曲库）</option>
          </select>

          <template v-if="onlineConfig.provider === 'jamendo'">
            <label class="field">client_id（<a href="https://www.jamendo.com/settings/api" target="_blank" rel="noreferrer">免费申请</a>）</label>
            <input v-model.trim="onlineConfig.jamendoClientId" type="text" placeholder="例如 a1b2c3d4" />
          </template>

          <template v-if="onlineConfig.provider === 'meting'">
            <label class="field">接口地址（dev 默认走 vite 代理 /meting/meting/）</label>
            <input v-model.trim="onlineConfig.metingBaseUrl" type="text" />
            <label class="field">曲源</label>
            <select v-model="onlineConfig.metingServer">
              <option value="netease">网易云</option>
              <option value="tencent">QQ 音乐</option>
              <option value="xiami">虾米</option>
              <option value="kugou">酷狗</option>
            </select>
          </template>

          <template v-if="onlineConfig.provider === 'ncm'">
            <label class="field">NeteaseCloudMusicApi 基址（dev 代理 /ncm）</label>
            <input v-model.trim="onlineConfig.ncmBaseUrl" type="text" />
          </template>

          <div class="row" style="margin-top: 10px">
            <button class="btn btn-sm" :disabled="testing || onlineConfig.provider === 'off'" @click="testOnline">
              {{ testing ? '测试中…' : '🔌 测试连通性' }}
            </button>
            <button class="btn btn-sm btn-ghost" @click="clearOnlineCache(); toast('在线结果缓存已清空', 'ok')">清空缓存</button>
          </div>
        </section>

        <section>
          <h4>② 识别参数（face-api.js）</h4>
          <div class="grid2">
            <div>
              <label class="field">检测分辨率 inputSize（需刷新）</label>
              <select v-model.number="faceConfig.inputSize">
                <option :value="224">224（快）</option>
                <option :value="320">320（默认）</option>
                <option :value="416">416（准）</option>
              </select>
            </div>
            <div>
              <label class="field">节流 interval（ms）</label>
              <input v-model.number="faceConfig.intervalMs" type="number" min="40" max="1000" step="10" />
            </div>
            <div>
              <label class="field">人脸阈值 scoreThreshold</label>
              <input v-model.number="faceConfig.scoreThreshold" type="range" min="0.1" max="0.7" step="0.01" />
              <span class="mono">{{ faceConfig.scoreThreshold.toFixed(2) }}</span>
            </div>
            <div>
              <label class="field">采纳阈值 minDetScore</label>
              <input v-model.number="faceConfig.minDetScore" type="range" min="0.2" max="0.9" step="0.01" />
              <span class="mono">{{ faceConfig.minDetScore.toFixed(2) }}</span>
            </div>
          </div>
          <label class="field"><input type="checkbox" v-model="faceConfig.withLandmarks" /> 加载 68 点关键点模型（需刷新）</label>
        </section>

        <section>
          <h4>③ 情绪时序聚合</h4>
          <label class="field">EMA 平滑系数 α（越大越跟手）</label>
          <input v-model.number="trackerConfig.emaAlpha" type="range" min="0.05" max="0.9" step="0.05" />
          <span class="mono">{{ trackerConfig.emaAlpha.toFixed(2) }}</span>
          <div class="grid2">
            <div>
              <label class="field">确认所需帧数</label>
              <input v-model.number="trackerConfig.stableFrames" type="number" min="1" max="30" />
            </div>
            <div>
              <label class="field">切换领先幅度</label>
              <input v-model.number="trackerConfig.switchMargin" type="number" min="0" max="0.4" step="0.01" />
            </div>
            <div>
              <label class="field">最低置信度</label>
              <input v-model.number="trackerConfig.minConfidence" type="number" min="0" max="0.9" step="0.01" />
            </div>
          </div>
        </section>

        <section>
          <h4>④ 推荐算法权重（和应为 {{ weightSum.toFixed(2) }}）</h4>
          <div v-for="(v, k) in recommendConfig.weights" :key="k" class="wrow">
            <span>{{ { mood: '情绪标签', circumplex: '环状模型', energy: '能量BPM', popularity: '热度', freshness: '新鲜度' }[k] }}</span>
            <input type="range" min="0" max="0.6" step="0.01" :value="v" @input="recommendConfig.weights[k] = Number($event.target.value)" />
            <span class="mono">{{ v.toFixed(2) }}</span>
          </div>
          <div class="grid2">
            <div>
              <label class="field">歌单长度 slots</label>
              <input v-model.number="recommendConfig.slots" type="number" min="4" max="24" />
            </div>
            <div>
              <label class="field">本地占比</label>
              <input v-model.number="recommendConfig.localRatio" type="range" min="0" max="1" step="0.05" />
              <span class="mono">{{ (recommendConfig.localRatio * 100).toFixed(0) }}%</span>
            </div>
            <div>
              <label class="field">MMR λ（多样性）</label>
              <input v-model.number="recommendConfig.mmrLambda" type="range" min="0.3" max="1" step="0.05" />
              <span class="mono">{{ recommendConfig.mmrLambda.toFixed(2) }}</span>
            </div>
          </div>
        </section>

        <section>
          <h4>⑤ 曲库与模型</h4>
          <div class="row">
            <span class="badge">本地曲目 {{ library.tracks.length + library.userTracks.length }}</span>
            <span class="badge">模型 {{ engine.modelsLoaded.join(' + ') || '未加载' }}</span>
            <span class="badge">后端 {{ engine.backend }}</span>
          </div>
          <div class="row" style="margin-top: 8px">
            <button class="btn btn-sm" @click="reloadLibrary">↻ 重载本地曲库</button>
            <button class="btn btn-sm" @click="recommend(session.snapshot, { force: true })" :disabled="!session.snapshot">
              ▶ 用当前参数重算推荐
            </button>
          </div>
          <p class="muted" style="font-size: 11.5px; margin-top: 8px">
            本地歌曲放置：<code>public/music/*.mp3</code>，并在 <code>public/music/manifest.json</code> 里登记
            title / artist / genre / mood / valence / arousal / bpm / rating。执行 <code>npm run music</code>
            可生成 14 首演示音源与清单。
          </p>
        </section>
      </div>

      <div class="drawer-foot">
        <button class="btn btn-ghost btn-sm" @click="defaults">恢复默认</button>
        <div class="spacer" />
        <button class="btn btn-primary" @click="save">保存参数</button>
      </div>
      </aside>
    </Transition>
  </Teleport>
</template>

<style scoped>
.drawer {
  position: fixed;
  right: 14px;
  top: 66px;
  bottom: 96px;
  width: min(400px, 92vw);
  z-index: 70;
  display: flex;
  flex-direction: column;
  border-radius: var(--radius);
  border: 1px solid var(--line-strong);
  background: rgba(10, 13, 24, 0.97);
  box-shadow: 0 30px 80px -20px rgba(0, 0, 0, 0.9);
}

.drawer-head,
.drawer-foot {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 14px;
  border-bottom: 1px solid var(--line);
}

.drawer-foot {
  border-bottom: 0;
  border-top: 1px solid var(--line);
}

.drawer-body {
  flex: 1;
  overflow: auto;
  padding: 6px 14px 14px;
}

h4 {
  margin: 16px 0 6px;
  font-size: 12.5px;
  color: var(--brand-2);
  letter-spacing: 0.04em;
}

.grid2 {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
}

.wrow {
  display: grid;
  grid-template-columns: 72px 1fr 38px;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: var(--text-dim);
}

.wrow input {
  accent-color: var(--brand);
}

input[type='range'] {
  width: 100%;
  accent-color: var(--brand);
}

a {
  color: var(--brand-2);
}

code {
  background: rgba(255, 255, 255, 0.08);
  padding: 1px 5px;
  border-radius: 5px;
}
</style>
