#!/usr/bin/env bash
# =============================================================================
# PERV Atlas 迁移打包脚本 (供 FileZilla 等手动传输使用)
# =============================================================================
# 把「迁移必备」的内容分成几个独立压缩包，放到 ./migrate_dist/ 下：
#
#   perv-core.tar.gz        代码 + 小数据 + data/ 索引 (含 gtf.sqlite/blast_db/
#                           pygenome_ref)。带上索引是为了「尽量少重新生成」，
#                           新机基本无需重建。约 350 MB。
#   perv-genome-ref.tar.gz  参考基因组 FASTA + GTF (genome.ref.guochao/)。约 2.9 GB。
#   perv-omics-<类别>.tar   多组学 BigWig，按 ATAC-seq/ChIP-seq/RNA-seq/WGBS
#                           分别打包 (BigWig 已压缩，故用 tar 不再 gzip)。合计 ~1.7 TB。
#
# 打完后用 FileZilla 把 migrate_dist/ 里的包传到新服务器，再按 README
# 「迁移到其它服务器」的解压与配置命令操作。
#
# 用法:
#   ./pack_for_migration.sh core           # 只打核心包 (默认)
#   ./pack_for_migration.sh genomeref      # 只打参考基因组
#   ./pack_for_migration.sh omics          # 打全部多组学 (每类别一个包)
#   ./pack_for_migration.sh omics ChIP-seq # 只打某一个多组学类别
#   ./pack_for_migration.sh all            # core + genomeref + omics 全打
# 打包完成会生成 migrate_dist/MANIFEST.txt (含各包大小与 sha256 校验)。
# =============================================================================
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"
BASE="$(basename "$DIR")"
PARENT="$(dirname "$DIR")"
OUT="$DIR/migrate_dist"
mkdir -p "$OUT"

manifest() {
  local f="$1"
  [[ -f "$f" ]] || return 0
  local size sha
  size="$(du -h "$f" | cut -f1)"
  sha="$(sha256sum "$f" | cut -d' ' -f1)"
  printf '%-40s %8s  %s\n' "$(basename "$f")" "$size" "$sha" >> "$OUT/MANIFEST.txt"
  echo "  -> $(basename "$f")  ($size)"
}

pack_core() {
  echo "[core] 打包代码 + 小数据 + data/ 索引 ..."
  # 从父目录打包，使压缩包内根目录就是项目文件夹名。
  # 只纳入迁移必备项，排除虚拟环境/缓存/日志/大文件/草稿。
  tar -C "$PARENT" -czf "$OUT/perv-core.tar.gz" \
      "$BASE/app.py" \
      "$BASE/genome.py" \
      "$BASE/build_genome_index.py" \
      "$BASE/generate_and_plot.py" \
      "$BASE/requirements.txt" \
      "$BASE/serve.sh" \
      "$BASE/migrate.sh" \
      "$BASE/pack_for_migration.sh" \
      "$BASE/README.md" \
      "$BASE/sequence" \
      "$BASE/Homologous" \
      "$BASE/templates" \
      "$BASE/static" \
      "$BASE/server" \
      "$BASE/data" \
      "$BASE/new.Multi-omics/all.sample.info" \
      "$BASE/new.Multi-omics/represent.sample.info" \
      "$BASE/new.Multi-omics/title.list" \
      --exclude="$BASE/server/__pycache__" \
      --exclude="$BASE/server/*.pyc" \
      --exclude="$BASE/data/pygenome_ref/.git" \
      --exclude="$BASE/Homologous/*.bak.*"
  manifest "$OUT/perv-core.tar.gz"
}

pack_genomeref() {
  if [[ ! -d "$DIR/genome.ref.guochao" ]]; then
    echo "[genomeref] 跳过：未找到 genome.ref.guochao/"; return 0
  fi
  echo "[genomeref] 打包参考基因组 FASTA + GTF (约 2.9 GB, 请耐心等待) ..."
  tar -C "$PARENT" -czf "$OUT/perv-genome-ref.tar.gz" "$BASE/genome.ref.guochao"
  manifest "$OUT/perv-genome-ref.tar.gz"
}

pack_omics() {
  local only="${1:-}"
  local cats=(ATAC-seq ChIP-seq RNA-seq WGBS)
  [[ -n "$only" ]] && cats=("$only")
  for c in "${cats[@]}"; do
    if [[ ! -d "$DIR/new.Multi-omics/$c" ]]; then
      echo "[omics] 跳过：未找到 new.Multi-omics/$c"; continue
    fi
    echo "[omics] 打包 new.Multi-omics/$c (BigWig 已压缩，仅归档不再压缩) ..."
    # 用 tar 不加 -z：BigWig 本身已压缩，再 gzip 收益极低且极慢。
    tar -C "$PARENT" -cf "$OUT/perv-omics-$c.tar" "$BASE/new.Multi-omics/$c"
    manifest "$OUT/perv-omics-$c.tar"
  done
}

: > "$OUT/MANIFEST.txt"
echo "PERV Atlas 迁移包清单  ($(date))" >> "$OUT/MANIFEST.txt"
echo "文件名                                     大小      sha256" >> "$OUT/MANIFEST.txt"
echo "-------------------------------------------------------------" >> "$OUT/MANIFEST.txt"

case "${1:-core}" in
  core)      pack_core ;;
  genomeref) pack_genomeref ;;
  omics)     pack_omics "${2:-}" ;;
  all)       pack_core; pack_genomeref; pack_omics ;;
  *)
    echo "用法: $0 {core|genomeref|omics [类别]|all}" >&2
    exit 2 ;;
esac

echo
echo "完成。压缩包位于: $OUT"
echo "清单/校验: $OUT/MANIFEST.txt"
echo "用 FileZilla 把上述包传到新服务器后，按 README「迁移到其它服务器」解压配置。"
