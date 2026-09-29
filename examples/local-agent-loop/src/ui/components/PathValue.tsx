import { DETAIL_TEXT } from '../glossary'
import { CopyButton, type OnCopy } from './copy'

/** A file path as data, with a button that copies it. */
export function PathValue({
  path,
  label,
  copied,
  onCopy,
}: {
  path: string
  label: string
  copied: { text: string } | null
  onCopy: OnCopy
}) {
  return (
    <span className="flex flex-col items-start gap-1">
      <span className="font-code break-all">{path}</span>
      <CopyButton text={path} label={label} copied={copied} onCopy={onCopy} />
    </span>
  )
}

/**
 * A log write error: a sentence saying the file may be incomplete, then
 * the error itself as data.
 */
export function LogWriteError({ error }: { error: string }) {
  return (
    <span className="flex flex-col gap-1">
      <span className="font-ui text-sm">{DETAIL_TEXT.logWriteErrorNote}</span>
      <span className="font-code text-xs break-all">{error}</span>
    </span>
  )
}
