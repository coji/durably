/**
 * Report Generation Job (Long-running demo)
 *
 * Simulates a multi-phase analytics report pipeline with many steps.
 * Designed to demonstrate:
 * - SSE streaming with real-time step progress
 * - Cron background processing for interrupted jobs
 * - Step resumability across serverless invocations
 *
 * Phases:
 * 1. Data collection (5 sources)
 * 2. Data cleaning & transformation (4 steps)
 * 3. Analysis (5 metrics)
 * 4. Chart generation (4 charts)
 * 5. Report assembly & delivery (3 steps)
 *
 * Total: ~21 steps, ~90 seconds
 *
 * This intentionally exceeds Vercel's serverless timeout (10s hobby / 60s pro)
 * to demonstrate step resumability: SSE streams progress until timeout,
 * then Vercel Cron picks up remaining steps on the next invocation.
 */

import { defineJob } from '@coji/durably'
import { z } from 'zod'
import { delay } from './delay'

const outputSchema = z.object({
  reportUrl: z.string(),
  totalRecords: z.number(),
  generatedAt: z.string(),
})

export const generateReportJob = defineJob({
  name: 'generate-report',
  input: z.object({
    reportType: z.enum(['daily', 'weekly', 'monthly']),
    department: z.string(),
  }),
  output: outputSchema,
  run: async (step, input) => {
    // Use fixed step numbers instead of a mutable counter.
    // Step callbacks are skipped on resume (cached output returned),
    // so a mutable counter would report wrong progress after restart.
    const T = 21

    step.log.info(`Starting ${input.reportType} report for ${input.department}`)

    // ── Phase 1: Data Collection (5 steps) ──

    const salesData = await step.run('collect-sales', async () => {
      step.progress(1, T, 'Collecting sales data...')
      await delay(4000)
      const records = Math.floor(Math.random() * 5000) + 3000
      step.log.info(`Sales: ${records} records`)
      return { records, revenue: records * 42.5 }
    })

    const inventoryData = await step.run('collect-inventory', async () => {
      step.progress(2, T, 'Collecting inventory data...')
      await delay(3500)
      const items = Math.floor(Math.random() * 2000) + 1000
      step.log.info(`Inventory: ${items} items`)
      return { items, lowStock: Math.floor(items * 0.12) }
    })

    const customerData = await step.run('collect-customers', async () => {
      step.progress(3, T, 'Collecting customer data...')
      await delay(4500)
      const customers = Math.floor(Math.random() * 1500) + 500
      step.log.info(`Customers: ${customers} profiles`)
      return { customers, newCustomers: Math.floor(customers * 0.08) }
    })

    const supportData = await step.run('collect-support', async () => {
      step.progress(4, T, 'Collecting support tickets...')
      await delay(3000)
      const tickets = Math.floor(Math.random() * 300) + 100
      step.log.info(`Support: ${tickets} tickets`)
      return { tickets, resolved: Math.floor(tickets * 0.85) }
    })

    const webAnalytics = await step.run('collect-analytics', async () => {
      step.progress(5, T, 'Collecting web analytics...')
      await delay(5000)
      const pageViews = Math.floor(Math.random() * 50000) + 20000
      step.log.info(`Analytics: ${pageViews} page views`)
      return { pageViews, uniqueVisitors: Math.floor(pageViews * 0.35) }
    })

    const totalRecords =
      salesData.records +
      inventoryData.items +
      customerData.customers +
      supportData.tickets +
      webAnalytics.pageViews

    // ── Phase 2: Data Cleaning & Transformation (4 steps) ──

    await step.run('deduplicate', async () => {
      step.progress(6, T, 'Deduplicating records...')
      await delay(5000)
      const dupes = Math.floor(totalRecords * 0.03)
      step.log.info(`Removed ${dupes} duplicate records`)
    })

    await step.run('normalize', async () => {
      step.progress(7, T, 'Normalizing data formats...')
      await delay(4000)
      step.log.info('Data formats normalized')
    })

    await step.run('enrich', async () => {
      step.progress(8, T, 'Enriching with external data...')
      await delay(6000)
      step.log.info('Data enriched with geo and demographic info')
    })

    await step.run('validate-data', async () => {
      step.progress(9, T, 'Validating data integrity...')
      await delay(3000)
      step.log.info('Data validation passed')
    })

    // ── Phase 3: Analysis (5 steps) ──

    const revenueMetrics = await step.run('analyze-revenue', async () => {
      step.progress(10, T, 'Analyzing revenue trends...')
      await delay(4000)
      const growth = (Math.random() * 20 - 5).toFixed(1)
      step.log.info(`Revenue growth: ${growth}%`)
      return { growth: Number(growth), total: salesData.revenue }
    })

    await step.run('analyze-retention', async () => {
      step.progress(11, T, 'Analyzing customer retention...')
      await delay(3500)
      const rate = (85 + Math.random() * 10).toFixed(1)
      step.log.info(`Retention rate: ${rate}%`)
    })

    await step.run('analyze-support', async () => {
      step.progress(12, T, 'Analyzing support metrics...')
      await delay(3000)
      const avgTime = (2 + Math.random() * 4).toFixed(1)
      step.log.info(`Avg resolution time: ${avgTime}h`)
    })

    await step.run('analyze-traffic', async () => {
      step.progress(13, T, 'Analyzing traffic patterns...')
      await delay(4000)
      step.log.info(
        `Peak traffic: ${webAnalytics.uniqueVisitors} unique visitors`,
      )
    })

    await step.run('analyze-inventory', async () => {
      step.progress(14, T, 'Analyzing inventory turnover...')
      await delay(3000)
      const turnover = (3 + Math.random() * 5).toFixed(1)
      step.log.info(`Inventory turnover: ${turnover}x`)
    })

    // ── Phase 4: Chart Generation (4 steps) ──

    await step.run('chart-revenue', async () => {
      step.progress(15, T, 'Generating revenue chart...')
      await delay(3500)
      step.log.info('Revenue trend chart generated')
    })

    await step.run('chart-customers', async () => {
      step.progress(16, T, 'Generating customer chart...')
      await delay(3000)
      step.log.info('Customer growth chart generated')
    })

    await step.run('chart-support', async () => {
      step.progress(17, T, 'Generating support chart...')
      await delay(3000)
      step.log.info('Support metrics chart generated')
    })

    await step.run('chart-traffic', async () => {
      step.progress(18, T, 'Generating traffic chart...')
      await delay(3500)
      step.log.info('Traffic heatmap generated')
    })

    // ── Phase 5: Report Assembly & Delivery (3 steps) ──

    await step.run('assemble-pdf', async () => {
      step.progress(19, T, 'Assembling PDF report...')
      await delay(6000)
      step.log.info('PDF report assembled (24 pages)')
    })

    const reportUrl = await step.run('upload-report', async () => {
      step.progress(20, T, 'Uploading report...')
      await delay(4000)
      const url = `https://reports.example.com/${input.department}/${input.reportType}-${Date.now()}.pdf`
      step.log.info(`Report uploaded: ${url}`)
      return url
    })

    await step.run('send-notifications', async () => {
      step.progress(21, T, 'Sending notifications...')
      await delay(2000)
      step.log.info(
        `Notification sent to ${input.department} team (revenue: $${revenueMetrics.total.toLocaleString()})`,
      )
    })

    return {
      reportUrl,
      totalRecords,
      generatedAt: new Date().toISOString(),
    }
  },
})
