import { ValidationError } from './errors'

export type JsonValue =
  null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }

/** Reject values that JSON.stringify would silently discard or coerce. */
export function serializeJsonValue(value: unknown): string {
  const ancestors = new WeakSet<object>()

  function validate(current: unknown): void {
    if (
      current === null ||
      typeof current === 'string' ||
      typeof current === 'boolean'
    ) {
      return
    }
    if (typeof current === 'number' && Number.isFinite(current)) {
      return
    }
    if (typeof current !== 'object') {
      throw new ValidationError('Attempt metadata must be a JSON value')
    }
    if (ancestors.has(current)) {
      throw new ValidationError('Attempt metadata must not contain cycles')
    }
    if (
      !Array.isArray(current) &&
      Object.getPrototypeOf(current) !== Object.prototype &&
      Object.getPrototypeOf(current) !== null
    ) {
      throw new ValidationError(
        'Attempt metadata must contain only plain objects and arrays',
      )
    }
    ancestors.add(current)
    if (Array.isArray(current)) {
      for (let index = 0; index < current.length; index++) {
        if (!(index in current)) {
          throw new ValidationError(
            'Attempt metadata must not contain sparse arrays',
          )
        }
        validate(current[index])
      }
    } else {
      if (Object.getOwnPropertySymbols(current).length > 0) {
        throw new ValidationError(
          'Attempt metadata must not contain symbol keys',
        )
      }
      for (const item of Object.values(current)) validate(item)
    }
    ancestors.delete(current)
  }

  validate(value)
  return JSON.stringify(value)
}
