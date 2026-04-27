#!/usr/bin/env python3
"""One-shot indexing for the genome browser module.

Run once after dropping new files into `genome.ref.guochao/`:

    python build_genome_index.py

This generates:
    data/genome.fa.fai      - samtools-compatible FASTA index (~30 KB)
    data/gtf.sqlite         - SQLite-backed GTF feature index (a few hundred MB)

Re-run with `--force` to rebuild.
"""

from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

import genome


BASE = Path(__file__).resolve().parent
REF_DIR = BASE / "genome.ref.guochao"
DATA_DIR = BASE / "data"
DATA_DIR.mkdir(exist_ok=True)

FASTA = REF_DIR / "Sus_scrofa.Sscrofa11.1.dna.toplevel.fa"
GTF = REF_DIR / "Sus_scrofa.Sscrofa11.1.108.gtf"
FAI = DATA_DIR / "genome.fa.fai"
DB = DATA_DIR / "gtf.sqlite"


def main(argv: list[str]) -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--force", action="store_true", help="rebuild even if up-to-date")
    p.add_argument(
        "--fasta", default=str(FASTA), help=f"override FASTA path (default: {FASTA})"
    )
    p.add_argument("--gtf", default=str(GTF), help=f"override GTF path (default: {GTF})")
    args = p.parse_args(argv)

    fasta = Path(args.fasta)
    gtf = Path(args.gtf)
    if not fasta.exists():
        print(f"FASTA not found: {fasta}", file=sys.stderr)
        return 2
    if not gtf.exists():
        print(f"GTF not found: {gtf}", file=sys.stderr)
        return 2

    t0 = time.time()
    print(f"[fai] indexing {fasta.name} ({fasta.stat().st_size / 1e9:.2f} GB) ...")
    genome.build_fai(fasta, FAI, force=args.force)
    print(f"[fai] -> {FAI}  ({time.time() - t0:.1f}s)")

    t1 = time.time()
    fai = genome.load_fai(FAI)
    print(f"[fai] {len(fai)} sequences indexed (top-5 by length):")
    for c in genome.list_chromosomes(fai, top_n=5):
        print(f"       {c['name']:<24} {c['length']:>12,} bp")

    t2 = time.time()
    print(f"[gtf] indexing {gtf.name} ({gtf.stat().st_size / 1e6:.0f} MB) ...")
    genome.build_gtf_sqlite(gtf, DB, force=args.force)
    print(f"[gtf] -> {DB}  ({time.time() - t2:.1f}s)")

    print(f"\nAll done in {time.time() - t0:.1f}s.")
    print("Now restart the web service:  ./serve.sh restart")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
