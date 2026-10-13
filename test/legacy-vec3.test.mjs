import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

test('plugin loads with legacy vec3 CommonJS exports lacking ESM named exports', () => {
  const require = createRequire(import.meta.url)
  const dir = mkdtempSync(join(tmpdir(), 'whale-legacy-vec3-'))
  const legacyPath = join(dir, 'legacy-vec3.cjs')
  const legacyUrl = pathToFileURL(legacyPath).href
  // vec3 0.1.7 assigns Vec3 on a function after module.exports = v.
  // Node does not infer that property as an ESM named export.
  writeFileSync(legacyPath, `
    const actual = require(${JSON.stringify(require.resolve('vec3'))});
    function v(...args) { return actual(...args); }
    module.exports = v;
    v.Vec3 = actual.Vec3;
  `)
  try {
    const output = execFileSync(process.execPath, ['--input-type=module', '-e', `
      import assert from 'node:assert/strict';
      import { registerHooks } from 'node:module';
      const legacy = await import(${JSON.stringify(legacyUrl)});
      assert.equal(legacy.Vec3, undefined);
      assert.equal(typeof legacy.default.Vec3, 'function');
      const hooks = registerHooks({ resolve(specifier, context, next) {
        return specifier === 'vec3'
          ? { url: ${JSON.stringify(legacyUrl)}, shortCircuit: true }
          : next(specifier, context);
      }});
      try {
        const plugin = await import(${JSON.stringify(new URL('../index.js', import.meta.url).href)});
        assert.equal(plugin.name, 'whale_craft');
        assert.equal(typeof plugin.apply, 'function');
        const helper = await import(${JSON.stringify(new URL('../src/hiyori-skills.mjs', import.meta.url).href)});
        assert.equal(typeof helper.assessExcavationFluidRisk, 'function');
        assert.equal(typeof helper.patchedGoto, 'function');
        console.log('LEGACY_VEC3_OK');
      } finally { hooks.deregister(); }
    `], { encoding: 'utf8', timeout: 15000 })
    assert.match(output, /LEGACY_VEC3_OK/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
