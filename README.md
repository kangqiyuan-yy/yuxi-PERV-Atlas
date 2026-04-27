# PERV Atlas 使用与部署说明

**PERV Atlas** 是猪内源性逆转录病毒（PERV）与相关多组学数据的在线浏览平台。您可在浏览器中查看统计图表、序列注释、参考基因组定位、多组学信号，并按需下载原始数据或导出当前查看结果。

- **开发单位**：中国科学院昆明动物研究所  
- **数据提供者与数据库开发者**：[yuankangqi@mail.kiz.ac.cn](mailto:yuankangqi@mail.kiz.ac.cn)  
- **界面语言**：中文 / English（页面右上角 **「中文」** / **「EN」** 切换）

---

## 平台概览

顶部导航对应五个功能页面；首页另含多组学数据图谱专区。

| 页面 | 地址 | 用途 |
|------|------|------|
| **首页** | `/` | 平台简介、核心数据量、模块入口、**试一试**快捷链接、多组学样本图谱 |
| **概览** | `/overview` | 1,165 条完整 PERV 的统计图与元数据表 |
| **序列 Browser** | `/browser` | 139 条精注释序列的 ORF / 结构域浏览与序列导出 |
| **基因组浏览器** | `/genome` | 猪参考基因组 + 基因注释 + PERV / 同源定位 + 多组学轨道 |
| **BLAST** | `/blast` | 对 PERV 核酸库 / 蛋白库进行序列相似性搜索 |

技术栈：Python 3.8+ · Flask · 原生 HTML/CSS/JS · ECharts · igv.js ·（可选）NCBI BLAST+ · pyGenomeTracks。

---

## 数据内容总览

所有数据路径均相对于**项目根目录**（与 `app.py` 同级），由程序在启动时解析，**不依赖**写死在代码里的服务器绝对路径（如 `/data_group/...`）。迁移时只要保持目录结构，把整个项目文件夹放到新机器即可。

| 目录 / 文件 | 说明 | 规模（参考） |
|-------------|------|----------------|
| `sequence/my.final.fa` | 1,165 条完整 intact PERV 序列 | 与条数相关 |
| `sequence/1165.intact.PERV.infomation.xlsx` | 元数据（ERV.type、Group、品种等） | — |
| `sequence/pass.139.fa` | 139 条精注释序列 | — |
| `sequence/ORF.combine.HTML.bed` | ORF 注释（0-based BED6） | — |
| `sequence/domin.combine.HTML.bed` | 结构域注释（0-based BED6） | — |
| `sequence/genome.information.xlsx` | 物种全名 / 简称 / 组装号（同源与概览展示） | — |
| `Homologous/RF.intact.region` | 47 条 PERV 在参考基因组上的定位（**1-based 闭区间，非 BED**） | — |
| `Homologous/final.Statistics.table.xlsx` | 876 条同源序列统计表 | — |
| `genome.ref.guochao/` | 参考 FASTA + GTF（Sus scrofa 11.1 / Ensembl 108） | FASTA ≈ 2.4 GB，GTF ≈ 500 MB |
| `data/` | 启动时生成的 JSON / SQLite / BED 索引（可重建） | 数百 MB 级 |
| `new.Multi-omics/` | 多组学 BigWig（`.bw`）及样本元数据 | **完整部署约 TB 级**（视文件数量） |
| `genome.ref/` | 历史目录，**可忽略**；代码仅使用 `genome.ref.guochao/` | — |

**坐标习惯**：序列 Browser 的 BED 与导出为常规生物信息学格式；基因组浏览器内 IGV 为 0-based，详情面板中标注 **1-based** 的坐标已做显示换算。`RF.intact.region` 源文件为 1-based，服务端转换为 BED 供 IGV 使用。

---

## 首页（`/`）

### 能做什么

- 查看平台简介与核心数据量（完整 PERV、γ/β 分型、精注释条数、同源定位等）。
- 通过模块卡片进入各功能页。
- **试一试（Try）**：首页 Hero 区提供一组快捷药丸按钮，由服务端根据当前数据自动生成，典型包括：
  - 跳转 **序列 Browser** 并预选一条 `pass.139` 序列 ID；
  - 跳转 **基因组浏览器** 到示例基因、基因组区间、PERV 条目或同源 Locus；
  - 跳转基因组并预加载一组推荐多组学 BigWig 轨道（如肝脏相关样本）。
- **多组学数据图谱**：点击猪体示意图旁的组织 / 细胞系，查看该样本下的多组学文件统计；支持轮播与全局概览图表。

### 能下载什么

首页不提供数据文件下载；下载请进入各功能页面。

---

## 模块一 · PERV 序列概览（`/overview`）

### 数据内容

- **1,165** 条完整 intact PERV（**1,020** 条 γ.ERV、**145** 条 β.ERV）。
- 元数据字段包括：`Sequence.ID`、`ERV.type`、`Group`（Eastern / Western / Wild）、`Abbretiation`、`Category`、`TE_type`、`Identity`、`Insertion_Time`、`Kimura.distance`、`Motif`、`TSD` 等。

### 交互功能

1. **统计图表**（6 张，ECharts 可交互）：γ/β 比例、Group、品种、Identity、Insertion_Time、Kimura 距离分布。  
2. **元数据表**：按 `Sequence.ID` 搜索；按 `ERV.type`、`Group` 筛选；分页浏览。

### 可下载（页面底部「数据下载」）

| 文件 | 格式 | 说明 |
|------|------|------|
| `my.final.fa` | FASTA | 全部 1,165 条 |
| `1165.intact.PERV.infomation.xlsx` | Excel | 元数据表 |

---

## 模块二 · 结构和功能注释序列浏览（`/browser`）

### 数据内容

- **139** 条 ORF / 结构域注释序列（`pass.139.fa`）。
- **ORF**：LTR、GAG、POL、ENV（LTR 为非编码区）。
- **结构域**：GAG、AP、RT、RNaseH、INT、ENV。

### 交互功能

1. 左侧列表选择或搜索序列 ID。  
2. 轨道视图切换 **ORF** / **结构域**；点击彩色区间载入序列。  
3. **DNA** / **蛋白** 显示（标准遗传密码；负链自动反向互补；LTR 无蛋白）。  
4. **复制**、**在整条序列中高亮** 当前区间。

### 可下载

**A. 页面顶部原始文件**

| 文件 | 说明 |
|------|------|
| `pass.139.fa` | 139 条序列全集 |
| `ORF.combine.HTML.bed` | ORF 区间（0-based） |
| `domin.combine.HTML.bed` | 结构域区间 |

**B. 工具栏即时导出**

| 操作 | 结果 |
|------|------|
| 下载 FASTA | 当前 DNA 或蛋白区间 |
| 导出全部蛋白 (FASTA) | 该序列所有可翻译区间（ORF 模式跳过 LTR） |

---

## 模块三 · 猪参考基因组浏览器（`/genome`）

> 若 `data/gtf.sqlite` 与 `data/genome.fa.fai` 尚未构建，页面会提示需运行 `build_genome_index.py`；模块一、二仍可正常使用。

### 数据与轨道

- **参考基因组**：*Sus scrofa* 11.1（Ensembl DNA toplevel）。  
- **基因注释**：Ensembl 108 GTF → `Genes` / `Transcripts` 轨道。  
- **PERV 基因组定位**：**47** 条（`PERV` 轨道 + 「PERV 序列」列表面板）。  
- **多品种同源**：**876** 条序列、**188** 个 locus（`PERV 同源序列` 抽屉 + `Homologous Seq` / `Homologous Loci` 轨道）。  
- **多组学**：`new.Multi-omics/` 下 BigWig，通过 **Multi-omics Tracks** 抽屉勾选加载（不提供整目录打包下载）。

### 交互功能

- **区间**：选染色体、输入起止坐标、**跳转**。  
- **搜索**：`gene_name` / `gene_id` / `transcript_id` 自动补全。  
- **IGV**：缩放平移；`Genes` / `TRANSCRIPTS` 的 Expanded / Squished / Collapsed；多转录本分行对比可变剪切。  
- **右侧详情**：基因 / 转录本 / 外显子 / PERV / 同源详情（含 **ERV.type** 标签）。  
- **Multi-omics Tracks**：按类别勾选 `.bw`；单轨 **Fixed / Auto** 纵轴；**清除多组学**、**恢复轨道（Reset Tracks）**、链颜色与 **联动（Link）**。  
- **导出 DNA / 导出 GTF**：当前视窗区间。  
- **下载可视化**：见下文。

### 可下载

| 来源 | 内容 |
|------|------|
| 页面右上角 | 参考 FASTA（约 2.4 GB）+ `.fai` |
| 工具栏 | 当前视窗 DNA（FASTA）、GTF 子集 |
| 下载可视化 | PDF / SVG / PNG / ZIP / pyGenomeTracks 图像与 `.ini`（区间 ≤ 10 Mb） |

**下载可视化**步骤概要：

1. 选择区间来源（基因 / 转录本 / PERV / 同源序列 / 同源位点 / 自定义坐标 / 单点 ± 窗口）。  
2. （可选）上下游延伸。  
3. 勾选 BigWig 轨道。  
4. 渲染方式：**pyGenomeTracks（推荐）** 多轨合成一张图；或 **matplotlib** 每轨一图（可叠注释轨，多文件 ZIP）。  

同源汇总 Excel、各 BED 轨道、原始 `.bw` 需通过其它渠道获取；详情面板内容可复制，无单独表格导出按钮。

---

## 模块四 · 首页「多组学数据图谱」

- 展示 `new.Multi-omics/` 收录规模：文件数、样本、发育时期、组织 / 细胞系、测序类型（ATAC-seq、ChIP-seq、RNA-seq、WGBS 等）。  
- 与基因组页 **Multi-omics Tracks** 共用同一数据；首页看统计，基因组页加载轨道或 **下载可视化**。  
- 本区无文件下载入口。

---

## 模块五 · BLAST 序列搜索（`/blast`）

### 数据内容（服务端库）

应用启动时会尝试用 `makeblastdb` 构建（缓存于 `data/blast_db/`）：

| 数据库键 | 内容 |
|----------|------|
| `perv_nt` | 1,165 条完整 PERV 核酸（`sequence/my.final.fa`） |
| `perv_protein` | 由 139 条序列 ORF 区间翻译得到的蛋白库 |

### 交互功能

1. 粘贴 **FASTA** 或裸序列。  
2. 选择程序：**blastn**（核酸→核酸）、**blastp**（蛋白→蛋白）、**tblastn**（蛋白→核酸库翻译搜索）。  
3. 设置 **E-value**、**最大命中数**（1–250）。  
4. 提交后异步运行，页面轮询任务状态并展示命中表（序列 ID、得分、E-value、比对区间等）。  
5. **加载示例** 可填入演示序列。

### 依赖说明

BLAST 依赖 **NCBI BLAST+** 可执行文件（见下文「外部生物信息软件」）。若目标机未安装或路径未配置，提交任务会失败；模块一–三不受影响。

---

## 下载能力一览

| 位置 | 可下载类型 |
|------|------------|
| 概览 `/overview` | 1165 FASTA、元数据 xlsx |
| 序列 `/browser` | 139 FASTA、ORF/结构域 BED；当前区间 DNA/蛋白；单序列全部蛋白 |
| 基因组 `/genome` | 参考 FASTA + fai；视窗 DNA/GTF；多组学可视化图 |
| BLAST `/blast` | （无文件下载；结果页内展示） |
| 首页多组学图谱 | （无文件下载） |

---

## 使用提示

1. **蛋白翻译**：标准遗传密码；终止子保留为 `*`；不自动校正读码框。  
2. **多组学无信号**：检查 BigWig 染色体命名是否与参考基因组一致（`chr1`–`chr18`、`chrX`、`chrY`、`chrM`）。  
3. **大基因组文件**：优先浏览器内小范围浏览，避免频繁下载全 FASTA。  
4. **服务重启**：生产环境请用 `./serve.sh restart`，不要只杀 `python app.py`（实际进程为 gunicorn）。  
5. **语言切换**：部分动态按钮在切换语言后需重新打开抽屉或刷新页面。

---

## 主要 API

### 页面路由

| Method | Path | 说明 |
|--------|------|------|
| GET | `/` | 首页 |
| GET | `/overview` | PERV 概览 |
| GET | `/browser` | 序列 Browser |
| GET | `/genome` | 基因组浏览器 |
| GET | `/blast` | BLAST 搜索 |

### 首页

| Method | Path | 说明 |
|--------|------|------|
| GET | `/api/home/try_examples` | 首页「试一试」药丸链接（JSON，缓存 24h） |

### PERV 概览与序列

| Method | Path | 说明 |
|--------|------|------|
| GET | `/api/overview/stats` | 统计图数据 |
| GET | `/api/overview/table` | 元数据分页（`q`, `type`, `group`, `page`, `size`） |
| GET | `/api/genome/genome_info` | 物种简称 / 全名 / 组装号映射 |
| GET | `/api/sequences/pass` | 139 条 ID 列表 |
| GET | `/api/sequences/pass/stats` | 139 条汇总统计 |
| GET | `/api/sequences/<sid>/regions` | ORF/结构域区间（`kind=orf\|domain`） |
| GET | `/api/sequences/<sid>/dna` | 区间 DNA + FASTA |
| GET | `/api/sequences/<sid>/protein` | 区间蛋白 + FASTA |
| GET | `/api/sequences/<sid>/all-protein` | 全部可翻译区间蛋白 |
| GET | `/api/sequences/<sid>/all-dna` | 全部区间 DNA |
| GET | `/download/<filename>` | 白名单原始文件下载 |

### 基因组

| Method | Path | 说明 |
|--------|------|------|
| GET | `/api/genome/status` | 索引是否就绪 |
| GET | `/api/genome/chromosomes` | 染色体列表与长度 |
| GET | `/api/genome/sequence` | 区间 DNA（≤ 1 Mb） |
| GET | `/api/genome/features` | GTF 区间内 feature 列表 |
| GET | `/api/genome/search` | 基因名 / gene_id / transcript_id 搜索 |
| GET | `/api/genome/gene/<gene_id>` | 基因及全部转录本结构 |
| GET | `/api/genome/transcript/<transcript_id>` | 单转录本结构 |
| GET | `/api/genome/region/dna` | 区间 DNA 下载 |
| GET | `/api/genome/region/gtf` | 区间 GTF 下载 |
| GET | `/api/genome/perv/list` | 47 条 PERV + domain/ORF 注释 |
| GET | `/api/genome/homologous/list` | 同源序列列表 |
| GET | `/api/genome/homologous/loci` | 同源 locus 列表 |
| GET | `/genome/data/genome.fa` | 参考 FASTA（支持 Range） |
| GET | `/genome/data/genome.fa.fai` | FASTA 索引 |
| GET | `/genome/data/genome.bed` | Transcripts BED12 |
| GET | `/genome/data/genome.genes.bed` | Genes BED9 |
| GET | `/genome/data/perv.bed` | PERV BED6 |
| GET | `/genome/data/homologous_seq.bed` | 同源序列 BED |
| GET | `/genome/data/homologous_locus.bed` | 同源 locus BED |
| GET | `/api/genome/igv` | 旧版 JSON 轨道（兼容保留） |
| GET | `/api/genome/igv.bed` | 旧版 BED 接口（兼容保留） |

### 多组学

| Method | Path | 说明 |
|--------|------|------|
| GET | `/api/multiomics/index` | `new.Multi-omics/` 目录树 |
| GET | `/api/multiomics/recommended` | 推荐样本分组 |
| GET | `/api/multiomics/summary` | 首页图谱统计 |
| GET | `/multiomics/data/<category>/<path:filename>` | BigWig 流式读取（HTTP Range） |

### 可视化导出

| Method | Path | 说明 |
|--------|------|------|
| GET | `/api/download/resolve_region` | 将 gene/transcript/perv/homo/custom/position 解析为统一区间 |
| POST | `/api/download/generate` | matplotlib 渲染（PDF/SVG/PNG，多轨 ZIP） |
| GET | `/api/pygt/categories` | pyGenomeTracks 可用类别 |
| POST | `/api/pygt/submit` | 提交 pyGenomeTracks 任务 |
| GET | `/api/pygt/status/<job_id>` | 任务状态 |
| GET | `/api/pygt/result/<job_id>` | 下载结果图 / ini |

### BLAST

| Method | Path | 说明 |
|--------|------|------|
| GET | `/api/blast/dbs` | 程序、数据库及就绪状态 |
| POST | `/api/blast/submit` | 提交 BLAST 任务 |
| GET | `/api/blast/status/<job_id>` | 任务状态 |
| GET | `/api/blast/result/<job_id>` | JSON 结果 |

---

## 迁移到其它服务器

本节面向**完整部署**（含基因组浏览器、BLAST 与 `new.Multi-omics`）。若仅迁移代码与小数据，可跳过标注为「大文件」的步骤，但对应功能将不可用。

一句话结论：**代码与所有业务数据都用「相对项目根」的路径，整目录搬走即可运行；唯一写死绝对路径的是两个外部生物信息软件（BLAST+ 与 pyGenomeTracks），需在新机安装并用环境变量指向新路径。**

---

### 第〇步 · 目录与文件清单（每项存什么 / 是否必迁 / 能否再生）

> 「再生」= 缺失时能否由程序自动或用一条命令重建。为**尽量少重新生成**，本项目的迁移脚本会把 `data/` 索引一并打包（省去在新机重建 326 MB 的 `gtf.sqlite`）。

#### 根目录代码与脚本（全部必迁，体积极小）

| 路径 | 存什么 | 必迁 | 再生 |
|------|--------|------|------|
| `app.py` | Flask 主程序（所有页面/接口） | ✅ | 否（源码） |
| `genome.py` | 基因组索引查询逻辑 | ✅ | 否 |
| `build_genome_index.py` | 构建基因组索引的一次性脚本 | ✅ | 否 |
| `generate_and_plot.py` | **离线**出图脚本，不参与网站运行 | 可选 | 否 |
| `serve.sh` | gunicorn 启停 | ✅ | 否 |
| `migrate.sh` | venv 创建 / 依赖安装 / 打包 | ✅ | 否 |
| `pack_for_migration.sh` | 分卷打包脚本（本次新增） | ✅ | 否 |
| `requirements.txt` | pip 依赖清单 | ✅ | 否 |
| `README.md` | 本说明 | ✅ | 否 |

#### 数据目录

| 路径 | 存什么 | 必迁 | 再生 |
|------|--------|------|------|
| `sequence/` | PERV 原始数据：`my.final.fa`(10MB)、`pass.139.fa`、`*.bed`、`*.xlsx`、`ref.id` 等 | ✅ | 否（源数据，不可再生） |
| `Homologous/` | `RF.intact.region`、`final.Statistics.table.xlsx` | ✅ | 否（`*.bak.*` 备份可不迁） |
| `genome.ref.guochao/` | 参考基因组 `Sscrofa11.1` FASTA(2.5GB) + GTF(508MB) + `.fai` | ✅（基因组页需要） | 否（需从 Ensembl 重新下载） |
| `new.Multi-omics/` | 多组学 BigWig（ATAC 319G / ChIP 1.2T / RNA 18G / WGBS 154G）+ `*.sample.info`、`title.list` | ✅（多组学页需要） | 否（原始数据） |
| `new.Multi-omics/*.sample.info`、`title.list` | 样本元数据（首页图谱与推荐轨道） | ✅ | 否；但**很小**，即使不迁 BigWig 也建议迁这几个 |

#### 前后端资源

| 路径 | 存什么 | 必迁 | 再生 |
|------|--------|------|------|
| `templates/` | 5 个页面 HTML 模板 | ✅ | 否 |
| `static/css` `static/js` `static/img` | 样式 / 前端脚本 / 图片(logo、猪示意图 svg) | ✅ | 否 |
| `server/` | `blast_engine.py`、`pygt_engine.py`、`pygt_wrapper.py`（`__pycache__`、`*.pyc` 不迁） | ✅ | 否 |

#### `data/` 索引目录（约 335 MB，建议整体迁移以少重建）

| 路径 | 存什么 | 必迁 | 再生方式 |
|------|--------|------|----------|
| `data/gtf.sqlite`(326MB)、`genome.fa.fai`、`genome.bed`、`genome.genes.bed` | 基因组注释索引 | 建议迁 | `build_genome_index.py`（需 `genome.ref.guochao/`，1–2 分钟） |
| `data/pygenome_ref/`（`PERV.gtf`、`PERV_*.bed`） | pyGenomeTracks 用 PERV 轨道，**手工整理无生成脚本** | ✅ 必迁 | ⚠️ **不可自动再生** |
| `data/meta_1165.json`、`orf_index.json`、`domain_index.json`、`seq_offsets.json` | 序列/概览缓存 | 可不迁 | 启动时按源文件自动重建 |
| `data/perv.bed`、`homologous_seq.bed`、`homologous_locus.bed` | PERV/同源 BED | 可不迁 | 启动时按源文件自动重建 |
| `data/blast_db/` | BLAST 数据库 | 可不迁 | 首次启动 `makeblastdb` 自动建（需 BLAST+） |
| `data/gtf_diff_108_vs_115/` | 版本比对中间产物 | ❌ 不迁 | — |

#### **不需要迁移**的目录 / 文件

| 路径 | 原因 |
|------|------|
| `.venv/` | 虚拟环境，跨机不可用；新机 `./migrate.sh setup` 重建 |
| `genome.ref/`（旧，含 115 版 GTF/GFF，3.2GB） | 历史副本，代码只用 `genome.ref.guochao/` |
| `Multi-omics/`（旧，空壳） | 已被 `new.Multi-omics/` 取代 |
| `__pycache__/`、`*.pyc` | Python 字节码缓存，自动生成 |
| `perv.log`、`perv.log.*.gz`、`.perv.pid`、`nohup.out` | 运行时日志 / PID（`perv.log` 由 crontab 每日 3 点自动执行 `./serve.sh rotate-log` 轮转压缩，默认保留 7 天，可用 `PERV_LOG_RETAIN_DAYS` 调整） |
| `tmp/` | 运行时任务目录，自动创建 |
| `PLAN.md`、`README.backup.md`、根目录 `pig.svg`/`log*.png` | 草稿 / 重复资源（正式图在 `static/img/`） |
| `.git/`、`.cursor/`、`.vscode/` | 版本库 / 编辑器配置 |

---

### 第一步 · 新服务器需要的配置、环境与软件

先把目标机准备好，再拷数据，可避免返工。

#### 1.1 硬件 / 系统

| 项目 | 建议 | 说明 |
|------|------|------|
| 操作系统 | Linux（x86_64，CentOS 7+/Ubuntu 18.04+ 均可） | `serve.sh` / `migrate.sh` 为 bash 脚本 |
| 磁盘空间 | **≥ 2 TB**（完整部署） | `new.Multi-omics/` ≈ **1.7 TB**、`genome.ref.guochao/` ≈ **2.9 GB**、`data/` 索引 ≈ 350 MB、代码+小数据 < 30 MB |
| 内存 | ≥ 4 GB（推荐 8 GB+） | 基因组索引/BigWig Range 读取偏 I/O，内存不是瓶颈 |
| 磁盘类型 | SSD / 高 IOPS 共享盘更佳 | BigWig 随机读多，机械盘会明显变慢 |

> 仅迁移代码 + 概览/序列/BLAST 模块时，几百 MB 磁盘即可（不拷 `new.Multi-omics/` 与 `genome.ref.guochao/`）。

#### 1.2 必备软件（系统层）

| 软件 | 是否必需 | 用途 | 备注 |
|------|----------|------|------|
| **Python 3.8+** | 必需 | 后端运行 | Flask 3.x 要求 3.8+；系统自带 3.6 需另装（如 conda / 源码 / SCL） |
| `python3-venv` | 必需 | 创建 `.venv` | Debian/Ubuntu 需 `apt install python3-venv` |
| `bash` + `rsync` + `tar` | 必需 | 打包与大文件同步 | 迁移脚本依赖 |
| `curl` | 建议 | 冒烟测试 | — |
| **NCBI BLAST+** | 仅 BLAST 页需要 | `blastn/blastp/tblastn/makeblastdb` | 见「第四步」，`conda install -c bioconda blast` |
| **pyGenomeTracks** | 仅基因组页「下载可视化(pyGT 模式)」需要 | 多轨合成图 | `conda install -c bioconda pygenometracks`；缺失时可退化用 matplotlib 模式 |

> 不需要 root / systemd；`serve.sh` 以普通用户后台跑 gunicorn。对外访问用 SSH 端口映射或由管理员配 nginx（见文末「安装、启动与访问」）。

#### 1.3 Python pip 依赖（`requirements.txt`，由 `migrate.sh setup` 自动装）

| 包 | 用途 |
|----|------|
| Flask ≥ 3.0 | Web 框架 |
| openpyxl ≥ 3.1 | 读取 xlsx 元数据 |
| gunicorn ≥ 21.2 | 生产 WSGI（`serve.sh` 使用） |
| pyBigWig ≥ 0.3 | BigWig 读取与 matplotlib 导出 |
| matplotlib ≥ 3.7 | 多组学可视化导出（matplotlib 模式） |

---

### 第二步 · 路径策略：哪些是相对路径、哪些是绝对路径（重要）

这是判断能否「整目录搬走」的关键。

#### 2.1 相对路径（跟着项目走，无需任何修改）

所有**业务代码与数据**均以项目根为基准解析：`BASE_DIR = Path(__file__).resolve().parent`（见 `app.py`、`build_genome_index.py`、`server/blast_engine.py`、`server/pygt_engine.py`）。因此以下内容随目录整体移动即可，**不含任何机器绝对路径**：

| 相对基准 | 覆盖内容 |
|----------|----------|
| `BASE_DIR/sequence/` | `my.final.fa`、`pass.139.fa`、各 `.bed`、`.xlsx` 等原始数据 |
| `BASE_DIR/Homologous/` | `RF.intact.region`、`final.Statistics.table.xlsx` |
| `BASE_DIR/genome.ref.guochao/` | 参考 FASTA + GTF |
| `BASE_DIR/new.Multi-omics/` | 多组学 BigWig 与样本元数据 |
| `BASE_DIR/data/` | 启动/构建生成的索引：`genome.fa.fai`、`gtf.sqlite`、各 `.bed`、`blast_db/`、`pygenome_ref/` |
| `BASE_DIR/tmp/` | 运行时任务目录（BLAST / pyGT 作业，自动创建） |
| `templates/` `static/` `server/` | 页面模板、前端资源、后端模块 |

> 换句话说：项目文件夹改名、换机器、换挂载点都不影响这些路径。

#### 2.2 绝对路径（迁移后**必须**改，否则 BLAST / pyGT 页面报错）

只有**外部可执行程序**写了当前生产机的默认绝对路径，且都支持用环境变量覆盖：

| 组件 | 代码默认值（仅当前机器有效） | 覆盖用环境变量 | 定义位置 |
|------|------------------------------|----------------|----------|
| BLAST+ `blastn` | `/opt/service/miniconda3/envs/rex_env/bin/blastn` | `BLASTN_BIN` | `server/blast_engine.py` |
| BLAST+ `blastp` | `.../rex_env/bin/blastp` | `BLASTP_BIN` | `server/blast_engine.py` |
| BLAST+ `tblastn` | `.../rex_env/bin/tblastn` | `TBLASTN_BIN` | `server/blast_engine.py` |
| BLAST+ `makeblastdb` | `.../rex_env/bin/makeblastdb` | `MAKEBLASTDB_BIN` | `server/blast_engine.py` |
| pyGenomeTracks | `.../rex_env/bin/pyGenomeTracks` | `PYGENOMETRACKS_BIN` | `server/pygt_engine.py` |
| pyGT 包装脚本用 Python | `.../rex_env/bin/python` | `PYGT_PYTHON` | `server/pygt_engine.py` |

> 另有 `generate_and_plot.py` 顶部也写了 `pyGenomeTracks` 绝对路径，但它是**独立离线出图脚本**，不参与网站运行；若不用可忽略。

**结论**：迁移只做两件事 —— ① 复制整个项目目录（相对路径部分自动生效）；② 在新机安装 BLAST+/pyGenomeTracks 并用上表环境变量指向新路径（见第四步）。

---

### 第三步 · 源机器打包（供 FileZilla 手动传输）

用随项目提供的 **`pack_for_migration.sh`** 把「必迁」内容分成几个独立压缩包，放到 `migrate_dist/`，再用 FileZilla 传输。分卷是因为多组学有 1.7 TB，不宜打进一个包。

```bash
cd /path/to/PERV.html

# 1) 核心包：代码 + 小数据 + data/ 索引（含 gtf.sqlite/pygenome_ref），约 350 MB
#    带上索引 = 新机基本不用重建，符合「尽量少重新生成」
./pack_for_migration.sh core            # 生成 migrate_dist/perv-core.tar.gz

# 2) 参考基因组（基因组浏览器需要），约 2.9 GB
./pack_for_migration.sh genomeref       # 生成 migrate_dist/perv-genome-ref.tar.gz

# 3) 多组学 BigWig（多组学页需要），按类别分别打包，合计约 1.7 TB
./pack_for_migration.sh omics           # 生成 perv-omics-ATAC-seq.tar 等 4 个包
#    也可只打某一类别：./pack_for_migration.sh omics ChIP-seq

# 或一次全打：./pack_for_migration.sh all
```

- 打包完成后，`migrate_dist/MANIFEST.txt` 记录每个包的大小与 **sha256 校验值**，传输后可在新机核对完整性。
- BigWig 已是压缩格式，故 `omics` 包用 `tar`（不再 gzip），避免耗时且几乎无收益。
- 若**暂不迁多组学 / 基因组**，只传 `perv-core.tar.gz` 即可跑起概览、序列、BLAST 三个模块。

**FileZilla 传输**：连接新服务器（SFTP），把 `migrate_dist/` 下的 `.tar.gz` / `.tar` 包传到新机的目标父目录（例如 `/path/to/parent/`）。传大文件建议开启断点续传。

#### 3.x 新服务器：解压 + 装环境 + 启动

```bash
cd /path/to/parent/            # FileZilla 传入压缩包的目录

# 1) 解压核心包（会得到 PERV.html/ 目录）
tar xzf perv-core.tar.gz
cd PERV.html

# 2) 解压参考基因组与多组学到项目内（-C 指向项目根）
tar xzf   ../perv-genome-ref.tar.gz   -C .        # 得到 genome.ref.guochao/
for f in ../perv-omics-*.tar; do tar xf "$f" -C .; done   # 得到 new.Multi-omics/*/

# 3) 校验完整性（可选）
sha256sum -c <(grep '\.tar' ../migrate_dist/MANIFEST.txt | awk '{print $3"  "$1}') 2>/dev/null || true

# 4) 创建虚拟环境并安装 pip 依赖（失败自动切清华镜像）
./migrate.sh setup

# 5) 基因组索引：核心包已含 data/gtf.sqlite，通常无需重建；
#    仅当未迁 data/ 或更换了 GTF 时才执行（约 1–2 分钟）
# .venv/bin/python build_genome_index.py

# 6) 安装外部软件并指定绝对路径（见第四步），随后启动
./serve.sh start
./serve.sh status
```

> `migrate.sh setup` 等价于 `python3 -m venv .venv && .venv/bin/pip install -r requirements.txt`，并在默认源超时时自动重试清华镜像。`.venv/` 绝不能跨机拷贝，必须在新机重建。

---

### 第四步 · 安装外部软件并修改绝对路径

BLAST+ 与 pyGenomeTracks **不在** `requirements.txt` 中，需单独安装（推荐 conda）：

```bash
conda create -n perv_tools python=3.10 -y
conda activate perv_tools
conda install -c bioconda blast pygenometracks -y
echo "$CONDA_PREFIX/bin"      # 记下这个 bin 目录
```

然后在启动 gunicorn **之前**导出环境变量（建议写入项目根旁的 `env.sh`，由运维 `source env.sh` 后再 `./serve.sh restart`）：

```bash
BIN=$CONDA_PREFIX/bin          # 换成实际 bin 目录
export BLASTN_BIN=$BIN/blastn
export BLASTP_BIN=$BIN/blastp
export TBLASTN_BIN=$BIN/tblastn
export MAKEBLASTDB_BIN=$BIN/makeblastdb
export PYGENOMETRACKS_BIN=$BIN/pyGenomeTracks
export PYGT_PYTHON=$BIN/python
./serve.sh restart
```

- **BLAST**：首次启动自动调用 `makeblastdb` 生成 `data/blast_db/`，需保证 `sequence/my.final.fa` 存在。  
- **pyGenomeTracks**：仅影响基因组页「下载可视化」的 pyGT 模式；缺失时仍可用 **matplotlib 模式**（只依赖 pip 里的 matplotlib + pyBigWig）。  
- **基因组索引**：`build_genome_index.py` 为纯 Python 实现，构建 `.fai` 与 `gtf.sqlite` **不需要** samtools。

`genome.ref.guochao/` 中应包含（供 `build_genome_index.py` 读取）：

- `Sus_scrofa.Sscrofa11.1.dna.toplevel.fa`
- `Sus_scrofa.Sscrofa11.1.108.gtf`

生成物：`data/genome.fa.fai`、`data/gtf.sqlite`、`data/genome.bed`、`data/genome.genes.bed`、`data/perv.bed`、`data/homologous_*.bed` 等；PERV / 同源索引在应用启动时也会按需更新。强制重建：`.venv/bin/python build_genome_index.py --force`。

---

### 第五步 · 冒烟测试

```bash
./serve.sh status
curl -fsS -o /dev/null http://127.0.0.1:5000/
curl -fsS -o /dev/null http://127.0.0.1:5000/overview
curl -fsS -o /dev/null http://127.0.0.1:5000/browser
curl -fsS -o /dev/null http://127.0.0.1:5000/genome
curl -fsS -o /dev/null http://127.0.0.1:5000/blast
curl -fsS http://127.0.0.1:5000/api/genome/status | python3 -m json.tool   # 期望 ready=true
curl -fsS http://127.0.0.1:5000/api/blast/dbs      | python3 -m json.tool   # 期望各程序 available=true
```

失败时查看日志：`./serve.sh log`。常见问题：
- `/genome` 提示需构建索引 → 未执行 `build_genome_index.py` 或 `genome.ref.guochao/` 缺文件。  
- BLAST 页任务失败 → 未装 BLAST+ 或环境变量未生效（`echo $BLASTN_BIN` 确认后 `./serve.sh restart`）。  
- 多组学轨道无信号 → BigWig 染色体命名需与参考一致（`chr1`…`chr18`、`chrX/Y/M`）。

---

## 安装、启动与访问

### 本地 / 服务器启动

```bash
cd /path/to/PERV.html
./migrate.sh setup                              # 首次
.venv/bin/python build_genome_index.py          # 首次且需要基因组模块
./serve.sh start                                # 后台 gunicorn
./serve.sh status | ./serve.sh restart | ./serve.sh log
```

环境变量（可选）：

| 变量 | 默认 | 说明 |
|------|------|------|
| `PERV_HOST` | `127.0.0.1` | 监听地址；公网直连可设 `0.0.0.0` |
| `PERV_PORT` | `5000` | 端口 |
| `PERV_WORKERS` | `2` | gunicorn worker 数 |
| `PERV_THREADS` | `8` | 每 worker 线程数（BigWig Range 偏 I/O） |

开发调试（不推荐生产）：

```bash
.venv/bin/python -m flask --app app run --host 127.0.0.1 --port 5000
```

### 方式一：SSH 本地端口映射（推荐）

服务默认只监听 `127.0.0.1:5000`。在**您自己的电脑**上执行：

```bash
ssh -N -L 5000:127.0.0.1:5000 用户名@服务器地址
```

浏览器打开 `http://127.0.0.1:5000/` 即可访问，流量经 SSH 加密，无需对公网开放 5000 端口。

### 方式二：nginx 反向代理

由服务器管理员在 nginx 中将对外 HTTPS/HTTP 转发到本机 Flask/gunicorn，例如：

```nginx
server {
    listen 80;
    server_name perv.example.org;

    location / {
        proxy_pass http://127.0.0.1:5000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        # BigWig / 参考基因组大文件建议开启缓冲与较长超时
        proxy_read_timeout 300s;
        proxy_buffering off;
    }
}
```

用户通过域名访问；运维仍可用 `./serve.sh` 管理进程。若需公网直连而不经过 nginx，可设 `PERV_HOST=0.0.0.0` 并配置防火墙，安全性需自行评估。

---

## 联系我们

- **单位**：中国科学院昆明动物研究所  
- **数据提供者与数据库开发者**：[yuankangqi@mail.kiz.ac.cn](mailto:yuankangqi@mail.kiz.ac.cn)

---

## 版权与引用

数据版权归原作者所有；引用或二次发表请遵守相关数据使用协议。网站代码可按项目约定使用；引用本平台请注明 PERV Atlas 及数据来源单位。
