/**
 * Type inference tests
 *
 * Verify that types are correctly inferred from job definitions
 *
 * These tests use vitest's expectTypeOf to verify compile-time type inference
 * rather than runtime behavior.
 */

import { defineJob } from '@coji/durably'
import { describe, expectTypeOf, it } from 'vitest'
import { z } from 'zod'
import type { UseJobResult } from '../src/hooks/use-job'
import type { UseJobLogsResult } from '../src/hooks/use-job-logs'
import type { UseJobRunResult } from '../src/hooks/use-job-run'

// Test job definitions
const typedJob = defineJob({
  name: 'typed-job',
  input: z.object({ taskId: z.string() }),
  output: z.object({ success: z.boolean() }),
  run: async (_ctx, payload) => ({ success: payload.taskId.length > 0 }),
})

const voidOutputJob = defineJob({
  name: 'void-output-job',
  input: z.object({ value: z.number() }),
  run: async () => {},
})

describe('Type inference', () => {
  describe('useJob', () => {
    it('infers correct return type', () => {
      type Result = UseJobResult<{ taskId: string }, { success: boolean }>

      expectTypeOf<Result['isReady']>().toEqualTypeOf<boolean>()
      expectTypeOf<Result['status']>().toEqualTypeOf<
        'pending' | 'running' | 'completed' | 'failed' | null
      >()
      expectTypeOf<Result['output']>().toEqualTypeOf<{
        success: boolean
      } | null>()
      expectTypeOf<Result['error']>().toEqualTypeOf<string | null>()
      expectTypeOf<Result['currentRunId']>().toEqualTypeOf<string | null>()
      expectTypeOf<Result['isRunning']>().toEqualTypeOf<boolean>()
      expectTypeOf<Result['isPending']>().toEqualTypeOf<boolean>()
      expectTypeOf<Result['isCompleted']>().toEqualTypeOf<boolean>()
      expectTypeOf<Result['isFailed']>().toEqualTypeOf<boolean>()
    })

    it('trigger accepts TInput and returns Promise<{ runId: string }>', () => {
      type Result = UseJobResult<{ taskId: string }, { success: boolean }>

      expectTypeOf<Result['trigger']>().toBeFunction()
      expectTypeOf<Result['trigger']>().parameter(0).toEqualTypeOf<{
        taskId: string
      }>()
      expectTypeOf<Result['trigger']>().returns.toEqualTypeOf<
        Promise<{ runId: string }>
      >()
    })

    it('triggerAndWait returns Promise with typed output', () => {
      type Result = UseJobResult<{ taskId: string }, { success: boolean }>

      expectTypeOf<Result['triggerAndWait']>().toBeFunction()
      expectTypeOf<Result['triggerAndWait']>().parameter(0).toEqualTypeOf<{
        taskId: string
      }>()
      expectTypeOf<Result['triggerAndWait']>().returns.toEqualTypeOf<
        Promise<{ runId: string; output: { success: boolean } }>
      >()
    })

    it('reset is a function with no arguments', () => {
      type Result = UseJobResult<{ taskId: string }, { success: boolean }>

      expectTypeOf<Result['reset']>().toBeFunction()
      expectTypeOf<Result['reset']>().returns.toEqualTypeOf<void>()
    })
  })

  describe('useJobRun', () => {
    it('infers output type from generic', () => {
      type Result = UseJobRunResult<{ data: number[] }>

      expectTypeOf<Result['output']>().toEqualTypeOf<{
        data: number[]
      } | null>()
      expectTypeOf<Result['status']>().toEqualTypeOf<
        'pending' | 'running' | 'completed' | 'failed' | null
      >()
      expectTypeOf<Result['error']>().toEqualTypeOf<string | null>()
    })

    it('defaults to unknown output type', () => {
      type Result = UseJobRunResult

      expectTypeOf<Result['output']>().toEqualTypeOf<unknown | null>()
    })
  })

  describe('useJobLogs', () => {
    it('returns logs array and clearLogs function', () => {
      type Result = UseJobLogsResult

      expectTypeOf<Result['logs']>().toBeArray()
      expectTypeOf<Result['clearLogs']>().toBeFunction()
      expectTypeOf<Result['isReady']>().toEqualTypeOf<boolean>()
    })
  })

  describe('Job definition type inference', () => {
    it('useJob infers types from job definition', () => {
      // This is a compile-time test - if it compiles, types are correct
      // In actual usage, the hook would be called inside a React component

      // Verify the job definition has correct types
      expectTypeOf(typedJob.name).toEqualTypeOf<'typed-job'>()

      // The input schema should accept the correct type
      expectTypeOf(typedJob.input.parse({ taskId: 'test' })).toEqualTypeOf<{
        taskId: string
      }>()

      // The output schema should accept the correct type
      expectTypeOf(typedJob.output?.parse({ success: true })).toEqualTypeOf<
        { success: boolean } | undefined
      >()
    })

    it('handles void output jobs', () => {
      // Void output job returns void, so no output schema is defined
      // We just verify the job compiles correctly without explicit output
      expectTypeOf(voidOutputJob.name).toEqualTypeOf<'void-output-job'>()
    })
  })
})
