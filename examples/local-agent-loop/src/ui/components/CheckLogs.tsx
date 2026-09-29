import { COPY, DETAIL, DETAIL_LABEL } from '../glossary'
import type { RunDetailResponse } from '../server'
import { CopyAnnouncer, useCopy } from './copy'
import { Field } from './KeyValue'
import { PathValue } from './PathValue'

/**
 * The check logs the check text points at, each with a copy button, or a
 * plain sentence when the file or the record of it is missing.
 */
export function CheckLogs({ logs }: { logs: RunDetailResponse['checkLogs'] }) {
  const { copied, copy } = useCopy()
  if (logs.length === 0)
    return <p className="text-fg-2 text-sm">{DETAIL.noLogRecorded}</p>
  return (
    <>
      <dl className="flex flex-col gap-2">
        {logs.map((log, at) => (
          // Attempts can share a path, so the position keeps keys apart.
          <Field key={`${at}:${log.path}`} label={DETAIL_LABEL[log.kind]}>
            <PathValue
              path={log.path}
              label={COPY.path(DETAIL_LABEL[log.kind])}
              copied={copied}
              onCopy={copy}
            />
            {log.exists ? null : (
              <span className="font-ui text-fg-2 mt-1 block text-xs">
                {DETAIL.logMissing}
              </span>
            )}
          </Field>
        ))}
      </dl>
      <CopyAnnouncer copied={copied} />
    </>
  )
}
