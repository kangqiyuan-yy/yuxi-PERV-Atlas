"""Genome browser helpers: FASTA random access (.fai) and GTF SQLite index.

Used by `build_genome_index.py` (one-shot offline indexing) and `app.py`
(query API). No external bioinformatics tools are required - the .fai is
samtools-compatible and built in pure Python; the GTF index is plain SQLite.
"""

from __future__ import annotations

import os
import re
import sqlite3
import threading
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
                attr_str.strip(),
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
            transcript_biotype TEXT,
            attr_str TEXT
        );

        CREATE TABLE meta (
            key TEXT PRIMARY KEY,
            value TEXT
        );
        """
    )

    insert_sql = (
        "INSERT INTO features (chrom, source, type, start, end, strand, phase, "
        "gene_id, transcript_id, gene_name, gene_biotype, transcript_biotype, attr_str) "
        "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)"
    )

    batch: list[tuple] = []
    n = 0
    BATCH = 20000
    for chrom, source, ftype, start, end, strand, phase, attrs, attr_str in iter_gtf(gtf_path):
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
                attr_str,
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
        "gene_id, transcript_id, gene_name, gene_biotype, transcript_biotype, attr_str "
        "FROM features WHERE " + " AND ".join(where) + " ORDER BY start, end LIMIT ?"
    )
    params.append(limit)
    return list(conn.execute(sql, params).fetchall())


def features_by_gene_id(
    conn: sqlite3.Connection,
    gene_id: str,
    limit: int = 200000,
) -> list[sqlite3.Row]:
    """Fetch all features (gene/transcript/exon/CDS/UTR/...) belonging to a
    single gene_id, regardless of coordinate overlap with anything else.

    This is what "export this gene's GTF" should use instead of a region
    (start/end) query, since a region query would also pick up unrelated
    genes/features that merely overlap the same coordinate span.
    """
    sql = (
        "SELECT id, chrom, source, type, start, end, strand, phase, "
        "gene_id, transcript_id, gene_name, gene_biotype, transcript_biotype, attr_str "
        "FROM features WHERE gene_id = ? ORDER BY start, end LIMIT ?"
    )
    return list(conn.execute(sql, (gene_id, limit)).fetchall())


def features_by_transcript_id(
    conn: sqlite3.Connection,
    transcript_id: str,
    limit: int = 200000,
) -> list[sqlite3.Row]:
    """Fetch all features (transcript/exon/CDS/UTR/start_codon/stop_codon)
    belonging to a single transcript_id. The parent gene's own `gene` line
    (which has no transcript_id) is intentionally excluded, since callers
    asking for "just this transcript" want an isoform-scoped GTF.
    """
    sql = (
        "SELECT id, chrom, source, type, start, end, strand, phase, "
        "gene_id, transcript_id, gene_name, gene_biotype, transcript_biotype, attr_str "
        "FROM features WHERE transcript_id = ? ORDER BY start, end LIMIT ?"
    )
    return list(conn.execute(sql, (transcript_id, limit)).fetchall())


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


# ---------------------------------------------------------------------------
# In-memory search index (gene / transcript name & id lookup)
# ---------------------------------------------------------------------------
#
# The `features` table holds every GTF record (gene/transcript/exon/CDS/UTR/
# codons - well over a million rows), but the search box only ever needs the
# small `gene` + `transcript` subset (~7% of rows) and a handful of columns
# (name/id/coordinates/biotype). Querying the full table with `LIKE '%q%'`
# on every keystroke is expensive in two ways: the wildcard prevents index
# usage for the substring match itself, and any column not covered by an
# index (e.g. gene_id, coordinates) forces a random per-row disk read once
# the `type` index narrows candidates - on slow/network-backed storage this
# alone can take several seconds per request.
#
# Instead we build a tiny in-memory index once per db file (rebuilt only if
# the file's mtime changes) using a single *sequential* full-table scan
# (`+type` disables the type index so SQLite can't fall back to random
# per-row lookups), then serve every subsequent search purely from Python
# memory - no SQLite/disk access at all.

_SEARCH_INDEX_CACHE: dict[str, tuple[float | None, list[dict], list[dict]]] = {}
_SEARCH_INDEX_LOCK = threading.Lock()


def _search_index_for(conn: sqlite3.Connection) -> tuple[list[dict], list[dict]]:
    """Return (genes, transcripts) lean in-memory records for `conn`'s db file.

    Cached per db file path + mtime, so the (~1-2s) full scan only happens
    once per process, and again automatically after the GTF index is rebuilt.
    """
    db_path: str | None = None
    try:
        row = conn.execute("PRAGMA database_list").fetchone()
        db_path = row["file"] if row is not None else None
    except Exception:
        db_path = None
    mtime: float | None = None
    if db_path:
        try:
            mtime = os.path.getmtime(db_path)
        except OSError:
            mtime = None
    cache_key = db_path or "default"

    cached = _SEARCH_INDEX_CACHE.get(cache_key)
    if cached is not None and cached[0] == mtime:
        return cached[1], cached[2]

    with _SEARCH_INDEX_LOCK:
        # Re-check after acquiring the lock: another thread may have just
        # finished building the same index while we were waiting.
        cached = _SEARCH_INDEX_CACHE.get(cache_key)
        if cached is not None and cached[0] == mtime:
            return cached[1], cached[2]

        rows = conn.execute(
            "SELECT type, chrom, start, end, strand, gene_id, transcript_id, "
            "gene_name, gene_biotype, transcript_biotype "
            "FROM features WHERE +type='gene' OR +type='transcript'"
        ).fetchall()

        genes: list[dict] = []
        transcripts: list[dict] = []
        for r in rows:
            if r["type"] == "gene":
                name = r["gene_name"] or ""
                gid = r["gene_id"] or ""
                genes.append({
                    "chrom": r["chrom"],
                    "start": int(r["start"]),
                    "end": int(r["end"]),
                    "strand": r["strand"],
                    "gene_id": gid,
                    "gene_name": name,
                    "gene_biotype": r["gene_biotype"],
                    "_name_l": name.lower(),
                    "_id_l": gid.lower(),
                })
            elif r["type"] == "transcript":
                tid = r["transcript_id"] or ""
                transcripts.append({
                    "chrom": r["chrom"],
                    "start": int(r["start"]),
                    "end": int(r["end"]),
                    "strand": r["strand"],
                    "gene_id": r["gene_id"] or "",
                    "gene_name": r["gene_name"] or "",
                    "gene_biotype": r["gene_biotype"],
                    "transcript_id": tid,
                    "transcript_biotype": r["transcript_biotype"],
                    "_tid_l": tid.lower(),
                })
        genes.sort(key=lambda g: g["gene_name"])
        transcripts.sort(key=lambda t: t["transcript_id"])
        _SEARCH_INDEX_CACHE[cache_key] = (mtime, genes, transcripts)
        return genes, transcripts


def warm_search_index(conn: sqlite3.Connection) -> None:
    """Eagerly build the in-memory search index (call once at app startup)."""
    _search_index_for(conn)


def search_features(conn: sqlite3.Connection, q: str, limit: int = 30) -> list[dict]:
    """Search by gene_name / gene_id / transcript_id.

    Returns plain dict rows (not sqlite3.Row) with a `hit_type` field of
    either 'gene' or 'transcript'. Genes are returned first, then transcripts.
    Served entirely from the in-memory index built by `_search_index_for`.
    """
    if not q:
        return []
    ql = q.lower()
    genes, transcripts = _search_index_for(conn)
    out: list[dict] = []

    gene_hits = [g for g in genes if ql in g["_name_l"] or ql in g["_id_l"]]
    gene_hits.sort(key=lambda g: (g["_name_l"] != ql, g["_id_l"] != ql, g["gene_name"]))
    for g in gene_hits[:limit]:
        out.append({
            "hit_type": "gene",
            "chrom": g["chrom"],
            "start": g["start"],
            "end": g["end"],
            "strand": g["strand"],
            "gene_id": g["gene_id"],
            "gene_name": g["gene_name"],
            "gene_biotype": g["gene_biotype"],
            "transcript_id": None,
            "transcript_biotype": None,
        })

    remaining = max(0, limit - len(out))
    if remaining > 0:
        tx_hits = [t for t in transcripts if ql in t["_tid_l"]]
        tx_hits.sort(key=lambda t: (t["_tid_l"] != ql, t["transcript_id"]))
        for t in tx_hits[:remaining]:
            out.append({
                "hit_type": "transcript",
                "chrom": t["chrom"],
                "start": t["start"],
                "end": t["end"],
                "strand": t["strand"],
                "gene_id": t["gene_id"],
                "gene_name": t["gene_name"],
                "gene_biotype": t["gene_biotype"],
                "transcript_id": t["transcript_id"],
                "transcript_biotype": t["transcript_biotype"],
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
