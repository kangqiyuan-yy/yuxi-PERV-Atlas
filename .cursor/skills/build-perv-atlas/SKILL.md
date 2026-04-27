---
name: build-perv-atlas
description: >-
  复现并搭建 PERV Atlas 网站：基于 Flask + ECharts + igv.js 的中英双语三模块站点
  （PERV 概览、注释序列浏览、参考基因组浏览）。当用户提到“搭建/复现 PERV 数据库、
  PERV 网站、PERV 浏览器、猪内源性逆转录病毒可视化”时使用本技能。
---

# 搭建 PERV Atlas（中文版）

本技能用于从模板快速复现 PERV 数据网站，只需用户提供关键数据文件，即可完成：

- 板块一：1165 类似规模的 PERV 概览
- 板块二：注释序列 ORF/结构域浏览
- 板块三：基因组浏览器（可选，支持可变剪切与外显子级详情）

---

## 一、先收集输入文件（必须先做）

优先使用 AskQuestion 工具收集路径；没有就直接向用户逐项要路径。

### 必填（没有就不能开始）

| 槽位 | 格式 | 示例 | 对应板块 |
|---|---|---|---|
| `full_fa` | 完整集合 FASTA | `my.final.fa` | 板块一 |
| `meta_xlsx` | 元数据 Excel | `1165.intact.PERV.infomation.xlsx` | 板块一 |
| `pass_fa` | 精注释子集 FASTA | `pass.139.fa` | 板块二 |
| `orf_bed` | BED6 | `ORF.combine.HTML.bed` | 板块二（ORF） |
| `domain_bed` | BED6 | `domin.combine.HTML.bed` | 板块二（结构域） |

### 可选（有则启用板块三）

| 槽位 | 格式 | 示例 |
|---|---|---|
| `genome_fa` | 参考基因组 FASTA | `Sus_scrofa.Sscrofa11.1.dna.toplevel.fa` |
| `genome_gtf` | GTF 注释 | `Sus_scrofa.Sscrofa11.1.108.gtf` |

若用户未提供基因组文件，板块三可跳过，前两板块仍可完整运行。

---

## 二、执行流程（按顺序）

把下面清单复制出来并打勾推进：

```
搭建进度：
- [ ] 1. 确认目标目录 + 收集文件路径
- [ ] 2. 做输入校验（FASTA / BED / xlsx 的 ID 一致性）
- [ ] 3. 从模板复制项目骨架
- [ ] 4. 放入用户数据（sequence/；可选 genome.ref/）
- [ ] 5. 按需修改文案与标签
- [ ] 6. 创建 venv 并安装依赖
- [ ] 7. （可选）构建基因组索引
- [ ] 8. 启动服务并冒烟测试
- [ ] 9. 告知访问方式（SSH 隧道 / nginx）
```

### 1) 目标目录

默认建议：`/home/<user>/workspace/<project_name>/`  
必须先和用户确认，避免覆盖已有项目。

### 2) 输入校验

```bash
# FASTA 序列条数
grep -c "^>" "<full_fa>"
grep -c "^>" "<pass_fa>"

# BED 的唯一 ID 数
awk '{print $1}' "<orf_bed>" | sort -u | wc -l
awk '{print $1}' "<domain_bed>" | sort -u | wc -l
```

如果 mismatch 超过 5%，先告知用户数据不一致，再继续。

### 3) 从模板复制骨架

模板项目默认在：`/home/ug2243/workspace/PERV.html`

同机复制推荐：

```bash
rsync -a --exclude='.venv' --exclude='__pycache__' --exclude='data' \
      --exclude='genome.ref' --exclude='sequence' --exclude='perv.log' \
      --exclude='.perv.pid' --exclude='perv-atlas.tar.gz' --exclude='.git' \
      /home/ug2243/workspace/PERV.html/ <target_dir>/
mkdir -p <target_dir>/sequence <target_dir>/data
```

异机可用 `migrate.sh pack` 生成 tar 再解压。

### 4) 放入用户数据

```bash
cp <full_fa>      <target_dir>/sequence/
cp <pass_fa>      <target_dir>/sequence/
cp <meta_xlsx>    <target_dir>/sequence/
cp <orf_bed>      <target_dir>/sequence/
cp <domain_bed>   <target_dir>/sequence/

# 可选：板块三
mkdir -p <target_dir>/genome.ref
cp <genome_fa>    <target_dir>/genome.ref/
cp <genome_gtf>   <target_dir>/genome.ref/
```

若文件名与模板常量不一致，修改 `app.py` 和（有基因组时）`build_genome_index.py` 的路径常量。

### 5) 按需改文案与视觉风格

优先改 `static/js/i18n.js`：

- `home.hero.*`：首页简介
- `home.card*.*`：卡片标题
- `home.ns.*` / `home.flow.*`：首页数字条与流程区文案
- `ov.kpi.*`：概览标签
- `gn.title` / `gn.subtitle`：基因组板块标题
- `gn.detail.*`：基因组详情面板（基因/转录本/外显子）文案

若分类不再是 γ/β，补改 `overview.js` 与 `style.css` 中的标签/颜色映射。

UI 升级最低要求（本项目当前基线）：

- 页面布局：内容区域近全屏（提高主容器宽度；基因组页使用 full-width 容器）
- 首页：非纯图文，至少包含 Hero 视觉层（渐变/动画/SVG）、关键数字条、模块卡片、流程区
- 基因组页：IGV 外层皮肤化（与站点配色一致），并提供右侧固定详情面板
- 基因组页：工具栏必须提供 `EXPANDED / SQUISHED / COLLAPSED` 三档展示模式，允许不同转录本按需展开/折叠
- 基因组页：搜索框必须支持 `gene_name / gene_id / transcript_id` 三字段输入并自动补全
- 基因组页：可变剪切不允许“叠成单行”；同一基因的多 transcript 在 EXPANDED 下应可逐条分行对比

### 6) 安装依赖

```bash
cd <target_dir>
./migrate.sh setup
```

### 7) 可选：构建基因组索引

```bash
.venv/bin/python build_genome_index.py
```

通常约 50 秒，生成：
- `data/genome.fa.fai`
- `data/gtf.sqlite`

### 8) 启动 + 冒烟测试

```bash
./serve.sh start
sleep 2
./serve.sh status

curl -fsS -o /dev/null http://127.0.0.1:5000/
curl -fsS -o /dev/null http://127.0.0.1:5000/overview
curl -fsS -o /dev/null http://127.0.0.1:5000/browser
curl -fsS http://127.0.0.1:5000/api/overview/stats | python3 -m json.tool | head
curl -fsS http://127.0.0.1:5000/api/sequences/pass | python3 -c 'import sys,json; print(json.load(sys.stdin)["total"])'
```

如果启用了板块三，还要测：

```bash
curl -fsS http://127.0.0.1:5000/api/genome/status
curl -fsS -o /dev/null -w "%{http_code}\n" http://127.0.0.1:5000/genome
curl -fsS "http://127.0.0.1:5000/api/genome/search?q=GAPDH"
curl -fsS "http://127.0.0.1:5000/api/genome/search?q=ENSSSCG00000028996"
curl -fsS "http://127.0.0.1:5000/api/genome/search?q=ENSSSCT00000027607"
# 将上一步返回的 gene_id 带入
curl -fsS "http://127.0.0.1:5000/api/genome/gene/<gene_id>"
curl -fsS "http://127.0.0.1:5000/api/genome/transcript/<transcript_id>"
curl -fsS "http://127.0.0.1:5000/api/genome/igv?chrom=1&start=226156037&end=226228510"
```

失败时查看日志：

```bash
./serve.sh log
```

### 9) 访问方式

- **SSH 隧道（最稳）**：`ssh -N -L 5000:127.0.0.1:5000 <user>@<host>`
- **nginx 反代（生产）**：需要管理员配置
- **公网端口直连**：`PERV_HOST=0.0.0.0 PERV_PORT=<port> ./serve.sh restart`（需放行端口）

---

## 三、必须遵守的规则（避免行为漂移）

1. **ORF 蛋白模式必须排除 LTR**（DNA 模式可显示 LTR）。
2. 翻译规则：标准密码子表、无读码框纠正、`*` 保留、`-` 链先反向互补。
3. igv.js 注释轨道优先使用 **静态 BED 文件 + 原生 BED 解析**（不要再走旧的 custom JSON source）：
   - transcript 轨道：`/genome/data/genome.bed`（BED12）
   - gene 轨道：`/genome/data/genome.genes.bed`（BED9）
   - `format: 'bed'`、`indexed: false`、`visibilityWindow: -1`
4. GTF 坐标是 1-based；igv feature 要转 0-based（`start - 1`）。
5. 无 sudo 场景下优先 `serve.sh` + SSH 隧道，不要强行走 systemd。
6. 基因组详情必须支持“点击 feature 后回显所属 gene / transcript / exon 序号”。
7. 可变剪切展示必须是“同一基因下全部 transcript 的并列对比”，不能只显示单一转录本。
8. 基因组搜索必须覆盖 `gene_name`、`gene_id`、`transcript_id`，且搜索命中 transcript 时要能定位到其父 gene 的对比视图。
9. GTF 第三列特征展示必须覆盖：`gene / transcript / exon / CDS / five_prime_utr / three_prime_utr / start_codon / stop_codon`（其中 gene 可在宏观视图，transcript 及其子特征须在细节视图可见）。
10. 为避免 igv.js 把同基因 isoform 合并成一行，transcript BED12 的第 4 列 `name` 必须使用 **纯 transcript_id（不能带空格/括号）**。  
    例如 `ENSSSCT00000027607`（正确），`ENSSSCT00000027607 (ALDH1A1)`（错误，会导致 BED12 列错位并退化为直条）。
11. Genome 页必须同时有两条注释轨道：`Genes`（基因总览，collapsed）+ `Transcripts`（可变剪切细节，支持 expanded/squished/collapsed）。
12. 点击 transcript（无论来自 IGV 轨道还是右侧 transcript 列表）时，右侧 header 必须切换到 transcript 视图（显示 transcript_id / biotype / exon 数 / CDS 长度），并提供 “返回基因” 按钮；不能一直停在 gene 头部。
13. 若需求是“IGV 调色板改色后整条轨道统一生效”，则 BED 的 `itemRgb`（第 9 列）必须写 `0`（或 `.`），不要写按 biotype 的 RGB。否则会出现“只部分生效”的现象（每条记录颜色覆盖轨道默认色）。
14. Genome 工具栏需支持“链特异颜色控制”：轨道选择（Genes / Transcripts）+ `+` 颜色 + `-` 颜色 + `联动（Link）`开关。  
    - `联动（Link）=开`：`altColor` 自动跟随 `color`（整轨单色）  
    - `联动（Link）=关`：允许正负链分色（`+` = `color`，`-` = `altColor`）
15. 颜色同步逻辑要按轨道粒度生效：仅当该轨道 `联动（Link）=开` 时才执行 `altColor=color` 自动同步；不能全局强制同步，否则会覆盖用户手工设置的负链颜色。
16. 若在 Genome 页新增 PERV 轨道并使用 `Homologous/RF.intact.region`：务必记住该文件是 **1-based 非 BED**；而 `ORF.combine.HTML.bed` / `domin.combine.HTML.bed` 是 **0-based BED**。两者混用时先统一到 BED 坐标再转换。
17. PERV 详情面板若显示 1-based 坐标，必须把 domain/ORF 的绝对 BED 起点做 `start + 1` 再展示（`end` 保持不变），否则会出现“LTR 起点比 PERV 序列起点更靠前”的显示错误。
18. 若新增 `PERV Homologous`（876 条同源定位）：`locus_id` 必须做数值排序（不能字典序）；同时支持序列视图与 locus 视图，并保证“点击空白处收起”行为与 Tracks 抽屉一致。
19. 同源详情中的 ECharts 图表重复渲染前必须 `dispose()`；物种柱状图高度按 species 数动态调整，否则会出现重叠和性能问题。
20. 若自定义 IGV 左侧 track label 样式在 CSS 中不生效，优先排查 igv.js v3 Shadow DOM：样式需注入 `#igv-container.shadowRoot`，外部样式表无法直接覆盖。
21. 为避免 track label 样式“先旧后新”闪烁（FOSC），不要延迟注入；应在 `igv.createBrowser` 成功后立即向 shadow root 注入 `<style>`。
22. 本项目运行通常由 `serve.sh`/gunicorn 管理；若只重启 `python app.py`，静态资源版本号可能不更新。需要重启 gunicorn 主进程或直接使用 `./serve.sh restart`。
23. 若需在 `PERV` 详情和 `PERV Homologous` 序列卡片展示类型标签，优先复用 `sequence/1165.intact.PERV.infomation.xlsx` 的 `ERV.type` 列：
    - 关联键：`Sequence.ID` ↔ `q_name`/`name`
    - 后端在组装 `/api/genome/perv/list` 与 `/api/genome/homologous/list` 时注入 `erv_type`
    - 前端仅负责渲染 badge，不在前端重复做 Excel 解析。
24. Homologous 抽屉 tab 切换异常（点击 `Sequences/Loci` 没反应）时，优先检查 CSS 是否覆盖 `hidden`：
    - 症状：`loci` 视图被“固定放在下方”，两块同时可见
    - 根因：容器规则 `display:flex` 抵消了 `hidden`
    - 固定修复：为 `[hidden]` 增加 `display:none !important`。
25. IGV 内置轨道允许被用户右键 `Remove track`，因此应提供“恢复内置轨道”按钮（如 `Reset Tracks`）：
    - 不建议要求用户整页刷新
    - 应按 `track.id` + `track.name` 检测缺失项
    - 仅重载缺失轨道，保持现有视图状态。
26. 多组学 `Fixed` 纵轴说明要准确：
    - `autoscale:false` = 不随 pan 自动重标尺
    - 不是全程绝对固定 max
    - 若需绝对固定，需同时设置 `min/max`。
27. 同一功能入口文案应与面板标题一致（例如按钮 `PERV Homologous` 对齐抽屉标题；按钮 `Multi-omics Tracks` 对齐轨道抽屉标题），避免多语言场景下误解。
28. transcript 细节表中的 feature 颜色应保证“exon 与 CDS 高对比”：
    - 推荐 `exon=#d97706`（琥珀黄）、`CDS=#2563eb`（蓝）
    - 若用户反馈“看不清差异”，先调色再考虑改布局。
29. Genome 工具栏中的“可变剪切模式”标签建议统一为 `TRANSCRIPTS`（全大写），与 `GENES` 分组风格一致。
30. 若需在 Genome/Homologous 显示“物种简称 + 全名 + 组装号”，优先复用 `sequence/genome.information.xlsx`：
    - 第 1 列 `Row name`（全名）、第 2 列 `Abbretiation`（简称）、第 3 列 `Assembly`（组装号或 URL）
    - 后端启动时构建简称映射，并通过 API 返回给前端（避免前端直接解析 Excel）
    - 前端筛选逻辑继续用简称 value，仅在 label/tooltip/detail 展示全名与组装信息
31. Homologous 的 `Species Distribution` 柱状图若有遮挡或“柱子过长”：
    - 开启 `grid.containLabel`，并给 yAxis 标签设置宽度与换行
    - 通过动态 `xAxis.max` 预留右侧空白（例如 `maxV + max(0.5, maxV*0.5)`）
    - 避免仅靠缩小字体硬压，优先调布局参数。
32. 若需重设 Genome 默认轨道高度，当前推荐基线：
    - `Genes = 80`
    - `Homologous Seq = 100`
    - `Homologous Loci = 50`
    - 同步修改两处：`igv.createBrowser` 初始 tracks + `Reset Tracks` 的 `BUILTIN_TRACKS`。

---

## 四、常见坑

- **坑 1：igv 报 `reading 'replace'`**  
  基本是轨道配置错误或旧缓存。先强刷页面（Ctrl+Shift+R），再检查自定义轨道是不是 URL 模板写法。

- **坑 2：xlsx 不是“第 1 行标题 + 第 2 行表头”**  
  需要调整 `app.py` 中 `parse_xlsx` 的 header 行索引。

- **坑 3：FASTA 行宽不一致**  
  `.fai` 构建会失败；先统一换行宽度后再构建索引。

- **坑 4：BED 区间越界**  
  会导致 `/api/sequences/<sid>/dna` 返回 400，需先清洗数据。

- **坑 5：IGV 里 transcript 变成长条、看不到外显子结构**  
  高概率是 BED12 第 4 列带了空格（如 `tx_id (gene_name)`）导致列解析错位。  
  修复：name 只保留 `transcript_id`，重新生成 `data/genome.bed` 并硬刷新页面。

- **坑 6：点击 transcript 但右侧一直显示 gene**  
  原因通常是前端没有维护 `viewMode`（gene/transcript）状态。  
  修复：在 feature click / transcript row click / search 命中 transcript 三处统一设置 `viewMode='transcript'`。

- **坑 7：IGV 里改 track color 只有部分生效**  
  原因：BED 第 9 列 `itemRgb` 写了每条记录自己的颜色（如 biotype 颜色），会覆盖轨道颜色。  
  修复：生成 `genome.bed` / `genome.genes.bed` 时把 `itemRgb` 统一写成 `0`，重建 BED 并硬刷新。

- **坑 8：已经支持正负链分色，但颜色总被“改回一样”**  
  原因：自动同步逻辑仍在无条件执行 `altColor=color`。  
  修复：增加 `strandColorLinked[trackId]` 状态；仅 `联动（Link）=开` 的轨道执行同步。

- **坑 9：PERV 详情里 LTR 起点比整段序列起点更小**  
  原因：后端保存的是 BED 0-based 坐标，前端按 1-based 直接展示了 start。  
  修复：详情渲染时统一使用 `display_start = start + 1`、`display_end = end`，并在表头标注 `Start (1-based)`。

- **坑 10：IGV 左侧 label 样式改了但页面无变化**  
  原因：igv.js v3 把 UI 渲染在 Shadow DOM 内，普通 CSS 选择器和 `document.querySelector` 无法穿透。  
  修复：在 `igv.createBrowser` 后获取 `document.getElementById('igv-container').shadowRoot` 并注入 `<style>`。

- **坑 11：重启后还是旧样式 / 版本号不变**  
  原因：实际服务由 gunicorn 在跑，只杀 `python app.py` 无效。  
  修复：使用 `./serve.sh restart`（或杀 gunicorn PID 后重启），确认页面里的 `?v=` 参数更新。

- **坑 12：下载可视化弹窗报 `matplotlib is not installed`**  
  原因：依赖未安装到“实际运行 gunicorn 的 Python 环境”。  
  修复：在目标 venv 中安装 `matplotlib`、`pyBigWig`，并重启 gunicorn；必要时检查 `which python` / `sys.path`。

- **坑 13：导出图是“大方块”，标签拥挤不可读**  
  原因：固定 `figsize` + 固定 track 高度。  
  修复：宽度按区间 span 动态调整；注释轨按 feature 堆叠行数计算高度；整体字号提高到可读范围。

- **坑 14：导出图只有彩色长条，缺失 gene/transcript/PERV/Homologous ID**  
  原因：仅按区间画 `broken_barh`，未绘制 feature label。  
  修复：按每条 feature 绘制 ID（gene 斜体），并采用 expanded 堆叠而非“每类一块”。

- **坑 15：Homologous 抽屉里 Sequences/Loci 不切换，Loci 总在下方**  
  原因：`#homo-seq-view/#homo-locus-view` 的 `display:flex` 覆盖了原生 `hidden`。  
  修复：增加 `[hidden]{ display:none !important; }` 兜底规则，保证 JS 切换 `hidden` 后立即生效。

- **坑 16：用户删掉内置轨道后“不知道怎么加回来”**  
  原因：内置轨道只在初始化时加载，默认没有恢复入口。  
  修复：增加 `Reset Tracks` 按钮，按缺失检测后调用 `browser.loadTrack` 重建。

- **坑 17：已选 Fixed，但同一窗口内峰形看起来仍变化**  
  原因：将 `autoscale:false` 误解为“强制固定 max”；实际只是关闭动态重标尺。  
  修复：在文档和 UI 说明中明确语义；如需绝对固定，提供 `min/max` 配置能力。

- **坑 18：Transcript 明细表里 exon 与 CDS 颜色太近**  
  原因：两者都使用蓝紫系，长列表阅读时不易区分。  
  修复：将 exon 改为琥珀黄（如 `#d97706`），CDS 保持蓝色（如 `#2563eb`）。

- **坑 19：Homologous 物种柱状图标签被遮挡、柱子顶满太长**  
  原因：左边距固定且未包含标签宽度，x 轴上限紧贴最大值（常见全是 1 时全部拉满）。  
  修复：`grid.containLabel=true` + yAxis 长标签换行；同时抬高 `xAxis.max`，让柱条保留右侧留白。

- **坑 20：改了默认高度但 Reset Tracks 后又恢复旧值**  
  原因：只改了初始化轨道配置，漏改 `Reset Tracks` 内置轨道定义。  
  修复：保证两处高度配置完全一致（尤其是 Genes/Homologous 两条轨道）。

---

## 五、完成标准（Done）

满足以下全部条件才算完成：

- [ ] `./serve.sh status` 显示 running
- [ ] `/`, `/overview`, `/browser` 全部 HTTP 200
- [ ] 至少 1 条 Section2 ID 能正常展示 region + DNA + protein
- [ ] 如有基因组文件：`/genome` 正常，`/api/genome/status` 为 `ready: true`
- [ ] 如有基因组文件：点击任意 gene/transcript/exon 能在右侧详情显示 gene/transcript/exon-N-of-M
- [ ] 如有基因组文件：同一基因下可见多转录本（alternative splicing）对比
- [ ] 如有基因组文件：IGV 中能同时看到 `Genes` + `Transcripts` 两条轨道
- [ ] 如有基因组文件：`Transcripts` 轨道显示 exon/intron/CDS 结构（不是单纯长条）
- [ ] 如有基因组文件：`/api/genome/search` 能分别命中 `gene_name / gene_id / transcript_id`
- [ ] 如有基因组文件：IGV 中可切换 `EXPANDED / SQUISHED / COLLAPSED`，并观察到转录本展开/折叠行为
- [ ] 如有基因组文件：选中转录本后可查看其 GTF 第三列特征明细（至少含 exon/CDS/UTR/start_codon/stop_codon）
- [ ] 如有基因组文件：点击 transcript 后右侧 header 进入 transcript 视图，且可一键返回 gene 视图
- [ ] 如有基因组文件：IGV 中设置 track color 后，`Genes` / `Transcripts` 轨道都能整轨统一改色（不再“部分生效”）
- [ ] 如有基因组文件：工具栏可按轨道切换并设置 `+/-` 链颜色；`联动（Link）` 开关可在“整轨单色”与“正负链分色”之间切换
- [ ] 如有基因组文件且启用 PERV 轨道：`/api/genome/perv/list` 返回 47 条；能在 IGV 看到 `PERV` 轨道（位于 Genes 下方）
- [ ] 如有基因组文件且启用 PERV 轨道：点击任一 PERV 条目可跳转定位并在右侧展示 region + domain/ORF（无注释条目允许为空）
- [ ] 如有基因组文件且启用 PERV 轨道：PERV 详情里所有 `Start (1-based)` 不得小于对应序列的起点（避免 0/1-based 混淆）
- [ ] 用户确认自己能访问（SSH 隧道或公网入口）

---

## 六、参考文档

- 输入文件详细规范：[`reference.md`](reference.md)
- 全项目方案：[`PLAN.md`](../../../PLAN.md)
- API 总表：[`README.md`](../../../README.md)

---

## 六点五、Genome 多组学可视化导出（2026-04 新增）

### 目标

在 `/genome` 中提供“多组学可视化下载”能力，满足：

1. 区间来源可选（gene/transcript/perv/homo/custom/position）
2. 支持上下游延伸
3. 多组学轨道可多选（每条轨道单独成图）
4. 可选叠加注释轨（Genes/Transcripts/PERV/Homologous）
5. 默认 PDF，同时支持 SVG/PNG

### 关键实现路径

- 前端：`templates/genome.html` + `static/js/download_modal.js` + i18n key
- 后端：
  - `GET /api/download/resolve_region`
  - `POST /api/download/generate`
- 渲染层：`matplotlib + pyBigWig`

### 必测清单（新增）

- [ ] Modal 可打开，7 种区间来源都能解析坐标
- [ ] 勾选 1 条 BigWig 可下载单文件（PDF/SVG/PNG）
- [ ] 勾选多条 BigWig 返回 ZIP（每条轨道 1 个文件）
- [ ] 注释轨开启后，能看到 feature 级别 ID（不是单条大色块）
- [ ] gene 标签为斜体；transcript/PERV/homologous 标签可见
- [ ] 导出配色与网页轨道一致（Genes 灰，Transcripts 金，PERV 橙红，Homo 蓝/紫）
- [ ] 区间 >10 Mb 返回 400
- [ ] 重启服务后功能仍可用（排除环境漂移）

---

## 七、多组学 `.bw` 轨道接入实施与回归要点（Genome Browser）

本节记录已落地实现；后续维护同类需求时按以下口径继续。

### 目标（保持现有轨道不变）

1. 现有基因组轨道（ruler/Genes/Transcripts）不改语义与交互。
2. 新增一个 **Tracks 抽屉面板**：按一级目录（ATAC-seq/ChIP-seq/RNA-seq/WGBS/Hi-C）展示，展开后可勾选具体 `.bw` 文件。
3. 勾选后将 `.bw` 动态加载到 IGV，且新轨道追加在现有轨道后面。
4. 现有轨道作为“冻结窗格”置顶；仅新增多组学轨道区域可滚动。

### 后端改动

- 在 `app.py` 新增：
  - `MULTIOMICS_DIR = BASE_DIR / "Multi-omics"`
  - `GET /api/multiomics/index`：扫描 `Multi-omics/<category>/*.bw` 返回目录树
  - `GET /multiomics/data/<category>/<path:filename>`：安全校验后 `send_file(..., conditional=True)`（支持 Range）
- 仅允许 `.bw` 后缀；拒绝路径穿越（`..` 等）。

### 前端改动

- `templates/genome.html`
  - 工具栏新增 `Tracks` 按钮
  - 新增右侧滑出抽屉（overlay/drawer），显示目录与文件勾选框
- `static/js/genome.js`
  - `igv.createBrowser` 后暴露 browser 实例（供多组学脚本调用）
  - 给“现有轨道”打上 frozen 标记（用于 sticky）
- 新增 `static/js/multiomics.js`
  - 拉取 `/api/multiomics/index`
  - 渲染折叠目录 + checkbox
  - 勾选：`browser.loadTrack({ type: 'wig', format: 'bigwig', ... })`
  - 取消勾选：移除对应 track
- `static/css/style.css`
  - 抽屉动画与蒙层样式
  - IGV 容器滚动区样式
  - `.frozen-track` sticky 置顶样式

### 数据兼容性检查（必须先做）

先确认 `.bw` 染色体命名与参考基因组一致（本项目为 `chr1...chr18, chrX, chrY, chrM`）。  
若 `.bw` 仍是无 `chr` 前缀命名，需要先做离线重建后再接入。

### 关键回归点（已上线）

- [x] `/api/multiomics/index` 返回目录分组与文件列表
- [x] `.bw` 路由支持 HTTP Range（206）
- [x] 勾选任意 `.bw` 后出现新增轨道，取消后消失
- [x] 现有轨道始终置顶；滚动仅影响新增多组学轨道
- [x] 搜索、跳转、详情面板、颜色工具栏等既有功能无回归

### 纵轴缩放说明（避免误判）

多组学信号轨道若启用 `autoscale: true`，IGV 会随当前视窗动态重算 Y 轴，导致同一区域在平移后“看起来高度不同”。  
当前默认策略：**`Fixed`（`autoscale: false`）**，保证跨区域比较时比例一致；用户可单轨切换到 `Auto` 查看局部细节。

### 本次新增经验（写代码时必须注意）

1. **i18n 全局对象名**
   - 项目实际使用 `window.I18n`，不是 `window.__pervI18n`。
   - 动态生成节点（例如 tracks 抽屉里的 `Fixed/Auto`）需要在语言切换后重绘，建议监听 `i18nchange`。

2. **Overview 饼图标签重叠**
   - 如果出现标签与图例/标签相互遮挡，优先在 `static/js/overview.js` 调整：
     - `avoidLabelOverlap: true`
     - `labelLayout.hideOverlap + moveOverlap`
     - 外部标签单行显示（避免 `\\n` 换行）
     - `center` 上移，给 legend 让位

3. **回归验证补充**
   - 多组学轨道接入后，除 API/Range 外，还要手测：
     - 同一区域平移时 `Fixed` 模式峰高是否保持可比
     - 切换语言后 `Tracks` 抽屉动态按钮文案是否同步
     - Overview 两个环图在中英双语下是否有标签重叠

4. **PERV 轨道 + 非 BED 坐标文件接入经验（2026-04）**
   - 新增数据源：`Homologous/RF.intact.region`（1-based 闭区间，非 BED）
   - 后端新增：
     - `GET /genome/data/perv.bed`：将 `RF.intact.region` 转 BED6（`start-1, end`）
     - `GET /api/genome/perv/list`：返回 47 条 PERV 列表并包含 domain/ORF 绝对坐标
   - 前端新增：
     - Genome 工具栏下方可折叠 `PERV Sequences` 面板（点击条目跳转定位）
     - IGV 新增 `PERV` 注释轨道（固定在 Genes 下方）
     - 右侧详情支持展示 region、domain、ORF（允许部分序列无注释）
   - 坐标规则（必须统一口径）：
     - 中间计算全部按 BED（0-based 半开）进行
     - 面板展示若用 1-based，必须 `start+1`
