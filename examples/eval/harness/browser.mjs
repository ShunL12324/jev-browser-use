// Isolated temp-profile Chromium for mechanical runs and harness page reads.
// Never the user's browser or profile.
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'

// Optional per-process proxy for public sites (e.g. EVAL_BROWSER_PROXY=http://127.0.0.1:7890);
// local eval sites always bypass it.
export const proxyArgs = () => process.env.EVAL_BROWSER_PROXY ? [`--proxy-server=${process.env.EVAL_BROWSER_PROXY}`, '--proxy-bypass-list=127.0.0.1;localhost;<-loopback>'] : []
export const CHROMIUM = process.env.CHROMIUM_EXECUTABLE ?? '/home/shun/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome'

export async function isolatedBrowser({ headless = true, args = [] } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'eval-profile-'))
  const context = await chromium.launchPersistentContext(join(dir, 'profile'), { executablePath: CHROMIUM, headless, viewport: { width: 1280, height: 900 }, acceptDownloads: true, args: [...proxyArgs(), ...args] })
  return { context, dir, close: async () => { await context.close().catch(() => {}); await rm(dir, { recursive: true, force: true }) } }
}

// Harness-side page read used by page-state checks (URL, visible text and
// labelled control values), independent of any runner's own observation.
export async function readPageState(page) {
  return page.evaluate(() => {
    const label = el => el.getAttribute('aria-label') || (el.labels?.[0]?.innerText) || (el.getAttribute('aria-labelledby') ?? '').split(/\s+/).map(id => document.getElementById(id)?.innerText ?? '').join(' ').trim() || el.innerText || el.getAttribute('placeholder') || ''
    const controls = [...document.querySelectorAll('input,select,textarea,button,[role=button],[role=combobox],[role=link],a[href]')].slice(0, 800).map(el => ({ role: el.getAttribute('role') || el.tagName.toLowerCase(), label: label(el).slice(0, 300), ariaLabel: el.getAttribute('aria-label'), text: (el.innerText ?? '').slice(0, 300), value: 'value' in el ? el.value : (el.getAttribute('aria-valuetext') ?? null) }))
    return { source: 'harness', url: location.href, title: document.title, text: document.body.innerText.slice(0, 20000), controls }
  })
}
