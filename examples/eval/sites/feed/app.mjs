// "Driftnote": a masonry feed of text and video posts in the style of
// Xiaohongshu. Cards show a cover and a truncated title; a post opens in a
// modal (URL changes to /explore/<id>) whose content is fetched from the API,
// so the server knows which posts were actually opened. A dismissible login
// nudge appears after a few posts. Plain HTML + one inline script.
import express from 'express'
import { RunStore, runMiddleware, mountEval, esc, check, normalize } from '../../lib/common.mjs'
import { feedData, searchPosts, TOPICS } from './data.mjs'

const PAGE = 12
const cardTitle = t => t.length > 26 ? t.slice(0, 24) + '…' : t

export function createFeed() {
  const app = express(), store = new RunStore('feed')
  app.use(express.json())
  app.use(runMiddleware(store, 'feed_run'))
  app.use((req, res, next) => (req.path.startsWith('/__eval') || req.run) ? next() : res.status(404).send('Unknown run; start from the task URL.'))
  const alt = req => req.run.variant === 'alternate'

  // Generated cover image, fetched lazily by the browser.
  app.get('/img/:id.svg', (req, res) => {
    const h = [...req.params.id].reduce((a, c) => a * 31 + c.charCodeAt(0), 7) % 360
    res.type('image/svg+xml').send(`<svg xmlns="http://www.w3.org/2000/svg" width="240" height="${220 + (h % 5) * 30}"><rect width="100%" height="100%" fill="hsl(${h},45%,78%)"/></svg>`)
  })
  app.get('/api/feed', (req, res) => {
    const list = searchPosts(req.run.seed, req.query.q ?? ''), offset = Number(req.query.offset) || 0
    res.json({ items: list.slice(offset, offset + PAGE).map(p => ({ id: p.id, title: cardTitle(p.title), author: p.author, likes: p.likes, video: p.video })), hasMore: offset + PAGE < list.length })
  })
  app.get('/api/post/:id', (req, res) => {
    const p = feedData(req.run.seed).posts.find(p => p.id === req.params.id)
    if (!p) return res.status(404).json({ error: 'Not found' })
    ;(req.run.state.opened ??= []).push({ id: p.id, at: Date.now() })
    res.json({ id: p.id, title: p.title, author: p.author, date: p.date, likes: p.likes, video: p.video, body: p.body, comments: p.comments })
  })
  const shell = (req, initialPost = '') => {
    const a = alt(req)
    const L = a ? { brand: 'Driftnote', nav: 'Discover', search: 'Search notes', go: 'Find', close: 'Dismiss', login: 'Sign in to keep reading', later: 'Maybe later', likes: 'hearts', more: 'Loading more notes…', end: 'No more notes' }
      : { brand: 'Driftnote', nav: 'Explore', search: 'Search', go: 'Search', close: 'Close', login: 'Log in to see more', later: 'Not now', likes: 'likes', more: 'Loading…', end: 'You have seen everything' }
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${L.brand}</title><style>${CSS}${a ? ALT_CSS : ''}</style></head>
<body class="${a ? 'alternate' : ''}">
<header><a class="brand" href="/">${L.brand}</a><nav aria-label="Main"><a href="/">${L.nav}</a><a href="/">Following</a></nav>
<form role="search" id="search"><input name="q" aria-label="${L.search}" placeholder="${L.search}"><button>${L.go}</button></form></header>
<main><h1 class="sr">${L.nav}</h1><div id="feed" class="${a ? 'columns' : 'masonry'}"></div><p id="sentinel" aria-live="polite"></p></main>
${a ? `<dialog id="post" aria-labelledby="post-title"></dialog>` : `<div id="post" role="dialog" aria-modal="true" aria-labelledby="post-title" hidden></div>`}
<div id="nudge" role="dialog" aria-modal="true" aria-labelledby="nudge-title" hidden><div><h2 id="nudge-title">${L.login}</h2><p>Join to like, save and comment.</p><button type="button">Log in</button> <button type="button" id="later">${L.later}</button></div></div>
<script>
const ALT = ${a}, L = ${JSON.stringify(L)}, feed = document.getElementById('feed'), sentinel = document.getElementById('sentinel'), post = document.getElementById('post'), nudge = document.getElementById('nudge')
let nudgeAfterClose = false, q = new URLSearchParams(location.search).get('q') || '', offset = 0, more = true, loading = false, opened = 0
const esc = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c])
async function load(reset) {
  if (loading || (!more && !reset)) return
  loading = true; if (reset) { feed.innerHTML = ''; offset = 0; more = true }
  sentinel.textContent = L.more
  const r = await (await fetch('/api/feed?q=' + encodeURIComponent(q) + '&offset=' + offset)).json()
  for (const p of r.items) {
    const card = document.createElement(ALT ? 'section' : 'a')
    card.className = 'card'; if (!ALT) card.href = '/explore/' + p.id
    card.dataset.id = p.id
    card.innerHTML = '<img loading="lazy" alt="" src="/img/' + p.id + '.svg">' + (p.video ? '<span class="play" aria-label="Video">▶</span>' : '') +
      (ALT ? '<h3><button type="button" class="open">' + esc(p.title) + '</button></h3>' : '<span class="title">' + esc(p.title) + '</span>') +
      '<span class="meta">' + esc(p.author) + ' · ' + p.likes + ' ' + L.likes + '</span>'
    feed.appendChild(card)
  }
  offset += r.items.length; more = r.hasMore; loading = false
  sentinel.textContent = more ? '' : L.end
}
feed.addEventListener('click', e => {
  const card = e.target.closest('.card'); if (!card) return
  e.preventDefault(); openPost(card.dataset.id, true)
})
async function openPost(id, push) {
  const p = await (await fetch('/api/post/' + id)).json()
  const time = ALT ? '<p class="when">Posted <time datetime="' + p.date + '">' + p.date + '</time></p>' : '<time datetime="' + p.date + '">' + p.date + '</time>'
  const author = '<p class="author"><a href="#" aria-label="Author ' + esc(p.author) + '">@' + esc(p.author) + '</a></p>'
  const media = p.video ? '<video controls preload="none" aria-label="Post video" poster="/img/' + p.id + '.svg"></video>' : '<img alt="" src="/img/' + p.id + '.svg">'
  const body = '<div class="body">' + esc(p.body).split('. ').join('.<br>') + '</div>'
  const comments = '<section aria-label="Comments"><h3>Comments</h3><ul>' + p.comments.map(c => '<li><b>' + esc(c.author) + '</b> ' + esc(c.text) + '</li>').join('') + '</ul></section>'
  const close = '<button type="button" class="close" aria-label="' + L.close + '">✕</button>'
  post.innerHTML = '<div class="sheet">' + close + '<div class="media">' + media + '</div><article>' + (ALT ? '<h2 id="post-title">' + esc(p.title) + '</h2>' + author + time : author + '<h2 id="post-title">' + esc(p.title) + '</h2>' + time) + body + '<p class="likes">' + p.likes + ' ' + L.likes + '</p>' + comments + '</article></div>'
  post.querySelector('.close').onclick = () => closePost(true)
  if (ALT) post.showModal(); else post.hidden = false
  if (push) history.pushState({ post: id }, '', '/explore/' + id + location.search)
  // A login nudge interrupts after the third opened post; it can be dismissed.
  if (++opened === 3) { if (ALT) nudgeAfterClose = true; else setTimeout(() => { nudge.hidden = false }, 400) }
}
function closePost(pop) {
  // Native <dialog> (held-out variant) goes back from its own close event.
  if (ALT) { if (post.open) post.close(); return }
  post.hidden = true
  if (pop && location.pathname.startsWith('/explore/')) history.back()
}
// The native modal dialog sits in the top layer, so the nudge waits for it to close.
post.addEventListener('close', () => { if (location.pathname.startsWith('/explore/')) history.back(); if (nudgeAfterClose) { nudgeAfterClose = false; nudge.hidden = false } })
addEventListener('popstate', () => { if (!location.pathname.startsWith('/explore/')) closePost(false) })
addEventListener('keydown', e => { if (e.key !== 'Escape') return; if (!nudge.hidden) nudge.hidden = true; else if (!ALT && !post.hidden) closePost(true) })
document.getElementById('later').onclick = () => { nudge.hidden = true }
document.getElementById('search').onsubmit = e => { e.preventDefault(); q = new FormData(e.target).get('q'); history.replaceState(null, '', '/?q=' + encodeURIComponent(q)); load(true) }
new IntersectionObserver(es => { if (es.some(x => x.isIntersecting)) load() }).observe(sentinel)
load(true).then(() => { ${initialPost ? `openPost(${JSON.stringify(initialPost)}, false)` : ''} })
</script></body></html>`
  }
  app.get('/', (req, res) => res.send(shell(req)))
  app.get('/explore/:id', (req, res) => res.send(shell(req, req.params.id)))

  mountEval(app, store, { tasks: feedTasks(), startPath: () => '/' })
  return { app, store }
}

// Collect-task oracle: N distinct text posts from the search results, each with
// the post body verbatim, each actually opened through the UI.
export function feedTasks() {
  const topic = run => run.seed === 'birch' ? TOPICS[1] : TOPICS[0]
  const collect = n => ({
    params: run => ({ query: topic(run), count: n }),
    items: (run, items) => gradeItems(run, items, topic(run), n)
  })
  return { 'feed.collect_text_posts': collect(5) }
}

export function gradeItems(run, items, query, n) {
  const posts = feedData(run.seed).posts, results = new Set(searchPosts(run.seed, query).map(p => p.id)), opened = new Set((run.state.opened ?? []).map(o => o.id))
  const byTitle = new Map(posts.map(p => [normalize(p.title), p]))
  const resolve = item => posts.find(p => typeof item?.url === 'string' && item.url.includes(`/explore/${p.id}`)) ?? byTitle.get(normalize(item?.title))
  const matched = items.map(i => ({ item: i, post: resolve(i) }))
  const ids = matched.map(m => m.post?.id).filter(Boolean)
  const verbatim = m => m.post && normalize(m.item.text).includes(normalize(m.post.body))
  return [
    check('count', items.length === n, items.length),
    check('all_identified', matched.every(m => m.post), matched.filter(m => !m.post).map(m => m.item?.title ?? null)),
    check('no_duplicates', new Set(ids).size === ids.length),
    check('text_posts_only', matched.every(m => m.post && !m.post.video), matched.filter(m => m.post?.video).map(m => m.post.id)),
    check('from_search_results', matched.every(m => m.post && results.has(m.post.id))),
    check('verbatim_text', matched.length > 0 && matched.every(verbatim), matched.filter(m => !verbatim(m)).map(m => m.post?.id ?? null)),
    check('opened_via_ui', matched.every(m => m.post && opened.has(m.post.id)))
  ]
}

const CSS = `body{margin:0;font-family:system-ui,sans-serif;background:#fafafa;color:#222}header{position:sticky;top:0;z-index:2;display:flex;gap:18px;align-items:center;padding:10px 24px;background:#fff;border-bottom:1px solid #eee}
.brand{font-weight:800;color:#e0245e;text-decoration:none;font-size:20px}header nav{display:flex;gap:12px}header nav a{color:#333;text-decoration:none}form[role=search]{margin-left:auto;display:flex;gap:6px}input{padding:7px 12px;border-radius:18px;border:1px solid #ddd;width:240px}button{font:inherit;cursor:pointer}
main{padding:18px 24px}.sr{position:absolute;left:-9999px}.masonry{columns:4 220px;column-gap:14px}.card{display:inline-block;width:100%;margin:0 0 14px;background:#fff;border-radius:12px;overflow:hidden;position:relative;color:#222;text-decoration:none;box-shadow:0 1px 3px #0001}
.card img{width:100%;display:block}.card .title,.card h3{display:block;padding:8px 10px 2px;font-size:14px;font-weight:600;margin:0}.card h3 button{all:unset;cursor:pointer}.card .meta{display:block;padding:0 10px 10px;font-size:12px;color:#888}.play{position:absolute;right:8px;top:8px;background:#0008;color:#fff;border-radius:50%;width:26px;height:26px;display:grid;place-items:center;font-size:12px}
div#post:not([hidden]){position:fixed;inset:0;background:#000a;display:flex;align-items:center;justify-content:center;z-index:5}.sheet{background:#fff;border-radius:14px;display:flex;max-width:960px;width:90vw;max-height:86vh;overflow:hidden;position:relative}.media{flex:1;background:#f2f2f2}.media img,.media video{width:100%;height:100%;object-fit:cover}
article{flex:1;padding:22px;overflow:auto}.close{position:absolute;right:10px;top:8px;border:0;background:#fff;border-radius:50%;width:32px;height:32px}.body{line-height:1.7;margin:14px 0}time{color:#999;font-size:12px}.author a{color:#333;font-weight:600}
#nudge:not([hidden]){position:fixed;inset:0;background:#0006;display:flex;align-items:center;justify-content:center;z-index:9}#nudge>div{background:#fff;padding:26px;border-radius:14px;text-align:center}`
const ALT_CSS = `.columns{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:12px;align-items:start}.columns .card{margin:0}dialog#post{padding:0;border:0;border-radius:14px;max-width:none}dialog#post::backdrop{background:#000a}.sheet{flex-direction:column;width:560px}.media{max-height:260px}header{flex-direction:row-reverse}`
