import { build } from 'esbuild';

await build({
  entryPoints: ['src/yet.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  minify: true,
  packages: 'external',
  outfile: 'dist/yet.js',
  tsconfig: 'tsconfig.json',
  logLevel: 'info',
});
