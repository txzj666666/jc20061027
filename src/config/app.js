/**
 * 全局可调参数（算法超参 + 在线 API 配置）
 * 前端设置面板会读写这些 reactive 对象并持久化到 localStorage，
 * 因此改参数不需要动代码，刷新后依然生效。
 */
import { reactive } from 'vue'

/** 人脸检测 / 情绪识别参数 */
export const faceConfig = reactive({
  // TinyFaceDetector 的输入分辨率：越小越快、小脸越容易漏检
  inputSize: 320,
  // 人脸置信度下限，低于此值视为「没检测到人脸」，该帧不参与情绪投票
  scoreThreshold: 0.35,
  // 单帧表情结果被采纳所需的人脸检测分
  minDetScore: 0.45,
  // 人脸面积占画面比例下限（小脸像素太少，表情分类器不可靠）
  minFaceAreaRatio: 0.006,
  // 推理节流：最多每 N 毫秒跑一次（实时摄像头 100ms ≈ 10fps 足够）
  intervalMs: 100,
  // 连续多少帧丢失人脸后，才把状态切成「无人脸」
  faceGraceFrames: 12,
  // 是否加载 68 点关键点模型（可视化更好看，但 CPU 推理会明显变慢，默认关闭）
  withLandmarks: false
})

/** 情绪时序聚合参数（见 core/emotionTracker.js） */
export const trackerConfig = reactive({
  emaAlpha: 0.3, // 指数滑动平均系数：越大越跟随当前帧，越小越平滑
  bufferSize: 30, // 概率历史环形缓冲长度（用于绘制曲线）
  stableFrames: 6, // 主情绪需连续满足优势条件的帧数才确认（滞回）
  switchMargin: 0.06, // 新情绪需领先当前确认情绪的幅度（滞回带宽度）
  minConfidence: 0.45 // 低于此置信度按「不确定」处理，推荐时回退到 neutral 权重
})

/**
 * 歌曲推荐打分权重（mood + circumplex + energy + popularity + freshness = 1.0）
 * 见 core/recommender.js
 */
export const recommendConfig = reactive({
  weights: {
    mood: 0.35, // 情绪隶属度向量余弦 + 曲风标签重合
    circumplex: 0.25, // Russell 环状模型 (valence, arousal) 距离
    energy: 0.15, // BPM / 能量与唤醒度匹配
    popularity: 0.15, // 曲库热度/评分先验
    freshness: 0.1 // 未播放/近期少播放的新鲜度奖励
  },
  mmrLambda: 0.7, // MMR 多样性重排：λ 越大越相似，越小越多样
  slots: 12, // 一次推荐产出的歌曲数
  localRatio: 0.7, // 本地曲库优先：占据的槽位比例（默认 8 本地 / 4 在线）
  onlineRatio: 0.3,
  // 悲伤/愤怒的「情绪调节斜率」：列表中后续曲目按此斜率抬升效价
  regulateSlope: { sad: 0.06, angry: -0.05 },
  maxOnlineFetch: 24,
  onlineCacheTtl: 5 * 60 * 1000 // 同一情绪的在线结果缓存 5 分钟，避免频繁请求
})

/**
 * 在线歌曲 API 配置
 * provider 可选：'jamendo' | 'meting' | 'ncm' | 'off'
 *   jamendo：官方开放 API，支持 CORS，返回 30 秒试听 mp3，需免费 client_id
 *            https://dev.jamendo.com/doc/api/
 *   meting ：Meting 音乐聚合接口的公网实例（网易云/QQ/酷狗 搜索 + 直链）
 *            默认走 Vite dev 代理 /meting 以规避浏览器 CORS
 *   ncm    ：自建 NeteaseCloudMusicApi（http://127.0.0.1:3000），dev 代理 /ncm
 *   off    ：只用本地曲库
 */
export const onlineConfig = reactive({
  // 默认用 Meting 聚合接口（华语曲库、返回可播直链、CORS 全开，开箱可用）
  provider: 'meting',
  // Jamendo 免费 client_id 申请：https://www.jamendo.com/settings/api
  jamendoClientId: '',
  // 公共实例（已验证 Access-Control-Allow-Origin: *，type=search 可用）
  metingBaseUrl: 'https://api.qijieya.cn/meting/',
  // 依次降级：本地 vite 代理 → injahow（该实例不支持 search，仅做兜底）
  metingFallbackUrls: ['/meting/meting/', 'https://api.injahow.cn/meting/'],
  ncmBaseUrl: '/ncm',
  metingServer: 'netease',
  timeoutMs: 8000
})

export const STORAGE_KEY = 'facetunes.settings.v1'
