# FaceTunes · 基于人脸情绪识别的歌曲推荐系统

> HTML5 + CSS3 + JavaScript (ESM) + **Vue 3** + Vite + face-api.js
> 人脸检测与情绪识别 **100% 在浏览器本地运行**，摄像头画面/照片像素不上传任何服务器。
>
> 在线演示：<https://txzj666666.github.io/jc20061027/>

---

## 1. 系统概览

```
┌──────────────┐   ┌───────────────────┐   ┌──────────────────┐   ┌────────────┐
│  ① 人脸采集   │ → │ ② 本地情绪识别      │ → │ ③ 情绪→歌曲推荐    │ → │ ④ 播放      │
│ 图片/视频/    │   │ TinyFaceDetector  │   │ 5 分量加权打分     │   │ <audio>    │
│ 摄像头/拍照   │   │ + ExpressionNet   │   │ + MMR + 本地在线混合│   │ 本地/在线   │
└──────────────┘   └───────────────────┘   └──────────────────┘   └────────────┘
                    WebGL / CPU 推理         纯 JS 计算             HTML5 媒体
```

| 需求 | 实现 |
| --- | --- |
| 4 种人脸采集方式 | 上传图片（可拖拽）、加载本地视频文件、实时摄像头（getUserMedia）、摄像头拍照截帧 |
| 本地情绪识别 | `@vladmandic/face-api`（TensorFlow.js）+ 随项目分地的模型权重，无任何网络请求参与推理 |
| 7 类基础情绪 | 中性 / 开心 / 悲伤 / 愤怒 / 恐惧 / 厌恶 / 惊讶（与模型输出顺序一致） |
| 情绪-曲风映射 | `src/config/emotions.js` 映射表（含 Russell 环状模型坐标、曲风、检索词、BPM 区间） |
| 混合推荐 | 本地曲库优先（70% 槽位）+ 在线 API 补位（30%），在线不可用时自动回填本地 |
| 内置播放器 | 播放本地 WAV/MP3 与在线直链，进度拖拽、上下曲、音量、循环、失败自动跳过 |
| 交互提示 | 模型加载/推理中 spinner、未检测到人脸、人脸过小/模糊/侧脸、接口失败、音频不可播 |

算法细节（公式、权重、参数含义）见 **[docs/算法说明.md](docs/算法说明.md)**，代码内也有逐行注释。

---

## 2. 运行步骤

### 2.1 环境

* Node.js ≥ 18（实测 v24）；npm ≥ 9
* 浏览器：Chrome / Edge / Firefox 最新版（需要 WebGL、`getUserMedia`、`<audio>`）
* **摄像头必须在 `http://localhost` 或 HTTPS 下才能授权**（浏览器安全限制），本项目 dev 服务器默认 `http://127.0.0.1:5173`，已满足。

### 2.2 三步启动

```bash
cd face-emotion-music
npm install        # 安装依赖（Vue3 + Vite + face-api）
npm run music      # 生成 14 首「情绪演示音源」+ public/music/manifest.json
npm run dev        # 打开 http://127.0.0.1:5173
```

> **模型已随仓库分发**：`public/models/`（0.9MB 权重）与 `public/face-api/face-api.js`（1.3MB 运行时）
> 已提交进 Git，clone 后**无需**下载模型即可识别。若你删掉了这两个目录，用 `npm run setup`
> 从 node_modules 重新复制即可（`npm install` 的 postinstall 也会自动做这件事）。
> 只有演示音源是生成出来的，所以 `npm run music` 这一步不能省（否则本地曲库为空，只剩在线推荐）。

生产构建与本地预览：

```bash
npm run build      # 产物在 dist/
npm run preview    # 用静态服务器预览 dist/
```

> 部署到子目录时，给 Vite 传 `--base=/子目录/`；模型路径与曲库路径都基于 `import.meta.env.BASE_URL` 拼接，无需改代码。

### 2.3 首次体验（无摄像头也能跑通）

1. 打开页面，顶部会显示 `🔒 本地推理 · webgl`（或 `cpu`）。
2. 点 **① 人脸采集 → 🖼️ 上传图片**，在「情绪人脸预览库」里点 6 张 AI 合成情绪人脸之一（或换成自己的照片）。
3. 约 0.1~1s 后，**② 情绪识别结果** 出现 7 类概率条、置信度圆环与推荐策略。
4. **③ 情绪歌单** 自动产出 12 首（约 8 本地 + 4 在线），点任意一条即可在底部播放器播放。
5. 切到 **📹 实时摄像头** → 「打开摄像头」→「▶ 连续识别」，做表情看情绪与歌单实时变化；「📸 拍照识别」会冻结当前帧做单帧识别。

---

### 2.4 情绪人脸预览库（6 张 AI 合成面孔）

`public/samples/` 内置 6 张不同情绪的**AI 合成**人脸（非真人照片），在「上传图片」标签下以预览网格显示，
点一下即完成"送进模型 → 出情绪 → 出歌单"的完整演示；每张卡片右上角的绿色角标是**模型对这张图的真实识别结果**，
识别正确时显示为绿色，方便演示前快速挑脸。

| 文件 | 目标情绪 | 实测识别 | 置信度 |
| --- | --- | --- | --- |
| `emo-happy.png` | 开心 | ✅ 开心 | 91% |
| `emo-sad.png` | 悲伤 | ✅ 悲伤 | 88% |
| `emo-angry.png` | 愤怒 | ✅ 愤怒 | 70% |
| `emo-surprised.png` | 惊讶 | ✅ 惊讶 | 92% |
| `emo-fearful.png` | 恐惧 | ✅ 恐惧 | 90% |
| `emo-disgusted.png` | 厌恶 | ✅ 厌恶 | 83% |

> 上表置信度为 CPU 后端单帧实测值（288×344 输入、`inputSize=320`）。第 7 类「中性」请用你自己的照片或摄像头，
> 因为合成图的情绪都做得比较夸张，中性脸反而不容易稳定命中。
> 想扩充：把新图放进 `public/samples/`，在 `src/components/CapturePanel.vue` 的 `SAMPLES` 数组里加一行即可。

---

## 2.5 部署到 GitHub Pages

仓库已带 `.github/workflows/deploy.yml`：push 到 `main` 就自动 `npm ci → npm run music → npm run build`
并把 `dist/` 发布为 Pages。**首次需要手动开启一次**：

> 仓库页 → **Settings** → 左侧 **Pages** → **Build and deployment → Source** 选 **GitHub Actions** → 保存。
> 之后回到 Actions 页面看 "部署到 GitHub Pages" 工作流跑完（约 1~2 分钟），即可访问
> `https://<你的用户名>.github.io/<仓库名>/`。

两个易踩的坑（本项目已处理）：

1. **子路径 404 导致整页黑屏**：项目型 Pages 挂在 `/仓库名/` 下，若 `base` 写成 `/`，
   `index.html` 会去根目录取 `/assets/xxx.js` → 全部 404 → Vue 不挂载，只剩深色背景。
   本项目用**相对 base**（`vite.config.js` 里 `base: './'`），产物里是 `./assets/...`，
   放根目录或任意子目录都能跑；代码里的 `models/`、`music/`、`samples/` 路径统一走
   `import.meta.env.BASE_URL` 拼接，同样自动适配。
2. **Pages 的 Source 选成 "Deploy from a branch"**：那样直接把仓库源码当静态站发布，
   浏览器拿到的是 `<script src="/src/main.js">` 这种未编译入口，必然白/黑屏。
   正确做法是 Source = GitHub Actions（走构建产物），或本地 `npm run build` 后把 `dist/` 单独发布。

HTTPS 环境下 `getUserMedia` 可用，所以 Pages 上**实时摄像头与拍照识别都能正常工作**；
在线音乐源默认走带 `Access-Control-Allow-Origin: *` 的公共接口，无需后端。

---

## 3. 依赖包

| 包 | 版本 | 作用 |
| --- | --- | --- |
| `vue` | ^3.5 | 框架（Composition API + `<script setup>`） |
| `vite` | ^7 | 开发服务器 / 构建 |
| `@vitejs/plugin-vue` | ^6 | Vue SFC 支持 |
| `@vladmandic/face-api` | ^1.7.15 | 人脸检测 + 表情分类（内置 TensorFlow.js，**且自带全部预训练权重**） |

没有引入 Pinia / Vue Router / UI 组件库：全局状态用 `reactive` 单例（`src/stores/session.js`）足够，样式全部手写 CSS3。

> **为什么用 `<script>` 标签加载 face-api？**
> 它的产物内联打包了整套 tfjs，交给 Vite 预构建容易与后端的 WebGL/WASM 探测冲突。
> `index.html` 直接引入 `public/face-api/face-api.js`（UMD，挂到 `window.faceapi`），
> 由 `src/core/faceEngine.js` 轮询等待就绪；本地文件缺失时自动回退 jsDelivr CDN。

---

## 4. 模型文件与下载地址

`npm run setup`（或 `npm install` 的 postinstall）会把模型从 node_modules 复制到 `public/models/`：

| 文件 | 大小 | 用途 | 必需 |
| --- | --- | --- | --- |
| `tiny_face_detector_model.bin` + `-weights_manifest.json` | ~190 KB | 人脸检测（MobileNetV2-SSD 轻量版） | ✅ |
| `face_expression_model.bin` + `-weights_manifest.json` | ~320 KB | **7 类表情分类器（核心）** | ✅ |
| `face_landmark_68_model.bin` + `-weights_manifest.json` | ~350 KB | 68 点关键点（人脸轮廓 + 姿态角门控） | 可选（设置面板默认关闭） |
| `public/face-api/face-api.js` | 1.27 MB | 推理运行时（含 tfjs） | ✅ |

手动下载（离线部署 / 换用原版 face-api.js 权重时）：

* vladmandic 权重目录（本项目所用，npm 包内即含）：
  `https://cdn.jsdelivr.net/npm/@vladmandic/face-api@1.7.15/model/`
* 原版 justadudewhohacks/face-api.js 权重仓库：
  `https://github.com/justadudewhohacks/face-api.js/tree/master/weights`
* 单文件运行时：
  `https://cdn.jsdelivr.net/npm/@vladmandic/face-api@1.7.15/dist/face-api.js`

**模型升级（精度换速度）**：把 `ssd_mobilenetv1_model.*` 复制到 `public/models/`，
再把 `src/core/faceEngine.js` 里的 `nets.tinyFaceDetector` / `TinyFaceDetectorOptions`
换成 `nets.ssdMobilenetv1` / `SSDMobileNetV1Options` 即可，其余管线不变。

---

## 5. 在线歌曲 API 说明

适配层在 `src/core/onlineMusic.js`，右上角 **⚙️ 设置 → ① 在线歌曲 API** 可切换，共 4 种模式：

### ① `meting`（默认，开箱可用）

Meting 聚合接口（网易云 / QQ / 酷狗 / 酷我），返回**可播直链 + 封面 + 歌词地址**。

```
GET https://api.qijieya.cn/meting/?server=netease&type=search&id=<关键词>&text=1&limit=20
→ [{ "name": "雨中舞", "artist": "Soulloom苏洛牧",
     "url": "…/meting/?server=netease&type=url&id=2755332551",   // 302 跳转到 mp3
     "pic": "…", "lrc": "…" }, …]
```

* 该公共实例返回 `Access-Control-Allow-Origin: *`，浏览器可直连；本项目仍保留了 dev 代理兜底。
* 已验证 `type=search` 可用；`api.injahow.cn` 实例不支持 `search`，因此只作为降级项。
* **限制**：公共实例随时可能限流/下线；VIP/版权曲目会 302 到带时效的 CDN，可能返回 403。
  播放器捕获 `error` 事件后会把该曲标为「不可播」并自动跳下一首（连续上限 5 次）。
* **生产建议自建**：`docker run -p 8080:8080 ghcr.io/injahow/meting-api`，
  然后把设置里的「接口地址」改成 `https://your-domain/meting/`。

### ② `jamendo`（官方开放 API，合法试听 30s）

```
GET https://api.jamendo.com/v3.0/tracks/?client_id=<你的ID>&format=json&limit=20&tag=relaxing&audio=mp3205&order=mooddesc
```

* 免费申请 client_id：`https://www.jamendo.com/settings/api`（填应用名即可，秒过）
* 文档：`https://dev.jamendo.com/doc/api/`；天然支持 CORS；返回 `audio` 为 30 秒 mp3 直链。
* 情绪 → Jamendo 标签映射见 `onlineMusic.js` 的 `JAMENDO_TAGS`（happy / melancholic / aggressive / dark / epic / weird / relaxing）。
* 未填 client_id 时界面会明确提示，并自动降级为「仅本地曲库」。

### ③ `ncm`（自建 NeteaseCloudMusicApi，功能最全）

```bash
npx @neteasecloudmusicapienhanced/api@latest   # 或 docker binwiederhier/ncm-api，默认 3000 端口
```

* 走 Vite dev 代理 `/ncm` → `http://127.0.0.1:3000`，可拿搜索/歌词/歌单。
* 播放外链用 `https://music.163.com/song/media/outer/url?id=<id>.mp3`，VIP 歌曲会失败（前端标记不可播）。

### ④ `off`

完全关闭在线请求，只用本地曲库（离线演示/内网部署）。

### 跨域与部署提示

`vite.config.js` 里已配好两条 dev 代理：`/meting → api.injahow.cn`、`/ncm → 127.0.0.1:3000`。
上生产时把等价规则写进 Nginx：

```nginx
location /meting/ { proxy_pass https://api.qijieya.cn/meting/; }
location /ncm/    { proxy_pass http://127.0.0.1:3000/; }
```

在线结果按 `provider + 情绪` 缓存 5 分钟（`recommendConfig.onlineCacheTtl`），设置面板可一键清空。

---

## 6. 本地歌曲库配置方法

### 6.1 目录与清单

```
public/music/
├── manifest.json        # 曲库清单（推荐算法只读这个）
├── happy-01.wav         # 演示音源（npm run music 生成）
└── your-song.mp3        # 你自己放的歌
```

在 `manifest.json` 的 `tracks` 数组里新增一条即可被推荐：

```jsonc
{
  "id": "local-my001",
  "file": "your-song.mp3",        // 相对 public/music/；也可写完整 http URL
  "title": "海街笔记",
  "artist": "某某",
  "album": "夏日集",
  "genre": ["city pop", "轻快"],   // 参与曲风标签匹配
  "bpm": 112,                      // 参与能量匹配；0 = 未知（该分量给中性分）
  "duration": 214,
  "valence": 0.55,                 // 效价 -1~1
  "arousal": 0.45,                 // 唤醒度 -1~1
  "mood": { "happy": 0.7, "neutral": 0.3 },  // 7 类情绪隶属度（会自动归一化）
  "rating": 0.7,                   // 热度先验 0~1
  "cover": "covers/mysong.jpg",
  "reason": " BPM 与明亮合成器音色贴合愉悦状态"
}
```

字段速记：`mood` 决定「情绪标签匹配」，`valence/arousal` 决定「环状模型距离」，`bpm` 决定「能量匹配」，`rating` 决定「热度」，`genre` 决定「曲风重合度」。缺省字段都有兜底默认值，不会报错。

### 6.2 演示音源生成器

```bash
npm run music            # 合成 14 个 WAV（7 情绪 × 2 首，共约 9MB）+ manifest.json
npm run music -- --clear # 先删除旧的演示音频
```

`scripts/gen-demo-music.mjs` 是零依赖的加法合成器：按情绪配方（调式、和弦进行、BPM、音色包络、鼓型、延迟混响）实时合成旋律并写 PCM16 WAV。想改演示曲风直接编辑 `TRACKS` 表即可。

### 6.3 运行时导入

不想动 manifest 的话，点 **③ 情绪歌单 → ➕ 导入本地音频**，多选 mp3/wav：
系统会用 `<audio>` 读出真实时长，并按文件名关键词猜情绪（含「欢快/rock/lofi/夜…」）；
猜不到的曲目会显示「未标注」，点卡片上的情绪表情按钮即可现场标注，立即参与后续推荐。
（ObjectURL 不跨刷新，重进页面需重新导入 —— 长期曲库请写进 manifest。）

---

## 7. 目录结构

```
face-emotion-music/
├─ index.html                     # 引入本地 face-api.js（含 CDN 回退）
├─ vite.config.js                 # Vue 插件 + 在线 API 的 dev 跨域代理
├─ scripts/
│  ├─ setup-assets.mjs            # node_modules → public/ 复制运行时与模型权重
│  └─ gen-demo-music.mjs          # 合成演示音源 + 生成 manifest.json
├─ public/
│  ├─ face-api/face-api.js        # [setup 生成] 推理运行时
│  ├─ models/                     # [setup 生成] 预训练权重（本地加载）
│  ├─ music/                      # [music 生成] 本地曲库 + manifest.json
│  └─ samples/                    # 6 张 AI 合成情绪人脸（演示用）
├─ docs/算法说明.md                # 两个算法的完整推导与参数表
└─ src/
   ├─ main.js / App.vue           # 入口 + 三栏布局骨架
   ├─ styles/global.css           # CSS3：Grid/自定义属性/conic-gradient/backdrop-filter/动画
   ├─ config/
   │  ├─ app.js                   # 全部算法超参与在线 API 配置（reactive，可热改）
   │  ├─ emotions.js              # 7 类情绪定义 + 情绪-曲风映射表 + 混淆容差
   │  └─ settings.js              # 参数持久化（localStorage）
   ├─ core/
   │  ├─ faceEngine.js            # 模型加载/后端选择/逐帧推理/质量门控
   │  ├─ emotionTracker.js        # EMA 时序聚合 + 滞回稳定判定
   │  ├─ recommender.js           # 5 分量打分 + MMR + 情绪调节轨迹 + 本地在线混排
   │  ├─ musicLibrary.js          # 本地曲库加载与运行时导入
   │  └─ onlineMusic.js           # Jamendo / Meting / NCM 适配 + 缓存 + 降级
   ├─ composables/
   │  ├─ useRecognition.js        # 四种采集方式调度 + rAF 识别循环
   │  └─ usePlayer.js             # <audio> 播放器封装
   ├─ stores/session.js           # 全局会话状态（识别结果→推荐目标→歌单→提示）
   └─ components/
      ├─ CapturePanel.vue         # 采集区（含人脸框 overlay canvas）
      ├─ EmotionPanel.vue         # 情绪结果面板（概率条 + 堆叠时序图）
      ├─ SongList.vue             # 推荐列表（匹配度 + 推荐理由 + 标注）
      ├─ PlayerBar.vue            # 底部播放器
      └─ SettingsDrawer.vue       # 参数面板
```

---

## 8. 隐私说明

* 人脸像素只在浏览器内存中流转：`<video>/<img>` → 320×320 离屏 canvas → WebGL/CPU 推理。
* 全站**没有**任何一处把图像数据（ImageData / Blob / dataURL）通过 `fetch`/`XHR`/`WebSocket` 发出。
* 唯一的外发请求是：① 从本站 `public/models/` 读取权重（同源）；② 向音乐 API 发送**文字搜索关键词**（不含任何人脸信息、不含用户标识）。
* 断网时：模型与本地曲库照常工作，只是在线补位为空 —— 可完全离线部署。

---

## 9. 常见问题

| 现象 | 原因 / 处理 |
| --- | --- |
| 顶部显示 `本地模型 · error`，提示 face-api.js 未能加载 | 没执行 `npm run setup`，`public/face-api/face-api.js` 缺失 |
| 一直「未检测到人脸」 | 侧脸/遮挡/光线不足/脸太小；把脸移到画面中央并靠近一点；或在设置里把 `scoreThreshold` 降到 0.25 |
| 识别到情绪但一直「置信度偏低」 | 图片分辨率低或模糊（清晰度分量上不去）；把「检测分辨率」调到 416、勾选 68 点模型再试 |
| FPS 只有 1~2 | 当前浏览器没有 WebGL，退回 CPU 后端（本项目测试环境即如此）。换 Chrome + 独显通常 8~10 FPS（受 100ms 节流上限） |
| 在线曲目点了没声音 / 标红「不可播」 | 公共聚合接口的直链带时效或需会员；换 `jamendo`、自建 meting/ncm，或用本地曲库 |
| 摄像头打不开：权限被拒绝 | 浏览器地址栏左侧图标改成「允许」；非 localhost 需 HTTPS |
| 摄像头被占用 | 微信/钉钉/Zoom 等会独占设备，先关闭它们 |
| 换了 `inputSize`/关键点开关没反应 | 这两项在模型加载时确定，刷新页面生效 |

---

## 10. 许可与素材来源

* 代码：MIT。
* 模型权重：face-api.js / vladmandic 分支（MIT），训练数据为公开学术数据集（FER-2013 等）。
* `public/samples/emo-*.png`：**豆包 AI 生成的合成面孔**，不对应任何真实人物，仅用于功能演示。
* 演示音源由本项目脚本程序化合成，无第三方版权。
* 接入第三方音乐接口请遵守其服务条款，仅用于个人学习研究。
