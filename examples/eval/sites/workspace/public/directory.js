// Virtualized list inside its own scroll container: only rows near the
// visible window exist in the DOM.
const viewport = document.getElementById('viewport'), spacer = document.getElementById('spacer'), ROW = 32
const people = await (await fetch('/api/people')).json()
spacer.style.height = people.length * ROW + 'px'
function render() {
  const first = Math.max(0, Math.floor(viewport.scrollTop / ROW) - 3), last = Math.min(people.length, first + Math.ceil(viewport.clientHeight / ROW) + 6)
  for (const row of [...viewport.querySelectorAll('.row')]) row.remove()
  for (let i = first; i < last; i++) {
    const p = people[i], row = document.createElement('div')
    row.className = 'row'; row.setAttribute('role', 'row'); row.setAttribute('aria-rowindex', String(i + 1)); row.style.top = i * ROW + 'px'
    row.innerHTML = `<span role="gridcell">${p.name}</span><span role="gridcell">${p.team}</span><span role="gridcell">Ext. ${p.ext}</span>`
    viewport.appendChild(row)
  }
}
viewport.addEventListener('scroll', render)
for (const b of document.querySelectorAll('[data-letter]')) b.addEventListener('click', () => {
  const i = people.findIndex(p => p.name.split(' ')[1].startsWith(b.dataset.letter))
  if (i >= 0) viewport.scrollTop = i * ROW
})
render()
