import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
const root = fileURLToPath(new URL('..', import.meta.url))
await build({
  entryPoints: [root + '/src/hiyori/index.ts'], outfile: root + '/src/hiyori-skills.mjs',
  bundle: true, packages: 'external', format: 'esm', platform: 'node', target: 'node22',
  banner: { js: "// Hiyori extracted helpers — MIT; original sources are in src/hiyori/.\nimport { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" },
})
