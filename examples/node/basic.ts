/**
 * Node.js Example for Durably
 *
 * This example shows basic usage of Durably with Turso/libSQL.
 * Implementation is pending - this is a placeholder.
 */

import { LibsqlDialect } from '@libsql/kysely-libsql'
// import { z } from 'zod'
// import { createDurably } from '@coji/durably'

// Turso の場合は環境変数から URL と authToken を取得
// ローカル開発では libsql://localhost:8080 または file:local.db を使用
const dialect = new LibsqlDialect({
  url: process.env.TURSO_DATABASE_URL ?? 'file:local.db',
  authToken: process.env.TURSO_AUTH_TOKEN,
})

console.log('Durably Node.js Example')
console.log('Dialect created:', dialect.constructor.name)
console.log('Implementation pending...')

// TODO: Implement after Phase 1
// const durably = createDurably({ dialect })
//
// const syncUsers = durably.defineJob({
//   name: 'sync-users',
//   input: z.object({ orgId: z.string() }),
//   output: z.object({ count: z.number() }),
// }, async (ctx, payload) => {
//   ctx.log.info('starting sync', { orgId: payload.orgId })
//
//   const users = await ctx.run('fetch-users', async () => {
//     await new Promise(r => setTimeout(r, 1000))
//     return [{ id: '1', name: 'Alice' }, { id: '2', name: 'Bob' }]
//   })
//
//   await ctx.run('save-users', async () => {
//     ctx.log.info('saving users', { count: users.length })
//     await new Promise(r => setTimeout(r, 500))
//   })
//
//   return { count: users.length }
// })
//
// durably.on('run:complete', (event) => {
//   console.log(`Run ${event.runId} completed`)
// })
//
// await durably.migrate()
// durably.start()
//
// const run = await syncUsers.trigger({ orgId: 'org_123' })
// console.log(`Triggered run: ${run.id}`)
//
// await new Promise(r => setTimeout(r, 3000))
// const result = await syncUsers.getRun(run.id)
// console.log('Result:', result)
//
// await durably.stop()
