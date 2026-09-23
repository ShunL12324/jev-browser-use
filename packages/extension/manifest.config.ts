// manifest.config.ts — @crxjs/vite-plugin generates the real manifest.json
// from this at build time. Keeping it as TS lets us reference paths
// relative to src/.

import { defineManifest } from '@crxjs/vite-plugin'
import pkg from './package.json' with { type: 'json' }

export default defineManifest({
  manifest_version: 3,
  name: 'browser-use',
  version: pkg.version,
  description:
    'MCP-driven browser automation. Pair with browser-use-mcp to drive Chrome from Claude Code or any MCP client.',

  // No `debugger` permission. Everything DOM-side runs through content
  // scripts (snapshot, click, type, network capture, file upload).
  // No "Debugging this browser" infobar, no CDP fingerprint.
  permissions: [
    'tabs',
    'storage',
    'cookies',         // chrome.cookies.getAll for get_cookie
    'scripting',       // chrome.scripting fallback (rarely used)
    'alarms',
    'webNavigation',   // chrome.webNavigation.getAllFrames for snapshot fanout
    'tabGroups'        // group agent tabs in their dedicated window
  ],
  host_permissions: ['<all_urls>'],

  background: {
    service_worker: 'src/service-worker/index.ts',
    type: 'module'
  },

  // Three content scripts run in every frame at document_start:
  //   - isolated.ts (ISOLATED world): DOM walk, ref tagging, action
  //     dispatch, chrome.* APIs (incl. chrome.dom.openOrClosedShadowRoot
  //     for closed shadow piercing on Chrome 124+).
  //   - main.ts (MAIN world): overrides alert/confirm/prompt;
  //     runs eval_js requests proxied via postMessage.
  //   - network-patch.ts (MAIN world): monkey-patches fetch + XHR to
  //     capture per-tab network activity in real time. Preserves
  //     Function.prototype.toString fingerprint for anti-detection.
  content_scripts: [
    {
      js: ['src/content-scripts/isolated.ts'],
      matches: ['<all_urls>'],
      run_at: 'document_start',
      all_frames: true,
      match_about_blank: true
    },
    {
      js: ['src/content-scripts/main.ts'],
      matches: ['<all_urls>'],
      run_at: 'document_start',
      all_frames: true,
      match_about_blank: true,
      world: 'MAIN'
    },
    {
      js: ['src/content-scripts/network-patch.ts'],
      matches: ['<all_urls>'],
      run_at: 'document_start',
      all_frames: true,
      match_about_blank: true,
      world: 'MAIN'
    }
  ],

  action: {
    default_title: 'browser-use',
    default_popup: 'src/popup/index.html'
  }
})
