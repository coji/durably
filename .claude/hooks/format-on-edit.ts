import { defineHook, runHook } from 'cc-hooks-ts'
import { execSync } from 'node:child_process'

const FORMATTABLE_EXTENSIONS = [
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.json',
  '.md',
  '.css',
]

const formatHook = defineHook({
  trigger: {
    PostToolUse: {
      Write: true,
      Edit: true,
    },
  },
  run: (context) => {
    const toolInput = context.input.tool_input
    const filePath = toolInput.file_path

    if (
      filePath &&
      FORMATTABLE_EXTENSIONS.some((ext) => filePath.endsWith(ext))
    ) {
      try {
        execSync(`pnpm exec prettier --write "${filePath}"`, {
          stdio: 'inherit',
        })
      } catch {}
    }

    return context.success()
  },
})

await runHook(formatHook)
