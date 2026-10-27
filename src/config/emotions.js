/**
 * 情绪定义与「情绪 → 音乐」映射表
 * ==================================================================
 * 一、7 类基础情绪采用 Ekman 扩展情绪集，且键名/顺序与
 *    face-api.js 的 face_expression_model 输出严格一致：
 *      neutral, happy, sad, angry, fearful, disgusted, surprised
 *    （见 node_modules/@vladmandic/face-api/src/ops/... 的
 *      FaceExpressionDescriptor._expressionLabels）
 *    这样模型 softmax 输出的 7 维向量可以直接按本表索引，无需重排。
 *
 * 二、每种情绪同时给出 Russell「情绪环状模型(Circumplex Model)」坐标
 *      valence 效价：-1 不愉悦 ←→ +1 愉悦（横轴）
 *      arousal 唤醒度：-1 平静 ←→ +1 兴奋（纵轴）
 *    推荐算法用这两个连续维度做「距离」计算，比只用离散标签更能兼容
 *    惊讶(高唤醒/中性效价)、厌恶(中唤醒/负效价)这类容易混淆的情绪。
 *
 * 三、genres / keywords 是情绪-曲风映射表：
 *      - genres   用于本地曲库标签匹配（打分见 core/recommender.js）
 *      - keywords 用于在线 API 的搜索词（中文歌名/曲风检索）
 */

// 与 face-api 输出顺序一致，切勿改动顺序
export const EMOTION_ORDER = ['neutral', 'happy', 'sad', 'angry', 'fearful', 'disgusted', 'surprised']

export const EMOTIONS = {
  neutral: {
    key: 'neutral',
    label: '中性',
    en: 'Neutral',
    emoji: '😐',
    color: '#8fa3bf',
    valence: 0.0,
    arousal: -0.05,
    // 该情绪下的推荐策略说明（会显示在 UI 上，让算法意图对用户可见）
    strategy: '情绪平稳 → 主推 Lo-Fi / 轻音乐等「不打扰」背景乐，避免强刺激',
    genres: ['lofi', '轻音乐', 'instrumental', 'jazz', 'pop', 'ambient'],
    keywords: ['轻音乐', 'lofi 纯音乐', '咖啡馆背景音乐', '通勤'],
    bpmRange: [70, 100]
  },
  happy: {
    key: 'happy',
    label: '开心',
    en: 'Happy',
    emoji: '😄',
    color: '#ffd166',
    valence: 0.8,
    arousal: 0.55,
    strategy: '正效价 + 中高唤醒 → 强化节奏与明亮大调，延长愉悦状态',
    genres: ['pop', 'funk', 'disco', 'edm', 'bossa nova', 'indie pop'],
    keywords: ['欢快', '治愈系', '好天气', '劲舞'],
    bpmRange: [105, 130]
  },
  sad: {
    key: 'sad',
    label: '悲伤',
    en: 'Sad',
    emoji: '😢',
    color: '#6c8cff',
    valence: -0.75,
    arousal: -0.45,
    // 音乐心理学：先「同频共鸣」再「上行调节」，所以第 2 首起逐渐抬升 BPM/效价
    strategy: '先共情后调节：首曲贴合低落状态，后续按 +0.06 效价斜率抬升（Musical Mood Regulation）',
    genres: ['ballad', '抒情', 'piano', 'acoustic', 'folk', 'ambient'],
    keywords: ['治愈', '钢琴曲', '深夜', '慢歌'],
    bpmRange: [58, 82]
  },
  angry: {
    key: 'angry',
    label: '愤怒',
    en: 'Angry',
    emoji: '😠',
    color: '#ff6b6b',
    valence: -0.6,
    arousal: 0.85,
    strategy: '高唤醒宣泄优先，第 3 首起切换低唤醒曲目完成「降唤醒」引导',
    genres: ['rock', 'metal', 'hiphop', 'trap', 'edm', '摇滚'],
    keywords: ['摇滚', '说唱', '燃', '健身'],
    bpmRange: [120, 160]
  },
  fearful: {
    key: 'fearful',
    label: '恐惧',
    en: 'Fearful',
    emoji: '😱',
    color: '#b07cff',
    valence: -0.55,
    arousal: 0.6,
    strategy: '安全感重建：稳定节拍 + 少突变的长音，避免悬疑/失真音色',
    genres: ['ambient', 'post rock', 'neo classical', '轻音乐', '古典'],
    keywords: ['纯音乐 安宁', '睡前', '冥想', '自然音'],
    bpmRange: [60, 85]
  },
  disgusted: {
    key: 'disgusted',
    label: '厌恶',
    en: 'Disgusted',
    emoji: '🤢',
    color: '#7ee081',
    valence: -0.55,
    arousal: 0.25,
    strategy: '转移注意：清爽、明亮、结构简单的曲目（换场景优于硬碰硬）',
    genres: ['indie', 'bossa nova', 'city pop', '轻快的', 'acoustic'],
    keywords: ['清爽', 'city pop', '午后', '轻快'],
    bpmRange: [92, 116]
  },
  surprised: {
    key: 'surprised',
    label: '惊讶',
    en: 'Surprised',
    emoji: '😲',
    color: '#ffa94d',
    valence: 0.2,
    arousal: 0.9,
    strategy: '承接高唤醒：保留能量但收敛效价不确定性，选节奏强、和声稳定的曲目',
    genres: ['edm', 'classical', 'jazz', 'soundtrack', 'electronic'],
    keywords: ['史诗', '电子', '燃向', '纯音乐 大气'],
    bpmRange: [118, 150]
  }
}

/** 情绪标签 → 7 维 one-hot（推荐算法里做加权混合时使用） */
export function oneHot(emotionKey) {
  return EMOTION_ORDER.map((k) => (k === emotionKey ? 1 : 0))
}

/**
 * 情绪之间的「混淆容许度」：表情分类器最容易把这几对搞混，
 * 稳定判定时对它们放宽切换阈值，避免 UI 抖动。
 */
export const CONFUSION_PAIRS = [
  ['fearful', 'surprised'],
  ['angry', 'disgusted'],
  ['sad', 'neutral'],
  ['neutral', 'disgusted']
]

export function confusionTolerance(a, b) {
  return CONFUSION_PAIRS.some(([x, y]) => (x === a && y === b) || (x === b && y === a)) ? 0.02 : 0
}
