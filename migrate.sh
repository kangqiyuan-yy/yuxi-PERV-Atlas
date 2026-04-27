#!/usr/bin/env bash
# Migration helpers for PERV Atlas.
#
# Usage:
#   ./migrate.sh pack                 # produce perv-atlas.tar.gz (no .venv, no logs)
#   ./migrate.sh push user@host:/path # pack + scp to remote dir
#   ./migrate.sh setup                # on TARGET server: create venv + install deps
#                                       (run inside the extracted project dir)
#
# After `setup` finishes on the target machine, run:
#   ./serve.sh start
# and the site is live on 127.0.0.1:5000.

set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"

ARCHIVE="perv-atlas.tar.gz"

cmd_pack() {
  local out="${1:-$ARCHIVE}"
  echo "Packing project into $out (excluding venv / logs / cache / data) ..."
  # Build a tar from the parent dir so the archive root is the project folder.
  # Write to a temp path first to avoid 'file changed as we read it' warnings.
  local parent base tmp
  parent="$(dirname "$DIR")"
  base="$(basename "$DIR")"
  tmp="$(mktemp -t perv-atlas.XXXXXX.tar.gz)"
  tar -C "$parent" \
      --exclude="$base/.venv" \
      --exclude="$base/__pycache__" \
      --exclude="$base/*.pyc" \
      --exclude="$base/data" \
      --exclude="$base/genome.ref" \
      --exclude="$base/genome.ref.guochao" \
      --exclude="$base/perv.log" \
      --exclude="$base/.perv.pid" \
      --exclude="$base/.git" \
      --exclude="$base/$out" \
      -czf "$tmp" "$base"
  mv "$tmp" "$DIR/$out"
  echo "Done: $DIR/$out  ($(du -h "$DIR/$out" | cut -f1))"
}

cmd_push() {
  local target="${1:-}"
  if [[ -z "$target" ]]; then
    echo "Usage: $0 push user@host:/remote/parent/dir" >&2
    exit 2
  fi
  cmd_pack
  echo "Uploading to $target ..."
  scp "$DIR/$ARCHIVE" "$target/"
  echo
  echo "Now SSH into the target host and run:"
  echo "  cd <the directory you uploaded to>"
  echo "  tar xzf $ARCHIVE"
  echo "  cd $(basename "$DIR")"
  echo "  ./migrate.sh setup"
  echo "  ./serve.sh start"
}

cmd_setup() {
  if ! command -v python3 >/dev/null 2>&1; then
    echo "python3 not found in PATH. Install Python 3.8+ first." >&2
    exit 1
  fi
  if [[ ! -d .venv ]]; then
    echo "Creating virtual environment .venv ..."
    python3 -m venv .venv
  fi
  echo "Installing dependencies ..."
  # Try direct install; fall back to a Chinese mirror if the default times out.
  if ! .venv/bin/pip install --default-timeout=120 -r requirements.txt; then
    echo "Default index failed, retrying with Tsinghua mirror ..."
    .venv/bin/pip install --default-timeout=300 \
      -i https://pypi.tuna.tsinghua.edu.cn/simple \
      -r requirements.txt
  fi
  echo "Setup complete."
  if [[ -d genome.ref.guochao ]] && [[ -f genome.ref.guochao/Sus_scrofa.Sscrofa11.1.dna.toplevel.fa ]]; then
    echo "  Detected genome.ref.guochao/. To enable the genome browser run:"
    echo "    .venv/bin/python build_genome_index.py"
  else
    echo "  Note: genome.ref.guochao/ is excluded from the migration archive (large)."
    echo "  Copy the FASTA + GTF separately if you want the genome browser,"
    echo "  then run: .venv/bin/python build_genome_index.py"
  fi
  echo "Then start the service with: ./serve.sh start"
}

case "${1:-}" in
  pack) shift; cmd_pack "$@" ;;
  push) shift; cmd_push "$@" ;;
  setup) cmd_setup ;;
  *)
    echo "Usage: $0 {pack|push user@host:/path|setup}" >&2
    exit 2
    ;;
esac
