# PERV Atlas

完整 PERV 序列资源、功能注释与猪参考基因组浏览网站 / Browse intact PERV sequences, annotations, and the Sus scrofa reference genome.

- 板块一（`/overview`）：1165 条完整 PERV 元数据概览（1020 γ.ERV + 145 β.ERV）
- 板块二（`/browser`）：139 条精注释序列的 ORF / 结构域 track 浏览，支持 DNA / 蛋白翻译查看与下载
- 板块三（`/genome`）：Sus scrofa 11.1 + Ensembl 108 注释基因组浏览器，基于 igv.js，支持染色体导航 / 基因搜索 / GTF 轨道 / DNA 序列查看 / 区间导出 / 可变剪切转录本对比 / 外显子级详情

技术栈：Python 3 + Flask（后端）+ 原生 HTML/CSS/JS（前端）+ ECharts（图表）+ igv.js（基因组浏览器）。中英文双语界面。

## 最新界面与交互升级（2026-04）

- **近全屏布局**：整体内容区域显著扩宽，基因组页使用 full-width 双栏布局（左侧浏览、右侧详情）。
- **首页重设**：Hero 视觉层（渐变 + 动态 DNA SVG）、关键数字条、三模块高亮卡片、数据流程区，避免“纯文字 + 图片”。
- **Genome Browser 增强**：
  - 点击 gene / transcript / exon 后在右侧显示详细信息（所属 gene、所属 transcript、外显子序号 Exon N of M、坐标、长度、biotype 等）；
  - 同一基因全部 transcript 并列显示，实现可变剪切（alternative splicing）结构对比；
  - IGV 外壳与轨道样式皮肤化，视觉与站点主题统一；
- **多组学扩展（已实现）**：`Multi-omics/` 下 `.bw` 文件已按目录分组接入 Genome Browser，支持在 Tracks 抽屉中勾选加载。
- **PERV 基因组轨道（已实现）**：Genome 页新增 `PERV` 注释轨道与可折叠序列导航面板，支持点击条目快速定位并查看 region + 结构/功能注释。
- 支持轨道颜色控制：既可整轨单色，也可正负链分色（`+/- strand` + `联动（Link）`开关）。

### 本轮补充更新（2026-04-29，续1）

- 新增 `PERV Homologous` 模块（876 条同源定位结果）：
  - 右侧抽屉支持 `Sequence ID` 与 `Locus ID` 两种视图
  - 序列视图支持多条件筛选与关键字搜索
  - 点击条目可展示详情并联动 IGV 定位
- 新增同源轨道：`Homologous Seq`、`Homologous Loci`
- 修复并固化：
  - `locus_id` 数值排序（非字典序）
  - 同源数据预加载与失败重试
  - ECharts 实例释放（避免内存泄漏）
  - 物种分布图动态高度
  - 同源抽屉“点击空白关闭”交互
- 轨道视觉一致性优化：
  - Genes/Transcripts/PERV/Homologous 字体与行高策略统一
  - 新增 Genes 快捷显示模式按钮
  - 默认颜色调整为：Genes 灰色系、Transcripts 橄榄金系
- 详情面板标题更新为：`Gene / Transcript / PERV detail`

### 本轮补充更新（2026-04-29，续2）

- 新增 **多组学可视化下载（Download Viz）**：
  - 在 Genome 页面工具栏新增“下载可视化”按钮
  - 支持按 `gene/transcript/PERV/Homologous/自定义区间/单点窗口` 选择导出区域
  - 支持上下游延伸
  - 支持多条 BigWig 同时勾选（每条轨道单独成图，多文件自动 ZIP）
  - 支持叠加注释轨：Genes / Transcripts / PERV / Homologous Seq / Homologous Loci
  - 导出格式：默认 PDF，另支持 SVG / PNG
- 导出图渲染策略优化：
  - 长区间自动导出为横向长图（不再固定方图）
  - 字号整体增大
  - 注释轨道按 feature 堆叠行数动态收缩，避免“色块过粗”
  - 保留 feature ID（gene 斜体，transcript/PERV/homologous 保留原 ID）
  - 默认配色与网页版轨道一致

### 本轮补充更新（2026-04-29，续3）

- **ERV.type 标签贯通**（来自 `sequence/1165.intact.PERV.infomation.xlsx`）：
  - `PERV` 详情卡片：显示该序列的 `ERV.type`
  - `PERV Homologous` 序列列表：在每条序列 badge 行新增 `ERV.type` 标签
  - 匹配键统一使用序列 ID：`Sequence.ID` ↔ `name/q_name`
- **Homologous 抽屉 tab 切换修复**：
  - 修复“点击 `Sequences/Loci` 无切换、Loci 视图总在下方”的问题
  - 根因：`display:flex` 覆盖了 `hidden`
  - 处理：为 `#homo-seq-view/#homo-locus-view/#homo-detail-view` 增加 `[hidden] { display:none !important; }`

### 本轮补充更新（2026-04-29，续4）

- 新增 **Reset Tracks** 按钮（Genome 工具栏）：
  - 用于恢复用户在 IGV 中 `Remove track` 删除的内置轨道
  - 按 `track.id` + `track.name` 检测缺失项，仅恢复缺失轨道
  - 覆盖内置轨道：`Genes / Transcripts / PERV / Homologous Seq / Homologous Loci`
- 文案统一：
  - 工具栏按钮 `Tracks` 调整为 `Multi-omics Tracks`（与抽屉标题一致）
  - 工具栏按钮 `Homologous` 调整为 `PERV Homologous`（与抽屉标题一致）

### 本轮补充更新（2026-04-29，续5）

- Genome 工具栏标签细化：
  - `Isoforms` 调整为 `TRANSCRIPTS`（全大写）
- Transcript 细节表配色优化：
  - `exon` 由蓝紫改为琥珀黄 `#d97706`
  - `CDS` 保持蓝色 `#2563eb`
  - 目的：提升长列表中 exon/CDS 的视觉区分度

### 本轮补充更新（2026-04-29，续6）

- 物种标签增强（Overview + Genome/Homologous）：
  - 新增读取 `sequence/genome.information.xlsx`（全名/简称/组装号）
  - 在保持简称筛选兼容的前提下，展示全名与组装号（或来源链接）
- Homologous `Species Distribution` 图表可读性优化：
  - 修复长标签遮挡（左侧标签完整显示）
  - 调整数值轴留白，避免横向柱子“顶满太长”

### 本轮补充更新（2026-04-29，续7）

- Genome Browser 默认轨道高度重设：
  - `Genes = 80`
  - `Homologous Seq = 100`
  - `Homologous Loci = 50`
- 已同步 `Reset Tracks` 的内置轨道定义，确保恢复轨道时不会回退到旧高度。

### Genome 轨道与颜色策略（重要）

- IGV 使用双注释轨道：
  - `Genes`：`/genome/data/genome.genes.bed`（BED9，基因跨度总览）
  - `Transcripts`：`/genome/data/genome.bed`（BED12，可变剪切细节）
- 为避免“Set track color 只有部分生效”，两份 BED 的第 9 列 `itemRgb` 统一写 `0`（不写每条记录固定 RGB）。
- 工具栏“链颜色”支持：
  - `联动（Link）=开`：`altColor = color`（整轨单色）
  - `联动（Link）=关`：`+`/`-` 可分别设色（正负链分色）

## 目录结构

```
PERV.html/
├── app.py                       # Flask 应用 + API + PERV 数据预处理
├── genome.py                    # 基因组工具 (.fai 构建、SQLite GTF 索引、查询)
├── build_genome_index.py        # 一次性基因组索引构建脚本
├── serve.sh / migrate.sh        # 服务启停 / 项目迁移辅助脚本
├── requirements.txt
├── README.md
├── sequence/                    # PERV 原始数据
│   ├── my.final.fa                       # 1165 条完整序列
│   ├── pass.139.fa                       # 139 条精注释序列
│   ├── 1165.intact.PERV.infomation.xlsx  # 元数据
│   ├── ORF.combine.HTML.bed              # ORF 注释 (LTR/GAG/POL/ENV)
│   └── domin.combine.HTML.bed            # 结构域注释 (GAG/AP/RT/RNaseH/INT/ENV)
├── Homologous/
│   └── RF.intact.region                  # PERV 在参考基因组上的定位（47 条，非 BED）
├── genome.ref.guochao/          # 参考基因组原始文件 (大文件)
│   ├── Sus_scrofa.Sscrofa11.1.dna.toplevel.fa     # ~2.4 GB
│   └── Sus_scrofa.Sscrofa11.1.108.gtf             # ~508 MB
├── data/                        # 自动生成的索引
│   ├── meta_1165.json / orf_index.json / domain_index.json / seq_offsets.json
│   ├── genome.fa.fai            # FASTA 随机访问索引 (~30 KB)
│   ├── gtf.sqlite               # GTF 区间/基因查询索引 (~300 MB)
│   ├── genome.bed               # transcript 轨道 BED12
│   └── genome.genes.bed         # gene 轨道 BED9
│   └── perv.bed                 # PERV 轨道 BED6
├── templates/
│   ├── base.html / index.html / overview.html / browser.html / genome.html
└── static/
    ├── css/style.css
    └── js/{i18n.js, overview.js, browser.js, sequence.js, genome.js}
```

## 安装与启动

需要 Python 3.8+。

```bash
# 1. 创建并激活虚拟环境
python3 -m venv .venv
source .venv/bin/activate

# 2. 安装依赖
pip install -r requirements.txt
# 国内可使用镜像: pip install -i https://pypi.tuna.tsinghua.edu.cn/simple -r requirements.txt

# 3. 构建基因组索引（仅需一次，约 1 分钟）
#    要求 genome.ref.guochao/ 下放好 Sus_scrofa.Sscrofa11.1.dna.toplevel.fa 与 Sus_scrofa.Sscrofa11.1.108.gtf
python build_genome_index.py

# 4. 启动服务
./serve.sh start              # 后台 gunicorn (推荐)
# 或开发模式:
python -m flask --app app run --host 0.0.0.0 --port 5000
```

如果不需要基因组浏览板块（板块三），可以跳过第 3 步，前两个板块仍然可以正常使用，访问 `/genome` 时会显示提示让您去构建索引。

打开浏览器访问 `http://<server-ip>:5000/`。

## 生产部署

使用 gunicorn 直接监听公网端口（也可前置 nginx 反向代理）：

```bash
gunicorn -w 2 -b 0.0.0.0:5000 app:app
```

systemd 单元示例（`/etc/systemd/system/perv.service`，按需修改路径与用户）：

```ini
[Unit]
Description=PERV Atlas
After=network.target

[Service]
WorkingDirectory=/home/ug2243/workspace/PERV.html
ExecStart=/home/ug2243/workspace/PERV.html/.venv/bin/gunicorn -w 2 -b 0.0.0.0:5000 app:app
Restart=on-failure
User=ug2243

[Install]
WantedBy=multi-user.target
```

## 数据说明

- 元数据列：`Sequence.ID, Category, Motif, TSD, Identity, TE_type, Insertion_Time, Kimura.distance, ERV.type (γ.ERV / β.ERV), Abbretiation, Group (Eastern / Western)`
- BED 文件均为 6 列：`seq_id, start, end, name, score, strand`，坐标为 0-based 半开区间。
- `Homologous/RF.intact.region` **不是 BED**：其 `start/end` 为 1-based 闭区间（用于 Genome PERV 轨道源数据）。
- ORF 文件中的 `name` 取值：`LTR / GAG / POL / ENV`；其中 LTR 为非编码区，蛋白模式自动屏蔽。
- 结构域文件中的 `name` 取值：`GAG / AP / RT / RNaseH / INT / ENV`，全部可翻译。
- 启动时若 `data/*.json` 不存在或源文件较新，会自动重新构建索引。

## 主要 API

PERV 板块：

| Method | Path | 说明 |
| ---- | ---- | ---- |
| GET | `/api/overview/stats` | γ/β、Group、Abbretiation 计数；Identity / Insertion_Time / Kimura 直方图分桶 |
| GET | `/api/overview/table?q=&type=&group=&page=&size=` | 1165 条元数据分页查询 |
| GET | `/api/sequences/pass` | 139 条 ID + 长度 |
| GET | `/api/sequences/<sid>/regions?kind=orf\|domain` | 区间列表 + 序列长度 |
| GET | `/api/sequences/<sid>/dna?start=&end=&strand=&name=` | 区间 DNA + FASTA |
| GET | `/api/sequences/<sid>/protein?start=&end=&strand=&name=` | 标准遗传密码翻译后的蛋白 + FASTA |
| GET | `/api/sequences/<sid>/all-protein?kind=orf\|domain` | 该序列下所有可编码区间的多 FASTA（ORF 模式自动跳过 LTR） |
| GET | `/download/<filename>` | 受白名单限制的原始数据下载 |

基因组板块：

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
| GET | `/genome/data/perv.bed` | PERV BED6 静态轨道（固定显示在 Genes 下方） |
| GET | `/api/genome/perv/list` | 返回 PERV 列表（47 条）+ region + domain/ORF 注释（按 ID 匹配并映射回基因组） |
| GET | `/api/multiomics/index` | 返回 `Multi-omics` 一级目录与 `.bw` 文件清单（Tracks 抽屉数据源） |
| GET | `/multiomics/data/<category>/<filename>.bw` | BigWig 文件流式读取（HTTP Range） |
| GET | `/api/download/resolve_region` | 把不同来源的选择（gene/transcript/perv/homo/custom/position）解析成统一区间 |
| POST | `/api/download/generate` | 渲染并导出多组学可视化图（PDF/SVG/PNG；多轨时 ZIP） |

翻译规则：直接对所选区间的 DNA 按标准密码子表逐三个碱基翻译；非 ACGT 或末尾不足 3 bp 的位置以 `X` 表示；遇到终止子保留 `*` 标记，不截断（前端展示完整序列）。`-` 链区间会先取反向互补再翻译（当前 PERV 数据均为 `+` 链）。

基因组数据：
- 参考序列：Ensembl Sus scrofa 11.1 (`dna.toplevel.fa`)，1-based 坐标
- 注释：Ensembl release 108 GTF，原始坐标 1-based 闭区间；本系统在 igv.js 接口中按 igv 习惯转为 0-based 半开区间
- 索引由 `build_genome_index.py` 生成；数据更新后重跑该脚本即可，无需手动删除旧索引

## 多组学轨道（已实现）

当 `Multi-omics/` 中存在 `.bw` 文件时，将在 Genome 页面提供 `Tracks` 抽屉用于分组勾选加载：

- 一级目录作为数据类型（如 `ATAC-seq` / `ChIP-seq` / `RNA-seq` / `WGBS` / `Hi-C`）
- 展开目录后列出该目录全部 `.bw` 文件，用户可多选加载为新 track
- 新增多组学 track 追加在已有轨道之后
- 现有轨道（ruler/Genes/Transcripts）保持固定在上方，多组学 track 在下方滚动区展示
- 每个轨道支持 `Fixed/Auto` 纵轴切换（默认 `Fixed`，保证平移时同一区域信号可比）

目录建议：

```text
Multi-omics/
├── ATAC-seq/*.bw
├── ChIP-seq/*.bw
├── RNA-seq/*.bw
├── WGBS/*.bw
└── Hi-C/*.bw
```

注意：BigWig 染色体命名必须与参考基因组一致（当前是 `chr` 前缀体系），否则会出现轨道无信号的情况。

## 多组学可视化下载（新）

在 `/genome` 页面工具栏点击 **下载可视化（Download Viz）**：

1. 选择区间来源（gene/transcript/perv/homo/custom/position）
2. （可选）设置上下游延伸
3. 勾选要导出的多组学 `.bw` 轨道
4. （可选）勾选注释轨叠加
5. 选择格式（PDF/SVG/PNG）并下载

输出规则：
- 单个轨道：直接下载单文件
- 多个轨道：自动打包 ZIP

限制：
- 导出区间最大 10 Mb（超限会返回 400）

## 常见问题（Genome 颜色）

- **Q: 为什么改了 IGV track color，只有部分 feature 变色？**  
  A: 一般是 BED 第 9 列 `itemRgb` 写了每条记录固定颜色。当前实现已统一写 `0`。若仍异常，请重启服务并硬刷新。

- **Q: Download Viz 弹窗提示 `matplotlib is not installed`？**  
  A: 说明依赖没有安装在 gunicorn 实际运行的 Python 环境中。请在项目 venv 安装：
  `pip install matplotlib pyBigWig`，然后重启服务（`./serve.sh restart`）。

- **Q: 能否给正链和负链设置不同颜色？**  
  A: 可以。在 Genome 工具栏关闭“联动（Link）”后，分别调整 `+` 与 `-` 颜色即可。

- **Q: 为什么同一个区域，平移后多组学峰高看起来变了？**  
  A: 常见有两种情况：  
  1) 若处于 `Auto`，这是动态重标尺导致的视觉差异；  
  2) 即使是 `Fixed`（`autoscale:false`），也不代表强制固定 max；它仅关闭“随 pan 自动重标尺”。  
  若需要绝对固定比例，请为轨道显式设置 `min/max`。

- **Q: 用户误删了 Genes/Transcripts/PERV 等内置轨道，怎么加回？**  
  A: 使用 Genome 工具栏的 `Reset Tracks`。它会自动检测缺失内置轨道并按需恢复，无需整页刷新。

- **Q: 我把轨道默认高度改了，为什么点 `Reset Tracks` 后又变回去了？**  
  A: 需要同时修改两处配置：初始化 `igv.createBrowser` 的 tracks 和 `Reset Tracks` 里的 `BUILTIN_TRACKS`。如果只改一处，恢复轨道时会回到旧高度。

- **Q: 为什么 transcript 明细里 exon 和 CDS 看起来太像？**  
  A: 两者若都用蓝紫系会降低可读性。当前建议使用高对比配色：`exon=#d97706`（琥珀黄）、`CDS=#2563eb`（蓝）。

- **Q: 为什么 PERV 详情里 LTR 的 Start 会比整条 PERV 的 Start 更小？**  
  A: 这是 0-based / 1-based 展示混用导致。`/api/genome/perv/list` 的注释坐标内部按 BED 语义（0-based）计算；若详情要显示 1-based，需要把注释 `start + 1` 后再显示，`end` 保持不变。

- **Q: 为什么 Tracks 抽屉中的 `Fixed/Auto` 没有随语言切换？**  
  A: 动态节点没有接入项目 i18n 对象。请确认脚本使用 `window.I18n.t(...)`，并在 `i18nchange` 事件后重绘抽屉内容。

- **Q: Overview 页面环图标签重叠怎么办？**  
  A: 在 `static/js/overview.js` 启用标签避让并优化布局：`avoidLabelOverlap`、`labelLayout.hideOverlap/moveOverlap`、外部单行标签，以及将图心上移以给底部 legend 留空间。

- **Q: Homologous 的 Species Distribution 左侧标签被挡住，怎么修？**  
  A: 在 ECharts 开启 `grid.containLabel`，并为 `yAxis.axisLabel` 设置宽度 + 自动换行（如 `overflow:'break'`），不要只靠减小字体。

- **Q: Species Distribution 柱子太长、全部顶到最右边怎么办？**  
  A: 给 `xAxis.max` 增加动态留白（如 `maxV + max(0.5, maxV*0.5)`）。这样在计数都很小（常见全是 1）时，柱子不会横向拉满整行。

- **Q: 我改了 IGV 左侧标签样式，但页面完全没变化？**  
  A: igv.js v3 运行在 Shadow DOM 内，外部 CSS 不能直接覆盖内部节点。请在 `igv.createBrowser` 成功后向 `#igv-container.shadowRoot` 注入 `<style>`。

- **Q: 刷新时先看到旧样式，再瞬间变成新样式？**  
  A: 这是样式延迟注入导致的 FOSC。不要 `setTimeout` 延迟注入，应在 browser 创建后立即注入 shadow-root 样式。

- **Q: 我已经改了文件，但页面一直还是旧的？**  
  A: 先确认在线进程是 gunicorn 还是 `python app.py`。本项目通常用 `./serve.sh` 管理，建议执行 `./serve.sh restart` 并确认静态资源版本参数 `?v=` 已变化。

- **Q: Homologous 抽屉里点击 `Sequences/Loci` 没切换怎么办？**  
  A: 高概率是样式覆盖了 `hidden`。检查是否存在 `#homo-seq-view/#homo-locus-view { display:flex }`，并补充：
  `#homo-seq-view[hidden], #homo-locus-view[hidden], #homo-detail-view[hidden] { display:none !important; }`。

## License

数据版权归原作者所有，本仓库的网站代码以 MIT 许可证发布（如需）。
