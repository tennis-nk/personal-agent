import { readFileSync, writeFileSync } from 'node:fs'
import { build } from 'esbuild'

// 直接用应用自己的解析器把课表转成课程记录，验证导入链路而不是另写一套。
const out = await build({
  entryPoints: ['src/schedule/parse.ts'],
  bundle: true, format: 'esm', platform: 'node', write: false,
})
const mod = await import('data:text/javascript;base64,' + Buffer.from(out.outputFiles[0].text).toString('base64'))
const text = readFileSync('docs/课表-2026秋.txt', 'utf8')
const res = mod.parseTimetable(text, 16)
const slots = [
  ['08:00','08:45'],['08:55','09:40'],['10:00','10:45'],['10:55','11:40'],
  ['14:00','14:45'],['14:55','15:40'],['16:00','16:45'],['16:55','17:40'],
  ['18:30','19:15'],['19:25','20:10'],['20:20','21:05'],['21:15','22:00'],
]
const now = new Date('2026-10-29T09:00:00.000Z').toISOString()
const courses = res.items.map((it, i) => ({
  id: i + 1, owner_id: 'local-user', name: it.name, teacher: it.teacher, location: it.location,
  weekday: it.weekday, start_slot: it.startSlot, end_slot: it.endSlot,
  start_time: slots[it.startSlot - 1][0], end_time: slots[it.endSlot - 1][1],
  weeks: it.weeks, semester_start: '2026-09-07', created_at: now,
}))
const db = { version: 1, notes: [], todos: [], courses, links: [], messages: [], reports: [], seq: 100 }
const seed = `<script>try{localStorage.setItem("infobutler.local.v1",${JSON.stringify(JSON.stringify(db))});localStorage.setItem("infobutler.slots.v1",${JSON.stringify(JSON.stringify(slots.map((s, i) => ({ index: i + 1, start: s[0], end: s[1] }))))})}catch(e){}</script>`
const html = readFileSync('dist/index.html', 'utf8')
writeFileSync('dist/seed.html', html.replace('</head>', seed + '</head>'))
console.log('courses =', courses.length)
