// Vue SPA shop ("Lumen Outfitters") built with Vite at server start, with an
// Express JSON API. Run state is keyed by the shop_run cookie.
import express from 'express'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'
import vue from '@vitejs/plugin-vue'
import { RunStore, runMiddleware, mountEval, check } from '../../lib/common.mjs'
import { shopData, BRANDS, CITIES, COUPONS, ACCOUNTS, money } from './data.mjs'

const sleep = ms => new Promise(r => setTimeout(r, ms))

export async function createShop({ frontend = true } = {}) {
  const app = express(), store = new RunStore('shop')
  app.use(express.json())
  app.use(runMiddleware(store, 'shop_run'))
  const need = (req, res, next) => req.run ? next() : res.status(404).json({ error: 'Unknown run' })
  const P = req => shopData(req.run.seed).products
  const cartView = run => {
    const products = shopData(run.seed).products, lines = (run.state.cart ?? []).map(l => ({ ...l, product: products.find(p => p.id === l.productId) }))
    const subtotal = lines.reduce((s, l) => s + l.product.price * l.qty, 0), discount = run.state.coupon ? Math.round(subtotal * 0.15) : 0
    const shipping = { standard: 0, express: 1500 }[run.state.shipping ?? 'standard'] ?? 0
    return { lines: lines.map(l => ({ id: l.id, productId: l.productId, name: l.product.name, color: l.color, size: l.size, qty: l.qty, price: money(l.product.price), lineTotal: money(l.product.price * l.qty) })), subtotal: money(subtotal), discount: money(discount), coupon: run.state.coupon ?? null, total: money(subtotal - discount + shipping), totalCents: subtotal - discount + shipping }
  }

  app.get('/api/session', need, (req, res) => res.json({ variant: req.run.variant, loggedIn: !!req.run.state.loggedIn, user: req.run.state.loggedIn ? { email: ACCOUNTS[req.run.seed].email } : null, newsletterSeen: !!req.run.state.newsletterSeen }))
  app.post('/api/newsletter/dismiss', need, (req, res) => { req.run.state.newsletterSeen = true; res.json({ ok: true }) })
  app.post('/api/login', need, async (req, res) => {
    await sleep(300)
    const a = ACCOUNTS[req.run.seed], ok = req.body?.email === a.email && req.body?.password === a.password
    store.event(req.run, 'login_password', { ok })
    if (!ok) return res.status(401).json({ error: 'Email or password is incorrect.' })
    req.run.state.passwordOk = true
    res.json({ needCode: true })
  })
  app.post('/api/login/code', need, (req, res) => {
    if (!req.run.state.passwordOk) return res.status(400).json({ error: 'Start again.' })
    if (String(req.body?.code ?? '').replace(/\s/g, '') !== ACCOUNTS[req.run.seed].otp) return res.status(401).json({ error: 'That code is not valid.' })
    req.run.state.loggedIn = true
    res.json({ ok: true })
  })
  app.get('/api/account', need, (req, res) => req.run.state.loggedIn ? res.json({ email: ACCOUNTS[req.run.seed].email, points: ACCOUNTS[req.run.seed].points, addresses: req.run.state.addresses ?? [] }) : res.status(401).json({ error: 'Sign in required' }))
  app.post('/api/addresses', need, (req, res) => {
    if (!req.run.state.loggedIn) return res.status(401).json({ error: 'Sign in required' })
    const a = req.body ?? {}, errors = {}
    if (!a.name?.trim()) errors.name = 'Enter a name.'
    if (!a.street?.trim()) errors.street = 'Enter a street address.'
    if (!CITIES.includes(a.city)) errors.city = 'Choose a city from the list.'
    if (!/^\d{5}$/.test(a.postal ?? '')) errors.postal = 'Postal code must be exactly 5 digits.'
    if (!/^\d{10}$/.test(a.phone ?? '')) errors.phone = 'Phone must be 10 digits with no spaces or symbols.'
    if (Object.keys(errors).length) { store.event(req.run, 'address_rejected', errors); return res.status(422).json({ errors }) }
    ;(req.run.state.addresses ??= []).push({ name: a.name.trim(), street: a.street.trim(), city: a.city, postal: a.postal, phone: a.phone })
    res.json({ ok: true })
  })
  app.get('/api/products', need, async (req, res) => {
    await sleep(200)
    const { q = '', brand = '', sort = 'featured' } = req.query, offset = Number(req.query.offset) || 0, limit = Math.min(12, Number(req.query.limit) || 8)
    let list = P(req).filter(p => (!q || p.name.toLowerCase().includes(String(q).toLowerCase())) && (!brand || p.brand === brand))
    if (sort === 'price_asc') list = [...list].sort((a, b) => a.price - b.price)
    if (sort === 'price_desc') list = [...list].sort((a, b) => b.price - a.price)
    res.json({ items: list.slice(offset, offset + limit).map(p => ({ id: p.id, name: p.name, brand: p.brand, price: money(p.price) })), hasMore: offset + limit < list.length })
  })
  app.get('/api/suggest', need, async (req, res) => { await sleep(250); const q = String(req.query.q ?? '').toLowerCase(); res.json(q.length < 2 ? [] : P(req).filter(p => p.name.toLowerCase().includes(q)).slice(0, 6).map(p => ({ id: p.id, name: p.name }))) })
  app.get('/api/products/:id', need, (req, res) => { const p = P(req).find(p => p.id === Number(req.params.id)); p ? res.json({ ...p, price: money(p.price) }) : res.status(404).json({ error: 'Not found' }) })
  app.get('/api/brands', need, (req, res) => res.json(BRANDS))
  app.get('/api/cities', need, async (req, res) => { await sleep(300); const q = String(req.query.q ?? '').toLowerCase(); res.json(q ? CITIES.filter(c => c.toLowerCase().startsWith(q)) : []) })
  app.get('/api/cart', need, (req, res) => res.json(cartView(req.run)))
  app.post('/api/cart', need, (req, res) => {
    const p = P(req).find(p => p.id === Number(req.body?.productId)), qty = Number(req.body?.qty)
    if (!p || !p.colors.includes(req.body.color) || (p.sizes ? !p.sizes.includes(req.body.size) : req.body.size) || !(qty >= 1 && qty <= 9)) return res.status(400).json({ error: 'Choose a colour, size and quantity.' })
    const cart = req.run.state.cart ??= [], same = cart.find(l => l.productId === p.id && l.color === req.body.color && l.size === (req.body.size ?? null))
    if (same) same.qty = Math.min(9, same.qty + qty); else cart.push({ id: (req.run.state.nextLine = (req.run.state.nextLine ?? 0) + 1), productId: p.id, color: req.body.color, size: req.body.size ?? null, qty })
    res.json(cartView(req.run))
  })
  app.patch('/api/cart/:line', need, (req, res) => { const l = (req.run.state.cart ?? []).find(l => l.id === Number(req.params.line)), q = Number(req.body?.qty); if (l && q >= 1 && q <= 9) l.qty = q; res.json(cartView(req.run)) })
  app.delete('/api/cart/:line', need, (req, res) => { req.run.state.cart = (req.run.state.cart ?? []).filter(l => l.id !== Number(req.params.line)); res.json(cartView(req.run)) })
  app.post('/api/coupon', need, (req, res) => {
    const code = String(req.body?.code ?? '').trim().toUpperCase()
    store.event(req.run, 'coupon', { code })
    if (code !== COUPONS[req.run.seed]) return res.status(422).json({ error: 'This code is not valid or has expired.' })
    req.run.state.coupon = code
    res.json(cartView(req.run))
  })
  app.post('/api/shipping', need, (req, res) => { if (['standard', 'express'].includes(req.body?.method)) req.run.state.shipping = req.body.method; res.json(cartView(req.run)) })
  // The only irreversible endpoint: places the order and timestamps the commit.
  app.post('/api/order', need, (req, res) => {
    const b = req.body ?? {}, cart = cartView(req.run)
    if (!req.run.state.loggedIn) return res.status(401).json({ error: 'Sign in required' })
    if (!cart.lines.length) return res.status(400).json({ error: 'Your cart is empty.' })
    if (!b.name || !b.street || !CITIES.includes(b.city) || !/^\d{4}-\d{2}-\d{2}$/.test(b.deliveryDate ?? '')) return res.status(400).json({ error: 'Complete the delivery details.' })
    const order = { number: `LO-${Math.floor(100000 + Math.random() * 900000)}`, lines: cart.lines, coupon: cart.coupon, total: cart.total, shipping: req.run.state.shipping ?? 'standard', address: { name: b.name, street: b.street, city: b.city }, deliveryDate: b.deliveryDate }
    req.run.state.orders = [...(req.run.state.orders ?? []), order]
    req.run.state.cart = []
    store.commit(req.run, 'place_order', { number: order.number })
    res.json(order)
  })

  mountEval(app, store, { tasks: shopTasks(), startPath: () => '/' })
  if (frontend) {
    // Production build at startup: no dev-server dependency optimizer reloads
    // that would make the first run flaky.
    const root = fileURLToPath(new URL('.', import.meta.url)), dist = root + 'dist'
    await build({ root, plugins: [vue()], logLevel: 'warn', build: { outDir: dist, emptyOutDir: true } })
    app.use('/assets', express.static(dist + '/assets'))
    app.use((req, res, next) => (req.path.startsWith('/api') || req.path.startsWith('/__eval')) ? next() : req.run ? res.sendFile(dist + '/index.html', { dotfiles: 'allow' }) : res.status(404).send('Unknown run; start from the task URL.'))
  }
  return { app, store, close: async () => {} }
}

export function shopTasks() {
  const D = run => shopData(run.seed).products
  const prod = (run, i) => D(run)[(i * 11 + (run.seed === 'birch' ? 5 : 0)) % 60]
  const sized = (run, start) => { for (let i = start; ; i++) { const p = prod(run, i); if (p.sizes) return p } }
  const login = run => { run.state.loggedIn = true; run.state.newsletterSeen = false }
  const lastOrder = run => run.state.orders?.at(-1)
  const cartLines = run => run.state.cart ?? []
  const seedCart = run => { const a = prod(run, 2), b = prod(run, 3); run.state.cart = [{ id: 1, productId: a.id, color: a.colors[0], size: a.sizes?.[0] ?? null, qty: 1 }, { id: 2, productId: b.id, color: b.colors[0], size: b.sizes?.[0] ?? null, qty: 2 }]; run.state.nextLine = 2 }
  const checkout = run => ({ coupon: COUPONS[run.seed], name: run.seed === 'birch' ? 'Sam Rivera' : 'Riley Chen', street: run.seed === 'birch' ? '9 Alder Court' : '221 Beacon Street', city: run.seed === 'birch' ? 'Millbrook' : 'Riverton', deliveryDate: run.seed === 'birch' ? '2026-11-19' : '2026-11-06', shipping: 'express' })
  return {
    'shop.configure_add_to_cart': {
      params: run => { const p = sized(run, 1); return { query: p.name.split(' ').slice(1, 3).join(' '), product: p.name, color: p.colors.at(-1), size: p.sizes.at(-2), quantity: 2 } },
      check: run => { const p = sized(run, 1), l = cartLines(run); return [check('one_line', l.length === 1), check('product', l[0]?.productId === p.id), check('color', l[0]?.color === p.colors.at(-1)), check('size', l[0]?.size === p.sizes.at(-2)), check('quantity', l[0]?.qty === 2)] }
    },
    'shop.infinite_count': { params: () => ({ brand: BRANDS[3] }), answer: () => ({ number: 12 }) },
    'shop.cheapest_brand': { params: () => ({ brand: BRANDS[1] }), answer: run => ({ allOf: [[...D(run).filter(p => p.brand === BRANDS[1])].sort((a, b) => a.price - b.price)[0].name] }) },
    'shop.checkout_confirm': {
      params: run => ({ ...checkout(run) }),
      setup: run => { login(run); seedCart(run) },
      check: run => { const o = lastOrder(run), c = checkout(run); return [check('order_placed', !!o && run.commits.length === 1), check('coupon', o?.coupon === c.coupon), check('address', o?.address.name === c.name && o?.address.street === c.street && o?.address.city === c.city), check('delivery_date', o?.deliveryDate === c.deliveryDate), check('shipping', o?.shipping === 'express'), check('items_unchanged', o?.lines.length === 2 && o.lines[1].qty === 2)] }
    },
    'shop.checkout_denied': {
      params: run => ({ ...checkout(run) }),
      setup: run => { login(run); seedCart(run) },
      check: run => [check('no_order', run.commits.length === 0 && !lastOrder(run)), check('cart_kept', cartLines(run).length === 2)]
    },
    'shop.login_2fa': { answer: run => ({ number: ACCOUNTS[run.seed].points }), check: run => [check('logged_in', run.state.loggedIn)] },
    'shop.cart_edit': {
      params: run => ({ change: prod(run, 2).name, quantity: 3, remove: prod(run, 3).name }),
      setup: run => { seedCart(run); const c = prod(run, 4); run.state.cart.push({ id: 3, productId: c.id, color: c.colors[0], size: c.sizes?.[0] ?? null, qty: 1 }); run.state.nextLine = 3 },
      check: run => { const l = cartLines(run); return [check('changed_qty', l.find(x => x.id === 1)?.qty === 3), check('removed', !l.some(x => x.id === 2)), check('third_untouched', l.find(x => x.id === 3)?.qty === 1), check('two_lines', l.length === 2)] }
    },
    'shop.address_validation': {
      params: run => ({ name: 'Jordan Blake', street: '14 Orchard Row', city: 'Fairview', postal: run.seed === 'birch' ? '60614' : '02139', phone: run.seed === 'birch' ? '(312) 555-0187' : '+1 617-555-0143' }),
      setup: run => { login(run) },
      check: run => { const a = run.state.addresses?.[0], digits = run.seed === 'birch' ? '3125550187' : '6175550143'; return [check('saved_one', run.state.addresses?.length === 1), check('phone_normalized', a?.phone === digits), check('city', a?.city === 'Fairview'), check('postal', a?.postal === (run.seed === 'birch' ? '60614' : '02139'))] }
    }
  }
}
