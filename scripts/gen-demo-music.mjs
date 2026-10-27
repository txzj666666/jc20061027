/**
 * gen-demo-music.mjs
 * ------------------------------------------------------------------
 * 用纯 Node（无任何依赖）合成一小批「情绪演示音源」WAV 文件，
 * 并生成 public/music/manifest.json。
 *
 * 目的：让项目 clone 下来就能立刻听到本地曲库的推荐效果（离线可用）。
 * 正式使用时把自己下载/拥有的 mp3 放进 public/music/，
 * 然后在 manifest.json 的 tracks 里补一条记录（README 有字段说明）。
 *
 *   node scripts/gen-demo-music.mjs        # 生成到 public/music/
 *   node scripts/gen-demo-music.mjs --clear # 先清空演示音频
 */
import { mkdirSync, writeFileSync, existsSync, rmSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const outDir = path.resolve(__dirname, '..', 'public', 'music')
const SR = 22050 // 采样率：足够听清旋律，同时把体积压到 ~45KB/秒

// ---------------------------------------------------------------- 音色库
// harmonics = 各次泛音幅度；attack/decay/sustain/release 单位秒
const TIMBRES = {
  sine: { harmonics: [1], gain: 0.5 },
  soft: { harmonics: [1, 0.32, 0.12, 0.05], gain: 0.5, attack: 0.35, release: 0.6 },
  pad: { harmonics: [1, 0.25, 0.18, 0.1, 0.06], gain: 0.42, attack: 0.5, release: 1.2, detune: 5 },
  pluck: { harmonics: [1, 0.45, 0.3, 0.18, 0.1], gain: 0.55, attack: 0.005, decay: 0.25, sustain: 0.05, release: 0.3 },
  key: { harmonics: [1, 0.5, 0.22, 0.12, 0.06, 0.03], gain: 0.5, attack: 0.008, decay: 0.6, sustain: 0.25, release: 0.7 },
  lead: { harmonics: [1, 0.65, 0.4, 0.28, 0.2, 0.14, 0.1], gain: 0.4, attack: 0.02, decay: 0.2, sustain: 0.7, release: 0.25, vibrato: 5.5 },
  saw: { harmonics: [1, 0.55, 0.36, 0.26, 0.2, 0.15, 0.11, 0.08], gain: 0.36, attack: 0.01, decay: 0.12, sustain: 0.8, release: 0.12 },
  bass: { harmonics: [1, 0.28, 0.1], gain: 0.7, attack: 0.006, decay: 0.18, sustain: 0.6, release: 0.12 },
  bell: { harmonics: [1, 0.1, 0.42, 0.05, 0.25], gain: 0.4, attack: 0.004, decay: 0.9, sustain: 0.0, release: 0.8 }
}

const midiToFreq = (m) => 440 * Math.pow(2, (m - 69) / 12)

/** 叠加正弦泛音 + ADSR + 可选颤音/失谐，写入缓冲区 */
function addNote(buf, startSec, durSec, midi, timbreName, vel = 1) {
  const t = TIMBRES[timbreName]
  const freq = midiToFreq(midi)
  const start = Math.floor(startSec * SR)
  const len = Math.max(1, Math.floor(durSec * SR))
  const attack = (t.attack ?? 0.01) * SR
  const release = (t.release ?? 0.1) * SR
  const decay = (t.decay ?? Math.max(0.05, durSec * 0.4)) * SR
  const sustain = t.sustain ?? 0.5
  const partials = t.harmonics
    .map((amp, i) => ({ amp, f: freq * (i + 1) }))
    // 超过奈奎斯特频率的泛音会被折叠成噪声，直接丢弃
    .filter((p) => p.f < SR / 2 - 1)

  for (let n = 0; n < len && start + n < buf.length; n++) {
    const timeSec = n / SR
    // ADSR 包络
    let env
    if (n < attack) env = n / attack
    else if (n < attack + decay) env = 1 - (1 - sustain) * ((n - attack) / decay)
    else if (n > len - release) env = sustain * Math.max(0, (len - n) / release)
    else env = sustain
    // 颤音：让长音不至于死板
    const vib = t.vibrato ? 1 + 0.006 * Math.sin(2 * Math.PI * t.vibrato * timeSec) : 1
    let s = 0
    for (const p of partials) {
      const detune = t.detune ? 1 + (t.detune / 1200) : 1
      s += p.amp * Math.sin(2 * Math.PI * p.f * vib * detune * timeSec)
    }
    buf[start + n] += s * env * t.gain * vel
  }
}

/** 低频鼓点（正弦下滑）与高频噪声镲 */
function addDrum(buf, startSec, kind) {
  const start = Math.floor(startSec * SR)
  if (kind === 'kick') {
    const len = Math.floor(0.16 * SR)
    for (let n = 0; n < len && start + n < buf.length; n++) {
      const f = 110 * Math.exp(-n / (len * 0.25)) + 42
      buf[start + n] += Math.sin((2 * Math.PI * f * n) / SR) * Math.exp(-n / (len * 0.35)) * 0.8
    }
  } else {
    const len = Math.floor(0.05 * SR)
    for (let n = 0; n < len && start + n < buf.length; n++) {
      buf[start + n] += (Math.random() * 2 - 1) * Math.exp(-n / (len * 0.3)) * 0.12
    }
  }
}

/** 一阶反馈延迟：制造空间感（原地正向循环即可形成回声尾巴） */
function applyDelay(buf, delayMs, feedback) {
  const d = Math.floor((delayMs / 1000) * SR)
  for (let i = d; i < buf.length; i++) buf[i] += buf[i - d] * feedback
}

/** 归一化 + tanh 软限幅 + 首尾淡入淡出 */
function master(buf) {
  let peak = 1e-6
  for (const v of buf) peak = Math.max(peak, Math.abs(v))
  const fade = Math.floor(0.08 * SR)
  const fadeOut = Math.floor(0.9 * SR)
  for (let i = 0; i < buf.length; i++) {
    let g = 0.95 / peak
    if (i < fade) g *= i / fade
    if (i > buf.length - fadeOut) g *= Math.max(0, (buf.length - i) / fadeOut)
    buf[i] = Math.tanh(buf[i] * g * 1.2) * 0.8
  }
}

/** PCM16 单声道 WAV 封装 */
function toWav(buf) {
  const out = Buffer.alloc(44 + buf.length * 2)
  out.write('RIFF', 0)
  out.writeUInt32LE(36 + buf.length * 2, 4)
  out.write('WAVE', 8)
  out.write('fmt ', 12)
  out.writeUInt32LE(16, 16)
  out.writeUInt16LE(1, 20) // PCM
  out.writeUInt16LE(1, 22) // 单声道
  out.writeUInt32LE(SR, 24)
  out.writeUInt32LE(SR * 2, 28)
  out.writeUInt16LE(2, 32)
  out.writeUInt16LE(16, 34)
  out.write('data', 36)
  out.writeUInt32LE(buf.length * 2, 40)
  for (let i = 0; i < buf.length; i++) {
    const v = Math.max(-1, Math.min(1, buf[i]))
    out.writeInt16LE(Math.round(v < 0 ? v * 32768 : v * 32767), 44 + i * 2)
  }
  return out
}

// --------------------------------------------------------- 演示曲目编排表
// chords 用相对根音的半音偏移表示（0=I 度根音，小调用和弦性质决定色彩）
const TRACKS = [
  {
    id: 'happy-01', file: 'happy-01.wav', title: '晨光漫步', artist: 'FaceTunes Demo',
    album: '情绪演示音源 · 开心', genre: ['轻快流行', 'pop', 'feel-good'],
    bpm: 118, root: 60, timbre: 'pluck', pad: 'soft', bars: 6, delay: [180, 0.28], drums: 'kick-hat',
    valence: 0.78, arousal: 0.58, bpmEnergy: 0.72, mood: { happy: 0.86, surprised: 0.08, neutral: 0.06 },
    // I - V - vi - IV：最经典的明亮进行
    chords: [[0, 4, 7], [7, 11, 14], [9, 12, 16], [5, 9, 12]], arp: 'up',
    reason: '大调 I–V–vi–IV + 118BPM 跳跃琶音，对应开心的高愉悦度、中高唤醒'
  },
  {
    id: 'happy-02', file: 'happy-02.wav', title: '柠檬汽水', artist: 'FaceTunes Demo',
    album: '情绪演示音源 · 开心', genre: ['放克', 'funk', '舞曲'],
    bpm: 126, root: 62, timbre: 'key', pad: 'saw', bars: 6, delay: [120, 0.18], drums: 'kick-hat',
    valence: 0.72, arousal: 0.72, bpmEnergy: 0.85, mood: { happy: 0.8, surprised: 0.12, neutral: 0.08 },
    chords: [[0, 3, 7, 10], [5, 8, 12], [0, 3, 7, 10], [-2, 3, 7]], arp: 'up-down',
    reason: '属七和弦 + 放克切分 + 126BPM，把开心的能量感推到更高'
  },
  {
    id: 'sad-01', file: 'sad-01.wav', title: '雨夜车窗', artist: 'FaceTunes Demo',
    album: '情绪演示音源 · 悲伤', genre: ['抒情', 'ballad', '钢琴'],
    bpm: 64, root: 57, timbre: 'key', pad: 'pad', bars: 5, delay: [420, 0.4], drums: 'none',
    valence: -0.72, arousal: -0.45, bpmEnergy: 0.2, mood: { sad: 0.88, fearful: 0.06, neutral: 0.06 },
    chords: [[0, 3, 7], [-3, 0, 4], [-5, -1, 2], [-4, 0, 3]], arp: 'sparse',
    reason: '小调慢速 + 长释放包络 + 大延迟混响，对应悲伤的低愉悦、低唤醒'
  },
  {
    id: 'sad-02', file: 'sad-02.wav', title: '旧照片', artist: 'FaceTunes Demo',
    album: '情绪演示音源 · 悲伤', genre: ['民谣', ' acoustic', '治愈'],
    bpm: 72, root: 55, timbre: 'pluck', pad: 'soft', bars: 5, delay: [300, 0.32], drums: 'none',
    valence: -0.55, arousal: -0.25, bpmEnergy: 0.3, mood: { sad: 0.74, neutral: 0.2, disgusted: 0.06 },
    chords: [[0, 3, 7], [7, 10, 14], [3, 7, 10], [-2, 3, 5]], arp: 'up',
    reason: '民谣指型分解和弦，略带暖意的悲伤（怀旧型）'
  },
  {
    id: 'angry-01', file: 'angry-01.wav', title: '混凝土裂缝', artist: 'FaceTunes Demo',
    album: '情绪演示音源 · 愤怒', genre: ['摇滚', 'rock', '金属'],
    bpm: 142, root: 52, timbre: 'saw', pad: 'saw', bars: 6, delay: [90, 0.12], drums: 'kick-hat',
    valence: -0.62, arousal: 0.86, bpmEnergy: 0.95, mood: { angry: 0.85, surprised: 0.1, disgusted: 0.05 },
    chords: [[0, 3, 7], [0, 3, 7], [-2, 1, 5], [-4, -1, 2]], arp: 'drive',
    reason: '失真锯齿波 + 142BPM 强推进 + 低音重复，对应愤怒的高唤醒负效价'
  },
  {
    id: 'angry-02', file: 'angry-02.wav', title: '反击节拍', artist: 'FaceTunes Demo',
    album: '情绪演示音源 · 愤怒', genre: ['嘻哈', 'hiphop', '电子'],
    bpm: 150, root: 49, timbre: 'bass', pad: 'saw', bars: 6, delay: [70, 0.1], drums: 'kick-hat',
    valence: -0.5, arousal: 0.9, bpmEnergy: 0.98, mood: { angry: 0.78, disgusted: 0.12, surprised: 0.1 },
    chords: [[0, 3, 7], [5, 8, 12], [0, 3, 7], [3, 7, 10]], arp: 'drive',
    reason: '重低音 riff + 高 BPM，用于把愤怒导向「宣泄/发力」而不是压抑'
  },
  {
    id: 'fearful-01', file: 'fearful-01.wav', title: '走廊尽头', artist: 'FaceTunes Demo',
    album: '情绪演示音源 · 恐惧', genre: ['氛围', 'ambient', '电影原声'],
    bpm: 84, root: 58, timbre: 'pad', pad: 'pad', bars: 5, delay: [520, 0.46], drums: 'none',
    valence: -0.6, arousal: 0.55, bpmEnergy: 0.45, mood: { fearful: 0.85, surprised: 0.1, sad: 0.05 },
    // 增四度（三全音）是经典的"不安"音程
    chords: [[0, 6, 11], [0, 3, 9], [1, 7, 12], [0, 6, 10]], arp: 'sparse',
    reason: '三全音 + 极长混响 + 持续低音踏板，对应恐惧的中高唤醒、低愉悦'
  },
  {
    id: 'fearful-02', file: 'fearful-02.wav', title: '心跳频率', artist: 'FaceTunes Demo',
    album: '情绪演示音源 · 恐惧', genre: ['后摇', 'post-rock', '悬疑'],
    bpm: 96, root: 53, timbre: 'lead', pad: 'pad', bars: 6, delay: [260, 0.4], drums: 'kick-hat',
    valence: -0.52, arousal: 0.68, bpmEnergy: 0.6, mood: { fearful: 0.72, surprised: 0.2, angry: 0.08 },
    chords: [[0, 3, 7], [0, 3, 8], [0, 4, 9], [-1, 3, 6]], arp: 'up',
    reason: '固定低音上的半音游移 + 类心跳底鼓，营造紧张感但保留推进力'
  },
  {
    id: 'surprised-01', file: 'surprised-01.wav', title: '反转开场', artist: 'FaceTunes Demo',
    album: '情绪演示音源 · 惊讶', genre: ['古典', 'classical', '弦乐'],
    bpm: 132, root: 64, timbre: 'bell', pad: 'soft', bars: 6, delay: [140, 0.25], drums: 'none',
    valence: 0.18, arousal: 0.9, bpmEnergy: 0.88, mood: { surprised: 0.85, happy: 0.1, fearful: 0.05 },
    // 突然的转调（增三和弦 → 属九）制造"意料之外"
    chords: [[0, 4, 8], [1, 5, 9, 13], [0, 4, 7, 11], [3, 7, 10, 14]], arp: 'up-down',
    reason: '增三和弦突转 + 132BPM 快速琶音，覆盖惊讶的高唤醒、效价中性'
  },
  {
    id: 'surprised-02', file: 'surprised-02.wav', title: '万花筒', artist: 'FaceTunes Demo',
    album: '情绪演示音源 · 惊讶', genre: ['爵士', 'jazz', '实验'],
    bpm: 120, root: 61, timbre: 'key', pad: 'soft', bars: 6, delay: [200, 0.3], drums: 'kick-hat',
    valence: 0.25, arousal: 0.7, bpmEnergy: 0.75, mood: { surprised: 0.7, happy: 0.2, neutral: 0.1 },
    chords: [[0, 4, 7, 11], [2, 5, 9, 12], [-1, 2, 6, 9], [4, 8, 11, 14]], arp: 'up-down',
    reason: '爵士延伸和弦（9/13）不断换位，制造"下一步猜不到"的新鲜感'
  },
  {
    id: 'disgusted-01', file: 'disgusted-01.wav', title: '过期果酱', artist: 'FaceTunes Demo',
    album: '情绪演示音源 · 厌恶', genre: ['独立', 'indie', '另类'],
    bpm: 100, root: 56, timbre: 'lead', pad: 'soft', bars: 5, delay: [240, 0.3], drums: 'hat',
    valence: -0.58, arousal: 0.35, bpmEnergy: 0.5, mood: { disgusted: 0.8, angry: 0.1, neutral: 0.1 },
    // 弗里吉亚调式（b2）听起来"别扭"，正适合厌恶
    chords: [[0, 1, 5], [0, 3, 7], [-2, 1, 5], [0, 1, 7]], arp: 'up',
    reason: '弗里吉亚 b2 音程的摩擦感 + 失谐主音，表达排斥/不适而非攻击'
  },
  {
    id: 'disgusted-02', file: 'disgusted-02.wav', title: '倒掉重做', artist: 'FaceTunes Demo',
    album: '情绪演示音源 · 厌恶', genre: ['电子', 'electronic', '治愈'],
    bpm: 108, root: 59, timbre: 'pluck', pad: 'bell', bars: 5, delay: [160, 0.2], drums: 'kick-hat',
    valence: -0.3, arousal: 0.45, bpmEnergy: 0.6, mood: { disgusted: 0.6, neutral: 0.3, happy: 0.1 },
    chords: [[0, 3, 8], [0, 4, 7], [-1, 2, 7], [0, 3, 7]], arp: 'up-down',
    reason: '轻微不协和后解决到干净和弦 —— 厌恶情绪更适合"翻篇/清爽"型推荐'
  },
  {
    id: 'neutral-01', file: 'neutral-01.wav', title: '白噪音午后', artist: 'FaceTunes Demo',
    album: '情绪演示音源 · 中性', genre: ['Lo-Fi', '轻音乐', '学习'],
    bpm: 78, root: 60, timbre: 'soft', pad: 'pad', bars: 6, delay: [320, 0.3], drums: 'hat',
    valence: 0.05, arousal: -0.1, bpmEnergy: 0.35, mood: { neutral: 0.9, happy: 0.1 },
    chords: [[0, 4, 7, 11], [-3, 0, 4, 9], [-5, -1, 2, 7], [-2, 2, 5, 9]], arp: 'sparse',
    reason: '七和弦 + 低唤醒节奏，中性状态默认走"不打扰"的 Lo-Fi 背景乐'
  },
  {
    id: 'neutral-02', file: 'neutral-02.wav', title: '通勤地铁', artist: 'FaceTunes Demo',
    album: '情绪演示音源 · 中性', genre: ['流行', 'pop', 'city'],
    bpm: 96, root: 62, timbre: 'key', pad: 'soft', bars: 6, delay: [180, 0.2], drums: 'kick-hat',
    valence: 0.15, arousal: 0.2, bpmEnergy: 0.55, mood: { neutral: 0.75, happy: 0.25 },
    chords: [[0, 4, 7], [5, 9, 12], [7, 11, 14], [2, 5, 9]], arp: 'up',
    reason: '平稳中速流行进行，中性状态下提供轻度愉悦而不改变情绪基线'
  }
]

/** 按曲风把和弦铺成事件（琶音型决定旋律线，是本系统的"编曲"层） */
function render(track) {
  const beat = 60 / track.bpm
  const barLen = beat * 4
  const total = track.bars * barLen + (track.timbre === 'key' ? 2.2 : 1.6)
  const buf = new Float32Array(Math.ceil(total * SR))
  const scale = [0, 2, 4, 5, 7, 9, 11, 12, 14] // 用于生成经过音

  for (let bar = 0; bar < track.bars; bar++) {
    const chord = track.chords[bar % track.chords.length]
    const t0 = bar * barLen

    // 1) 和弦垫底
    chord.forEach((iv, i) => addNote(buf, t0 + i * 0.02, barLen * 0.95, track.root + iv - 12, track.pad, 0.55))
    // 2) 低音
    addNote(buf, t0, barLen * 0.5, track.root + chord[0] - 24, 'bass', 0.9)
    addNote(buf, t0 + barLen * 0.5, barLen * 0.45, track.root + chord[0] - 24, 'bass', 0.65)

    // 3) 主旋律/琶音（arp 决定旋律型）
    const stepsPerBar = track.arp === 'sparse' ? 2 : track.arp === 'drive' ? 8 : 4
    const notes = [...chord, chord[0] + 12]
    const seq = []
    if (track.arp === 'sparse') {
      seq.push(notes[0], notes[2 % notes.length])
    } else if (track.arp === 'drive') {
      // 连续同音推进，第 4 拍加一个经过音，制造 riff 感
      for (let s = 0; s < stepsPerBar; s++) seq.push(notes[0] + (s % 4 === 3 ? scale[3] : 0))
    } else if (track.arp === 'up-down') {
      const pattern = [0, 1, 2, 3, 2, 1]
      for (let s = 0; s < stepsPerBar; s++) seq.push(notes[pattern[s % pattern.length] % notes.length])
    } else {
      for (let s = 0; s < stepsPerBar; s++) seq.push(notes[s % notes.length])
    }
    seq.forEach((iv, s) => {
      const stepDur = barLen / stepsPerBar
      // 周期性插入经过音，让演示旋律不至于太机械
      const passing = (bar * 7 + s * 3) % 6 === 0 ? scale[(bar + s) % scale.length] : 0
      addNote(buf, t0 + s * stepDur, stepDur * (track.arp === 'drive' ? 0.8 : 0.9), track.root + iv + passing, track.timbre, 0.8 - (s % 4) * 0.06)
    })

    // 4) 鼓
    if (track.drums !== 'none') {
      for (let b = 0; b < 4; b++) {
        if (track.drums === 'kick-hat' && (b === 0 || b === 2)) addDrum(buf, t0 + b * beat, 'kick')
        if (track.drums === 'hat' && b % 2 === 0) addDrum(buf, t0 + b * beat, 'hat')
        if (track.drums === 'kick-hat') addDrum(buf, t0 + b * beat + beat * 0.5, 'hat')
      }
    }
  }

  applyDelay(buf, track.delay[0], track.delay[1])
  master(buf)
  return { buf, duration: buf.length / SR }
}

// ---------------------------------------------------------------- main
mkdirSync(outDir, { recursive: true })
if (process.argv.includes('--clear')) {
  for (const f of readdirSync(outDir)) if (f.endsWith('.wav')) rmSync(path.join(outDir, f))
}

const manifest = {
  __doc: '本地歌曲库清单。把 mp3 放进 public/music/ 后，在 tracks 数组里新增一条即可被推荐算法检索。',
  fieldDoc: {
    id: '唯一 ID',
    file: '相对于 public/music/ 的文件名；也可直接填完整 URL（http 开头则不拼接前缀）',
    title: '歌名',
    artist: '歌手',
    genre: '曲风标签数组，会参与标签匹配打分',
    bpm: '每分钟节拍，用于能量（arousal）匹配',
    valence: '效价 -1(不愉悦)~1(愉悦)，对应 Russell 情绪环状模型横轴',
    arousal: '唤醒度 -1(平静)~1(兴奋)，对应环状模型纵轴',
    mood: '该曲在 7 类基础情绪上的隶属度向量（0~1，无需严格归一）',
    rating: '主观热度 0~1，对应流行度权重',
    reason: '为什么这首歌适合该情绪，会显示在前端推荐理由里'
  },
  tracks: []
}

let totalBytes = 0
for (const track of TRACKS) {
  const { buf, duration } = render(track)
  const wav = toWav(buf)
  writeFileSync(path.join(outDir, track.file), wav)
  totalBytes += wav.length
  manifest.tracks.push({
    id: `local-${track.id}`,
    file: track.file,
    title: track.title,
    artist: track.artist,
    album: track.album,
    genre: track.genre,
    bpm: track.bpm,
    duration: Number(duration.toFixed(2)),
    valence: track.valence,
    arousal: track.arousal,
    bpmEnergy: track.bpmEnergy,
    mood: track.mood,
    rating: 0.55 + (track.bpmEnergy % 0.2) * 0.3,
    source: 'local',
    cover: '',
    reason: track.reason
  })
  console.log(`  ♪ ${track.file.padEnd(16)} ${duration.toFixed(1)}s  ${(wav.length / 1024).toFixed(0)}KB`)
}

writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8')
console.log(
  `[music] 本地演示曲库 ${manifest.tracks.length} 首 / ${(totalBytes / 1024 / 1024).toFixed(1)}MB -> public/music/`
)
if (!existsSync(path.join(outDir, 'manifest.json'))) console.warn('manifest 写入异常')
