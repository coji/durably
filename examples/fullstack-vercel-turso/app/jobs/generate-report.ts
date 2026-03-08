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

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))

const outputSchema = z.object({
  reportUrl: z.string(),
  totalRecords: z.number(),
  generatedAt: z.string(),
})

export type GenerateReportOutput = z.infer<typeof outputSchema>

export const generateReportJob = defineJob({
  name: 'generate-report',
  input: z.object({
    reportType: z.enum(['daily', 'weekly', 'monthly']),
    department: z.string(),
  }),
  output: outputSchema,
  run: async (step, input) => {
    const totalSteps = 21
    let currentStep = 0

    step.log.info(`Starting ${input.reportType} report for ${input.department}`)

    // ── Phase 1: Data Collection (5 steps) ──

    const salesData = await step.run('collect-sales', async () => {
      currentStep++
      step.progress(currentStep, totalSteps, 'Collecting sales data...')
      await delay(4000)
      const records = Math.floor(Math.random() * 5000) + 3000
      step.log.info(`Sales: ${records} records`)
      return { records, revenue: records * 42.5 }
    })

    const inventoryData = await step.run('collect-inventory', async () => {
      currentStep++
      step.progress(currentStep, totalSteps, 'Collecting inventory data...')
      await delay(3500)
      const items = Math.floor(Math.random() * 2000) + 1000
      step.log.info(`Inventory: ${items} items`)
      return { items, lowStock: Math.floor(items * 0.12) }
    })

    const customerData = await step.run('collect-customers', async () => {
      currentStep++
      step.progress(currentStep, totalSteps, 'Collecting customer data...')
      await delay(4500)
      const customers = Math.floor(Math.random() * 1500) + 500
      step.log.info(`Customers: ${customers} profiles`)
      return { customers, newCustomers: Math.floor(customers * 0.08) }
    })

    const supportData = await step.run('collect-support', async () => {
      currentStep++
      step.progress(currentStep, totalSteps, 'Collecting support tickets...')
      await delay(3000)
      const tickets = Math.floor(Math.random() * 300) + 100
      step.log.info(`Support: ${tickets} tickets`)
      return { tickets, resolved: Math.floor(tickets * 0.85) }
    })

    const webAnalytics = await step.run('collect-analytics', async () => {
      currentStep++
      step.progress(currentStep, totalSteps, 'Collecting web analytics...')
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
      currentStep++
      step.progress(currentStep, totalSteps, 'Deduplicating records...')
      await delay(5000)
      const dupes = Math.floor(totalRecords * 0.03)
      step.log.info(`Removed ${dupes} duplicate records`)
    })

    await step.run('normalize', async () => {
      currentStep++
      step.progress(currentStep, totalSteps, 'Normalizing data formats...')
      await delay(4000)
      step.log.info('Data formats normalized')
    })

    await step.run('enrich', async () => {
      currentStep++
      step.progress(currentStep, totalSteps, 'Enriching with external data...')
      await delay(6000)
      step.log.info('Data enriched with geo and demographic info')
    })

    await step.run('validate-data', async () => {
      currentStep++
      step.progress(currentStep, totalSteps, 'Validating data integrity...')
      await delay(3000)
      step.log.info('Data validation passed')
    })

    // ── Phase 3: Analysis (5 steps) ──

    const revenueMetrics = await step.run('analyze-revenue', async () => {
      currentStep++
      step.progress(currentStep, totalSteps, 'Analyzing revenue trends...')
      await delay(4000)
      const growth = (Math.random() * 20 - 5).toFixed(1)
      step.log.info(`Revenue growth: ${growth}%`)
      return { growth: Number(growth), total: salesData.revenue }
    })

    await step.run('analyze-retention', async () => {
      currentStep++
      step.progress(currentStep, totalSteps, 'Analyzing customer retention...')
      await delay(3500)
      const rate = (85 + Math.random() * 10).toFixed(1)
      step.log.info(`Retention rate: ${rate}%`)
    })

    await step.run('analyze-support', async () => {
      currentStep++
      step.progress(currentStep, totalSteps, 'Analyzing support metrics...')
      await delay(3000)
      const avgTime = (2 + Math.random() * 4).toFixed(1)
      step.log.info(`Avg resolution time: ${avgTime}h`)
    })

    await step.run('analyze-traffic', async () => {
      currentStep++
      step.progress(currentStep, totalSteps, 'Analyzing traffic patterns...')
      await delay(4000)
      step.log.info(
        `Peak traffic: ${webAnalytics.uniqueVisitors} unique visitors`,
      )
    })

    await step.run('analyze-inventory', async () => {
      currentStep++
      step.progress(currentStep, totalSteps, 'Analyzing inventory turnover...')
      await delay(3000)
      const turnover = (3 + Math.random() * 5).toFixed(1)
      step.log.info(`Inventory turnover: ${turnover}x`)
    })

    // ── Phase 4: Chart Generation (4 steps) ──

    await step.run('chart-revenue', async () => {
      currentStep++
      step.progress(currentStep, totalSteps, 'Generating revenue chart...')
      await delay(3500)
      step.log.info('Revenue trend chart generated')
    })

    await step.run('chart-customers', async () => {
      currentStep++
      step.progress(currentStep, totalSteps, 'Generating customer chart...')
      await delay(3000)
      step.log.info('Customer growth chart generated')
    })

    await step.run('chart-support', async () => {
      currentStep++
      step.progress(currentStep, totalSteps, 'Generating support chart...')
      await delay(3000)
      step.log.info('Support metrics chart generated')
    })

    await step.run('chart-traffic', async () => {
      currentStep++
      step.progress(currentStep, totalSteps, 'Generating traffic chart...')
      await delay(3500)
      step.log.info('Traffic heatmap generated')
    })

    // ── Phase 5: Report Assembly & Delivery (3 steps) ──

    await step.run('assemble-pdf', async () => {
      currentStep++
      step.progress(currentStep, totalSteps, 'Assembling PDF report...')
      await delay(6000)
      step.log.info('PDF report assembled (24 pages)')
    })

    const reportUrl = await step.run('upload-report', async () => {
      currentStep++
      step.progress(currentStep, totalSteps, 'Uploading report...')
      await delay(4000)
      const url = `https://reports.example.com/${input.department}/${input.reportType}-${Date.now()}.pdf`
      step.log.info(`Report uploaded: ${url}`)
      return url
    })

    await step.run('send-notifications', async () => {
      currentStep++
      step.progress(currentStep, totalSteps, 'Sending notifications...')
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
