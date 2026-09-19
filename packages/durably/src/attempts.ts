import { ValidationError } from './errors'

export type JsonValue =
  null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }

/** Take one data-property snapshot so validation and serialization see the same values. */
export function serializeJsonValue(value: unknown): string {
  const ancestors = new WeakSet<object>()

  function normalize(current: unknown): JsonValue {
    if (
      current === null ||
      typeof current === 'string' ||
      typeof current === 'boolean'
    ) {
      return current
    }
    if (typeof current === 'number' && Number.isFinite(current)) return current
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
    try {
      if (Array.isArray(current)) {
        const keys = Reflect.ownKeys(current)
        if (
          keys.some(
            (key) =>
              key !== 'length' &&
              (typeof key !== 'string' ||
                !/^(0|[1-9]\d*)$/.test(key) ||
                Number(key) >= current.length),
          )
        ) {
          throw new ValidationError(
            'Attempt metadata arrays must not contain extra properties',
          )
        }
        const normalized: JsonValue[] = []
        for (let index = 0; index < current.length; index++) {
          const descriptor = Object.getOwnPropertyDescriptor(current, index)
          if (!descriptor?.enumerable || !('value' in descriptor)) {
            throw new ValidationError(
              'Attempt metadata must not contain sparse arrays or accessors',
            )
          }
          normalized.push(normalize(descriptor.value))
        }
        return normalized
      }

      const normalized: { [key: string]: JsonValue } = Object.create(null)
      for (const key of Reflect.ownKeys(current)) {
        if (typeof key !== 'string') {
          throw new ValidationError(
            'Attempt metadata must not contain symbol keys',
          )
        }
        const descriptor = Object.getOwnPropertyDescriptor(current, key)
        if (!descriptor?.enumerable || !('value' in descriptor)) {
          throw new ValidationError(
            'Attempt metadata objects must contain only enumerable data properties',
          )
        }
        normalized[key] = normalize(descriptor.value)
      }
      return normalized
    } finally {
      ancestors.delete(current)
    }
  }

  return JSON.stringify(normalize(value))
}
