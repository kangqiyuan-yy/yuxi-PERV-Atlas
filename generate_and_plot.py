#!/usr/bin/env python3
"""Generate PyGenomeTracks ini files from 04_recommended_tracks.tsv and run pyGenomeTracks."""

import argparse
import csv
import logging
import os
import subprocess
import sys

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.dirname(os.path.dirname(SCRIPT_DIR))
DEFAULT_TSV = os.path.join(
    PROJECT_ROOT, "deeptools/signal_analysis/results/04_recommended_tracks.tsv"
)
DEFAULT_OUTPUT = os.path.join(SCRIPT_DIR, "output")
REFERENCE_INI = os.path.join(SCRIPT_DIR, "tracks.ini")
PYGENOMETRACKS = "/opt/service/miniconda3/envs/rex_env/bin/pyGenomeTracks"
RNA_BW_DIR = os.path.join(PROJECT_ROOT, "RNA-seq/data_bw")
WGBS_BW_DIR = os.path.join(PROJECT_ROOT, "WGBS/data_bw")
CHIP_BW_DIR = os.path.join(PROJECT_ROOT, "ChIP-seq/data_bw")

FLANK_BP = 10000
# Right label column width; 0.10 is pyGenomeTracks default (left y-axis column is 0.01).
# Keep >= 0.10 so titles stay on one line.
TRACK_LABEL_FRACTION = 0.11
TRACK_SPACER_HEIGHT = 0.12

# Match reference tracks.ini: ATAC -> active marks -> repressive marks -> RNA -> WGBS
# H3K9ac is inserted after H3K36me3 (active mark, not in original S_PIEC panel)
SEQTYPE_ORDER = [
    "ATAC",
    "H3K27ac",
    "H3K4me1",
    "H3K4me3",
    "H3K36me3",
    "H3K9ac",
    "Pol2",
    "H3K27me3",
    "H3K9me3",
    "RNA_Rep1",
    "RNA_Rep2",
    "WGBS_Rep1",
    "WGBS_Rep2",
]

SEQTYPE_COLORS = {
    "ATAC": "#8dd3c7",
    "H3K27ac": "#bf812d",
    "H3K9ac": "#bc80bd",
    "Pol2": "#a65628",
    "H3K4me1": "#bebada",
    "H3K4me3": "#fb8072",
    "H3K36me3": "#80b1d3",
    "H3K27me3": "#fdb462",
    "H3K9me3": "#b3de69",
    "RNA": "#fccde5",
    "RNA_Rep1": "#fccde5",
    "RNA_Rep2": "#fccde5",
    "WGBS": "#d9d9d9",
    "WGBS_Rep1": "#d9d9d9",
    "WGBS_Rep2": "#d9d9d9",
}

BIGWIG_TRACK_TEMPLATE = """\
[{section}]
file = {file_path}
title = {title}
height = 2
color = {color}
min_value = 0
number_of_bins = 700
nans_to_zeros = true
summary_method = mean
show_data_range = true
file_type = bigwig
"""

SPACER_TEMPLATE = """\
[spacer]
height = {height}
"""


class TrackGroup(object):
    def __init__(self, interval, sample, chrom, start, end):
        self.interval = interval
        self.sample = sample
        self.chrom = chrom
        self.start = int(start)
        self.end = int(end)
        self.tracks = {}

    @property
    def basename(self):
        return "{0}_{1}".format(self.interval, self.sample)

    @property
    def region(self):
        plot_start = max(0, self.start - FLANK_BP)
        plot_end = self.end + FLANK_BP
        return "{0}:{1}-{2}".format(self.chrom, plot_start, plot_end)


def ensure_perv_bed():
    """Build PERV_genes.bed from GTF; prefix spaces add gap between bar and label."""
    gtf_path = os.path.join(PROJECT_ROOT, "pygenome/ref/PERV.gtf")
    bed_path = os.path.join(PROJECT_ROOT, "pygenome/ref/PERV_genes.bed")
    if not os.path.isfile(gtf_path):
        return
    lines = []
    with open(gtf_path, "r") as handle:
        for line in handle:
            if line.startswith("#") or "\tgene\t" not in line:
                continue
            fields = line.rstrip("\n").split("\t")
            chrom, start, end, strand = fields[0], fields[3], fields[4], fields[6]
            name = chrom
            if 'gene_name "' in line:
                name = line.split('gene_name "')[1].split('"')[0]
            bed_start = str(int(start) - 1)
            lines.append(
                "\t".join([chrom, bed_start, end, "    {0}".format(name), "0", strand])
            )
    with open(bed_path, "w") as handle:
        handle.write("\n".join(lines) + "\n")


# Visual constants — keep PERV/gene arrow visual height matched.
PERV_TRACK_HEIGHT_CM = 0.65
PERV_COLLAPSED_YLIM_RANGE = 110.0   # pyGenomeTracks hard-codes (-5, 105)
INTERVAL_HEIGHT = 90                # data units per arrow
ROW_SCALE_FACTOR = 2.3              # pyGenomeTracks row spacing in stacked mode


def _gene_max_rows(pig_genes_bed, chrom, start, end, label_fontsize_bp_per_char=120):
    """Estimate how many stacked rows pyGenomeTracks will use in a given window.

    Mimics the algorithm in BedTrack.process_bed() so we can pick a track
    height that makes each gene arrow as thick as the PERV arrow.
    """
    if not os.path.isfile(pig_genes_bed):
        return 1
    feats = []
    with open(pig_genes_bed) as fh:
        for line in fh:
            if not line.strip():
                continue
            p = line.rstrip("\n").split("\t")
            if p[0] != chrom:
                continue
            s, e, name = int(p[1]), int(p[2]), p[3]
            if e <= start or s >= end:
                continue
            feats.append((s, e, name))
    if not feats:
        return 1
    feats.sort()
    row_last = []
    for s, e, name in feats:
        # bed_extended_end mirrors pyGenomeTracks: end + (n_chars+2) * len_w
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


def _gene_track_height_cm(rows):
    """Return height (cm) so each gene arrow matches PERV arrow visual height."""
    # PERV visual arrow height (cm)
    perv_visual = (INTERVAL_HEIGHT / PERV_COLLAPSED_YLIM_RANGE) * PERV_TRACK_HEIGHT_CM
    # stacked ylim range = (rows-1) * (interval_height * ROW_SCALE_FACTOR) + interval_height
    ylim_range = (rows - 1) * (INTERVAL_HEIGHT * ROW_SCALE_FACTOR) + INTERVAL_HEIGHT
    return perv_visual * (ylim_range / INTERVAL_HEIGHT)


def load_annotation_blocks(interval_name, gene_rows=2):
    """Build bottom annotation ini blocks for a specific PERV interval.

    PERV structure
    --------------
    A single BED9 track with ``color = bed_rgb`` and ``display = collapsed``
    shows lLTR / coding / rLTR on ONE row with per-feature colours.

    Label placement trick
    ---------------------
    pyGenomeTracks v3 places feature labels at ``bed.end + small_relative``
    (horizontally to the RIGHT of the bar).  A white (invisible) 1 bp anchor
    ending at lLTR_genome_start is embedded in PERV_structure.bed so that the
    "lLTR" text lands at the *upstream* edge of the lLTR bar.  "rLTR" on the
    actual rLTR bar places the text in the downstream flank.  The coding bar
    has an empty name so it shows no label.

    The right-axis title is set to the PERV interval name (e.g. RF1-132.023M).
    """
    structure_bed = os.path.join(PROJECT_ROOT, "pygenome/ref/PERV_structure.bed")
    perv_labels_bed = os.path.join(PROJECT_ROOT, "pygenome/ref/PERV_labels.bed")
    pig_genes_bed = os.path.join(PROJECT_ROOT, "pygenome/ref/pig_genes_PERV_regions.bed")

    if os.path.isfile(structure_bed) and os.path.isfile(perv_labels_bed):
        perv_block = """\
[spacer]
height = 0.3

[PERV_structure]
file = ../../ref/PERV_structure.bed
title = {interval}
height = 0.65
color = bed_rgb
labels = false
fontsize = 12
border color = black
interval_height = 90
style = flybase
display = collapsed
file_type = bed

[PERV_labels]
file = ../../ref/PERV_labels.bed
overlay previous = yes
height = 0.65
title =
color = #ffffff
labels = true
fontsize = 12
border color = none
interval_height = 90
style = flybase
display = collapsed
file_type = bed
""".format(interval=interval_name)
    else:
        logging.warning(
            "PERV_structure.bed not found; falling back to PERV_genes.bed. "
            "Run pygenome/ref/build_ref_beds.py to generate it."
        )
        perv_block = """\
[PERV]
file = ../../ref/PERV_genes.bed
title = {interval}
height = 0.55
color = #cab2d6
labels = true
fontsize = 11
border_color = black
style = flybase
display = collapsed
file_type = bed
""".format(interval=interval_name)

    if os.path.isfile(pig_genes_bed):
        gene_track_h = _gene_track_height_cm(max(1, gene_rows))
        pig_block = """\
[spacer]
height = 0.5

[pig_genes_title]
spacer =
height = {h:.2f}
title = Sus scrofa genes

[pig_genes]
file = ../../ref/pig_genes_PERV_regions.bed
overlay previous = yes
height = {h:.2f}
title =
color = bed_rgb
labels = true
fontsize = 12
border color = black
interval_height = 90
style = flybase
display = stacked
file_type = bed
""".format(h=gene_track_h)
    else:
        logging.warning(
            "pig_genes_PERV_regions.bed not found; gene annotation track skipped. "
            "Run pygenome/ref/build_ref_beds.py to generate it."
        )
        pig_block = ""

    return perv_block + pig_block


def is_valid_bw_path(path):
    if not path or path.strip() == "NOT_FOUND":
        return False
    return os.path.isfile(path)


def replicate_bw_paths(sample, assay):
    """Return (rep1_path, rep2_path) for RNA or WGBS."""
    if assay == "RNA":
        rep1 = os.path.join(RNA_BW_DIR, "{0}_RNA_Rep1.bw".format(sample))
        rep2 = os.path.join(RNA_BW_DIR, "{0}_RNA_Rep2.bw".format(sample))
    elif assay == "WGBS":
        rep1 = os.path.join(WGBS_BW_DIR, "{0}_WGBS_Rep1.cpg.bw".format(sample))
        rep2 = os.path.join(WGBS_BW_DIR, "{0}_WGBS_Rep2.cpg.bw".format(sample))
    else:
        raise ValueError("Unsupported assay: {0}".format(assay))
    return rep1, rep2


def add_replicate_tracks(group, assay):
    rep1, rep2 = replicate_bw_paths(group.sample, assay)
    added = 0
    if is_valid_bw_path(rep1):
        key = "{0}_Rep1".format(assay)
        group.tracks[key] = rep1
        added += 1
    if is_valid_bw_path(rep2):
        key = "{0}_Rep2".format(assay)
        group.tracks[key] = rep2
        added += 1
    return added


def add_pol2_track(group):
    """Add RNA Pol II ChIP-seq (merged reps) when available for this sample."""
    path = os.path.join(CHIP_BW_DIR, "{0}_Pol2_Reps.Pval.bw".format(group.sample))
    if is_valid_bw_path(path):
        group.tracks["Pol2"] = path


def enrich_replicate_tracks(group):
    """Expand single RNA track to Rep1/Rep2; add WGBS and Pol2 when available."""
    if "RNA" in group.tracks:
        group.tracks.pop("RNA", None)
        add_replicate_tracks(group, "RNA")
        add_replicate_tracks(group, "WGBS")
    add_pol2_track(group)


def parse_tsv(tsv_path):
    groups = {}

    with open(tsv_path, "r") as handle:
        reader = csv.DictReader(handle, delimiter="\t")
        for row in reader:
            interval = row["interval"]
            sample = row["balanced_sample"]
            seqtype = row["seqtype"]
            bw_path = row["bw_path_balanced"].strip()

            if not is_valid_bw_path(bw_path):
                continue

            key = (interval, sample)
            if key not in groups:
                groups[key] = TrackGroup(
                    interval=interval,
                    sample=sample,
                    chrom=row["chr"],
                    start=int(row["interval_start"]),
                    end=int(row["interval_end"]),
                )
            group = groups[key]
            if group.tracks.get(seqtype) and group.tracks[seqtype] != bw_path:
                logging.warning(
                    "Duplicate seqtype %s for %s/%s; keeping first path",
                    seqtype,
                    interval,
                    sample,
                )
                continue
            group.tracks[seqtype] = bw_path

    result = []
    for group in sorted(groups.values(), key=lambda g: (g.interval, g.sample)):
        enrich_replicate_tracks(group)
        result.append(group)

    if not result:
        raise RuntimeError("No valid track groups found in TSV")
    return result


def append_spacer(lines):
    lines.append(
        SPACER_TEMPLATE.format(height=TRACK_SPACER_HEIGHT).rstrip()
    )
    lines.append("")


def build_ini_content(group):
    pig_genes_bed = os.path.join(PROJECT_ROOT, "pygenome/ref/pig_genes_PERV_regions.bed")
    window_start = max(0, group.start - FLANK_BP)
    window_end = group.end + FLANK_BP
    n_gene_rows = _gene_max_rows(pig_genes_bed, group.chrom, window_start, window_end)
    annotation_blocks = load_annotation_blocks(group.interval, gene_rows=n_gene_rows)
    lines = ["[x-axis]", ""]
    append_spacer(lines)

    order_index = {name: i for i, name in enumerate(SEQTYPE_ORDER)}
    sorted_seqtypes = sorted(
        group.tracks.keys(),
        key=lambda s: order_index.get(s, len(SEQTYPE_ORDER)),
    )

    for idx, seqtype in enumerate(sorted_seqtypes):
        color = SEQTYPE_COLORS.get(seqtype)
        if color is None:
            logging.warning("Unknown seqtype %s; using gray", seqtype)
            color = "#999999"

        if seqtype.startswith("RNA_") or seqtype.startswith("WGBS_"):
            title = "{0}_{1}".format(group.sample, seqtype)
        else:
            title = "{0}_{1}".format(group.sample, seqtype)

        section = title
        lines.append(
            BIGWIG_TRACK_TEMPLATE.format(
                section=section,
                file_path=group.tracks[seqtype],
                title=title,
                color=color,
            ).rstrip()
        )
        lines.append("")
        if idx < len(sorted_seqtypes) - 1:
            append_spacer(lines)

    append_spacer(lines)
    lines.append(annotation_blocks.rstrip())
    lines.append("")
    return "\n".join(lines)


def write_ini(group, output_dir):
    ini_path = os.path.join(output_dir, "{0}.ini".format(group.basename))
    with open(ini_path, "w") as handle:
        handle.write(build_ini_content(group))
    return ini_path


def run_pygenome(ini_path, region, pdf_path, pygenometracks_bin):
    cmd = [
        pygenometracks_bin,
        "--tracks",
        str(ini_path),
        "--region",
        region,
        "--outFileName",
        str(pdf_path),
        "--trackLabelFraction",
        str(TRACK_LABEL_FRACTION),
        "--fontSize",
        "12",
    ]
    return subprocess.run(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        universal_newlines=True,
    )


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--tsv",
        default=DEFAULT_TSV,
        help="Input TSV (04_recommended_tracks.tsv)",
    )
    parser.add_argument(
        "--output-dir",
        default=DEFAULT_OUTPUT,
        help="Directory for ini/pdf/log output",
    )
    parser.add_argument(
        "--reference-ini",
        default=REFERENCE_INI,
        help="Reference tracks.ini (for PERV block)",
    )
    parser.add_argument(
        "--pygenometracks",
        default=PYGENOMETRACKS,
        help="Path to pyGenomeTracks executable",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Only generate ini files, do not plot",
    )
    parser.add_argument(
        "--plot-only",
        action="store_true",
        help="Only plot existing ini files (skip generation)",
    )
    parser.add_argument(
        "--limit",
        type=int,
        default=0,
        help="Process at most N groups (0 = all)",
    )
    parser.add_argument(
        "--filter",
        type=str,
        default="",
        help="Only process groups whose basename contains this substring",
    )
    args = parser.parse_args()

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
    )

    if not os.path.isdir(args.output_dir):
        os.makedirs(args.output_dir)
    log_path = os.path.join(args.output_dir, "run_pygenome.log")
    file_handler = logging.FileHandler(log_path, mode="w")
    file_handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(message)s"))
    logging.getLogger().addHandler(file_handler)

    ensure_perv_bed()
    groups = parse_tsv(args.tsv)
    if args.filter:
        groups = [g for g in groups if args.filter in g.basename]
    if args.limit > 0:
        groups = groups[: args.limit]

    logging.info("Found %d track groups", len(groups))

    if not args.plot_only:
        for group in groups:
            ini_path = write_ini(group, args.output_dir)
            logging.info(
                "Wrote %s (%d tracks)",
                os.path.basename(ini_path),
                len(group.tracks),
            )

    if args.dry_run:
        logging.info("Dry run complete; ini files in %s", args.output_dir)
        return 0

    if not os.path.isfile(args.pygenometracks):
        logging.error("pyGenomeTracks not found: %s", args.pygenometracks)
        return 1

    ok, fail = 0, 0
    for group in groups:
        ini_path = os.path.join(args.output_dir, "{0}.ini".format(group.basename))
        pdf_path = os.path.join(args.output_dir, "{0}.pdf".format(group.basename))
        if not os.path.isfile(ini_path):
            logging.error("Missing ini: %s", ini_path)
            fail += 1
            continue

        logging.info("Plotting %s region=%s", group.basename, group.region)
        result = run_pygenome(ini_path, group.region, pdf_path, args.pygenometracks)
        if result.returncode == 0 and os.path.isfile(pdf_path):
            logging.info("OK %s", os.path.basename(pdf_path))
            ok += 1
        else:
            logging.error(
                "FAIL %s (code=%s)\nstdout: %s\nstderr: %s",
                group.basename,
                result.returncode,
                (result.stdout or "").strip()[-2000:],
                (result.stderr or "").strip()[-2000:],
            )
            fail += 1

    logging.info("Done: %d succeeded, %d failed", ok, fail)
    return 0 if fail == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
