import test from 'node:test'
import assert from 'node:assert/strict'
import { gradeItems, feedTasks } from '../sites/feed/app.mjs'
import { feedData, searchPosts } from '../sites/feed/data.mjs'

const seed = 'atlas', query = 'trail running'
const texts = searchPosts(seed, query).filter(p => !p.video), videos = searchPosts(seed, query).filter(p => p.video)
// Item as a runner would extract it from the modal: author, title, date, body with line breaks, comments.
const item = p => ({ title: p.title, author: p.author, url: `http://127.0.0.1:17446/explore/${p.id}?q=x`, text: `@${p.author}\n${p.title}\n${p.date}\n${p.body.split('. ').join('.\n')}\n${p.likes} likes\nComments` })
const run = opened => ({ seed, state: { opened: opened.map(p => ({ id: p.id })) } })
const failed = (items, opened = texts) => gradeItems(run(opened), items, query, 5).filter(c => !c.passed).map(c => c.id)

test('fixture shape: each topic has enough text posts and some videos', () => {
  assert.ok(texts.length >= 5 && videos.length >= 2)
  assert.equal(feedData(seed).posts.length, 40)
  assert.equal(feedTasks()['feed.collect_text_posts'].params({ seed: 'birch' }).query, 'sourdough')
})
test('five opened text posts with verbatim text pass', () => {
  assert.deepEqual(failed(texts.slice(0, 5).map(item)), [])
})
test('identity by title works without a URL', () => {
  assert.deepEqual(failed(texts.slice(0, 5).map(p => ({ ...item(p), url: undefined }))), [])
})
test('summarized or fabricated text fails verbatim_text', () => {
  const items = texts.slice(0, 5).map(item); items[2] = { ...items[2], text: 'A short summary of the post about running.' }
  assert.deepEqual(failed(items), ['verbatim_text'])
})
test('a video post fails text_posts_only', () => {
  const items = [...texts.slice(0, 4), videos[0]].map(item)
  assert.deepEqual(failed(items, [...texts, videos[0]]), ['text_posts_only'])
})
test('a duplicate fails no_duplicates', () => {
  const items = [...texts.slice(0, 4), texts[0]].map(item)
  assert.deepEqual(failed(items), ['no_duplicates'])
})
test('fewer or more than N fails count', () => {
  assert.deepEqual(failed(texts.slice(0, 4).map(item)), ['count'])
  assert.deepEqual(failed(texts.slice(0, 6).map(item)), ['count'])
})
test('a post from another topic fails from_search_results', () => {
  const other = feedData(seed).posts.find(p => !p.video && !searchPosts(seed, query).includes(p))
  assert.deepEqual(failed([...texts.slice(0, 4), other].map(item), [...texts, other]), ['from_search_results'])
})
test('text never fetched through the UI fails opened_via_ui', () => {
  assert.deepEqual(failed(texts.slice(0, 5).map(item), texts.slice(0, 4)), ['opened_via_ui'])
})
test('empty and unknown items fail', () => {
  assert.ok(failed([]).includes('count'))
  assert.ok(failed([...texts.slice(0, 4).map(item), { title: 'Not a real post', text: 'x' }]).includes('all_identified'))
})

test('feed page and list API never expose post bodies or fitness beyond the visible video badge', async () => {
  const { createFeed } = await import('../sites/feed/app.mjs')
  const { app, store } = createFeed(), run = store.create({ seed, taskId: 'feed.collect_text_posts' })
  const server = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)) }), base = `http://127.0.0.1:${server.address().port}`
  try {
    const html = await (await fetch(`${base}/?run=${run.id}`)).text(), list = await (await fetch(`${base}/api/feed?q=${encodeURIComponent(query)}`, { headers: { cookie: `feed_run=${run.id}` } })).text()
    for (const p of texts) { assert.ok(!html.includes(p.body.slice(0, 40))); assert.ok(!list.includes(p.body.slice(0, 40))) }
    assert.equal((await fetch(`${base}/__eval/grade/${run.id}`, { method: 'POST' })).status, 403)
    assert.equal(run.state.opened, undefined, 'listing does not count as opening')
  } finally { server.close() }
})
