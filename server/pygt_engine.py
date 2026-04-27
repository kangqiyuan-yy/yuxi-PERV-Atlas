"""pyGenomeTracks rendering engine for the PERV Atlas web UI.

This module is a refactor of the original ``generate_and_plot.py`` offline
script. It exposes two public functions:

- ``build_ini_content(spec)``: turn a user-customisable spec dict into the text
  of a ``tracks.ini`` file that pyGenomeTracks can consume.
- ``render(spec, work_dir)``: write the ini, invoke pyGenomeTracks, and return
  the artifact path together with the ini and log text.

All file paths (BigWig, reference BED) are resolved from a server-controlled
whitelist; the front-end only supplies category/filename and parameter values.
"""

from __future__ import annotations

import os
import re
import shlex
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Any


BASE_DIR = Path(__file__).resolve().parent.parent
MULTIOMICS_DIR = BASE_DIR / "new.Multi-omics"
PYGT_REF_DIR = BASE_DIR / "data" / "pygenome_ref"

PERV_STRUCTURE_BED = PYGT_REF_DIR / "PERV_structure.bed"
PERV_LABELS_BED = PYGT_REF_DIR / "PERV_labels.bed"
PERV_GTF = PYGT_REF_DIR / "PERV.gtf"

# Whole-genome annotation tracks (derived from Sus_scrofa.Sscrofa11.1.108.gtf)
# – BED9 for genes, BED12 for transcripts with exon blocks. These cover any
# region of the pig genome, not just PERV loci.
GENOME_GENES_BED = BASE_DIR / "data" / "genome.genes.bed"  # BED9
GENOME_TX_BED = BASE_DIR / "data" / "genome.bed"           # BED12

GENE_TRACK_COLOR = "#ccebc5"          # pastel green — gene bar (swapped)
TRANSCRIPT_EXON_COLOR = "#b3cde3"     # pastel blue — exon block
TRANSCRIPT_ARROW_COLOR = "#fbb4ae"    # pastel red — intron arrows/backbone (swapped)

PYGENOMETRACKS_BIN = os.environ.get(
    "PYGENOMETRACKS_BIN",
    "/opt/service/miniconda3/envs/rex_env/bin/pyGenomeTracks",
)
# Python interpreter from the same env as pyGenomeTracks (used to run the
# wrapper that injects custom intron/backbone colour properties).
PYGT_PYTHON = os.environ.get(
    "PYGT_PYTHON",
    "/opt/service/miniconda3/envs/rex_env/bin/python",
)
PYGT_WRAPPER = Path(__file__).resolve().parent / "pygt_wrapper.py"

ALLOWED_FORMATS = ("pdf", "svg", "png")
ALLOWED_CATEGORIES = ("ATAC-seq", "ChIP-seq", "RNA-seq", "WGBS")

# pyGenomeTracks visual constants (mirror the original offline script).
PERV_TRACK_HEIGHT_CM = 0.65
PERV_COLLAPSED_YLIM_RANGE = 110.0
INTERVAL_HEIGHT = 90
ROW_SCALE_FACTOR = 2.3
TRACK_SPACER_HEIGHT = 0.12

# Default per-seqtype colours; the front-end may override per-track.
DEFAULT_SEQTYPE_COLORS = {
    "ATAC": "#8dd3c7",
    "H3K27ac": "#bf812d",
    "H3K9ac": "#bc80bd",
    "Pol2": "#a65628",
    "H3K4me1": "#bebada",
    "H3K4me3": "#fb8072",
    "H3K36me3": "#80b1d3",
    "H3K27me3": "#fdb462",
    "H3K9me3": "#b3de69",
    "CTCF": "#80b1d3",
    "RNA": "#fccde5",
    "WGBS": "#d9d9d9",
}

_HEX_RE = re.compile(r"^#[0-9a-fA-F]{6}$")
_REGION_RE = re.compile(r"^[A-Za-z0-9._-]+$")  # validates chrom


def _sanitize_label(value: str, max_len: int = 80) -> str:
    """Strip control characters / newlines so user text can't break the ini."""
    if not value:
        return ""
    cleaned = re.sub(r"[\r\n\t=\[\]]", " ", value)
    cleaned = re.sub(r"\s+", " ", cleaned).strip()
    return cleaned[:max_len]


# ── Errors ───────────────────────────────────────────────────────────────────


class PygtError(ValueError):
    """User-facing validation/render error."""


# ── BigWig path resolution ───────────────────────────────────────────────────


def resolve_bw_path(category: str, filename: str) -> Path:
    """Return absolute Path to a BigWig under new.Multi-omics, or raise.

    Both ``category`` and ``filename`` are user-supplied; we strictly validate
    them against a whitelist before touching the filesystem.
    """
    if category not in ALLOWED_CATEGORIES:
        raise PygtError(f"Invalid category: {category!r}")
    if "/" in filename or ".." in filename or not filename.endswith(".bw"):
        raise PygtError(f"Invalid BigWig filename: {filename!r}")

    p = MULTIOMICS_DIR / category / "data_bw" / filename
    if not p.is_file():
        raise PygtError(f"BigWig not found: {category}/{filename}")
    return p


# ── pig_genes stacking estimate (from generate_and_plot.py) ──────────────────


def _gene_max_rows(
    bed_path: Path, chrom: str, start: int, end: int,
    label_fontsize_bp_per_char: int = 120,
) -> int:
    """Mirror pyGenomeTracks BedTrack stacking to estimate row count."""
    if not bed_path.is_file():
        return 1
    feats: list[tuple[int, int, str]] = []
    with bed_path.open() as fh:
        for line in fh:
            if not line.strip():
                continue
            p = line.rstrip("\n").split("\t")
            if p[0] != chrom:
                continue
            try:
                s, e = int(p[1]), int(p[2])
            except ValueError:
                continue
            if e <= start or s >= end:
                continue
            name = p[3].strip() if len(p) > 3 else ""
            feats.append((s, e, name))
    if not feats:
        return 1
    feats.sort()
    row_last: list[int] = []
    for s, e, name in feats:
        extended = e + (len(name) + 2) * label_fontsize_bp_per_char
        placed = False
        for i, last in enumerate(row_last):
            if last < s:
                row_last[i] = extended
                placed = True
                break
        if not placed:
            row_last.append(extended)
    return max(1, len(row_last))


def _gene_track_height_cm(rows: int) -> float:
    perv_visual = (INTERVAL_HEIGHT / PERV_COLLAPSED_YLIM_RANGE) * PERV_TRACK_HEIGHT_CM
    ylim_range = (rows - 1) * (INTERVAL_HEIGHT * ROW_SCALE_FACTOR) + INTERVAL_HEIGHT
    return perv_visual * (ylim_range / INTERVAL_HEIGHT)


def _get_out_of_range_features(
    bed_path: Path, chrom: str, start: int, end: int
) -> list[str]:
    """Return unique names of BED features that overlap [start,end] but extend beyond it."""
    out: list[str] = []
    seen: set[str] = set()
    try:
        with open(bed_path) as fh:
            for line in fh:
                if line.startswith("#") or not line.strip():
                    continue
                parts = line.split("\t")
                if len(parts) < 4 or parts[0] != chrom:
                    continue
                try:
                    b_start, b_end = int(parts[1]), int(parts[2])
                except ValueError:
                    continue
                # overlaps the visible region
                if b_start < end and b_end > start:
                    # extends beyond either boundary
                    if b_start < start or b_end > end:
                        name = parts[3].strip()
                        if name and name not in seen:
                            seen.add(name)
                            out.append(name)
    except OSError:
        pass
    return out


def _write_filtered_bed(
    bed_path: Path, chrom: str, start: int, end: int, out_path: Path
) -> None:
    """Write to out_path only features *fully* within [start, end] on chrom."""
    with open(bed_path) as fin, open(out_path, "w") as fout:
        for line in fin:
            if line.startswith("#") or not line.strip():
                fout.write(line)
                continue
            parts = line.split("\t")
            if len(parts) < 3 or parts[0] != chrom:
                continue
            try:
                b_start, b_end = int(parts[1]), int(parts[2])
            except ValueError:
                continue
            if b_start >= start and b_end <= end:
                fout.write(line)


# ── Spec validation ──────────────────────────────────────────────────────────


@dataclass
class TrackSpec:
    category: str
    filename: str
    title: str
    color: str
    height_cm: float

    def bw_path(self) -> Path:
        return resolve_bw_path(self.category, self.filename)


@dataclass
class RenderSpec:
    chrom: str
    start: int            # 1-based, inclusive
    end: int              # 1-based, inclusive
    upstream: int
    downstream: int
    tracks: list[TrackSpec]
    annot_perv: bool
    annot_genes: bool
    annot_transcripts: bool
    annot_transcripts_display: str  # "collapsed" or "stacked"
    fontsize: int
    track_label_fraction: float
    number_of_bins: int
    show_data_range: bool
    interval_title: str
    include_partial_genes: bool   # False → filter out genes/txs extending beyond region
    fmt: str              # pdf|svg|png

    @property
    def plot_start(self) -> int:
        return max(1, self.start - self.upstream)

    @property
    def plot_end(self) -> int:
        return self.end + self.downstream

    @property
    def region_str(self) -> str:
        return f"{self.chrom}:{self.plot_start}-{self.plot_end}"


def _clamp(v: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, v))


def validate_spec(body: dict[str, Any]) -> RenderSpec:
    """Parse + validate a JSON request body into a RenderSpec."""
    chrom = str(body.get("chrom", "")).strip()
    if not chrom or not _REGION_RE.match(chrom):
        raise PygtError("Invalid or missing chromosome")
    try:
        start = int(body.get("start", 0))
        end = int(body.get("end", 0))
    except (TypeError, ValueError):
        raise PygtError("start/end must be integers")
    if start <= 0 or end <= 0 or end < start:
        raise PygtError("Invalid coordinates")

    upstream = max(0, int(body.get("upstream") or 0))
    downstream = max(0, int(body.get("downstream") or 0))
    span = (end - start + 1) + upstream + downstream
    if span > 10_000_000:
        raise PygtError(f"Region too large ({span:,} bp). Maximum is 10 Mb.")

    raw_tracks = body.get("tracks") or []
    if not raw_tracks:
        raise PygtError("At least one BigWig track must be selected")
    if len(raw_tracks) > 30:
        raise PygtError("Too many tracks (max 30)")

    tracks: list[TrackSpec] = []
    for i, t in enumerate(raw_tracks):
        if not isinstance(t, dict):
            raise PygtError(f"Track #{i+1}: not an object")
        cat = str(t.get("category", "")).strip()
        fname = str(t.get("filename", "")).strip()
        title = _sanitize_label(str(t.get("title") or Path(fname).stem))
        if not title:
            title = f"track_{i+1}"
        color = str(t.get("color", "")).strip() or "#2563eb"
        if not _HEX_RE.match(color):
            raise PygtError(f"Track #{i+1}: invalid colour {color!r} (expected #rrggbb)")
        try:
            h = float(t.get("height_cm", 2.0))
        except (TypeError, ValueError):
            h = 2.0
        h = _clamp(h, 0.5, 8.0)
        # resolve_bw_path performs whitelist + filesystem validation
        spec = TrackSpec(category=cat, filename=fname, title=title, color=color, height_cm=h)
        spec.bw_path()
        tracks.append(spec)

    annot = body.get("annotation") or {}
    options = body.get("options") or {}

    fontsize = int(options.get("fontsize", 12) or 12)
    fontsize = int(_clamp(fontsize, 6, 24))
    label_frac = float(options.get("track_label_fraction", 0.25) or 0.25)
    label_frac = _clamp(label_frac, 0.05, 0.40)
    n_bins = int(options.get("number_of_bins", 700) or 700)
    n_bins = int(_clamp(n_bins, 100, 5000))

    fmt = str(body.get("format", "pdf")).lower()
    if fmt not in ALLOWED_FORMATS:
        raise PygtError(f"Invalid format: {fmt!r}")

    interval_title = _sanitize_label(str(body.get("interval_title", "")))

    return RenderSpec(
        chrom=chrom,
        start=start,
        end=end,
        upstream=upstream,
        downstream=downstream,
        tracks=tracks,
        annot_perv=bool(annot.get("perv_structure", True)),
        annot_genes=bool(annot.get("genes", True)),
        annot_transcripts=bool(annot.get("transcripts", False)),
        annot_transcripts_display=(
            "stacked" if annot.get("transcripts_display") == "stacked" else "collapsed"
        ),
        fontsize=fontsize,
        track_label_fraction=label_frac,
        number_of_bins=n_bins,
        show_data_range=bool(options.get("show_data_range", True)),
        interval_title=interval_title,
        include_partial_genes=bool(annot.get("include_partial_genes", True)),
        fmt=fmt,
    )


# ── INI generation ───────────────────────────────────────────────────────────


_BIGWIG_TEMPLATE = """\
[{section}]
file = {file_path}
title = {title}
height = {height:.2f}
color = {color}
min_value = 0
number_of_bins = {n_bins}
nans_to_zeros = true
summary_method = mean
show_data_range = {show_range}
file_type = bigwig
"""

_SPACER_TEMPLATE = "[spacer]\nheight = {h:.2f}\n"


def _bed_has_overlap(bed_path: Path, chrom: str, start: int, end: int) -> bool:
    """Return True iff bed_path contains any feature overlapping the window."""
    if not bed_path.is_file():
        return False
    try:
        with bed_path.open() as fh:
            for line in fh:
                if not line.strip() or line.startswith("#"):
                    continue
                p = line.rstrip("\n").split("\t")
                if len(p) < 3 or p[0] != chrom:
                    continue
                try:
                    s, e = int(p[1]), int(p[2])
                except ValueError:
                    continue
                if e > start and s < end:
                    return True
    except OSError:
        return False
    return False


def _annotation_block(
    spec: RenderSpec,
    genes_bed: Path | None = None,
    tx_bed: Path | None = None,
) -> str:
    parts: list[str] = []

    # PERV_structure is only meaningful inside PERV loci — skip it when the
    # selected region has no overlapping PERV feature so we don't render an
    # empty annotation track.
    perv_in_region = _bed_has_overlap(
        PERV_STRUCTURE_BED, spec.chrom, spec.plot_start, spec.plot_end,
    )
    if (spec.annot_perv and perv_in_region
            and PERV_STRUCTURE_BED.is_file() and PERV_LABELS_BED.is_file()):
        title = spec.interval_title or "PERV"
        parts.append(_SPACER_TEMPLATE.format(h=0.30))
        parts.append(
            f"""[PERV_structure]
file = {PERV_STRUCTURE_BED}
title = {title}
height = 0.65
color = bed_rgb
labels = false
fontsize = {spec.fontsize}
border color = black
interval_height = 90
style = flybase
display = collapsed
file_type = bed

[PERV_labels]
file = {PERV_LABELS_BED}
overlay previous = yes
height = 0.65
title =
color = #ffffff
labels = true
fontsize = {spec.fontsize}
border color = none
interval_height = 90
style = flybase
display = collapsed
file_type = bed
"""
        )

    # ── Genes (whole-genome BED9, one row per gene) ──
    _genes_bed = genes_bed or GENOME_GENES_BED
    if spec.annot_genes and _genes_bed.is_file():
        n_rows = _gene_max_rows(
            _genes_bed, spec.chrom, spec.plot_start, spec.plot_end,
        )
        # Give genes enough room for bar + label without crowding.
        gene_h = max(0.8, _gene_track_height_cm(max(1, n_rows)) * 0.40)
        parts.append(_SPACER_TEMPLATE.format(h=0.40))
        parts.append(
            f"""[genes]
file = {_genes_bed}
title = Genes
height = {gene_h:.2f}
color = {GENE_TRACK_COLOR}
arrow_scale = 2.5
bar_height_fraction = 0.5
labels = true
fontsize = {spec.fontsize}
border color = black
interval_height = 45
style = UCSC
display = stacked
file_type = bed
"""
        )

    # ── Transcripts (whole-genome BED12 with exon blocks) ──
    # collapsed → isoforms of the same gene merge into one row (union of exons),
    #             gene-level labels shown.
    # stacked   → each isoform on its own row, no labels (too cluttered).
    _tx_bed = tx_bed or GENOME_TX_BED
    if spec.annot_transcripts and _tx_bed.is_file():
        tx_disp = spec.annot_transcripts_display  # "collapsed" or "stacked"
        tx_labels = "true" if tx_disp == "collapsed" else "false"
        tx_height = 1.20 if tx_disp == "collapsed" else max(
            1.20,
            _gene_track_height_cm(
                max(1, _gene_max_rows(_tx_bed, spec.chrom, spec.plot_start, spec.plot_end))
            ),
        )
        # Wider spacer between Genes and Transcripts so gene labels don't
        # visually collide with the top of the Transcripts track.
        parts.append(_SPACER_TEMPLATE.format(h=0.50))
        parts.append(
            f"""[transcripts]
file = {_tx_bed}
title = Transcripts
height = {tx_height:.2f}
color = {TRANSCRIPT_EXON_COLOR}
color_arrow = {TRANSCRIPT_ARROW_COLOR}
color_backbone = {TRANSCRIPT_ARROW_COLOR}
bar_height_fraction = 0.60
labels = {tx_labels}
fontsize = {spec.fontsize}
border color = black
interval_height = 45
style = UCSC
display = {tx_disp}
file_type = bed
"""
        )

    return "\n".join(parts)


def build_ini_content(
    spec: RenderSpec,
    genes_bed: Path | None = None,
    tx_bed: Path | None = None,
) -> str:
    """Compose the full tracks.ini text from a validated RenderSpec."""
    chunks: list[str] = ["[x-axis]\n"]
    chunks.append(_SPACER_TEMPLATE.format(h=TRACK_SPACER_HEIGHT))

    for i, t in enumerate(spec.tracks):
        # Unique section header even if two tracks share a display title
        section = f"track_{i+1}_{re.sub(r'[^A-Za-z0-9_]', '_', t.title)[:40]}"
        chunks.append(
            _BIGWIG_TEMPLATE.format(
                section=section,
                file_path=t.bw_path(),
                title=t.title,
                height=t.height_cm,
                color=t.color,
                n_bins=spec.number_of_bins,
                show_range="true" if spec.show_data_range else "false",
            )
        )
        if i < len(spec.tracks) - 1:
            chunks.append(_SPACER_TEMPLATE.format(h=TRACK_SPACER_HEIGHT))

    chunks.append(_SPACER_TEMPLATE.format(h=TRACK_SPACER_HEIGHT))
    annot = _annotation_block(spec, genes_bed=genes_bed, tx_bed=tx_bed)
    if annot:
        chunks.append(annot)

    return "\n".join(chunks).rstrip() + "\n"


# ── Render ───────────────────────────────────────────────────────────────────


@dataclass
class RenderResult:
    artifact_path: Path
    ini_text: str
    log_text: str
    cmd_line: str
    warnings: list[str]   # e.g. gene names extending beyond the plot region


def render(spec: RenderSpec, work_dir: Path, *, timeout_sec: int = 120) -> RenderResult:
    """Write ini, run pyGenomeTracks, return artifact + logs.

    Raises ``PygtError`` on validation/timeout/failure. The work_dir must
    already exist; callers (the API layer) own its lifecycle.
    """
    work_dir.mkdir(parents=True, exist_ok=True)
    ini_path = work_dir / "tracks.ini"
    out_path = work_dir / f"out.{spec.fmt}"
    log_path = work_dir / "run.log"

    # ── Detect genes / transcripts that extend beyond the plot region ──────────
    partial_names: list[str] = []
    if spec.annot_genes and GENOME_GENES_BED.is_file():
        partial_names.extend(
            _get_out_of_range_features(
                GENOME_GENES_BED, spec.chrom, spec.plot_start, spec.plot_end
            )
        )
    if spec.annot_transcripts and GENOME_TX_BED.is_file():
        partial_names.extend(
            _get_out_of_range_features(
                GENOME_TX_BED, spec.chrom, spec.plot_start, spec.plot_end
            )
        )
    # de-duplicate while preserving order
    seen_names: set[str] = set()
    out_of_range: list[str] = []
    for n in partial_names:
        if n not in seen_names:
            seen_names.add(n)
            out_of_range.append(n)

    # ── Optionally filter BED files to fully-contained features ───────────────
    genes_bed_path: Path | None = None
    tx_bed_path: Path | None = None
    if not spec.include_partial_genes:
        if spec.annot_genes and GENOME_GENES_BED.is_file():
            genes_bed_path = work_dir / "filtered_genes.bed"
            _write_filtered_bed(
                GENOME_GENES_BED, spec.chrom, spec.plot_start, spec.plot_end,
                genes_bed_path,
            )
        if spec.annot_transcripts and GENOME_TX_BED.is_file():
            tx_bed_path = work_dir / "filtered_tx.bed"
            _write_filtered_bed(
                GENOME_TX_BED, spec.chrom, spec.plot_start, spec.plot_end,
                tx_bed_path,
            )

    ini_text = build_ini_content(spec, genes_bed=genes_bed_path, tx_bed=tx_bed_path)
    ini_path.write_text(ini_text, encoding="utf-8")

    if not Path(PYGT_PYTHON).is_file() or not PYGT_WRAPPER.is_file():
        raise PygtError(
            f"pyGenomeTracks wrapper not found "
            f"(python={PYGT_PYTHON}, wrapper={PYGT_WRAPPER}). "
            "Set PYGT_PYTHON env var to point at the env containing pyGenomeTracks."
        )

    cmd = [
        PYGT_PYTHON, str(PYGT_WRAPPER),
        "--tracks", str(ini_path),
        "--region", spec.region_str,
        "--outFileName", str(out_path),
        "--trackLabelFraction", f"{spec.track_label_fraction:.3f}",
        "--fontSize", str(spec.fontsize),
    ]

    try:
        proc = subprocess.run(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            timeout=timeout_sec,
            universal_newlines=True,
            check=False,
        )
    except subprocess.TimeoutExpired as exc:
        log_path.write_text(
            f"TIMEOUT after {timeout_sec}s\n\nCMD: {shlex.join(cmd)}\n",
            encoding="utf-8",
        )
        raise PygtError(f"pyGenomeTracks timed out after {timeout_sec}s") from exc

    log_text = proc.stdout or ""
    log_path.write_text(
        f"CMD: {shlex.join(cmd)}\nEXIT: {proc.returncode}\n\n{log_text}",
        encoding="utf-8",
    )

    if proc.returncode != 0 or not out_path.is_file():
        tail = "\n".join(log_text.strip().splitlines()[-20:])
        raise PygtError(
            f"pyGenomeTracks failed (exit={proc.returncode}). Last log lines:\n{tail}"
        )

    return RenderResult(
        artifact_path=out_path,
        ini_text=ini_text,
        log_text=log_text,
        cmd_line=shlex.join(cmd),
        warnings=out_of_range,
    )
