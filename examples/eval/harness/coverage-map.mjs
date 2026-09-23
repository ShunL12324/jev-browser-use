#!/usr/bin/env node
// Prints the checklist -> task coverage map (markdown) used in docs/eval.zh-CN.md.
import { readFileSync } from 'node:fs'
import { loadTasks } from './tasks.mjs'
const checklist = JSON.parse(readFileSync(new URL('../checklist.json', import.meta.url))), tasks = loadTasks()
const total = checklist.items.reduce((s, i) => s + i.weight, 0)
console.log('| ID | 能力 | 权重 | 本地任务 | 公开任务 |\n|---|---|---|---|---|')
for (const i of checklist.items) {
  const local = i.id === 'ROB-3' ? ['所有 local 任务的 alternate 变体'] : tasks.filter(t => t.suite === 'local' && t.capabilities.includes(i.id)).map(t => t.id)
  const pub = tasks.filter(t => t.suite === 'public' && t.capabilities.includes(i.id)).map(t => t.id)
  console.log(`| ${i.id} | ${i.title}${i.knownLimit ? '（known-limit）' : ''} | ${i.weight} | ${local.join(', ') || '—'} | ${pub.join(', ') || '—'} |`)
}
console.log(`\n总权重 ${total}；known-limit 权重 ${checklist.items.filter(i => i.knownLimit).reduce((s, i) => s + i.weight, 0)}（${(100 * checklist.items.filter(i => i.knownLimit).reduce((s, i) => s + i.weight, 0) / total).toFixed(1)}%）。本地任务 ${tasks.filter(t => t.suite === 'local').length} 个，公开只读任务 ${tasks.filter(t => t.suite === 'public').length} 个。`)
