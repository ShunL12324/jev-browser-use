// Starts every local eval site on its own port (distinct origins, so the
// workspace/partner pair exercises real cross-origin iframes and popups).
// complex-forms (React) stays in examples/complex-forms on 17431.
import { fileURLToPath } from 'node:url'
import { writeFileSync } from 'node:fs'
import { EVAL_TOKEN } from './lib/common.mjs'
import { createPortal } from './sites/portal/app.mjs'
import { createShop } from './sites/shop/app.mjs'
import { createWorkspace } from './sites/workspace/app.mjs'
import { createPartner } from './sites/partner/app.mjs'
import { createForma } from './sites/forma/app.mjs'
import { createFeed } from './sites/feed/app.mjs'

export const HOST = process.env.EVAL_HOST ?? '127.0.0.1'
export const PORTS = { portal: 17441, shop: 17442, workspace: 17443, partner: 17444, forma: 17445, feed: 17446 }
export const origin = site => `http://${HOST === '0.0.0.0' ? '127.0.0.1' : HOST}:${PORTS[site]}`

export async function startAll({ quiet = false } = {}) {
  const servers = [], closers = []
  const listen = (name, app) => new Promise((resolve, reject) => {
    const s = app.listen(PORTS[name], HOST, () => { if (!quiet) console.log(`${name.padEnd(9)} ${origin(name)}`); resolve() })
    s.on('error', reject); servers.push(s)
  })
  const partner = createPartner({ workspaceOrigin: origin('workspace') })
  await listen('portal', createPortal().app)
  const shop = await createShop(); closers.push(shop.close)
  await listen('shop', shop.app)
  await listen('workspace', createWorkspace({ partnerOrigin: origin('partner'), partner: partner.store }).app)
  await listen('partner', partner.app)
  await listen('forma', createForma().app)
  await listen('feed', createFeed().app)
  // Written only after every port is bound, so a failed duplicate start cannot
  // replace the running servers' token. Only the harness reads this file.
  writeFileSync(new URL('./.eval-token', import.meta.url), EVAL_TOKEN, { mode: 0o600 })
  return { close: async () => { await Promise.all(closers.map(c => c())); await Promise.all(servers.map(s => new Promise(r => s.close(r)))) } }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await startAll()
