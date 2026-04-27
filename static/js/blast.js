// BLAST module: submit a query, poll the async job, render hits + alignments.
(function () {
  const T = (k) => (window.I18n ? window.I18n.t(k) : k);

  // Real fragments drawn from the PERV libraries so the example returns hits.
  const EXAMPLE_NT =
    '>example_PERV_nt_fragment\n' +
    'CGGGCGTGCCACAAAATGTTGAAAATCCTGATAAATATATCTTGGTGACAATATGTCTCCC\n' +
    'CCACCCAGAGACAGGCACAAACATGTAACTCCAGAACAACTTAAAATTAATTGGTCCACAA\n' +
    'AGCGCGGGCTCTCGAAGTTTTGAATTGACTGGTTTGCGATATTTTAAAAATGATTAGTTTG\n' +
    'TAAAAGCGCGGGCTTTGTTGTGAACCCCATAAAAGCTGTCCCGACTCCACACTCGGG';
  const EXAMPLE_AA =
    '>example_PERV_protein_fragment\n' +
    'SRAHNLSVQVKKGPWQTFCVSEWPTFDVGWPSEGTFNSEIILAVKAIIFQTGPGSHPDQEP\n' +
    'YILTWQDLAEDPPPWVKPWLNKPRKPGPRILALGEKNKH';

  let cfg = null;          // /api/blast/dbs response
  let lastResult = null;   // last parsed result, for re-render on lang change
  let polling = false;

  const $ = (id) => document.getElementById(id);

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (m) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[m]);
  }

  function langKey() {
    return (window.I18n && window.I18n.lang === 'zh') ? 'label_zh' : 'label_en';
  }

  function detectMol(text) {
    // Strip FASTA headers, count residues; decide nucl vs prot.
    const seq = text.replace(/^>.*$/gm, '').replace(/\s+/g, '').toUpperCase();
    if (!seq) return null;
    const acgtun = (seq.match(/[ACGTUN]/g) || []).length;
    return acgtun / seq.length > 0.9 ? 'nucl' : 'prot';
  }

  function queryStats(text) {
    const lines = text.split('\n');
    let nSeqs = 0;
    let residues = 0;
    let sawHeader = false;
    let curHas = false;
    for (const line of lines) {
      if (line.startsWith('>')) {
        sawHeader = true;
        nSeqs += 1;
        curHas = false;
      } else {
        const r = line.replace(/\s+/g, '').length;
        if (r > 0) {
          residues += r;
          if (!sawHeader && !curHas) { nSeqs += 1; curHas = true; }
        }
      }
    }
    return { nSeqs: Math.max(nSeqs, residues > 0 ? 1 : 0), residues };
  }

  // ── Populate selectors ─────────────────────────────────────────────────────
  function fillSelectors() {
    const progSel = $('blast-program');
    progSel.innerHTML = cfg.programs
      .map((p) => `<option value="${p.key}">${esc(p[langKey()])}</option>`)
      .join('');
    const evList = $('blast-evalue-list');
    evList.innerHTML = (cfg.evalue_choices || [])
      .map((e) => `<li role="option" data-val="${esc(e)}">${esc(e)}</li>`)
      .join('');
    const evEl = $('blast-evalue');
    if (!evEl.value) evEl.value = '1e-5';
    const maxEl = $('blast-maxhits');
    maxEl.value = cfg.max_target_default;
    maxEl.min = cfg.max_target_min;
    maxEl.max = cfg.max_target_max;
    syncDbForProgram();
    if (progSel._refresh) progSel._refresh();
  }

  // Custom E-value combobox: a styled dropdown (matches the DB select) that
  // still allows typing a custom value. Native <datalist> can't be styled.
  function setupEvalueCombo() {
    const input = $('blast-evalue');
    const list = $('blast-evalue-list');
    if (!input || !list) return;
    const open = () => { list.hidden = false; input.setAttribute('aria-expanded', 'true'); };
    const close = () => { list.hidden = true; input.setAttribute('aria-expanded', 'false'); };
    input.addEventListener('focus', open);
    input.addEventListener('click', open);
    list.addEventListener('mousedown', (e) => {
      const li = e.target.closest('li[data-val]');
      if (!li) return;
      e.preventDefault();  // keep focus, avoid blur race
      input.value = li.dataset.val;
      close();
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') close();
      else if (e.key === 'Enter' && !list.hidden) close();
    });
    document.addEventListener('click', (e) => {
      if (!e.target.closest('.blast-combo')) close();
    });
  }

  function syncDbForProgram() {
    const prog = cfg.programs.find((p) => p.key === $('blast-program').value);
    if (!prog) return;
    const dbSel = $('blast-db');
    // Programs map 1:1 to a database in this build; show the matching one.
    dbSel.innerHTML = cfg.databases
      .filter((d) => d.key === prog.db)
      .map((d) => {
        const lbl = esc(d[langKey()]) + (d.ready ? '' : ' (' + T('blast.db.notready') + ')');
        return `<option value="${d.key}">${lbl}</option>`;
      })
      .join('');
    if (dbSel._refresh) dbSel._refresh();
    const hint = $('blast-program-hint');
    hint.textContent = prog.query === 'nucl'
      ? T('blast.program.hint.nucl')
      : T('blast.program.hint.prot');
  }

  function autoSuggestProgram() {
    const mol = detectMol($('blast-query').value);
    if (!mol) return;
    const cur = cfg.programs.find((p) => p.key === $('blast-program').value);
    if (cur && cur.query === mol) return;
    // pick first program whose query molecule matches the pasted sequence
    const match = cfg.programs.find((p) => p.query === mol);
    if (match) {
      const progSel = $('blast-program');
      progSel.value = match.key;
      if (progSel._refresh) progSel._refresh();
      syncDbForProgram();
    }
  }

  function updateQueryInfo() {
    const { nSeqs, residues } = queryStats($('blast-query').value);
    const info = $('blast-query-info');
    if (residues === 0) { info.textContent = ''; return; }
    const mol = detectMol($('blast-query').value);
    const molTxt = mol === 'nucl' ? T('blast.mol.nucl')
      : mol === 'prot' ? T('blast.mol.prot') : '';
    info.textContent =
      `${nSeqs} ${T('blast.info.seqs')} · ${residues} ${T('blast.info.residues')}` +
      (molTxt ? ` · ${molTxt}` : '');
  }

  // ── File upload (client-side read into the query box) ──────────────────────
  const MAX_FILE_BYTES = 2 * 1024 * 1024;  // 2 MB — server enforces the real limits
  const ALLOWED_EXT = ['fa', 'fasta', 'fna', 'faa', 'txt'];

  function readFile(file) {
    if (!file) return;
    const ext = (file.name.split('.').pop() || '').toLowerCase();
    if (!ALLOWED_EXT.includes(ext)) {
      setStatus(T('blast.err.filetype'), 'err');
      return;
    }
    if (file.size > MAX_FILE_BYTES) {
      setStatus(T('blast.err.filesize'), 'err');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      $('blast-query').value = String(reader.result || '');
      updateQueryInfo();
      autoSuggestProgram();
      setStatus(T('blast.file.loaded') + ' ' + file.name, 'ok');
    };
    reader.onerror = () => setStatus(T('blast.err.fileread'), 'err');
    reader.readAsText(file);
  }

  // ── Submit + poll ──────────────────────────────────────────────────────────
  function setStatus(msg, kind) {
    const el = $('blast-status');
    el.textContent = msg || '';
    el.className = 'blast-status' + (kind ? ' ' + kind : '');
  }

  async function submit() {
    if (polling) return;
    const query = $('blast-query').value.trim();
    if (!query) { setStatus(T('blast.err.empty'), 'err'); return; }
    const evalue = ($('blast-evalue').value || '').trim() || '1e-5';
    const body = {
      program: $('blast-program').value,
      db: $('blast-db').value,
      query,
      evalue,
      // Always fetch the full allowed set so the "Max hits" control can
      // re-slice the results client-side without re-running BLAST.
      max_target_seqs: cfg.max_target_max,
    };
    $('blast-submit').disabled = true;
    polling = true;
    setStatus(T('blast.status.submitting'), 'busy');
    try {
      const r = await fetch('/api/blast/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || ('HTTP ' + r.status));
      await pollJob(data.job_id);
    } catch (e) {
      setStatus((T('blast.err.prefix') + ' ' + e.message).trim(), 'err');
    } finally {
      $('blast-submit').disabled = false;
      polling = false;
    }
  }

  async function pollJob(jobId) {
    setStatus(T('blast.status.running'), 'busy');
    const started = Date.now();
    while (Date.now() - started < 120000) {
      await new Promise((res) => setTimeout(res, 1000));
      const r = await fetch('/api/blast/status/' + jobId);
      const s = await r.json();
      if (s.state === 'done') {
        const rr = await fetch('/api/blast/result/' + jobId);
        if (!rr.ok) {
          const err = await rr.json().catch(() => ({}));
          throw new Error(err.error || ('HTTP ' + rr.status));
        }
        lastResult = await rr.json();
        renderResults(lastResult);
        setStatus(T('blast.status.done'), 'ok');
        return;
      }
      if (s.state === 'error') {
        throw new Error(s.error || T('blast.err.failed'));
      }
      if (s.state === 'unknown') {
        throw new Error(T('blast.err.failed'));
      }
    }
    throw new Error(T('blast.err.timeout'));
  }

  // ── Cross-links ────────────────────────────────────────────────────────────
  // All three modules are always shown. A link is clickable only when that
  // module actually has the sequence: Overview holds all 1165 PERVs; Browser
  // only the annotated subset (139); Genome only the sequences with a genomic
  // location (direct placement or homologous mapping among the 876). Otherwise
  // the entry is rendered as a greyed-out, disabled button.
  function xrefEntry(enabled, href, label) {
    if (enabled) {
      return `<a href="${href}" data-tip="${esc(label)}">${esc(label)}</a>`;
    }
    return `<span class="blast-xref-off" aria-disabled="true" ` +
      `data-tip="${esc(label + ' — ' + T('blast.xref.unavailable'))}">${esc(label)}</span>`;
  }

  function hitLinks(hit) {
    const sid = hit.perv_sid;
    if (!sid) return '';
    const e = encodeURIComponent(sid);
    let genomeHref = '#';
    if (hit.genome) {
      // Direct-placement PERVs open the PERV detail drawer (?perv=); homologously
      // mapped sequences open the homologous-sequence drawer (?homo_seq=).
      if (hit.genome.mode === 'loc') {
        genomeHref = `/genome?homo_seq=${e}`;
      } else {
        genomeHref = `/genome?perv=${e}`;
      }
    }
    const parts = [
      xrefEntry(true, `/overview?q=${e}`, T('blast.xref.overview')),
      xrefEntry(!!hit.annotated, `/browser?id=${e}`, T('blast.xref.browser')),
      xrefEntry(!!hit.genome, genomeHref, T('blast.xref.genome')),
    ];
    return `<span class="blast-xref">${parts.join('')}</span>`;
  }

  // ── Alignment formatting (BLAST-style pairwise) ────────────────────────────
  function formatAlignment(hsp, program) {
    const q = hsp.qseq || '';
    const h = hsp.hseq || '';
    const m = hsp.midline || '';
    const width = 60;
    const sUnits = program === 'tblastn' ? 3 : 1;
    const qStep = (hsp.query_to >= hsp.query_from) ? 1 : -1;
    const sStep = (hsp.hit_to >= hsp.hit_from) ? 1 : -1;
    let qPos = hsp.query_from;
    let sPos = hsp.hit_from;
    const out = [];
    const pad = (n) => String(n).padStart(9, ' ');
    for (let i = 0; i < q.length; i += width) {
      const qc = q.slice(i, i + width);
      const hc = h.slice(i, i + width);
      const mc = m.slice(i, i + width);
      const qn = (qc.match(/[^-]/g) || []).length;
      const hn = (hc.match(/[^-]/g) || []).length;
      const qEnd = qn ? qPos + qStep * (qn - 1) : qPos;
      // For nucleotide subjects under tblastn, each aligned residue spans 3 nt.
      const sEndCalc = hn ? sPos + sStep * (hn * sUnits - 1) : sPos;
      out.push('Query  ' + pad(qPos) + '  ' + esc(qc) + '  ' + pad(qEnd));
      out.push('       ' + pad('') + '  ' + esc(mc));
      out.push('Sbjct  ' + pad(sPos) + '  ' + esc(hc) + '  ' + pad(sEndCalc));
      out.push('');
      qPos = qEnd + qStep;
      sPos = sEndCalc + sStep;
    }
    return out.join('\n');
  }

  function hspSummary(hsp) {
    return (
      `${T('blast.hsp.score')} ${hsp.bit_score} bits · ` +
      `E ${formatE(hsp.evalue)} · ` +
      `${T('blast.hsp.ident')} ${hsp.identity}/${hsp.align_len} (${hsp.identity_pct}%) · ` +
      `${T('blast.hsp.gaps')} ${hsp.gaps}`
    );
  }

  function formatE(v) {
    if (v === 0) return '0';
    if (v >= 0.001 && v < 1000) return Number(v).toPrecision(2);
    return Number(v).toExponential(1);
  }

  function currentMaxHits() {
    const max = (cfg && cfg.max_target_max) || 250;
    const min = (cfg && cfg.max_target_min) || 1;
    let n = parseInt($('blast-maxhits').value, 10);
    if (!Number.isFinite(n)) n = (cfg && cfg.max_target_default) || 10;
    return Math.max(min, Math.min(max, n));
  }

  function renderResults(data) {
    const box = $('blast-results');
    const body = $('blast-results-body');
    box.hidden = false;
    const queries = data.queries || [];
    const limit = currentMaxHits();
    const parts = [];
    parts.push(`<div class="blast-meta blast-muted">${esc(T('blast.results.program'))}: ` +
      `<b>${esc(data.program || '')}</b></div>`);

    queries.forEach((qy) => {
      parts.push('<div class="blast-query-block">');
      const qtitle = qy.query_title || qy.query_id || '';
      const qnum = (qy.query_title && qy.query_id)
        ? ` <span class="blast-muted">[${esc(qy.query_id)}]</span>` : '';
      parts.push(`<h4 class="blast-qtitle">${esc(qtitle)}${qnum} ` +
        `<span class="blast-muted">(${qy.query_len} ${esc(T('blast.info.residues'))})</span></h4>`);
      const allHits = qy.hits || [];
      if (!allHits.length) {
        parts.push(`<p class="empty-hint">${esc(T('blast.results.nohits'))}</p>`);
        parts.push('</div>');
        return;
      }
      const shownHits = allHits.slice(0, limit);
      if (allHits.length > shownHits.length) {
        parts.push(`<div class="blast-muted blast-shown-note">` +
          `${T('blast.results.showing')} ${shownHits.length} / ${allHits.length}</div>`);
      }
      parts.push('<div class="blast-table-wrap"><table class="blast-table"><thead><tr>' +
        `<th>#</th>` +
        `<th>${esc(T('blast.col.hit'))}</th>` +
        `<th>${esc(T('blast.col.ident'))}</th>` +
        `<th>${esc(T('blast.col.cov'))}</th>` +
        `<th>${esc(T('blast.col.evalue'))}</th>` +
        `<th>${esc(T('blast.col.bits'))}</th>` +
        `<th>${esc(T('blast.col.links'))}</th>` +
        '</tr></thead><tbody>');
      shownHits.forEach((hit, idx) => {
        const rowId = `hit-${Math.random().toString(36).slice(2, 9)}`;
        const label = hit.seqid || hit.title;
        parts.push(
          `<tr class="blast-hit-row" data-target="${rowId}">` +
          `<td>${idx + 1}</td>` +
          `<td class="blast-hit-id"><span class="blast-caret">▸</span>${esc(label)}</td>` +
          `<td>${hit.best_identity_pct}%</td>` +
          `<td>${hit.query_cov_pct}%</td>` +
          `<td>${formatE(hit.best_evalue)}</td>` +
          `<td>${hit.best_bit_score}</td>` +
          `<td>${hitLinks(hit)}</td>` +
          '</tr>');
        const aligns = hit.hsps.map((hsp) =>
          `<div class="blast-hsp"><div class="blast-hsp-head">${esc(hspSummary(hsp))}</div>` +
          `<pre class="blast-aln">${formatAlignment(hsp, data.program)}</pre></div>`).join('');
        parts.push(
          `<tr class="blast-hsp-row" id="${rowId}" hidden><td colspan="7">` +
          `<div class="blast-hit-title blast-muted">${esc(hit.title)} · ${hit.hit_len} ${esc(T('blast.info.residues'))}</div>` +
          aligns + '</td></tr>');
      });
      parts.push('</tbody></table></div>');
      parts.push('</div>');
    });
    body.innerHTML = parts.join('');

    body.querySelectorAll('.blast-hit-row').forEach((row) => {
      row.addEventListener('click', (e) => {
        if (e.target.closest('a')) return;  // don't toggle when clicking a link
        const tr = document.getElementById(row.dataset.target);
        if (!tr) return;
        tr.hidden = !tr.hidden;
        const caret = row.querySelector('.blast-caret');
        if (caret) caret.textContent = tr.hidden ? '▸' : '▾';
      });
    });
  }

  // ── Wire up ────────────────────────────────────────────────────────────────
  async function init() {
    try {
      const r = await fetch('/api/blast/dbs');
      cfg = await r.json();
    } catch (e) {
      setStatus(T('blast.err.config'), 'err');
      return;
    }
    fillSelectors();
    setupEvalueCombo();
    if (window.PervSelect) {
      PervSelect.enhance($('blast-program'));
      PervSelect.enhance($('blast-db'));
    }

    $('blast-program').addEventListener('change', syncDbForProgram);
    // Max hits controls display only: re-slice the cached result live.
    $('blast-maxhits').addEventListener('input', () => {
      if (lastResult) renderResults(lastResult);
    });
    $('blast-query').addEventListener('input', () => { updateQueryInfo(); });
    $('blast-query').addEventListener('blur', autoSuggestProgram);
    $('blast-submit').addEventListener('click', submit);
    $('blast-clear').addEventListener('click', () => {
      $('blast-query').value = '';
      updateQueryInfo();
      $('blast-results').hidden = true;
      setStatus('');
    });
    $('blast-example').addEventListener('click', () => {
      const prog = cfg.programs.find((p) => p.key === $('blast-program').value);
      $('blast-query').value = (prog && prog.query === 'prot') ? EXAMPLE_AA : EXAMPLE_NT;
      updateQueryInfo();
      autoSuggestProgram();
    });

    // File upload: button opens the picker; drag-drop onto the query area.
    $('blast-file-btn').addEventListener('click', () => $('blast-file').click());
    $('blast-file').addEventListener('change', (e) => {
      readFile(e.target.files && e.target.files[0]);
      e.target.value = '';  // allow re-selecting the same file
    });
    const drop = $('blast-drop');
    let dragDepth = 0;
    const setDrag = (on) => drop.classList.toggle('blast-drop-active', on);
    drop.addEventListener('dragenter', (e) => {
      e.preventDefault();
      dragDepth += 1;
      setDrag(true);
    });
    drop.addEventListener('dragover', (e) => { e.preventDefault(); });
    drop.addEventListener('dragleave', (e) => {
      e.preventDefault();
      dragDepth = Math.max(0, dragDepth - 1);
      if (dragDepth === 0) setDrag(false);
    });
    drop.addEventListener('drop', (e) => {
      e.preventDefault();
      dragDepth = 0;
      setDrag(false);
      const files = e.dataTransfer && e.dataTransfer.files;
      if (files && files.length) readFile(files[0]);
    });

    document.addEventListener('i18nchange', () => {
      // Re-localise selector labels / hints and re-render the last result.
      const progSel = $('blast-program');
      const cur = progSel.value;
      progSel.innerHTML = cfg.programs
        .map((p) => `<option value="${p.key}">${esc(p[langKey()])}</option>`)
        .join('');
      progSel.value = cur;
      if (progSel._refresh) progSel._refresh();
      syncDbForProgram();
      updateQueryInfo();
      if (lastResult) renderResults(lastResult);
    });
  }

  document.addEventListener('DOMContentLoaded', init);
})();
