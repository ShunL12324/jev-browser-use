// contenteditable editor using execCommand for formatting.
const editor = document.getElementById('editor')
for (const b of document.querySelectorAll('[data-cmd]')) b.addEventListener('mousedown', e => { e.preventDefault(); editor.focus(); document.execCommand(b.dataset.cmd) })
document.getElementById('save').addEventListener('click', async () => {
  const r = await fetch('/api/notes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ html: editor.innerHTML, text: editor.innerText }) })
  document.getElementById('status').textContent = r.ok ? 'Note saved.' : 'Save failed.'
})
