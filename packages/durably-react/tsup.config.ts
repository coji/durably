import { defineConfig } from 'tsup'

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    spa: 'src/spa.ts',
  },
  format: ['esm'],
  dts: {
    // tsup injects baseUrl into its declaration compiler configuration.
    compilerOptions: { ignoreDeprecations: '6.0' },
  },
  clean: true,
  sourcemap: true,
  external: ['react', 'react-dom', '@coji/durably'],
})
