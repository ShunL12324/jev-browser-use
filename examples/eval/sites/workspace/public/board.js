// HTML5 drag and drop between columns; the server records every move.
const run = document.body.dataset.run
let dragged = null
for (const card of document.querySelectorAll('.card')) {
  card.addEventListener('dragstart', e => { dragged = card; e.dataTransfer?.setData('text/plain', card.dataset.card); card.style.opacity = '0.5' })
  card.addEventListener('dragend', () => { card.style.opacity = '' })
}
for (const col of document.querySelectorAll('.column')) {
  col.addEventListener('dragover', e => e.preventDefault())
  col.addEventListener('drop', async e => {
    e.preventDefault()
    const id = e.dataTransfer?.getData('text/plain') || dragged?.dataset.card
    const card = document.querySelector(`.card[data-card="${id}"]`)
    if (!card) return
    col.appendChild(card)
    await fetch('/api/board/move', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ card: Number(id), column: col.dataset.column }) })
  })
}
void run
