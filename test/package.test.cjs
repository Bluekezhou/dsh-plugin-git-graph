const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const text = p => fs.readFileSync(path.join(root, p), 'utf8');
const pkg = JSON.parse(text('package.json'));

test('bundle patch and browser module identify the same plugin', () => {
  const patch = text(pkg.dsh.bundle.patch);
  assert.ok(patch.split('\n').some(line => line.trim() === `name: ${pkg.name}`));
  let module;
  vm.runInNewContext(text(pkg.exports['./client']), { window: { __ModuleLoader__: { load: entry => { module = entry; } } } });
  assert.equal(module.id, pkg.name);
  assert.equal(typeof module.factory, 'function');
});

test('declared display resources exist for both supported languages', () => {
  for (const language of ['zh', 'en']) {
    const {meta} = JSON.parse(text(pkg.exports['./locale/*.json'].replace('*', language)));
    assert.ok(meta.title && meta.description);
  }
  assert.match(text(pkg.exports['./icon']), /<svg\b/);
});
