# PERV Atlas — 输入文件参考规范

本文件用于定义每类输入数据的详细结构。在校验用户数据、或适配非标准数据布局时使用。

---

## 1. `full_fa` — 完整 PERV FASTA

标准 FASTA。每条序列 1 行头部（`>` 开头）+ 多行序列。换行宽度可变（推荐 60）。
头部可以有空格，但系统只取第一个空白分隔 token 作为 ID。

```
>BM8-51.378M
TGAAAGGATGAAAATGCAACCTGACTCTCCCAGAACCCAGGAAGTTAATAAGAAGCTCTA
AATGCCCTCGAATTCCAGACCCTGTTCCCTATAGGTAAAAGATCATACTTTTTGCTGTTT
...
```

- ID 集合应与 `meta_xlsx` 里的 `Sequence.ID` 一一对应。
- 该文件在板块一作为下载资源，不在请求时按区间读取。

---

## 2. `meta_xlsx` — PERV 元数据 Excel

标准 `.xlsx`。推荐布局如下：

| 行号 | 内容 |
|---|---|
| 1 | 自由文本标题（例如 ` All intact porcine endogenous retroviruses`） |
| 2 | 表头：11 列（见下） |
| 3..N | 数据行 |

必需表头（区分大小写，建议保持完全一致）：

| 列名 | 类型 | 用途 |
|---|---|---|
| `Sequence.ID` | string | 主键，关联 FASTA / BED |
| `Category` | string（如 `pass`） | 表格展示 |
| `Motif` | string | 表格展示 |
| `TSD` | string | 表格展示 |
| `Identity` | float | KPI / 直方图 |
| `TE_type` | string（如 `LTR`） | 表格展示 |
| `Insertion_Time` | int（年） | KPI / 直方图 |
| `Kimura.distance` | float | KPI / 直方图 |
| `ERV.type` | string（`γ.ERV` / `β.ERV`） | KPI / 饼图 / 标签颜色 |
| `Abbretiation` | string（品种缩写） | 柱状图 |
| `Group` | string（`Eastern` / `Western`） | KPI / 饼图 |

解析函数：`app.py` 中 `parse_xlsx()`。当前按“第 2 行是表头”写死。
若用户 xlsx 没有第 1 行标题（即第 1 行就是表头），需要把该函数里的
`rows[1]` 改为 `rows[0]`。

数值转换规则：`Identity`、`Kimura.distance` → float；`Insertion_Time` → int。
空值会变成 `None`，并在统计直方图时自动跳过。

---

## 3. `pass_fa` — 精注释子集 FASTA

格式与 `full_fa` 相同。系统首次启动会建立字节偏移索引，实现 O(1) 随机访问
（`build_fasta_offsets()` 写入 `data/seq_offsets.json`）。

- ID **必须是** `full_fa` 的子集。
- ID **必须等于** `orf_bed` 第一列与 `domain_bed` 第一列的并集。

---

## 4. `orf_bed`、`domain_bed` — 区间注释

均为 BED6（TAB 分隔，0-based 半开区间）。

```
seq_id<TAB>start<TAB>end<TAB>name<TAB>score<TAB>strand
BH6-165.009M	0	702	LTR	.	+
BH6-165.009M	1152	2727	GAG	.	+
BH6-165.009M	2874	6309	POL	.	+
```

- `score` 列未使用，填 `.` 即可。
- `strand` 可为 `+` 或 `-`。当前标准 PERV 数据基本都是 `+`；
  若为 `-`，翻译前会先做反向互补。

### `orf_bed` 的 `name` 允许值

`LTR`、`GAG`、`POL`、`ENV`。其中 LTR 为非编码区，在蛋白模式会自动过滤
（服务端 `/api/sequences/<sid>/all-protein` + 前端下拉双重过滤）。

### `domain_bed` 的 `name` 允许值

`GAG`、`AP`、`RT`、`RNaseH`、`INT`、`ENV`。这些都可以翻译成蛋白。

若用户引入了新 `name`，后端通常无需改；只需在
`static/js/browser.js` 的 `REGION_COLORS` 增加配色，保证前端显示友好。

---

## 5. `genome_fa` — 参考基因组 FASTA（可选，板块三）

标准 FASTA。每条序列内部的行宽应保持一致（Ensembl/NCBI 文件通常满足）。
头部第一个空白分隔 token 作为染色体名（例如
`>1 dna:primary_assembly ...` 会被识别为 `1`）。

`build_fai()` 会生成与 samtools 兼容的 `.fai`（5 列：name、length、
offset、line_bases、line_width），支持 O(1) 区间随机读取。

2.4 GB 这类体量是可行的。系统通过 Flask `send_file` + HTTP Range 按需读取，
并由 `.fai` 提供定位，不会整文件加载到内存。

---

## 6. `genome_gtf` — 基因组注释（可选，板块三）

标准 Ensembl 风格 GTF。必需列（TAB 分隔）：

```
seqname  source  feature  start  end  score  strand  frame  attributes
```

解析器只保留以下 `feature` 类型（其余会跳过）：

- `gene`, `transcript`, `exon`, `CDS`
- `five_prime_utr`, `three_prime_utr`, `start_codon`, `stop_codon`

推荐关键 `attributes`（每行 key/value，`;` 分隔，值带引号）：

| 属性 | 出现位置 | 用途 |
|---|---|---|
| `gene_id` | gene / transcript / exon / CDS | 分组、搜索 |
| `transcript_id` | transcript / exon / CDS | 按转录本分组轨道 |
| `gene_name` | gene / transcript（若存在） | 搜索、展示标签 |
| `gene_biotype` | gene | 元信息标签、筛选 |
| `transcript_biotype` | transcript | 元信息标签 |

其他属性会被保留但当前不使用。若大量条目缺少 `gene_name`，
搜索框仍可通过 `gene_id` 工作。

`build_gtf_sqlite()` 建索引后，主要按以下键查询：
- `(chrom, start, end)`：区间查询
- `gene_name`、`gene_id`、`transcript_id`：搜索

对哺乳动物基因组，生成的 `gtf.sqlite` 通常约 300 MB。

---

## 7. `multi_omics_bw` — 多组学 BigWig 轨道文件（可选，板块三扩展）

用于在 Genome Browser 中追加信号轨道。目录约定如下：

```text
Multi-omics/
├── ATAC-seq/*.bw
├── ChIP-seq/*.bw
├── RNA-seq/*.bw
├── WGBS/*.bw
└── Hi-C/*.bw   # 可为空
```

### 文件与命名要求

- 仅接收 `.bw`（BigWig）文件。
- 一级目录名即前端分类名（例如 `ATAC-seq`、`ChIP-seq`）。
- 二级为可勾选文件列表，文件名用于 track label（可去掉 `.bw` 后缀显示）。

### 染色体命名一致性（关键）

BigWig 中染色体名必须与参考 FASTA 完全一致。  
本项目当前使用 `chr` 前缀命名（如 `chr1 ... chr18, chrX, chrY, chrM`）。

- 若 BigWig 为无 `chr` 前缀命名（如 `1/2/X/MT`），IGV 无法自动别名映射，会出现空轨道。
- 需先离线转换并重建为命名一致的 `.bw` 再接入。

### 传输与访问要求

- 服务端应通过 `send_file(..., conditional=True)` 暴露 `.bw`，以支持 HTTP Range。
- `.bw` 文件通常较大，IGV 通过按需分块读取，不会整文件下载。

### 前端交互要求（实现口径）

1. 提供独立“Tracks”抽屉（可展开/收起）。
2. 支持按一级目录折叠浏览与多选勾选。
3. 新增轨道追加在已有基因组轨道后面。
4. 已有轨道（ruler/Genes/Transcripts）保持冻结置顶，仅多组学轨道区域滚动。

### 纵轴缩放策略（已采用）

- 默认 `Fixed`（`autoscale: false`）：平移时同一区域信号高度可比，不会因视窗变化重标尺。
- 可切换 `Auto`（`autoscale: true`）：按当前视窗自动重算 Y 轴，适合放大查看弱信号。
- 若用户反馈“同一区域平移后峰高变化”，优先检查是否启用了 `Auto`。

### i18n 接入注意事项（本次实战）

- 本项目 i18n 全局对象是 `window.I18n`（不是 `window.__pervI18n`）。
- 自定义脚本需要文案翻译时，优先调用 `window.I18n.t(key)`。
- 若按钮文案一直显示英文默认值，优先排查：
  1) 是否引用了错误的全局对象  
  2) `static/js/i18n.js` 中是否补充了对应 key  
  3) 是否监听 `i18nchange` 并重绘动态节点

### Overview 环图标签防重叠建议（ECharts）

对小扇区较多或长标签场景，建议统一采用：

- `avoidLabelOverlap: true`
- `label.position: 'outside'` + 单行 formatter（避免换行挤压）
- `labelLayout: { hideOverlap: true, moveOverlap: 'shiftY' }`
- 适当上移 `center`（给底部 legend 留空间）

---

## 7.1 `multiomics_viz_export` — 多组学可视化导出规范（2026-04 新增）

用于 Genome Browser 的“下载可视化”能力（PDF/SVG/PNG 导出）。

### 导出入口与依赖

- 前端入口：Genome 工具栏按钮 `下载可视化 / Download Viz`。
- 后端接口：
  - `GET /api/download/resolve_region`
  - `POST /api/download/generate`
- Python 依赖：`matplotlib` + `pyBigWig`。

### 区间选择输入（统一口径）

支持 7 种来源：

1. `gene`
2. `transcript`
3. `perv`
4. `homo_seq`
5. `homo_locus`
6. `custom`（`chrom/start/end`）
7. `position`（`chrom/pos/window`）

`resolve_region` 返回统一对象：

```json
{"chrom":"chr16","start":59570885,"end":59581646,"name":"RF16-59.575M","length":10762}
```

### 绘图风格与布局（实战口径）

为避免“图太方、太挤、字太小”，采用以下经验参数：

- 宽度按区间长度动态伸缩（长区间导出为横向长图）
- 注释轨按实际重叠行数自适应高度（不要固定高块）
- 字号统一抬高（标题/坐标/track label/feature label）
- 注释轨使用“展开堆叠”而非“单条大矩形”

### ID 保留与标签规则（关键）

- `Genes`：显示 gene ID（建议斜体）
- `Transcripts`：显示 transcript ID
- `PERV`：显示 PERV ID
- `Homologous Seq`：按实际命中条目逐条显示 ID（有多少条显示多少条）
- `Homologous Loci`：按 locus 逐条显示 ID

### 轨道颜色一致性（与网页版同步）

导出图默认颜色应与 `genome.js` 主配色保持一致：

- Genes: `#555555`
- Transcripts: `#b8860b`
- PERV: `#e05c2b`
- Homologous Seq: `#4a90e2`
- Homologous Loci: `#9b59b6`

多组学信号面建议使用页面主蓝色（如 `#2563eb`）保持一致视觉风格。

### 区间与性能约束

- 导出区间上限：10 Mb（超限返回 400）
- BigWig 采样建议：`bw.stats(..., nBins=1000~2000, type='mean')`
- `None` 值填 0，避免 matplotlib 绘制异常
- 多轨导出时：单轨单文件，多文件 ZIP 打包

### 部署/运维经验（高频坑）

1. 只改代码不重启 gunicorn，会导致前端已更新但后端接口仍旧逻辑。
2. 报错 `matplotlib is not installed` 时，先确认运行进程使用的是哪个 Python/venv。
3. 网络受限环境下 `pip install` 超时，可通过 `.pth` 将系统 site-packages 映射到 venv（需版本兼容）。

---

## 8. `perv_region` — PERV 基因组位点文件（Genome 扩展）

当需要在 `/genome` 中新增 PERV 专用注释轨道时，可使用：

- `Homologous/RF.intact.region`

格式（**不是 BED**）：

```text
chrom<TAB>start<TAB>end<TAB>name<TAB>score<TAB>strand
chrX    52459847    52468694    RFX-52.463M   .   +
```

其中 `start/end` 为 **1-based 闭区间**。

### 与 ORF/Domain BED 的坐标关系（关键）

`ORF.combine.HTML.bed` 与 `domin.combine.HTML.bed` 都是 BED6（0-based 半开区间），
其第 1 列为序列 ID（如 `RF3-51.114M`），坐标是该条提取序列的相对坐标。

需要先按 ID 匹配，再映射回参考基因组。

### 坐标换算口径（统一使用 BED 语义做中间计算）

1. `RF.intact.region` 转 BED：
   - `region_bed_start = region_start_1based - 1`
   - `region_bed_end = region_end_1based`
2. 相对 BED 坐标（`rel_start`, `rel_end`）转基因组绝对 BED 坐标：
   - `+` 链：`abs_start = region_bed_start + rel_start`，`abs_end = region_bed_start + rel_end`
   - `-` 链：`abs_start = region_bed_end - rel_end`，`abs_end = region_bed_end - rel_start`

### 前端展示口径（避免“LTR 比整段起点更靠前”）

若详情面板显示 **1-based 坐标**：

- `display_start = abs_start + 1`
- `display_end = abs_end`（数值可直接复用）

否则会出现 + 链序列中：
- 序列起点显示为 13836（1-based）
- LTR 起点显示为 13835（0-based）
这种看似“LTR 越界靠前”的错觉。

---

## 9. `homologous_xlsx` — 876 条同源定位结果（Genome 扩展）

当需要在 `/genome` 中新增 **PERV Homologous** 版块时，使用：

- `Homologous/final.Statistics.table.xlsx`

推荐列定义（按当前实现口径）：

| 列序号 | 含义 | 说明 |
|---|---|---|
| 1 | `seq_id` | 序列 ID（876 条） |
| 2 | `seq_start` | 序列在参考基因组上的起点（1-based） |
| 3 | `seq_end` | 序列在参考基因组上的终点（1-based） |
| 4 | `seq_strand` | `+/-` |
| 5 | `species` | 物种简称 |
| 6 | `seq_chrom` | 染色体（源文件可能无 `chr` 前缀） |
| 7 | `group` | 群体分类（3 组） |
| 8 | `locus_id` | 同源位点 ID（如 `Locus_12`） |
| 9 | `locus_label` | 位点标签（含 chr/start/end/strand 文本） |
| 10 | `locus_range` | 位点在基因组坐标（start/end，1-based） |

### 染色体命名标准化（关键）

若 `seq_chrom` / `locus_label` 内的染色体名无 `chr` 前缀，接入前必须补齐。  
否则 IGV 无法正确定位或显示轨道。

### `locus_id` 排序规则（关键）

不要按纯字符串排序（会出现 `Locus_1, Locus_10, Locus_2`）。  
应提取数值部分做数值排序（`1,2,3...`）。

### 与前端展示相关的经验口径

1. 坐标数字格式建议统一 `toLocaleString('en-US')`，避免逗号后出现空格。
2. 同源 drawer 需支持“点击空白处收起”，交互逻辑与 Tracks drawer 一致。
3. ECharts 图（locus 详情中的群体/物种分布）重复渲染前必须 `dispose()`，避免内存泄漏。
4. 物种柱状图高度应随 species 数动态增长（否则标签拥挤不可读）。
5. 同源数据首次加载失败时必须允许重试（`loading/loaded` 状态需分离）。
6. 若要在 Homologous `Sequences` 卡片显示类型标签，可直接复用 `meta_xlsx` 的 `ERV.type`：
   - 匹配键：`q_name`（`Homologous/final.Statistics.table.xlsx`）↔ `Sequence.ID`（`sequence/1165.intact.PERV.infomation.xlsx`）
   - 本项目实测可全量匹配（876/876），适合在 badge 行展示 `γ.ERV` / `β.ERV`。
7. 同源抽屉的 `Sequences/Loci` 切换若“点击无效且两块同时显示”，优先排查 `hidden` 属性是否被 CSS 覆盖：
   - 问题根因：`#homo-seq-view, #homo-locus-view { display:flex; }` 会覆盖原生 `hidden` 的 `display:none`
   - 修复方式：补充
     `#homo-seq-view[hidden], #homo-locus-view[hidden], #homo-detail-view[hidden] { display:none !important; }`
   - 该项为前端样式修复，无需重启后端服务。
8. 若同源物种仅显示简称（如 `KM`），可新增 `sequence/genome.information.xlsx`（第 1 列全名、第 2 列简称、第 3 列组装号/URL）作为映射源：
   - 后端建议启动时读取并缓存为 `abbr -> {full_name, assembly}`
   - 前端在 `Homologous` 的筛选下拉、详情面板、分布图 tooltip 中展示 `full_name + assembly`
   - 保持筛选值仍使用简称（避免破坏既有过滤逻辑）
9. 同源 `Species Distribution` 横向柱状图若出现“标签遮挡/柱子过长”，优先按 ECharts 参数修复：
   - `grid.containLabel: true`（避免 y 轴长标签被裁切）
   - `yAxis.axisLabel.width + overflow:'break'`（长标签自动换行）
   - 通过 `xAxis.max = maxV + max(0.5, maxV*0.5)` 预留右侧空白，避免柱子顶满整行
   - 保留 `barHeight` 随 species 数动态增长

### 轨道显示口径（Genome）

- `Homologous Seq` 建议默认 `EXPANDED`，可见每条序列 ID。
- `Homologous Loci` 建议与 Genes/Transcripts/PERV 统一字体大小。
- `visibilityWindow` 避免使用 `-1` 触发初始极端缩放，建议设置大窗口（如 `300000000`）。
- 若工具栏存在 `PERV Homologous` 按钮，文案建议与抽屉标题保持一致（避免按钮叫 `Homologous`、标题叫 `PERV Homologous` 的认知割裂）。
- 若需优化默认可读性，推荐初始高度：
  - `Genes`: `80`
  - `Homologous Seq`: `100`
  - `Homologous Loci`: `50`
  并确保 `Reset Tracks` 的内置轨道定义与初始化配置保持一致。

---

## ID 一致性约束

做数据校验时，至少检查以下条件（不满足要告警用户）：

1. `set(IDs(full_fa))` ⊇ `set(IDs(pass_fa))`
2. `set(IDs(pass_fa))` == `set(col1(orf_bed))` == `set(col1(domain_bed))`
3. `set(IDs(full_fa))` ≈ `set(meta_xlsx['Sequence.ID'])`（重叠率至少 95%）
4. 每条 BED 记录都满足：`0 <= start < end <= 对应 pass_fa 序列长度`

快速检查命令：

```bash
# 检查条件 (1) 和 (2)
grep '^>' "<full_fa>"  | awk '{print substr($1,2)}' | sort -u > /tmp/full.ids
grep '^>' "<pass_fa>"  | awk '{print substr($1,2)}' | sort -u > /tmp/pass.ids
awk '{print $1}' "<orf_bed>"     | sort -u > /tmp/orf.ids
awk '{print $1}' "<domain_bed>"  | sort -u > /tmp/dom.ids

comm -23 /tmp/pass.ids /tmp/full.ids   # 应为空
comm -23 /tmp/orf.ids  /tmp/pass.ids   # 应为空
diff /tmp/orf.ids /tmp/dom.ids         # 应无差异
```

若这些检查失败，对应 ID 在页面中通常会表现为静默 404 或空结果。

---

## 10. `igv_builtin_tracks` — 内置轨道恢复与纵轴口径（2026-04 新增）

### A) 内置轨道被用户 `Remove track` 后的恢复策略

Genome 页当前内置轨道通常包括：

- `Genes`
- `Transcripts`
- `PERV`
- `Homologous Seq`
- `Homologous Loci`

若用户在 IGV 原生菜单中删除了这些轨道，建议提供工具栏按钮（例如 `Reset Tracks`）执行“缺失检测 + 按需恢复”。

实现口径：

1. 维护内置轨道定义列表（与 `igv.createBrowser` 初始配置保持一致）。
2. 读取 `browser.trackViews`，同时按 `track.id` 和 `track.name` 检测已存在轨道。
3. 只对缺失轨道调用 `browser.loadTrack(...)`，不要整页刷新。
4. 恢复时沿用当前显示状态（如 transcript/gene displayMode），避免把用户视图重置回默认。

### B) `Fixed` 纵轴的真实语义（多组学 BigWig）

`autoscale: false` 的含义是“不随每次平移自动重算 Y 轴”，**不等于**“全程绝对固定 max 值”。

- 若要绝对固定，需要同时指定显式 `min/max`（例如 `min:0, max:5`）。
- 仅设置 `autoscale:false` 时，初始窗口会参与一次范围估计；后续看起来的峰形变化可能来自真实信号差异，而非每次重标尺。

### C) 详情表 feature 配色区分（Transcript 细节表）

当用户反馈 `exon` 与 `CDS` 颜色太接近时，优先保证“编码区 vs 非编码结构”一眼可区分。

推荐口径（本项目已验证）：

- `exon`：`#d97706`（琥珀黄）
- `CDS`：`#2563eb`（蓝）

这样在同一列表中可快速区分“外显子边界标签”与“CDS 片段”。

### D) 工具栏标签一致性

为降低认知负担，按钮文案应与对应面板标题一致：

- `Tracks` 按钮 → `Multi-omics Tracks`
- `Homologous` 按钮 → `PERV Homologous`
- `Isoforms` 段落标签 → `TRANSCRIPTS`（全大写）
