import { COMMAND_COPY, COMMON, COPY } from '../glossary'
import { commandNote, commandText } from '../labels'
import { CopyAnnouncer, CopyButton, useCopy } from './copy'

/** What a copy button says, from the command it copies. */
export function commandLabel(command: string): string {
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
    default:
      return COMMAND_COPY.other
  }
}

/**
 * Next commands as copy buttons named for what they do. The command text,
 * which carries IDs such as the wait ID, stays behind a disclosure.
 */
export function Commands({ lines }: { lines: string[] }) {
  const { copied, copy } = useCopy()
  if (lines.length === 0) return null
  const commands = lines.map(commandText)
  const notes = lines.flatMap((line, i) => {
    const note = commandNote(line)
    const command = commands[i] as string
    return note ? [{ command, label: commandLabel(command), note }] : []
  })
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-2">
        {commands.map((command) => (
          <CopyButton
            key={command}
            text={command}
            label={commandLabel(command)}
            copied={copied}
            onCopy={copy}
          />
        ))}
      </div>
      {notes.length > 0 && (
        <ul className="text-fg-2 flex flex-col gap-1 text-xs">
          {notes.map((n) => (
            <li key={n.command}>
              {n.label}
              {COMMON.listSeparator}
              {n.note}
            </li>
          ))}
        </ul>
      )}
      <details className="text-xs">
        <summary className="text-fg-2 hover:text-fg inline-flex min-h-8 cursor-pointer items-center">
          {COPY.commandText}
        </summary>
        <ul className="mt-1 flex flex-col gap-2">
          {commands.map((command) => (
            <li key={command}>
              <code className="bg-sunken font-code text-fg block overflow-x-auto rounded-sm px-2 py-1 text-sm whitespace-pre">
                {command}
              </code>
            </li>
          ))}
        </ul>
      </details>
      <CopyAnnouncer copied={copied} />
    </div>
  )
}
