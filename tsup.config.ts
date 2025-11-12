import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  dts: true,
  format: ['cjs', 'esm'],
  outDir: 'dist',
  sourcemap: true,
  clean: true,
  target: 'node18',
  minify: false,
  treeshake: true,
  skipNodeModulesBundle: true,
  // Bundle any ESM-only deps to avoid require() errors in CJS build
  // Keep existing external dependencies since they should support both formats
  external: ['fhir-snapshot-generator', 'fhir-package-explorer'],
  splitting: false,
  outExtension({ format }) {
    if (format === 'esm') return { js: '.mjs' };
    return { js: '.cjs' };
  }
});