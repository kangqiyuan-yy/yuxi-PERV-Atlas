// Small sequence helpers shared by the browser page.
window.SeqUtils = (function () {
  function fastaWrap(seq, width) {
    width = width || 60;
    const out = [];
    for (let i = 0; i < seq.length; i += width) {
      out.push(seq.substring(i, i + width));
    }
    return out.join('\n');
  }

  function downloadText(filename, content, mime) {
    const blob = new Blob([content], { type: mime || 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 200);
  }

  async function copyToClipboard(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (e) {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      let ok = false;
      try { ok = document.execCommand('copy'); } catch (_) {}
      document.body.removeChild(ta);
      return ok;
    }
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (m) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[m]);
  }

  return { fastaWrap, downloadText, copyToClipboard, escapeHtml };
})();
