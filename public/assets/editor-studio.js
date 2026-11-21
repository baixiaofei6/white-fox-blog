/* shared writing studio helpers: extracted from Typora/StackEdit patterns */
var EDITOR_DRAFT_KEY = 'white-fox-blog-editor-draft';
function escapeHtml(value) { return String(value == null ? '' : value).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }
function editorPlainText(markup) {
  var root = document.createElement('div'); root.innerHTML = String(markup || '');
  return (root.textContent || '').replace(/\s+/g, ' ').trim();
}
function editorPreviewHtml(markup) {
  var text = String(markup || '').trim(); if (!text) return '<p class="editor-preview-empty">还没有正文，先写几句吧。</p>';
  if (/^\s*</.test(text) && /<\/(p|div|h[1-6]|li|blockquote|pre|section)\s*>/i.test(text)) return text;
  return text.split(/\n{2,}/).map(function (p) { return '<p>' + escapeHtml(p).replace(/\n/g,'<br>') + '</p>'; }).join('');
}
function bindEditorEnhancements(opts) {
  var body = opts.body, status = opts.status, preview = opts.preview, toggle = opts.toggle,
      toggleZen = opts.toggleZen, save = opts.save, count = opts.count, clear = opts.clear,
      title = opts.title, slug = opts.slug, key = opts.key || (EDITOR_DRAFT_KEY + ':' + location.pathname);
  var previewOn = false, savedTimer = 0;
  function setStatus(text) { if (status) status.textContent = text; }
  function flash(text) { setStatus(text); clearTimeout(savedTimer); savedTimer = setTimeout(function(){ setStatus('就绪 · 草稿自动保存在本机 · Ctrl+S 保存 / Ctrl+P 预览 / Ctrl+Shift+F 沉浸'); }, 2600); }
  function updateCount() { if (count) count.textContent = body.value.length + ' 字'; }
  function draftPayload() { return { title: title && title.value, slug: slug && slug.value, body: body.value, savedAt: Date.now() }; }
  function saveDraft() { try { localStorage.setItem(EDITOR_DRAFT_KEY + ":" + key, JSON.stringify(draftPayload())); flash('草稿已保存在本机'); } catch (_) { setStatus('草稿保存失败：本地存储不可用'); } }
  function restoreDraft() {
    var raw; try { raw = localStorage.getItem(EDITOR_DRAFT_KEY + ":" + key); } catch (_) { return false; }
    if (!raw) return false; var d; try { d = JSON.parse(raw); } catch (_) { return false; }
    if (!d || typeof d.body !== 'string' || !d.body) return false;
    if (title && d.title && !title.value) title.value = d.title;
    if (slug && d.slug && !slug.value) slug.value = d.slug;
    body.value = d.body; updateCount(); setStatus('已恢复上次未发布的草稿 · 可继续写作'); return true;
  }
  function togglePreview(force) {
    previewOn = force === undefined ? !previewOn : !!force;
    if (preview) { preview.hidden = !previewOn; if (previewOn) preview.innerHTML = editorPreviewHtml(body.value); }
    if (toggle) toggle.textContent = previewOn ? '继续编辑' : '预览';
    if (body) body.style.display = previewOn ? 'none' : '';
    setStatus(previewOn ? '预览模式 · 再次按 Ctrl+P 或点击「继续编辑」返回' : '编辑模式 · 草稿自动保存在本机');
  }
  function applyZen(on) {
    var shell = opts.shell; if (!shell) return;
    shell.classList.toggle('zen', on); document.body.classList.toggle('zen-open', on);
    if (toggleZen) toggleZen.textContent = on ? '退出沉浸' : '沉浸写作';
    if (on) body.focus();
  }
  body.addEventListener('input', function () { updateCount(); if (previewOn && preview) preview.innerHTML = editorPreviewHtml(body.value); });
  document.addEventListener('editor shortcut', function (e) { if (e.detail && e.detail.action === 'save') saveDraft(); });
  document.addEventListener('keydown', function (e) {
    var typing = e.target === body || e.target === title || e.target === slug || (e.target && /INPUT|TEXTAREA/.test(e.target.tagName));
    if ((e.ctrlKey || e.metaKey) && e.key && e.key.toLowerCase() === 's') { e.preventDefault(); saveDraft(); if (save) save(); }
    if ((e.ctrlKey || e.metaKey) && e.key && e.key.toLowerCase() === 'p') { e.preventDefault(); togglePreview(); }
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key && e.key.toLowerCase() === 'f') { e.preventDefault(); applyZen(!opts.shell.classList.contains('zen')); }
    if (e.key === 'Escape' && opts.shell.classList.contains('zen')) applyZen(false);
  });
  if (toggle) toggle.addEventListener('click', function(){ togglePreview(); });
  if (clear) clear.addEventListener('click', function () {
    if (!confirm('清空当前草稿和恢复默认提示？此操作不可撤销。')) return;
    try { localStorage.removeItem(EDITOR_DRAFT_KEY + ":" + key); } catch (_) {}
    body.value = ''; if (title) title.value = ''; if (slug) slug.value = '';
    updateCount(); togglePreview(false); setStatus('草稿已清空'); if (body.focus) body.focus();
  });
  return { restoreDraft: restoreDraft, saveDraft: saveDraft, setStatus: setStatus, updateCount: updateCount, togglePreview: togglePreview };
}

window.EditorStudio = { EDITOR_DRAFT_KEY: EDITOR_DRAFT_KEY, bindEditorEnhancements: bindEditorEnhancements, editorPreviewHtml: editorPreviewHtml, editorPlainText: editorPlainText, escapeHtml: escapeHtml };
