import { COMMAND_COPY, COPY } from '../glossary'
import { commandNote, commandText } from '../labels'
import { CopyAnnouncer, CopyButton, useCopy } from './copy'

/** What a copy button says, from the command it copies. */
function commandLabel(command: string): string {
  if (/^git .* worktree remove /.test(command))
    return COMMAND_COPY.worktreeRemove
  const sub = /\bdemo (\S+)/.exec(command)?.[1]
  switch (sub) {
    case 'approve':
      return COMMAND_COPY.approve
    case 'reject':
      return COMMAND_COPY.reject
    case 'report':
      return command.includes('--format json')
        ? COMMAND_COPY.reportJson
        : COMMAND_COPY.report
    case 'status':
      return COMMAND_COPY.status
    case 'worker':
      return COMMAND_COPY.worker
    case 'retrigger':
      return command.includes('--reload-config')
        ? COMMAND_COPY.retriggerReload
        : COMMAND_COPY.retrigger
    case 'waits':
      return COMMAND_COPY.waits
    case 'spec-revise':
      return COMMAND_COPY.specRevise
    case 'archive':
      return COMMAND_COPY.archive
    case 'unarchive':
      return COMMAND_COPY.unarchive
    default:
      return COMMAND_COPY.other
  }
}

/**
 * Next commands as copy buttons named for what they do, each with the CLI's
 * note as its tooltip. The command text, which carries IDs such as the wait
 * ID, stays behind a disclosure. With `summary`, the buttons go behind it
 * too: one closed disclosure beside the actions that do the same.
 */
export function Commands({
  lines,
  summary,
}: {
  lines: string[]
  summary?: string
}) {
  const { copied, copy } = useCopy()
  if (lines.length === 0) return null
  const commands = lines.map((line) => {
    const command = commandText(line)
    return { command, label: commandLabel(command), note: commandNote(line) }
  })
  const buttons = (
    <div className="flex flex-wrap gap-2">
      {commands.map(({ command, label, note }) => (
        <CopyButton
          key={command}
          text={command}
          label={label}
          title={note ?? undefined}
          copied={copied}
          onCopy={copy}
        />
      ))}
    </div>
  )
  const text = (
    <ul className="flex flex-col gap-2">
      {commands.map(({ command }) => (
        <li key={command}>
          <code className="bg-sunken font-code text-fg block overflow-x-auto rounded-sm px-2 py-1 text-sm whitespace-pre">
            {command}
          </code>
        </li>
      ))}
    </ul>
  )
  return (
    <div className="flex flex-col gap-2">
      {summary ? null : buttons}
      <details className="text-xs">
        <summary className="text-fg-2 hover:text-fg inline-flex min-h-8 cursor-pointer items-center">
          {summary ?? COPY.commandText}
        </summary>
        <div className="mt-1 flex flex-col gap-2">
          {summary ? buttons : null}
          {text}
        </div>
      </details>
      <CopyAnnouncer copied={copied} />
    </div>
  )
}
