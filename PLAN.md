# PERV Atlas 项目方案文档

> 这是一份项目级方案文档，记录了从最初的几个灵感板块到落地完整网站的全过程：
> 原始需求、关键设计决策、目录结构、API 清单、运维操作、迁移与扩展指引。
> 后续维护、迁移、扩展功能时优先参考本文件。

最后更新：2026-04-29（14:06）

---

## 1. 项目目标

搭建一个 **PERV (Porcine Endogenous Retrovirus) 数据展示与基因组浏览网站**，包含三个板块：

1. **板块一**（`/overview`）：1165 条完整 PERV 序列概览
2. **板块二**（`/browser`）：139 条精注释序列的 ORF / 结构域浏览
3. **板块三**（`/genome`）：Sus scrofa 11.1 参考基因组浏览器（基于 igv.js）

**部署形态**：单机 Flask 服务，前端纯 HTML/CSS/JS（无构建步骤），中英双语切换。

---

## 2. 板块一：1165 条 PERV 序列概览

### 2.1 需求

> 收录完整 PERV 的序列信息：1020 条 γ.ERV，145 条 β.ERV。
> 展示序列基本组成（γ vs β 比例等），同时提供 fasta 序列与 Excel 元数据下载链接。

### 2.2 数据源

- [`sequence/my.final.fa`](sequence/my.final.fa) — 1165 条 FASTA
- [`sequence/1165.intact.PERV.infomation.xlsx`](sequence/1165.intact.PERV.infomation.xlsx) — 11 列元数据：
  `Sequence.ID, Category, Motif, TSD, Identity, TE_type, Insertion_Time, Kimura.distance, ERV.type (γ.ERV / β.ERV), Abbretiation, Group (Eastern / Western)`

### 2.3 实现

| 元素 | 实现 |
|---|---|
| KPI 卡片 | 总数 / γ.ERV / β.ERV / Group 数 |
| γ vs β 比例 | ECharts 饼图 |
| Group 分布 (Eastern / Western) | 饼图 |
| Abbretiation (品种) 分布 | 柱状图 |
| Identity / Insertion_Time / Kimura distance 分布 | 直方图（后端分桶） |
| 元数据搜索表 | 按 Sequence.ID 关键字 / ERV.type / Group 过滤，分页 |
| 下载 | `my.final.fa` (~10MB), `1165.intact.PERV.infomation.xlsx` (~85KB) |

文件：[`templates/overview.html`](templates/overview.html)、[`static/js/overview.js`](static/js/overview.js)。

---

## 3. 板块二：139 条精注释序列浏览器

### 3.1 需求（原文要点）

> 收录通过完整结构和功能注释的序列。点击序列 ID 可展示注释信息，
> 用户可选择展示 **ORF** 或 **结构域**：
>
> - **ORF**（来自 [`ORF.combine.HTML.bed`](sequence/ORF.combine.HTML.bed)）：
>   `LTR / GAG / POL / ENV`。LTR 是非编码区。
> - **结构域**（来自 [`domin.combine.HTML.bed`](sequence/domin.combine.HTML.bed)）：
>   `GAG / AP / RT / RNaseH / INT / ENV`。
>
> 用户可进一步选择查看 DNA 或蛋白序列：
> - **DNA**：展示 ID + 区间范围 + 区间名（含 LTR）
> - **蛋白**：仅蛋白编码区（不展示 LTR），按标准密码子表翻译
>
> 同时提供 fa / 两个 bed 文件的下载链接。

### 3.2 数据源

- [`sequence/pass.139.fa`](sequence/pass.139.fa) — 139 条精注释序列 FASTA (~1.3MB)
- [`sequence/ORF.combine.HTML.bed`](sequence/ORF.combine.HTML.bed) — ORF BED6
- [`sequence/domin.combine.HTML.bed`](sequence/domin.combine.HTML.bed) — 结构域 BED6

### 3.3 实现

UI 三栏：
- **左侧**：139 条 ID 列表，可搜索
- **中部**：模式切换 `[ORF | Domain]` + DNA/蛋白切换 + 区间下拉选择 + ECharts 自定义 track（色块代表区间，悬停显示 name/range/strand，点击载入）
- **底部**：序列展示卡片
  - DNA 模式：标题 `ID | start-end | name`，FASTA 60 字符/行，可复制 / 下载单 FASTA
  - 蛋白模式：同上，标准密码子表翻译；ORF 模式自动屏蔽 LTR
  - 折叠面板：在整条序列中 `<mark>` 高亮当前区间
  - 一键导出"该序列下所有区间蛋白"为多 FASTA

文件：[`templates/browser.html`](templates/browser.html)、[`static/js/browser.js`](static/js/browser.js)、[`static/js/sequence.js`](static/js/sequence.js)。

---

## 4. 板块三：猪参考基因组浏览器

### 4.1 需求（原文要点）

> 新加入了基因组数据（Sus scrofa 11.1 FASTA + Ensembl 108 GTF），
> 在网站中再做一个模块，叫做 Genome Browser，把基因组与注释整合，方便可视化。

确认设计选择：
- 使用 **igv.js**（专业基因组浏览器组件，UCSC/IGV 同款）
- 不做 PERV 插入位点叠加（后续可加）
- 功能集：染色体导航 / 基因搜索 / GTF 轨道 / DNA 序列查看 / 区间导出

### 4.2 数据源

- [`genome.ref.guochao/Sus_scrofa.Sscrofa11.1.dna.toplevel.fa`](genome.ref.guochao/Sus_scrofa.Sscrofa11.1.dna.toplevel.fa) — **2.4 GB**，613 个 contig
- [`genome.ref.guochao/Sus_scrofa.Sscrofa11.1.108.gtf`](genome.ref.guochao/Sus_scrofa.Sscrofa11.1.108.gtf) — **508 MB**，1,363,550 行（35,670 基因 / 60,273 转录本）

### 4.3 关键设计决策

| 决策 | 原因 |
|---|---|
| 自建 `.fai`（samtools 兼容） | 服务器无 samtools；纯 Python 即可，约 23 秒 |
| GTF 解析为 SQLite（300 MB） | 一次解析，多次查询；区间/基因名都能 ms 级响应 |
| igv.js 注释轨道走静态 BED（`genome.bed` + `genome.genes.bed`） | 原生 BED12/BED9 解析稳定，避免 custom JSON source 的字段兼容问题 |
| FASTA 通过 Flask `send_file` 走 HTTP Range | igv.js 通过字节范围按需读取，2.4GB 全文件不会一次性下载 |
| 视野 > 5 Mb 只返回 gene 摘要；≤ 5 Mb 返回 transcript+exon+CDS 聚合 | 避免大视野下渲染过载；同时小视野下能画出 intron 线 + CDS 粗细 |
| `displayMode: 'EXPANDED'`、`height: 220` | 默认展开多行显示所有重叠转录本 |

### 4.4 索引构建

```bash
.venv/bin/python build_genome_index.py
```

约 **49 秒一次性**完成；后续启动只读索引，毫秒级。索引文件落在 `data/`：
- `data/genome.fa.fai` (~23 KB)
- `data/gtf.sqlite` (~300 MB)

数据更新后重跑同一脚本即可，会按 mtime 自动判断重建。

### 4.5 实现

文件：[`genome.py`](genome.py)、[`build_genome_index.py`](build_genome_index.py)、[`templates/genome.html`](templates/genome.html)、[`static/js/genome.js`](static/js/genome.js)。

UI：
- 顶部工具栏：染色体下拉 / start-end 输入 + Go / 基因名/Ensembl ID 自动补全搜索 / 展示模式（EXPANDED/SQUISHED/COLLAPSED） / 导出 DNA / 导出 GTF / 链颜色控制（按轨道选择 + `+/- strand` 色 + 联动（Link））
- 主体：igv.js 嵌入容器，1 条 GTF 轨道（自动按视野缩放级别返回 gene 或 transcript 详情）
- 详情卡：点击基因/转录本展示详细属性 + 折叠面板查看当前区间 DNA（≤100 kb）

### 4.6 2026-04 体验升级（新增）

针对“页面尽量全屏、首页更美观、Genome Browser 展示可变剪切并支持细粒度详情”的新增需求，已完成如下升级：

1) **全局布局近全屏**
- 主内容容器宽度从中等版心扩展到近全屏（提升可视区域利用率）
- 基因组页切换到 full-width 容器，采用“左主视图 + 右固定详情面板”双栏布局

2) **首页视觉重构**
- Hero 改为分层渐变 + 动态 DNA SVG + 动画元素，替代原先单一图文
- 增加关键数字条（总序列、注释序列、参考基因组等核心指标）
- 三大模块卡片加入色彩分层、图标与交互动效
- 新增数据流程区（Identification → Classification → Annotation → Visualization）

3) **Genome Browser 可变剪切与点击详情**
- 点击 gene / transcript / exon 后，右侧面板展示：
  - 所属 gene / transcript
  - 坐标、长度、链方向、biotype
  - 外显子序号（Exon N of M）
- 同一 gene 下全部 transcript 并列展示，用统一坐标尺对比可变剪切结构
- 细化 exon/CDS/UTR 可视化与当前选中外显子高亮

4) **Genome Browser 皮肤化**
- 对 igv.js 外层容器与核心控件进行主题化样式改造
- 保留专业浏览能力同时提升视觉一致性，避免“传统 igv 裸界面”割裂感

5) **后端新增结构化详情 API**
- `GET /api/genome/gene/<gene_id>`：返回 gene 及其所有 transcript（含 exon/CDS/UTR）
- `GET /api/genome/transcript/<transcript_id>`：返回单 transcript 的完整结构详情

### 4.7 2026-04 晚间增强（搜索 + 转录本展开 + 全特征可视化）

针对“基因组浏览器只看到全长范围、希望按 transcript 细看可变剪切并支持折叠”的新增需求，补充完成：

1) **三字段搜索（gene_name / gene_id / transcript_id）**
- `/api/genome/search` 从“仅 gene”扩展为“gene + transcript”联合检索
- 搜索命中 transcript 时，前端会自动跳转对应区间并在右侧详情中高亮该 transcript
- 搜索下拉结果显式区分 `GENE` 与 `TX` 类型，降低误选

2) **IGV 中可变剪切真正展开（修复同名合并）**
- 原先多个 isoform 可能因 `name=gene_name` 被 igv.js 归并到同一行，导致看起来只有“全长一条”
- 已改为 transcript feature 使用 `name=transcript_id`，`gene_name` 单独作为附加字段返回
- 结果：同一基因下多个 transcript 在 EXPANDED 模式可逐条分行显示

3) **转录本展开/折叠交互**
- 工具栏新增展示模式切换：`EXPANDED / SQUISHED / COLLAPSED`
- 支持在同一区间内快速切换“逐转录本对比”与“折叠概览”
- track 高度按当前模式与可见转录本数量自适配，减少拥挤或浪费空间

4) **GTF 第三列 feature 全量可见**
- 在 transcript 细节视图中完整覆盖并可定位：  
  `transcript / exon / CDS / five_prime_utr / three_prime_utr / start_codon / stop_codon`
- 右侧详情新增“当前 transcript 的 GTF 特征明细”折叠表（类型、基因组坐标、长度）
- transcript 微型结构图补充 `start_codon` / `stop_codon` 标记，便于阅读编码边界

### 4.8 2026-04 深夜关键修复（IGV 轨道语义对齐）

针对“IGV 里 transcript 像基因一样是一条长线、点击 transcript 右侧仍显示 gene”的问题，新增并固化以下实现：

1) **双轨道方案（Genes + Transcripts）**
- 新增基因轨道文件：`data/genome.genes.bed`（BED9，基因级跨度）
- 保留转录本轨道文件：`data/genome.bed`（BED12，外显子/CDS 结构）
- 前端 `igv.js` 同时挂载两条轨道：
  - `Genes`：用于“基因在哪”的宏观定位（默认 collapsed）
  - `Transcripts`：用于可变剪切细节（支持 `EXPANDED/SQUISHED/COLLAPSED`）

2) **修复 BED12 退化为“长条”的根因**
- 旧版 BED12 第 4 列 name 曾写成：`transcript_id (gene_name)`，包含空格
- 在部分 BED 解析路径中会导致列错位，`blockCount/blockSizes/blockStarts` 丢失，进而退化成 BED6 样式长条
- 现已改为：name **仅 transcript_id**（无空格/括号），确保 igv.js 稳定按 BED12 渲染 exon/intron/CDS

3) **右侧详情面板引入视图状态机**
- 新增 `viewMode: gene | transcript`
- 点击 transcript（IGV 或右侧列表）时切到 transcript header，展示：
  - transcript_id、biotype、strand、exon_count、transcript length、CDS length
- 并提供 “Back to gene” 按钮，避免用户误以为一直在看 gene 详情

4) **构建与服务策略**
- 由 `app.py` 的 `_build_genome_bed()` 同时生成：
  - `data/genome.bed`
  - `data/genome.genes.bed`
- `/genome/data/genome.bed` 与 `/genome/data/genome.genes.bed` 均通过 `send_file(..., conditional=True)` 提供 Range/缓存友好访问

5) **轨道颜色控制策略（按最新需求）**
- 为支持“IGV 里手动设置 track 颜色后整条轨道统一生效”，生成 BED 时将第 9 列 `itemRgb` 统一写为 `0`
- 不再使用 biotype→RGB 的 per-feature 写色策略，避免 `itemRgb` 覆盖轨道默认色导致“只有部分改色”
- 结果：`Genes` 与 `Transcripts` 两条轨道都可由 IGV 调色板或前端 `track.color` 全局控制

6) **正负链独立配色（新增）**
- 工具栏新增链颜色控件：轨道选择（`Genes` / `Transcripts`）、`+` 颜色、`-` 颜色、`联动（Link）`开关
- 语义定义：
  - `+` 对应 `track.color`
  - `-` 对应 `track.altColor`
- `联动（Link）=开`：自动保持 `altColor = color`（单色整轨）
- `联动（Link）=关`：允许正负链分色（链特异可视化）
- 自动同步逻辑按轨道状态执行：只对“联动开启”的轨道做同步，避免覆盖用户手动设置的负链颜色

### 4.9 2026-04 PERV 基因组轨道与导航面板（新增）

针对“在 Genome Browser 中增加 PERV 注释轨道，并支持按序列列表快速定位 + 详情查看”的需求，已新增：

1) **PERV 轨道接入（固定在 Genes 下方）**
- 新增静态轨道文件：`data/perv.bed`（BED6）
- 新增路由：`GET /genome/data/perv.bed`
- 前端 `igv.js` 轨道数组新增：
  - `id: perv-sequences`
  - `name: PERV`
  - `url: /genome/data/perv.bed`

2) **PERV 序列导航面板**
- 在 `genome.html` 的工具栏下方新增可折叠 `PERV Sequences` 面板
- 点击条目可：
  - 跳转到对应基因组位置
  - 同步在右侧详情面板展示该序列 region 信息

3) **后端 PERV 聚合 API**
- 新增：`GET /api/genome/perv/list`
- 返回 47 条序列（来自 `Homologous/RF.intact.region`）
- 部分序列可附带结构/功能注释（来自 `domin.combine.HTML.bed` 与 `ORF.combine.HTML.bed`，按 ID 匹配）

4) **坐标体系统一（关键）**
- `RF.intact.region`：**1-based 闭区间**（非 BED）
- `ORF/Domain` 文件：**BED 0-based 半开区间**
- 映射规则：
  - 先把 region 转 BED：`region_start_bed = start - 1`，`region_end_bed = end`
  - `+` 链：`abs = region_start_bed + rel`
  - `-` 链：`abs_start = region_end_bed - rel_end`，`abs_end = region_end_bed - rel_start`

5) **显示层修复（避免误判）**
- 后端内部与 API 可保留 BED 绝对坐标（便于 IGV 与轨道复用）
- 右侧详情若显示 1-based，必须：
  - `display_start = start + 1`
  - `display_end = end`
- 否则会出现“LTR 起点比整段 PERV 起点更靠前”的假象（本次已修复）

### 4.10 2026-04 PERV Homologous 模块与交互修复（新增）

围绕 876 条同源定位结果（`Homologous/final.Statistics.table.xlsx`），新增并修复如下能力：

1) **PERV Homologous 右侧抽屉模块**
- 新增入口：`PERV Homologous`
- 抽屉支持两类视图：
  - 全部 `Sequence ID`
  - 全部 `Locus ID`
- 序列视图支持按 `species / chr / group / locus.id` 过滤，以及按序列 ID 搜索
- 点击序列或 locus 可在抽屉内展示详情并联动 IGV 跳转

2) **同源轨道与默认显示策略**
- 新增 `Homologous Seq` 与 `Homologous Loci` 两条注释轨道
- `Homologous Seq` 默认 `EXPANDED`，展示每条序列 ID
- 统一 `Genes/Transcripts/PERV/Homologous` 轨道字体与标签风格
- 调整 `visibilityWindow`，避免初始进入时自动最大缩放

3) **关键回归修复**
- 修复 `locus_id` 字典序错误（改为数值排序）
- 修复“未先打开同源抽屉时，点击同源 track 无详情”的初始化问题（预加载数据）
- 修复同源数据请求失败后不可重试的问题（`loading` 与 `loaded` 状态解耦）
- 修复 ECharts 实例未释放导致的潜在内存泄漏（渲染前 `dispose`）
- 修复 locus 物种分布图高度固定导致可读性差（按物种数动态计算高度）

4) **交互与样式细节优化**
- 同源抽屉支持点击空白区域关闭，行为与 Tracks 抽屉保持一致
- 搜索下拉布局重构，避免 gene 名称被截断
- 同源抽屉列表字体层级与坐标排版优化（统一 `en-US` 数字格式）
- 新增 Genes 快捷显示模式按钮，支持 `EXPANDED/SQUISHED/COLLAPSED`
- Genes/Transcripts 默认高度优化（重点提升标签重叠可读性）
- 详情标题更新为 `Gene / Transcript / PERV detail`
- 基因组默认配色调整：Genes（灰色系）与 Transcripts（橄榄金系）

5) **IGV v3 样式覆盖工程经验（重要）**
- igv.js 3.x 在 Shadow DOM 内渲染，外部 CSS 不能直接覆盖内部 `.igv-track-label`
- 解决方式：在 `igv.createBrowser` 成功后，向 `#igv-container.shadowRoot` 注入 `<style>`
- 为避免页面初始“旧样式闪一下再替换”（FOSC），应立即注入，避免 `setTimeout` 延迟

### 4.11 2026-04 ERV.type 贯通与 Homologous Tab 修复（新增）

1) **ERV.type 标签贯通（PERV + Homologous）**
- 数据源：`sequence/1165.intact.PERV.infomation.xlsx`（第 2 行表头，使用 `Sequence.ID` 与 `ERV.type`）
- 关联策略：
  - `PERV` 详情：`name` ↔ `Sequence.ID`
  - `Homologous` 序列：`q_name` ↔ `Sequence.ID`
- 后端在聚合 API 时直接注入 `erv_type` 字段，前端仅渲染 badge
- 实测：Homologous `876/876` 可匹配到 `ERV.type`（`γ.ERV`/`β.ERV`）

2) **Homologous 抽屉 Sequences/Loci 不切换问题**
- 现象：点击 tab 无明显切换，`Loci` 区域长期出现在列表下方
- 根因：`#homo-seq-view, #homo-locus-view { display:flex; }` 覆盖了原生 `hidden` 的 `display:none`
- 修复：增加样式兜底
  `#homo-seq-view[hidden], #homo-locus-view[hidden], #homo-detail-view[hidden] { display:none !important; }`
- 结论：这类问题优先检查“状态切换是否正确”与“样式是否抵消状态”两层。

### 4.12 2026-04 内置轨道恢复与文案对齐（新增）

1) **内置轨道恢复入口（Reset Tracks）**
- 背景：IGV 允许用户右键 `Remove track`，删除后原生 UI 不提供“加回内置轨道”的站点级入口。
- 方案：在 Genome 工具栏新增 `Reset Tracks` 按钮。
- 逻辑：
  - 维护内置轨道清单（Genes/Transcripts/PERV/Homologous Seq/Homologous Loci）
  - 按 `track.id` + `track.name` 检测缺失
  - 仅恢复缺失轨道（`browser.loadTrack`），不重置全部轨道

2) **Fixed 纵轴语义澄清**
- `autoscale:false` 仅表示“关闭随视窗自动重标尺”
- 不等于“绝对固定 min/max”
- 若业务需要“严格固定比例”，应显式设置 `min/max`

3) **入口文案一致性**
- 工具栏按钮与抽屉标题统一命名，减少认知成本：
  - `Tracks` → `Multi-omics Tracks`
  - `Homologous` → `PERV Homologous`
  - `Isoforms` 标签 → `TRANSCRIPTS`（全大写）

4) **Transcript 特征表配色优化**
- 背景：用户反馈 `exon` 与 `CDS` 同为蓝紫系，辨识度不足
- 调整：将 `exon` 改为琥珀黄（`#d97706`），`CDS` 保持蓝色（`#2563eb`）
- 目标：在 feature 列表中快速区分“结构外显子标签”与“编码区”

### 4.13 2026-04-29（续）物种标签增强与同源分布图防遮挡（新增）

1) **物种标签从简称升级为“简称 + 全名 + 组装号”**
- 新增数据源：`sequence/genome.information.xlsx`
- 字段口径：
  - 第 1 列：物种全名（`Row name`）
  - 第 2 列：简称（`Abbretiation`）
  - 第 3 列：组装号/来源链接（`Assembly`）
- 后端在启动时读取并缓存为简称映射，前端通过 API 使用，不在前端重复解析 Excel。

2) **展示策略（不破坏既有筛选逻辑）**
- Homologous filter 的 option `value` 保持简称（如 `KM`），仅显示文案扩展为 `KM — Korean Minipig`。
- Homologous 详情 `Metadata` 中展示：
  - `Species`：简称 + 全名
  - `Assembly`：组装号或 URL
- Overview `Abbretiation` 柱状图 tooltip 展示全名与 assembly。

3) **Species Distribution 柱状图遮挡/过长修复**
- 问题表现：
  - y 轴长标签（`abbr + full_name`）被左侧裁切或重叠
  - 数据全为 1 时柱条横向“拉满”
- 修复口径（ECharts）：
  - `grid.containLabel: true`
  - `yAxis.axisLabel.width` + `overflow: 'break'`
  - `xAxis.max = maxV + max(0.5, maxV*0.5)` 预留右侧留白，避免柱条顶满
- 同时保留 `barHeight` 按 species 数动态增长策略。

### 4.14 2026-04-29（续）Genome 轨道默认高度重设（新增）

为改善初始可读性并减少同源轨道拥挤，调整默认高度为：

- `Genes`：`80`
- `Homologous Seq`：`100`
- `Homologous Loci`：`50`

实现约束：

1. `igv.createBrowser` 初始轨道配置与 `Reset Tracks` 的 `BUILTIN_TRACKS` 必须同步。
2. `Genes` 的 `EXPANDED` 模式高度映射应与上述默认值一致，避免模式切换后回弹。

---

## 5. 技术栈与架构

### 5.1 后端

- **Python 3.8+**
- **Flask 3.x**（路由 / 模板渲染 / `send_file` 自带 HTTP Range）
- **openpyxl**（解析 xlsx 元数据）
- **gunicorn**（生产部署）
- **stdlib only** for: 序列翻译、反向互补、`.fai` 构建、GTF SQLite 构建、SQLite 区间查询

### 5.2 前端

- **原生 HTML / CSS / JS**（零构建步骤）
- **ECharts 5.5**（板块一/二图表）
- **igv.js 3.8**（板块三基因组浏览器）
- 自研轻量 i18n（zh / en，`localStorage` 持久化）

### 5.3 数据层

| 层 | 内容 |
|---|---|
| 原始数据 | `sequence/*`（PERV）+ `genome.ref.guochao/*`（参考基因组） |
| 原始数据（Genome 扩展） | `Homologous/RF.intact.region`（PERV 基因组定位，非 BED） |
| 启动时索引 | `data/{meta_1165.json, orf_index.json, domain_index.json, seq_offsets.json}` |
| 一次性离线索引 | `data/{genome.fa.fai, gtf.sqlite}` |
| Genome 轨道静态物料 | `data/{genome.bed, genome.genes.bed, perv.bed}` |

---

## 6. 目录结构

```
PERV.html/
├── app.py                       # Flask 应用 + PERV API + 基因组 API
├── genome.py                    # FAI 构建 + SQLite GTF 索引 + 查询函数
├── build_genome_index.py        # 一次性基因组索引构建 CLI
├── serve.sh                     # 服务启停 (start/stop/restart/status/log)
├── migrate.sh                   # 项目打包 / scp 推送 / 新机器 setup
├── requirements.txt
├── README.md                    # 用户向：安装、启动、API
├── PLAN.md                      # ← 本文件，项目级方案文档
├── .gitignore
├── sequence/                    # PERV 原始数据
│   ├── my.final.fa                       # 1165 条 (10 MB)
│   ├── pass.139.fa                       # 139 条 (1.3 MB)
│   ├── 1165.intact.PERV.infomation.xlsx  # 元数据 (85 KB)
│   ├── ORF.combine.HTML.bed              # LTR/GAG/POL/ENV
│   └── domin.combine.HTML.bed            # GAG/AP/RT/RNaseH/INT/ENV
├── Homologous/
│   └── RF.intact.region         # PERV 在参考基因组上的定位（47 条，非 BED，1-based）
├── genome.ref.guochao/          # 参考基因组（大文件，迁移时单独传输）
│   ├── Sus_scrofa.Sscrofa11.1.dna.toplevel.fa     # 2.4 GB
│   └── Sus_scrofa.Sscrofa11.1.108.gtf             # 508 MB
├── data/                        # 自动生成的索引
│   ├── meta_1165.json / orf_index.json / domain_index.json / seq_offsets.json
│   ├── genome.fa.fai            # 23 KB
│   ├── gtf.sqlite               # 300 MB
│   ├── genome.bed               # transcript BED12（~60,440 条）
│   └── genome.genes.bed         # gene BED9（~35,682 条）
│   └── perv.bed                 # PERV BED6（47 条）
├── templates/
│   ├── base.html                # 顶栏 / i18n 切换 / 底部
│   ├── index.html               # 首页：三个板块入口
│   ├── overview.html            # 板块一
│   ├── browser.html             # 板块二
│   └── genome.html              # 板块三
└── static/
    ├── css/style.css
    └── js/
        ├── i18n.js              # 双语字典 + 切换逻辑
        ├── overview.js          # 板块一图表 + 表格
        ├── browser.js           # 板块二 ID 列表 + track + 序列查看
        ├── sequence.js          # FASTA wrap / 复制 / 下载工具
        └── genome.js            # 板块三 igv.js 集成 + 搜索 + 导出
```

---

## 7. API 清单

### 7.1 PERV 板块（板块一/二）

| Method | Path | 用途 |
|---|---|---|
| GET | `/api/overview/stats` | γ/β、Group、Abbretiation 计数；Identity / Insertion_Time / Kimura 直方图 |
| GET | `/api/overview/table?q=&type=&group=&page=&size=` | 1165 条元数据分页查询 |
| GET | `/api/sequences/pass` | 139 条 ID + 长度 |
| GET | `/api/sequences/<sid>/regions?kind=orf\|domain` | 区间列表 + 序列长度 |
| GET | `/api/sequences/<sid>/dna?start=&end=&strand=&name=` | 区间 DNA + FASTA |
| GET | `/api/sequences/<sid>/protein?start=&end=&strand=&name=` | 标准遗传密码翻译后的蛋白 + FASTA |
| GET | `/api/sequences/<sid>/all-protein?kind=orf\|domain` | 该序列下所有可编码区间多 FASTA（ORF 模式自动跳过 LTR） |
| GET | `/download/<filename>` | 受白名单限制下载（fa / xlsx / bed） |

### 7.2 基因组板块（板块三）

| Method | Path | 用途 |
|---|---|---|
| GET | `/api/genome/status` | 索引是否就绪 |
| GET | `/api/genome/chromosomes` | 染色体列表 + 长度（chr1–18、chrX、chrY、chrM 优先） |
| GET | `/api/genome/sequence?chrom=&start=&end=` | 区间 DNA（≤1 Mb） |
| GET | `/api/genome/features?chrom=&start=&end=&types=` | GTF 区间内 feature 扁平列表 |
| GET | `/api/genome/igv?chrom=$CHR&start=$START&end=$END` | 旧版 JSON 轨道接口（保留兼容，不再作为主轨道数据源） |
| GET | `/api/genome/search?q=` | 支持 `gene_name / gene_id / transcript_id` 联合搜索（返回 `gene` 或 `transcript` 类型） |
| GET | `/api/genome/gene/<gene_id>` | 返回 gene 与全部 transcript 结构（含 exon/CDS/UTR/start_codon/stop_codon、统计信息） |
| GET | `/api/genome/transcript/<transcript_id>` | 返回单 transcript 结构详情（含 exon/CDS/UTR/start_codon/stop_codon） |
| GET | `/api/genome/region/dna?chrom=&start=&end=` | 区间 DNA 下载（FASTA） |
| GET | `/api/genome/region/gtf?chrom=&start=&end=&types=` | 区间 GTF 子集下载 |
| GET | `/genome/data/genome.fa` | 参考 FASTA（带 HTTP Range，供 igv.js 流式读取） |
| GET | `/genome/data/genome.fa.fai` | FASTA 索引 |
| GET | `/genome/data/genome.bed` | transcript BED12 静态轨道（主轨道，含 exon/CDS block） |
| GET | `/genome/data/genome.genes.bed` | gene BED9 静态轨道（gene 总览轨道） |
| GET | `/genome/data/perv.bed` | PERV BED6 静态轨道（PERV 基因组定位） |
| GET | `/api/genome/perv/list` | PERV 列表 + region + domain/ORF 注释（按 ID 匹配并映射回基因组） |
| GET | `/api/multiomics/index` | 返回 `Multi-omics` 目录分组与 `.bw` 文件清单（用于 Tracks 抽屉） |
| GET | `/multiomics/data/<category>/<filename>.bw` | BigWig 文件分块读取（HTTP Range，供 igv.js 动态加载） |
| GET | `/api/download/resolve_region` | 将 gene/transcript/perv/homo/custom/position 解析为统一基因组区间 |
| POST | `/api/download/generate` | 基于 BigWig + 注释轨渲染导出图（PDF/SVG/PNG；多轨 ZIP） |

---

## 8. 运维操作

### 8.1 首次安装

```bash
cd PERV.html
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt   # 国内可加 -i https://pypi.tuna.tsinghua.edu.cn/simple

# 仅当需要板块三时
python build_genome_index.py
```

### 8.2 启动 / 停止 / 状态

```bash
./serve.sh start      # 后台启动 gunicorn (默认 127.0.0.1:5000)
./serve.sh status
./serve.sh restart
./serve.sh stop
./serve.sh log        # 实时跟踪日志
```

环境变量覆盖（不改代码）：
```bash
PERV_HOST=0.0.0.0 PERV_PORT=8000 PERV_WORKERS=4 ./serve.sh restart
```

### 8.3 数据更新

| 数据 | 更新方式 |
|---|---|
| PERV 元数据 / BED / FASTA | 直接覆盖 `sequence/*`，重启服务自动重建 `data/*.json` |
| 参考基因组 / GTF | 覆盖 `genome.ref.guochao/*`，运行 `python build_genome_index.py` 重建索引，再重启服务 |
| 前端文案（中英） | 编辑 [`static/js/i18n.js`](static/js/i18n.js)，刷新即可 |

### 8.4 公网访问方案

按可用性排序：

| 方案 | 适用场景 | 操作 |
|---|---|---|
| **SSH 隧道** | 个人临时访问，零配置 | 本地 `ssh -N -L 5000:127.0.0.1:5000 user@server`，浏览器开 `http://localhost:5000/` |
| **nginx 反代** | 生产环境，多人访问 | 让管理员加一段 `location /` proxy_pass 到 `127.0.0.1:5000` |
| **公网端口** | 内网/有完整防火墙控制 | `PERV_HOST=0.0.0.0 ./serve.sh restart`，让管理员开放对应端口 |

### 8.5 项目迁移

```bash
# 在源服务器
./migrate.sh pack                          # 打包成 perv-atlas.tar.gz (排除 venv/data/genome.ref*/log)
./migrate.sh push user@host:/path          # 打包 + scp 一气呵成

# 在目标服务器（解压后）
./migrate.sh setup                         # 建 venv + pip install (失败自动用清华镜像重试)
python build_genome_index.py               # 如果有 genome.ref.guochao/，构建基因组索引
./serve.sh start
```

注意：`genome.ref.guochao/` 因体积大默认**不打包**，需要单独传输（OSS / scp / U盘）。

---

## 9. 关键设计决策与权衡

| 决策 | 替代方案 | 选择理由 |
|---|---|---|
| Flask + 原生前端 | Vue/React + Vite | 零构建步骤；运维简单；体积小；后续 API 化扩展友好 |
| ECharts | Chart.js / Plotly | 国产、图表类型多、性能好；与 igv.js 不冲突 |
| igv.js v3.8 | 自研 ECharts 基因组轨道 | 免开发，UCSC 同款交互；支持 byte-range FASTA 与原生 BED12 可变剪切渲染 |
| 自建 `.fai` | 调用 samtools | 服务器无 samtools；纯 Python 23 秒可建好 |
| GTF → SQLite | GTF → JSON / 内存 dict | SQLite 区间索引快、磁盘占用低；600MB GTF 内存装不下 |
| 静态 BED 轨道（`genome.bed` + `genome.genes.bed`） | URL 模板 JSON 轨道 | 原生 BED12 渲染更稳，能直接显示 exon/intron/CDS 结构，避免 JSON/custom source 的解析分歧 |
| BED `itemRgb` 统一置 `0` | 按 biotype 写 itemRgb | 满足用户“整轨调色”的交互预期，避免颜色仅部分生效 |
| 轨道级 `+/-` 链配色 + 联动开关 | 仅依赖 IGV 默认调色板 | 同时满足两类需求：一键整轨单色（联动开）与正负链分色（联动关） |
| 中英双语 (`data-i18n`) | 单语 / 服务端国际化 | 前端纯 JS 切换、零网络往返；扩展第三语言只需扩字典 |
| 启动时构建 PERV 索引 / 离线构建基因组索引 | 全部启动时构建 | PERV 索引秒级、可启动时建；基因组索引需 49 秒，做成离线避免每次启动等待 |

---

## 10. 已知限制与未来扩展点

### 10.1 已知限制

- 板块二仅展示 `+` 链区间（当前数据全是 `+`），但代码已支持 `-` 链反向互补
- 板块三未叠加 PERV 插入位点（用户当前选择跳过）
- 单 Flask 进程；高并发场景需 gunicorn 多 worker（serve.sh 已默认 2 worker）
- 没有用户系统 / 鉴权 —— 假定网站对授权用户群体开放

### 10.2 易于扩展的点（已留接口）

| 扩展功能 | 改动位置 |
|---|---|
| 在基因组上叠加 PERV 插入位点 | 新增 `/api/genome/perv-insertions` 路由；前端 `genome.js` 加一个 igv.js 轨道，URL 指过去；位点可来自外部 BED 文件或从 PERV 元数据中解析 |
| BLAST / 序列比对 | 后端集成 `blast+` 命令行；新增 `/api/blast` 路由 |
| 第三语言（如日文） | 在 `static/js/i18n.js` 加一个 `ja: {...}` 字典并在顶栏加按钮 |
| 数据源扩到其他物种 | `genome.ref.guochao/` 改成多目录、`data/` 加多个 sqlite，`/api/genome/*` 加 `species=` 参数 |
| 用户标注 / 收藏 | 新增 SQLite 表存用户书签；前端加登录态 |
| 公网部署 + HTTPS | nginx 反代 + Let's Encrypt 证书 |

---

## 10.3 多组学 BigWig 轨道接入（已落地）

目标：将 `Multi-omics/` 下 `.bw` 文件按目录分组接入 Genome Browser，支持用户勾选加载；保持现有 `Genes/Transcripts` 轨道逻辑不变，并作为冻结窗格置顶。

### 已实现摘要

1. **交互入口**：Genome 工具栏新增 `Tracks` 按钮，右侧弹出抽屉（drawer overlay）。
2. **分组规则**：一级目录即数据类型（如 `ATAC-seq` / `ChIP-seq` / `RNA-seq` / `WGBS` / `Hi-C`），展开后列出该目录下全部 `.bw` 供勾选。
3. **轨道加载**：勾选时调用 igv.js `loadTrack` 以 `wig/bigwig` 方式加载；取消勾选即卸载对应 track。
4. **滚动策略**：使用单 IGV 实例。已有轨道（ruler + Genes + Transcripts）加 sticky 冻结；新增多组学轨道在其后滚动。

### 后端任务

- 新增 `MULTIOMICS_DIR = BASE_DIR / "Multi-omics"`。
- 新增 `GET /api/multiomics/index`：扫描目录并返回分类-文件树（仅 `.bw`）。
- 新增 `GET /multiomics/data/<category>/<path:filename>`：路径安全校验后 `send_file(..., conditional=True)`，支持 Range。

### 前端任务

- `templates/genome.html`：新增 `Tracks` 按钮、抽屉容器、遮罩层。
- `static/js/multiomics.js`（新增）：拉取目录树、渲染折叠分类、管理 checkbox 与轨道增删。
- `static/js/genome.js`：暴露 browser 实例，标记 frozen tracks 并动态计算 sticky top 偏移。
- `static/css/style.css`：抽屉动画、蒙层、IGV 滚动区与 sticky 样式。

### 前置校验

BigWig 染色体命名必须与参考基因组一致（当前为 `chr*` 命名）。  
若存在 `1/2/X/MT` 这类无 `chr` 前缀文件，需先离线转换后再接入。

### 已修复：同一区域平移后信号高度变化

原因是多组学 track 使用 `autoscale: true` 时，IGV 会随视窗动态重算 Y 轴。  
现已改为默认 `Fixed`（`autoscale: false`），并在每个文件条目提供 `Fixed/Auto` 切换按钮：

- `Fixed`：跨区域可比，适合横向比较
- `Auto`：细节增强，适合局部弱峰观察

---

## 10.4 多组学可视化下载（2026-04 新增）

目标：在 Genome Browser 内新增“导出多组学可视化图”能力，满足按实体/坐标选区、上下游扩展、轨道多选导出、注释叠加、格式选择（PDF/SVG/PNG）。

### 架构

- 前端：
  - `templates/genome.html`：新增 `Download Viz` 按钮与 Modal 结构
  - `static/js/download_modal.js`：区域选择、轨道勾选、格式选择、请求提交与下载触发
  - `static/js/i18n.js`：补充 `gn.dl_viz.*` 文案
- 后端：
  - `GET /api/download/resolve_region`
  - `POST /api/download/generate`
  - `app.py` 中新增 matplotlib/pyBigWig 渲染函数

### 核心策略

1. **区间解析统一化**
   - 所有入口先归一成 `{chrom,start,end,name,length}`，降低前端分支复杂度。

2. **导出结果组织**
   - 选 1 条 BigWig → 直接返回单文件
   - 选多条 BigWig → 逐条渲染后 ZIP 返回

3. **可视化风格统一**
   - 轨道颜色与 `genome.js` 一致（Genes/Transcripts/PERV/Homologous）
   - 长区间自动横向扩展；注释轨高度按堆叠行数自适应
   - feature 级 ID 保留（gene 用斜体，transcript/perv/homo 保留原 ID）

4. **性能与安全边界**
   - 区间上限 10 Mb，避免大范围渲染超时
   - 仅允许合法 `.bw` 相对路径，拒绝路径穿越
   - BigWig 采样使用 `bw.stats(..., nBins)`，避免逐碱基读取

### 落地经验（重要）

- 运行环境与依赖一致性是首要风险：报错“matplotlib not installed”时，通常是 venv 与 gunicorn 实际解释器不一致。
- 修改后必须重启 gunicorn 才会生效；仅刷新页面不足以加载后端新逻辑。
- 导出图“看起来方、挤、粗”时，优先调宽高策略和行高策略，而不是只调颜色。

---

## 11. 故障排查指引

| 症状 | 原因 / 处理 |
|---|---|
| `/genome` 显示 "Genome index not built" | 运行 `python build_genome_index.py` 后重启 |
| igv.js 报 `Cannot read properties of undefined (reading 'replace')` | 通常是缓存或轨道字段异常；本仓库主轨道为静态 BED（`/genome/data/genome.bed`），先 Ctrl+Shift+R 强刷，再检查 BED 行列完整性 |
| 修改了 track label 样式但页面无变化 | igv.js v3 使用 Shadow DOM。需在 `#igv-container.shadowRoot` 注入样式，普通全局 CSS 无法直接覆盖 |
| 同一基因多 transcript 在 IGV 中只看到“蓝色长条” | 检查 `data/genome.bed` 第 4 列是否带空格（错误示例：`tx_id (gene)`）；改为纯 `transcript_id` 后重建 BED 并重启 |
| IGV 调 `Set track color` 只有部分记录变色 | 检查 BED 第 9 列 `itemRgb` 是否是具体 RGB；若是，改为统一 `0`，重建 `genome.bed` 与 `genome.genes.bed` 并硬刷新 |
| 想做正负链分色，但总是被改回同色 | 检查该轨道的“联动（Link）”是否开启；关闭联动后再分别设置 `+/-` 颜色 |
| PERV 详情中 LTR 起点比序列起点更小 | 通常是把 BED 0-based 起点直接当 1-based 展示；详情面板需 `start+1` 后再显示 |
| Tracks 抽屉里 `Fixed/Auto` 不随语言切换 | 检查自定义脚本是否调用了 `window.I18n.t(...)`，并监听 `i18nchange` 后重绘动态节点 |
| Overview 环图标签互相重叠 | 在 `static/js/overview.js` 的饼图配置启用 `avoidLabelOverlap` + `labelLayout.hideOverlap/moveOverlap`，并把标签改为外部单行、上移图心 |
| 点击 transcript 后右侧仍显示 gene header | 检查前端 `state.viewMode` 是否在 transcript click/search 命中时切换到 `'transcript'` |
| `./serve.sh start` 提示 gunicorn 找不到 | venv 没建好或没装依赖，重跑 `./migrate.sh setup` |
| 明明改了静态资源但刷新还是旧版本 | 实际服务可能是 gunicorn；仅重启 `python app.py` 不会替换在线进程。请执行 `./serve.sh restart` 并确认 `?v=` 版本变化 |
| 浏览器访问 `localhost:5000` 不通但 SSH 已连 | 检查 `ssh -N -L 5000:127.0.0.1:5000` 命令是否还在运行；`./serve.sh status` 确认服务在 |
| 表格 / 图表打不开 | F12 看 Network；通常是某个 `/api/*` 返回 500，看 `perv.log` 错误堆栈 |
| 重新打包发现 tar.gz 太大 | 检查是否漏排除 `.venv/` 或 `genome.ref.guochao/`；migrate.sh 已默认排除 |

---

## 12. 历史里程碑

| 日期 | 内容 |
|---|---|
| 2026-04-26 上午 | 初始化项目骨架，板块一/二落地，1165 条元数据 + 139 条注释序列双语浏览 |
| 2026-04-26 下午 | 增加 `serve.sh`、`migrate.sh`、SSH 隧道访问方案、迁移文档 |
| 2026-04-26 晚上 | 集成 Sus scrofa 11.1 基因组并上线板块三基因组浏览器（igv.js）；修复初始版 igv 自定义轨道 API 错误（`getFeatures` → `source.url` 模板）|
| 2026-04-27 晚间 | 参考数据切换到 `genome.ref.guochao`（Ensembl 108 GTF + `chr` 前缀染色体命名），并同步修正主染色体排序为 `chr1-18, chrX, chrY, chrM` |
| 2026-04-26 深夜 | UI/UX 升级：近全屏布局、首页视觉重构；Genome Browser 新增可变剪切转录本对比、feature 点击详情（gene/transcript/exon-N-of-M）与新结构化 API（`/api/genome/gene/*`、`/api/genome/transcript/*`） |
| 2026-04-26 深夜（续） | Genome Browser 增强：搜索扩展到 `gene_name/gene_id/transcript_id`；IGV 修复 isoform 同名合并并支持 `EXPANDED/SQUISHED/COLLAPSED` 切换；补齐 GTF 第三列关键特征（含 `start_codon/stop_codon`）在细节视图中的可视化与定位 |
| 2026-04-27 凌晨 | Genome Browser 关键语义修复：切换为双轨道（`Genes` + `Transcripts`），主轨道改为静态 BED12；修复 BED name 含空格导致的“外显子结构丢失”问题；右侧详情新增 transcript 视图与返回 gene 交互 |
| 2026-04-27 凌晨（续） | 按用户要求改为“整轨统一调色”策略：`genome.bed`/`genome.genes.bed` 的 `itemRgb` 统一置 `0`，IGV 轨道调色板不再只部分生效 |
| 2026-04-27 凌晨（续2） | 新增链特异配色：Genome 工具栏支持按轨道设置 `+/-` 链颜色与联动（Link）开关；联动开保持整轨单色，联动关支持正负链分色 |
| 2026-04-27 深夜 | 多组学轨道已上线：`Multi-omics/*.bw` 支持 Tracks 抽屉分组勾选加载，现有轨道冻结置顶，多组学轨道滚动展示 |
| 2026-04-27 深夜（续） | 修复多组学信号随平移看似变化：默认改为 `Fixed` 纵轴（`autoscale=false`），并支持单轨 `Fixed/Auto` 切换 |
| 2026-04-27 深夜（续2） | 修复 Tracks 抽屉动态文案未接入 i18n（统一改为 `window.I18n`）；同时优化 Overview 环图标签防重叠策略（外部单行 + 自动避让） |
| 2026-04-29（续1） | Genome Browser 新增 `PERV` 轨道（`/genome/data/perv.bed`）与可折叠 PERV 序列导航面板；新增 `/api/genome/perv/list`，并修复 PERV 详情中 0-based/1-based 混用导致的 LTR 起点显示偏小问题 |
| 2026-04-29（续2） | Genome Browser 新增 `PERV Homologous` 抽屉（876 条同源记录）与 `Homologous Seq/Loci` 轨道；完成 locus 数值排序、同源数据预加载与失败重试、ECharts dispose 与动态高度、搜索下拉与字体排版优化、Genes 快捷模式与默认高度优化、IGV label Shadow DOM 样式注入与防闪烁、详情标题更新与默认配色调整 |
| 2026-04-29（续3） | 上线“多组学可视化下载”功能：新增 Download Viz Modal、`/api/download/resolve_region` + `/api/download/generate`、PDF/SVG/PNG 导出与多轨 ZIP 打包；后续按用户反馈优化了导出图比例、字号、注释轨密度与 ID 标签展示，并将导出配色对齐网页版轨道 |
| 2026-04-29（续4） | `ERV.type` 标签贯通到 PERV 详情与 Homologous 序列卡片（来自 `1165.intact.PERV.infomation.xlsx`）；修复 Homologous 抽屉 Sequences/Loci tab 切换失效（`hidden` 被 `display:flex` 覆盖） |
| 2026-04-29（续5） | Genome 工具栏新增 `Reset Tracks` 用于恢复被 Remove 的内置轨道；同步统一按钮文案与抽屉标题（`Multi-omics Tracks`、`PERV Homologous`），并补充 `Fixed` 纵轴语义说明 |
| 2026-04-29（续6） | Genome 文案与配色微调：`Isoforms` 标签统一为 `TRANSCRIPTS`（全大写）；Transcript 特征表将 `exon` 改为琥珀黄以提升与 `CDS` 的对比度 |
| 2026-04-29（续7） | Genome 默认轨道高度重设：`Genes=80`、`Homologous Seq=100`、`Homologous Loci=50`；并同步 `Reset Tracks` 内置轨道配置，避免恢复后回退旧高度 |

