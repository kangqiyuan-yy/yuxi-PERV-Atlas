---
name: multiomics-track-load-speed
overview: 双管齐下优化多组学 .bw 轨道的“勾选后首次出现”体验：(A) 服务端给 gunicorn 加线程提升并发取数能力（治本，已确认线程安全）；(B) 前端用带并发上限的加载队列 + 逐条出现的 loading 占位，替换“全部读完才出现”的串行/无序加载（治体感）。
todos:
  - id: server-threads
    content: serve.sh 给 gunicorn 加 --threads（建议 8 起步），提升 bigwig Range 读的并发取数能力，改完 ./serve.sh restart 生效
    status: pending
  - id: queue
    content: 在 multiomics.js 实现带并发上限(默认3)的加载队列，统一 toggleTrack/loadAllGroupTracks/consumePreselect 三个入口，移除 80ms 硬延迟与纯串行循环
    status: pending
  - id: progressive-ui
    content: 实现逐条出现 + per-item loading 占位，批量按钮显示 Loading (k/N) 进度，必要时补 i18n key
    status: pending
  - id: error-handling
    content: 为 loadTrackDirect 补 try/catch 与成功/失败返回；单条失败回滚 checkbox 不阻塞队列；清空/关抽屉时清空未开始任务
    status: pending
  - id: verify
    content: 验证 10 轨道首次出现总耗时下降、逐条出现、并发上限生效、各交互无回归
    status: pending
isProject: false
---

## 背景与瓶颈

- 用户痛点：一次勾选 ~10 条多组学 `.bw` 轨道时，“首次出现”很慢。
- 链路事实：
  - 默认视窗仅 100kb（[static/js/genome.js](static/js/genome.js) 第 8-11 行），所以慢点不在数据量，而在每条 bigwig 的多次依赖性 Range 请求（header → chromTree → R-tree index → data）。
  - 服务端 `gunicorn -w 2` 且为默认 sync worker、无线程（[serve.sh](serve.sh) 第 23、52 行），全站同时最多处理 2 个请求。
  - `.bw` 单文件最大约 2GB、共 1.7TB，位于 `/data_group` 共享盘，随机 Range 读延迟高。
  - 批量加载当前是“逐条 await + 80ms”的纯串行（[static/js/multiomics.js](static/js/multiomics.js) `loadAllGroupTracks` 第 585-622 行、`consumePreselect` 第 297-305 行）；勾选框路径则是各自独立并发、无统一节流（`toggleTrack` 第 887 行）。
  - 用户选择“尽量只改前端，不大动服务端/数据”。

> 诚实结论：纯前端改不了“总请求数”和“网络盘单次读延迟”，真正的天花板是服务端并发；前端能稳拿“可感知速度”+“并发匹配”两类收益。要真正缩短“首次出现”总时长，必须同时提升服务端并发取数能力（加线程）。

## 方案（服务端 + 前端 双管齐下）

### 0. 服务端提线程（治本，已确认线程安全）
- 改动点：[serve.sh](serve.sh) 第 52 行 gunicorn 启动命令，从 `-w "$WORKERS"` 增加 `--threads`，建议 `--threads 8` 起步；`-w` 仍保持 2（bigwig 读是 I/O 密集，线程比多 worker 更省内存）。
  - 形如：`"$GUNICORN" -w "$WORKERS" --threads "${PERV_THREADS:-8}" -b ...`，并在脚本顶部加 `PERV_THREADS` 默认值便于调参。
- 原理：当前 `-w 2` 默认 sync worker 全站同时只处理 2 个请求；10 条轨道 × 每条多次 Range 请求会严重排队。加线程后单 worker 可同时等多个 I/O，并发取数能力从 2 提升到约 `2 × threads`。
- 调参提醒：线程数上限受 `/data_group` 网络盘随机读 IOPS 限制，不是越大越快；8 起步、按实测再调。
- 生效方式：必须 `./serve.sh restart` 重启 gunicorn 主进程（见 SKILL 注意事项 22；只重跑 `python app.py` 无效）。

#### 线程安全审计结论（已逐点确认，可放心提线程）
- 热路径 `.bw` 下载 `serve_multiomics_bw`（[app.py](app.py) 第 2340 行）：纯 `send_file`，无状态，多线程安全。
- SQLite 连接 `_get_gtf_conn()`（[app.py](app.py) 第 936-937 行）：每请求新建连接、只读模式、`check_same_thread=False`（[genome.py](genome.py) 第 314 行），各线程独立，且全程有 `.close()` 收尾，安全。
- 多组学缓存 `_MULTIOMICS_META_CACHE` / `_INDEX_CACHE` / `_RECOMMENDED_CACHE`（[app.py](app.py) 第 1974、2022、2096 行）：懒加载后只读，首次并发填充为幂等赋值，最坏只是重复算一次，不会数据错乱。
- 热路径上无共享可变状态被写入。
- 结论：提线程无阻断性隐患，无需额外加锁。

### 1. 统一的带并发上限加载队列（前端核心）
在 [static/js/multiomics.js](static/js/multiomics.js) 新增一个轻量并发池（默认 `MAX_CONCURRENT = 3`，常量便于调参）：
- 所有加载入口统一走队列：`toggleTrack`（勾选）、`loadAllGroupTracks`（组内 Load all）、`consumePreselect`（首页跳转预选）。
- 队列保证“同时最多 N 条在 `br.loadTrack` 中”，其余排队，完成一条立刻补一条。
- 移除现有 `loadAllGroupTracks` / `consumePreselect` 里的 `setTimeout(80)` 硬延迟与纯串行循环。
- 取消勾选时若该 url 仍在队列里未开始，直接出队，避免“加载完又被移除”的浪费。

并发数选 ~3 的理由：与 2 个 sync worker 接近、又留出 1 个缓冲；避免浏览器对单 origin ~6 连接上限与服务端 2 worker 之间反复排队抖动。该值设为常量，后续可按实测微调。

### 2. 可见加载进度（前端，可感知速度）
> 更正：单独勾选 checkbox 本来就各自异步、逐条出现（`toggleTrack` 独立触发），真正缺的是“可见的进度反馈”——旧的 `.loading` 仅把行 `opacity:.6`，几乎看不出来，且手动多选时没有聚合进度。
- 新增**全局加载进度横幅** `#g-tracks-progress`（[templates/genome.html](templates/genome.html) 抽屉头部），带转圈 spinner + `正在加载轨道 (done/total)…` 文案，由队列状态驱动（`loadStats` + `updateLoadProgress`），覆盖三条加载路径（勾选 / Load all / 首页预选）。i18n key：`gn.tracks.progress`。
- 单行 `.tracks-file-item.loading` 升级为“变淡 + 文件名旁转圈”，让正在读取的行肉眼可见。
- `loadAllGroupTracks` 按钮仍显示 `Loading (k/N)…`（i18n key `gn.tracks.recommended.loading_progress`）。

### 3. 失败与边界处理（前端）
- 队列内单条 `loadTrack` 失败时：回滚对应 checkbox、清除 loading、`console.warn`，不阻塞队列其余任务（当前 `loadTrackDirect` 第 624 行无 try/catch，需补上并返回成功/失败）。
- 关抽屉/清空（`clearAllMultiomicsTracks` 第 175 行）时清空队列中未开始的任务。

## 不做 / 排除项
- 不离线重生成/降采样 1.7TB 的 `.bw`（用户已排除大动数据）。
- 不改默认视窗（已是 100kb，合理）。
- 不引入服务端缓存层。

## 验证
- 服务端：`./serve.sh restart` 后用 10 条轨道对比首次出现总耗时（提线程前后），确认明显下降；`./serve.sh status` 正常。
- 前端：勾选 10 条轨道观察是否“逐条出现”，而非全部读完才出现；批量按钮显示进度。
- 队列并发上限生效（同时 in-flight ≤ N）。
- 取消勾选/清空/切语言/关开抽屉均无回归，`Clear MO Tracks` 计数正确。
- 回归既有功能：搜索、跳转、详情面板、基因组其它轨道（线程并发下 SQLite 接口无报错）。