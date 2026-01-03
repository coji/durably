/**
 * HTTP response utilities for the Durably HTTP handler.
 * Extracted to eliminate duplication in server.ts handlers.
 */

import { getErrorMessage } from './errors'

export { getErrorMessage }

/**
 * JSON response headers
 */
const JSON_HEADERS = {
  'Content-Type': 'application/json',
} as const

/**
 * Create a JSON response
 */
export function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: JSON_HEADERS,
  })
}

/**
 * Create an error response with consistent format
 */
export function errorResponse(
  message: string,
  status: 400 | 404 | 500 = 500,
): Response {
  return jsonResponse({ error: message }, status)
}

/**
 * Create a success response with { success: true }
 */
export function successResponse(): Response {
  return jsonResponse({ success: true })
}

/**
 * Get required query parameter or return error response
 */
export function getRequiredQueryParam(
  url: URL,
  paramName: string,
): string | Response {
  const value = url.searchParams.get(paramName)
  if (!value) {
    return errorResponse(`${paramName} query parameter is required`, 400)
  }
  return value
}
