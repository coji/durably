/**
 * Browser Example for Durably
 *
 * This example shows basic usage of Durably with SQLocal (SQLite WASM + OPFS).
 * Implementation is pending - this is a placeholder.
 */

import { SQLocalKysely } from 'sqlocal/kysely'
// import { z } from 'zod'
// import { createDurably } from '@coji/durably'

const { dialect } = new SQLocalKysely('example.sqlite3')

console.log('Durably Browser Example')
console.log('Dialect created:', dialect.constructor.name)

const statusEl = document.getElementById('status')!
const resultEl = document.getElementById('result')!

statusEl.textContent = 'Implementation pending...'
resultEl.textContent = JSON.stringify({ dialect: dialect.constructor.name }, null, 2)

// TODO: Implement after Phase 1
// const durably = createDurably({ dialect })
//
// const processData = durably.defineJob({
//   name: 'process-data',
//   input: z.object({ items: z.array(z.string()) }),
//   output: z.object({ processed: z.number() }),
// }, async (ctx, payload) => {
//   ctx.setProgress({ current: 0, total: payload.items.length })
//
//   for (let i = 0; i < payload.items.length; i++) {
//     await ctx.run(`process-${i}`, async () => {
//       await new Promise(r => setTimeout(r, 200))
//     })
//     ctx.setProgress({ current: i + 1, message: `Processed ${payload.items[i]}` })
//   }
//
//   return { processed: payload.items.length }
// })
//
// durably.on('step:complete', (event) => {
//   statusEl.textContent = `Step ${event.stepName} completed`
// })
//
// await durably.migrate()
// durably.start()
//
// document.getElementById('run-btn')!.addEventListener('click', async () => {
//   const run = await processData.trigger({
//     items: ['item1', 'item2', 'item3']
//   })
//
//   const interval = setInterval(async () => {
//     const current = await processData.getRun(run.id)
//     if (current?.progress) {
//       document.getElementById('progress')!.textContent =
//         `${current.progress.current}/${current.progress.total}`
//     }
//     if (current?.status === 'completed' || current?.status === 'failed') {
//       clearInterval(interval)
//       resultEl.textContent = JSON.stringify(current, null, 2)
//     }
//   }, 100)
// })
