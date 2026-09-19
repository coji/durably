import { defineConfig } from 'tsup'

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'plugins/index': 'src/plugins/index.ts',
  },
  format: ['esm'],
  dts: {
    // tsup injects baseUrl into its declaration compiler configuration.
    compilerOptions: { ignoreDeprecations: '6.0' },
  },
  clean: true,
  sourcemap: true,
})
