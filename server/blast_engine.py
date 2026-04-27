"""BLAST search engine for the PERV Atlas web UI.

This module mirrors the structure of ``pygt_engine.py``: it validates a
user-supplied request into a ``BlastSpec`` and runs the appropriate NCBI
BLAST+ program as a subprocess, returning the path to a JSON result file.

Three programs are supported, against two server-controlled databases:

- ``blastn``  : nucleotide query  vs  PERV nucleotide library  (perv_nt)
- ``blastp``  : protein query     vs  PERV protein library     (perv_protein)
- ``tblastn`` : protein query     vs  PERV nucleotide library  (perv_nt)

All database paths come from a server-side whitelist; the front-end only ever
supplies a program key, a database key, the raw query text, and a couple of
bounded numeric parameters.
"""

from __future__ import annotations

import json
import math
import os
import re
import subprocess
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any


BASE_DIR = Path(__file__).resolve().parent.parent
BLAST_DB_DIR = BASE_DIR / "data" / "blast_db"

# NCBI BLAST+ executables (same conda env as pyGenomeTracks). Absolute paths so
# behaviour does not depend on the runtime PATH.
_BIN_DIR = "/opt/service/miniconda3/envs/rex_env/bin"
BLASTN_BIN = os.environ.get("BLASTN_BIN", f"{_BIN_DIR}/blastn")
BLASTP_BIN = os.environ.get("BLASTP_BIN", f"{_BIN_DIR}/blastp")
TBLASTN_BIN = os.environ.get("TBLASTN_BIN", f"{_BIN_DIR}/tblastn")
MAKEBLASTDB_BIN = os.environ.get("MAKEBLASTDB_BIN", f"{_BIN_DIR}/makeblastdb")

# ── Database registry ────────────────────────────────────────────────────────
# ``stem`` is the makeblastdb -out prefix; index files live next to it.
DATABASES: dict[str, dict[str, Any]] = {
    "perv_nt": {
        "dbtype": "nucl",
        "stem": BLAST_DB_DIR / "perv_nt",
        "label_en": "PERV intact nucleotide (1165)",
        "label_zh": "PERV 完整核酸库 (1165)",
    },
    "perv_protein": {
        "dbtype": "prot",
        "stem": BLAST_DB_DIR / "perv_protein",
        "label_en": "PERV ORF protein (Gag/Pol/Env)",
        "label_zh": "PERV ORF 蛋白库 (Gag/Pol/Env)",
    },
}

# ``query`` is the molecule type the user must paste; ``db`` is the database key.
PROGRAMS: dict[str, dict[str, Any]] = {
    "blastn": {
        "bin": BLASTN_BIN,
        "query": "nucl",
        "db": "perv_nt",
        "label_en": "blastn (nucleotide vs nucleotide)",
        "label_zh": "blastn(核酸 → 核酸库)",
    },
    "blastp": {
        "bin": BLASTP_BIN,
        "query": "prot",
        "db": "perv_protein",
        "label_en": "blastp (protein vs protein)",
        "label_zh": "blastp(蛋白 → 蛋白库)",
    },
    "tblastn": {
        "bin": TBLASTN_BIN,
        "query": "prot",
        "db": "perv_nt",
        "label_en": "tblastn (protein vs translated nucleotide)",
        "label_zh": "tblastn(蛋白 → 核酸库)",
    },
}

# Query limits (defensive — keep subprocess fast and bounded).
MAX_QUERY_SEQS = 10
MAX_QUERY_RESIDUES = 50_000
MAX_SINGLE_SEQ_LEN = 50_000

# Bounded parameter ranges exposed to the UI.
# EVALUE_CHOICES are suggestions shown in the UI; users may also type any
# positive value up to MAX_EVALUE (validated server-side).
EVALUE_CHOICES = ("1e-50", "1e-20", "1e-10", "1e-5", "1e-2", "1", "10")
EVALUE_DEFAULT = "1e-5"
MAX_EVALUE = 10000.0
MAX_TARGET_MIN = 1
MAX_TARGET_MAX = 250
MAX_TARGET_DEFAULT = 10

_NUCL_RE = re.compile(r"^[ACGTUNRYSWKMBDHV]+$")
_PROT_RE = re.compile(r"^[ABCDEFGHIKLMNPQRSTVWXYZ*]+$")
_SEQID_SANITIZE_RE = re.compile(r"[^A-Za-z0-9._-]")


class BlastError(ValueError):
    """User-facing validation / run error."""


@dataclass
class BlastSpec:
    program: str
    db_key: str
    query_fasta: str          # cleaned, ready to write to query.fa
    n_seqs: int
    total_residues: int
    evalue: str
    max_target_seqs: int
    query_titles: list[str] = field(default_factory=list)  # original headers, for display


@dataclass
class BlastResult:
    json_path: Path
    cmd_line: str
    log_text: str
    parsed: dict = field(default_factory=dict)


def sanitize_seqid(value: str, max_len: int = 60) -> str:
    """Make a safe BLAST-compatible sequence id (no pipes/spaces)."""
    cleaned = _SEQID_SANITIZE_RE.sub("_", (value or "").strip())
    cleaned = cleaned.strip("_") or "query"
    return cleaned[:max_len]


def _parse_query_text(raw: str, mol: str) -> tuple[str, int, int, list[str]]:
    """Normalise pasted text into FASTA.

    Returns ``(fasta, n_seqs, residues, titles)`` where ``titles`` holds the
    original FASTA header line (everything after ``>``, description included)
    for each written record, in order. These are used only for display so the
    results show the user's real sequence ids; the FASTA written for BLAST
    still uses sanitized, BLAST-safe ids.

    Accepts either FASTA (one or more ``>`` records) or a single bare sequence.
    Validates residue alphabet against ``mol`` ('nucl' or 'prot').
    """
    if not raw or not raw.strip():
        raise BlastError("Query is empty.")

    text = raw.replace("\r\n", "\n").replace("\r", "\n").strip()
    records: list[tuple[str, str, str]] = []  # (first_token_id, seq, full_header)

    if text.lstrip().startswith(">"):
        cur_id: str | None = None
        cur_header = ""
        cur_seq: list[str] = []
        for line in text.split("\n"):
            if line.startswith(">"):
                if cur_id is not None:
                    records.append((cur_id, "".join(cur_seq), cur_header))
                header = line[1:].strip()
                cur_header = header
                cur_id = header.split()[0] if header else ""
                cur_seq = []
            else:
                cur_seq.append(re.sub(r"\s+", "", line))
        if cur_id is not None:
            records.append((cur_id, "".join(cur_seq), cur_header))
    else:
        seq = re.sub(r"\s+", "", text)
        records.append(("query_1", seq, ""))

    valid_re = _NUCL_RE if mol == "nucl" else _PROT_RE
    out_lines: list[str] = []
    titles: list[str] = []
    total = 0
    n = 0
    for idx, (sid, seq, header) in enumerate(records, start=1):
        seq = seq.upper()
        if not seq:
            continue
        if not valid_re.match(seq):
            bad = sorted({c for c in seq if not valid_re.match(c)})[:6]
            kind = "nucleotide" if mol == "nucl" else "protein"
            raise BlastError(
                f"Query sequence {sid or idx!r} contains characters that are "
                f"not valid for a {kind} query: {' '.join(bad)}"
            )
        if len(seq) > MAX_SINGLE_SEQ_LEN:
            raise BlastError(
                f"Query sequence {sid or idx!r} is too long "
                f"({len(seq)} > {MAX_SINGLE_SEQ_LEN} residues)."
            )
        clean_id = sanitize_seqid(sid or f"query_{idx}")
        out_lines.append(f">{clean_id}")
        out_lines.extend(seq[i:i + 70] for i in range(0, len(seq), 70))
        titles.append(header or sid or f"query_{idx}")
        total += len(seq)
        n += 1

    if n == 0:
        raise BlastError("No valid sequence found in the query.")
    if n > MAX_QUERY_SEQS:
        raise BlastError(f"Too many query sequences ({n} > {MAX_QUERY_SEQS}).")
    if total > MAX_QUERY_RESIDUES:
        raise BlastError(
            f"Total query length too large ({total} > {MAX_QUERY_RESIDUES} residues)."
        )
    return "\n".join(out_lines) + "\n", n, total, titles


def validate_spec(body: dict[str, Any]) -> BlastSpec:
    """Validate a raw request body into a BlastSpec or raise BlastError."""
    program = str(body.get("program", "")).strip().lower()
    if program not in PROGRAMS:
        raise BlastError(f"Unknown program: {program!r}")

    prog = PROGRAMS[program]
    db_key = str(body.get("db", prog["db"])).strip()
    if db_key not in DATABASES:
        raise BlastError(f"Unknown database: {db_key!r}")
    # Program ↔ database compatibility (db molecule type must match program).
    expected_db_type = "nucl" if program in ("blastn", "tblastn") else "prot"
    if DATABASES[db_key]["dbtype"] != expected_db_type:
        raise BlastError(
            f"Program {program} is not compatible with database {db_key}."
        )

    query_fasta, n_seqs, total, query_titles = _parse_query_text(
        str(body.get("query", "")), prog["query"]
    )

    evalue = str(body.get("evalue", EVALUE_DEFAULT)).strip()
    try:
        ev_val = float(evalue)
    except (TypeError, ValueError):
        raise BlastError(f"Invalid E-value: {evalue!r}")
    if not (math.isfinite(ev_val) and 0 < ev_val <= MAX_EVALUE):
        raise BlastError(
            f"E-value must be a positive number \u2264 {MAX_EVALUE:g} (got {evalue!r})."
        )

    try:
        max_target = int(body.get("max_target_seqs", MAX_TARGET_DEFAULT))
    except (TypeError, ValueError):
        raise BlastError("max_target_seqs must be an integer.")
    max_target = max(MAX_TARGET_MIN, min(MAX_TARGET_MAX, max_target))

    return BlastSpec(
        program=program,
        db_key=db_key,
        query_fasta=query_fasta,
        n_seqs=n_seqs,
        total_residues=total,
        evalue=evalue,
        max_target_seqs=max_target,
        query_titles=query_titles,
    )


def db_ready(db_key: str) -> bool:
    """True if the makeblastdb index files exist for the given database."""
    info = DATABASES.get(db_key)
    if not info:
        return False
    stem = str(info["stem"])
    suffixes = ((".nin", ".nhr", ".nsq") if info["dbtype"] == "nucl"
                else (".pin", ".phr", ".psq"))
    return all(Path(stem + s).exists() for s in suffixes)


def _build_cmd(spec: BlastSpec, query_path: Path, out_path: Path) -> list[str]:
    prog = PROGRAMS[spec.program]
    db_stem = str(DATABASES[spec.db_key]["stem"])
    return [
        prog["bin"],
        "-query", str(query_path),
        "-db", db_stem,
        "-outfmt", "15",          # BLAST JSON (single-file)
        "-evalue", spec.evalue,
        "-max_target_seqs", str(spec.max_target_seqs),
        "-num_threads", "2",
        "-out", str(out_path),
    ]


def render(spec: BlastSpec, work_dir: Path, *, timeout_sec: int = 90) -> BlastResult:
    """Run BLAST and return the result file path + parsed summary.

    Raises ``BlastError`` on missing DB / timeout / non-zero exit. The work_dir
    must already exist (the API layer owns its lifecycle).
    """
    work_dir.mkdir(parents=True, exist_ok=True)
    query_path = work_dir / "query.fa"
    out_path = work_dir / "out.json"
    log_path = work_dir / "run.log"

    if not db_ready(spec.db_key):
        raise BlastError(
            f"Database {spec.db_key!r} is not built yet. "
            "It is created automatically on server startup."
        )
    prog_bin = PROGRAMS[spec.program]["bin"]
    if not Path(prog_bin).is_file():
        raise BlastError(f"BLAST executable not found: {prog_bin}")

    query_path.write_text(spec.query_fasta, encoding="utf-8")
    cmd = _build_cmd(spec, query_path, out_path)
    cmd_line = " ".join(cmd)

    try:
        proc = subprocess.run(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            timeout=timeout_sec,
            cwd=str(work_dir),
        )
    except subprocess.TimeoutExpired as exc:
        raise BlastError(
            f"BLAST timed out after {timeout_sec}s. Try a shorter query."
        ) from exc

    log_text = (proc.stdout or b"").decode("utf-8", errors="replace")
    log_path.write_text(log_text, encoding="utf-8")

    if proc.returncode != 0:
        tail = "\n".join(log_text.strip().splitlines()[-6:])
        raise BlastError(f"BLAST failed (exit {proc.returncode}).\n{tail}")
    if not out_path.is_file():
        raise BlastError("BLAST produced no output.")

    parsed = parse_results(out_path, query_titles=spec.query_titles)
    return BlastResult(
        json_path=out_path, cmd_line=cmd_line, log_text=log_text, parsed=parsed,
    )


def _hit_seqid(description: list[dict]) -> tuple[str, str]:
    """Return (seqid, title) from a BLAST hit description list."""
    if not description:
        return ("", "")
    d0 = description[0]
    seqid = d0.get("accession") or d0.get("id") or ""
    # Strip BLAST's "gnl|BL_ORD_ID|n" / "Query_n" style fallbacks.
    if seqid.startswith("gnl|") or seqid.startswith("lcl|"):
        seqid = seqid.split("|")[-1]
    title = d0.get("title") or seqid
    return (seqid, title)


def parse_results(json_path: Path, query_titles: list[str] | None = None) -> dict:
    """Parse outfmt-15 JSON into a compact, front-end friendly structure.

    ``query_titles`` (if given) are the original FASTA headers in query order;
    BLAST reports one entry per query in the same order, so we override the
    internal ``query_title`` by index to surface the user's real sequence ids.
    """
    try:
        raw = json.loads(json_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise BlastError(f"Could not parse BLAST output: {exc}") from exc

    titles = query_titles or []
    reports = raw.get("BlastOutput2") or []
    queries: list[dict] = []
    program = ""
    db_name = ""

    for q_idx, entry in enumerate(reports):
        report = entry.get("report") or {}
        program = program or report.get("program", "")
        search = (report.get("results") or {}).get("search") or {}
        if not db_name:
            db_name = (report.get("search_target") or {}).get("db", "")
        query_len = search.get("query_len", 0)
        hits_out: list[dict] = []
        for hit in search.get("hits", []):
            seqid, title = _hit_seqid(hit.get("description", []))
            hit_len = hit.get("len", 0)
            hsps_out = []
            best_eval = None
            best_bits = 0.0
            best_ident_pct = 0.0
            aligned_total = 0
            ident_total = 0
            for hsp in hit.get("hsps", []):
                align_len = hsp.get("align_len", 0) or 0
                identity = hsp.get("identity", 0) or 0
                ident_pct = (identity / align_len * 100.0) if align_len else 0.0
                aligned_total += align_len
                ident_total += identity
                hsps_out.append({
                    "bit_score": round(hsp.get("bit_score", 0.0), 1),
                    "score": hsp.get("score", 0),
                    "evalue": hsp.get("evalue", 0.0),
                    "identity": identity,
                    "align_len": align_len,
                    "identity_pct": round(ident_pct, 1),
                    "gaps": hsp.get("gaps", 0),
                    "query_from": hsp.get("query_from", 0),
                    "query_to": hsp.get("query_to", 0),
                    "hit_from": hsp.get("hit_from", 0),
                    "hit_to": hsp.get("hit_to", 0),
                    "query_strand": hsp.get("query_strand", ""),
                    "hit_strand": hsp.get("hit_strand", ""),
                    "qseq": hsp.get("qseq", ""),
                    "hseq": hsp.get("hseq", ""),
                    "midline": hsp.get("midline", ""),
                })
                ev = hsp.get("evalue", 0.0)
                if best_eval is None or ev < best_eval:
                    best_eval = ev
                if hsp.get("bit_score", 0.0) > best_bits:
                    best_bits = hsp.get("bit_score", 0.0)
                if ident_pct > best_ident_pct:
                    best_ident_pct = ident_pct
            query_cov = (
                round(min(100.0, aligned_total / query_len * 100.0), 1)
                if query_len else 0.0
            )
            # PERV sequence id for cross-linking (protein ids look like sid__orf).
            perv_sid = seqid.split("__")[0] if seqid else ""
            hits_out.append({
                "seqid": seqid,
                "perv_sid": perv_sid,
                "title": title,
                "hit_len": hit_len,
                "best_evalue": best_eval if best_eval is not None else 0.0,
                "best_bit_score": round(best_bits, 1),
                "best_identity_pct": round(best_ident_pct, 1),
                "query_cov_pct": query_cov,
                "hsps": hsps_out,
            })
        orig_title = titles[q_idx] if q_idx < len(titles) else ""
        queries.append({
            "query_id": search.get("query_id", ""),
            "query_title": orig_title or search.get("query_title", ""),
            "query_len": query_len,
            "hits": hits_out,
            "message": search.get("message", ""),
        })

    return {"program": program, "db": db_name, "queries": queries}
