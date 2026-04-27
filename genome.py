"""Genome browser helpers: FASTA random access (.fai) and GTF SQLite index.

Used by `build_genome_index.py` (one-shot offline indexing) and `app.py`
(query API). No external bioinformatics tools are required - the .fai is
samtools-compatible and built in pure Python; the GTF index is plain SQLite.
"""

from __future__ import annotations

import os
import re
import sqlite3
from pathlib import Path
from typing import Iterator


# ---------------------------------------------------------------------------
# FASTA index (.fai)
# ---------------------------------------------------------------------------
#
# Samtools-compatible .fai layout (one line per sequence, tab-separated):
#   NAME  LENGTH  OFFSET  LINEBASES  LINEWIDTH
# - OFFSET    : byte offset (in the FASTA file) to the first base of the seq
# - LINEBASES : number of bases per line (must be constant within a seq except
#               possibly the last line)
# - LINEWIDTH : line length in bytes including the trailing newline (LINEBASES+1
#               for LF, LINEBASES+2 for CRLF)


def build_fai(fasta_path: Path, fai_path: Path, *, force: bool = False) -> Path:
    """Build a samtools-compatible .fai for the given FASTA file."""
    fasta_path = Path(fasta_path)
    fai_path = Path(fai_path)
    if fai_path.exists() and not force:
        if fai_path.stat().st_mtime >= fasta_path.stat().st_mtime:
            return fai_path

    rows: list[str] = []
    with fasta_path.open("rb") as fh:
        seq_name: str | None = None
        seq_offset = 0
        seq_length = 0
        line_bases: int | None = None
        line_width: int | None = None
        last_line_short = False  # last line of current seq was already shorter

        offset = 0
        for raw in fh:
            line_len = len(raw)
            if raw.startswith(b">"):
                if seq_name is not None:
                    rows.append(
                        f"{seq_name}\t{seq_length}\t{seq_offset}\t"
                        f"{line_bases or 0}\t{line_width or 0}"
                    )
                header = raw[1:].decode("utf-8", errors="replace").rstrip("\r\n")
                seq_name = header.split()[0] if header else ""
                seq_offset = offset + line_len
                seq_length = 0
                line_bases = None
                line_width = None
                last_line_short = False
            else:
                stripped = raw.rstrip(b"\r\n")
                bases = len(stripped)
                if bases == 0:
                    offset += line_len
                    continue
                if line_bases is None:
                    line_bases = bases
                    line_width = line_len
                else:
                    if last_line_short:
                        # multiple short lines inside one record => not indexable
                        raise ValueError(
                            f"FASTA sequence {seq_name!r} has inconsistent line "
                            f"widths; cannot build .fai"
                        )
                    if bases < line_bases:
                        last_line_short = True
                    elif bases != line_bases:
                        raise ValueError(
                            f"FASTA sequence {seq_name!r} has inconsistent line "
                            f"widths; cannot build .fai"
                        )
                seq_length += bases
            offset += line_len

        if seq_name is not None:
            rows.append(
                f"{seq_name}\t{seq_length}\t{seq_offset}\t"
                f"{line_bases or 0}\t{line_width or 0}"
            )

    fai_path.write_text("\n".join(rows) + "\n")
    return fai_path


def load_fai(fai_path: Path) -> dict[str, dict]:
    out: dict[str, dict] = {}
    with Path(fai_path).open("r", encoding="utf-8") as fh:
        for line in fh:
            line = line.rstrip("\n")
            if not line:
                continue
            name, length, offset, lb, lw = line.split("\t")
            out[name] = {
                "length": int(length),
                "offset": int(offset),
                "line_bases": int(lb),
                "line_width": int(lw),
            }
    return out


def read_fasta_region(
    fasta_path: Path, fai: dict[str, dict], chrom: str, start: int, end: int
) -> str:
    """Read DNA from `chrom:start-end` (1-based inclusive, like samtools).

    Returns uppercase DNA without newlines.
    """
    if chrom not in fai:
        raise KeyError(f"chromosome {chrom!r} not in index")
    info = fai[chrom]
    length = info["length"]
    if start < 1:
        start = 1
    if end > length:
        end = length
    if start > end:
        return ""

    line_bases = info["line_bases"]
    line_width = info["line_width"]
    offset = info["offset"]

    s = start - 1  # 0-based
    e = end  # exclusive
    byte_start = offset + (s // line_bases) * line_width + (s % line_bases)
    # bytes to read: full lines and partial first/last
    last = e - 1
    byte_end = offset + (last // line_bases) * line_width + (last % line_bases) + 1
    with open(fasta_path, "rb") as fh:
        fh.seek(byte_start)
        block = fh.read(byte_end - byte_start)
    return re.sub(r"[\r\n\s]+", "", block.decode("ascii", errors="replace")).upper()


# ---------------------------------------------------------------------------
# GTF -> SQLite index
# ---------------------------------------------------------------------------

GTF_FEATURE_TYPES = (
    "gene",
    "transcript",
    "exon",
    "CDS",
    "five_prime_utr",
    "three_prime_utr",
    "start_codon",
    "stop_codon",
)


_ATTR_RE = re.compile(r'(\w+)\s+"([^"]*)"')


def parse_gtf_attributes(s: str) -> dict[str, str]:
    return {m.group(1): m.group(2) for m in _ATTR_RE.finditer(s)}


def iter_gtf(gtf_path: Path) -> Iterator[tuple]:
    """Yield parsed GTF rows: (chrom, source, type, start, end, strand, phase, attrs)."""
    with Path(gtf_path).open("r", encoding="utf-8", errors="replace") as fh:
        for raw in fh:
            if not raw or raw.startswith("#"):
                continue
            parts = raw.rstrip("\n").split("\t")
            if len(parts) < 9:
                continue
            chrom, source, ftype, start, end, _score, strand, phase, attr_str = parts[:9]
            try:
                start_i = int(start)
                end_i = int(end)
            except ValueError:
                continue
            if ftype not in GTF_FEATURE_TYPES:
                continue
            attrs = parse_gtf_attributes(attr_str)
            yield (
                chrom,
                source,
                ftype,
                start_i,
                end_i,
                strand,
                phase,
                attrs,
            )


def build_gtf_sqlite(
    gtf_path: Path, db_path: Path, *, force: bool = False, log=print
) -> Path:
    """Parse GTF into a SQLite database with proper indexes for region/gene queries."""
    gtf_path = Path(gtf_path)
    db_path = Path(db_path)
    if db_path.exists() and not force:
        if db_path.stat().st_mtime >= gtf_path.stat().st_mtime:
            return db_path

    tmp_path = db_path.with_suffix(db_path.suffix + ".tmp")
    if tmp_path.exists():
        tmp_path.unlink()

    log(f"[gtf] building SQLite index at {tmp_path}")
    conn = sqlite3.connect(tmp_path)
    conn.execute("PRAGMA journal_mode = OFF")
    conn.execute("PRAGMA synchronous = OFF")
    conn.execute("PRAGMA temp_store = MEMORY")
    conn.execute("PRAGMA cache_size = -200000")  # ~200MB

    conn.executescript(
        """
        CREATE TABLE features (
            id INTEGER PRIMARY KEY,
            chrom TEXT NOT NULL,
            source TEXT,
            type TEXT NOT NULL,
            start INTEGER NOT NULL,
            end INTEGER NOT NULL,
            strand TEXT,
            phase TEXT,
            gene_id TEXT,
            transcript_id TEXT,
            gene_name TEXT,
            gene_biotype TEXT,
            transcript_biotype TEXT
        );

        CREATE TABLE meta (
            key TEXT PRIMARY KEY,
            value TEXT
        );
        """
    )

    insert_sql = (
        "INSERT INTO features (chrom, source, type, start, end, strand, phase, "
        "gene_id, transcript_id, gene_name, gene_biotype, transcript_biotype) "
        "VALUES (?,?,?,?,?,?,?,?,?,?,?,?)"
    )

    batch: list[tuple] = []
    n = 0
    BATCH = 20000
    for chrom, source, ftype, start, end, strand, phase, attrs in iter_gtf(gtf_path):
        batch.append(
            (
                chrom,
                source,
                ftype,
                start,
                end,
                strand,
                phase,
                attrs.get("gene_id"),
                attrs.get("transcript_id"),
                attrs.get("gene_name"),
                attrs.get("gene_biotype"),
                attrs.get("transcript_biotype"),
            )
        )
        if len(batch) >= BATCH:
            conn.executemany(insert_sql, batch)
            n += len(batch)
            batch.clear()
            if n % 200000 == 0:
                log(f"[gtf] inserted {n} rows")
    if batch:
        conn.executemany(insert_sql, batch)
        n += len(batch)
    conn.commit()
    log(f"[gtf] inserted {n} rows total; building indexes ...")

    conn.executescript(
        """
        CREATE INDEX idx_features_region    ON features (chrom, start, end);
        CREATE INDEX idx_features_chrom_end ON features (chrom, end);
        CREATE INDEX idx_features_type      ON features (type);
        CREATE INDEX idx_features_gene_id   ON features (gene_id);
        CREATE INDEX idx_features_gene_name ON features (gene_name);
        CREATE INDEX idx_features_tx_id     ON features (transcript_id);
        """
    )
    conn.execute("INSERT INTO meta(key, value) VALUES ('source', ?)", (str(gtf_path),))
    conn.execute("INSERT INTO meta(key, value) VALUES ('rows', ?)", (str(n),))
    conn.commit()
    conn.execute("VACUUM")
    conn.commit()
    conn.close()

    os.replace(tmp_path, db_path)
    log(f"[gtf] done: {db_path}")
    return db_path


# ---------------------------------------------------------------------------
# Query helpers (used by app.py)
# ---------------------------------------------------------------------------

def gtf_connect(db_path: Path) -> sqlite3.Connection:
    conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    return conn


def features_in_region(
    conn: sqlite3.Connection,
    chrom: str,
    start: int,
    end: int,
    types: list[str] | None = None,
    limit: int = 5000,
) -> list[sqlite3.Row]:
    """Fetch features whose [start,end] overlaps the requested region.

    Coordinates are 1-based inclusive (GTF convention).
    """
    where = ["chrom = ?", "start <= ?", "end >= ?"]
    params: list = [chrom, end, start]
    if types:
        placeholders = ",".join(["?"] * len(types))
        where.append(f"type IN ({placeholders})")
        params.extend(types)
    sql = (
        "SELECT id, chrom, source, type, start, end, strand, phase, "
        "gene_id, transcript_id, gene_name, gene_biotype, transcript_biotype "
        "FROM features WHERE " + " AND ".join(where) + " ORDER BY start, end LIMIT ?"
    )
    params.append(limit)
    return list(conn.execute(sql, params).fetchall())


def search_genes(conn: sqlite3.Connection, q: str, limit: int = 50) -> list[sqlite3.Row]:
    """Backwards-compatible: search by gene_name / gene_id only."""
    if not q:
        return []
    pat = f"%{q}%"
    sql = (
        "SELECT chrom, start, end, strand, gene_id, gene_name, gene_biotype "
        "FROM features WHERE type='gene' AND ("
        "gene_name LIKE ? OR gene_id LIKE ?) "
        "ORDER BY (gene_name = ?) DESC, (gene_id = ?) DESC, gene_name LIMIT ?"
    )
    return list(conn.execute(sql, (pat, pat, q, q, limit)).fetchall())


def search_features(conn: sqlite3.Connection, q: str, limit: int = 30) -> list[dict]:
    """Search by gene_name / gene_id / transcript_id.

    Returns plain dict rows (not sqlite3.Row) with a `hit_type` field of
    either 'gene' or 'transcript'. Genes are returned first, then transcripts.
    """
    if not q:
        return []
    pat = f"%{q}%"
    out: list[dict] = []

    # Exact gene_name / gene_id / transcript_id float to the top of each section.
    gene_rows = conn.execute(
        "SELECT chrom, start, end, strand, gene_id, gene_name, gene_biotype "
        "FROM features WHERE type='gene' AND (gene_name LIKE ? OR gene_id LIKE ?) "
        "ORDER BY (gene_name = ?) DESC, (gene_id = ?) DESC, gene_name LIMIT ?",
        (pat, pat, q, q, limit),
    ).fetchall()
    for r in gene_rows:
        out.append({
            "hit_type": "gene",
            "chrom": r["chrom"],
            "start": int(r["start"]),
            "end": int(r["end"]),
            "strand": r["strand"],
            "gene_id": r["gene_id"],
            "gene_name": r["gene_name"],
            "gene_biotype": r["gene_biotype"],
            "transcript_id": None,
            "transcript_biotype": None,
        })

    remaining = max(0, limit - len(out))
    if remaining > 0:
        tx_rows = conn.execute(
            "SELECT chrom, start, end, strand, gene_id, gene_name, gene_biotype, "
            "transcript_id, transcript_biotype "
            "FROM features WHERE type='transcript' AND transcript_id LIKE ? "
            "ORDER BY (transcript_id = ?) DESC, transcript_id LIMIT ?",
            (pat, q, remaining),
        ).fetchall()
        for r in tx_rows:
            out.append({
                "hit_type": "transcript",
                "chrom": r["chrom"],
                "start": int(r["start"]),
                "end": int(r["end"]),
                "strand": r["strand"],
                "gene_id": r["gene_id"],
                "gene_name": r["gene_name"],
                "gene_biotype": r["gene_biotype"],
                "transcript_id": r["transcript_id"],
                "transcript_biotype": r["transcript_biotype"],
            })
    return out


def list_chromosomes(fai: dict[str, dict], top_n: int | None = None) -> list[dict]:
    items = sorted(
        fai.items(), key=lambda kv: (-kv[1]["length"], kv[0])
    )
    out = [{"name": k, "length": v["length"]} for k, v in items]
    if top_n is not None:
        out = out[:top_n]
    return out
