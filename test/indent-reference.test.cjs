const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const fixture = require('./fixtures/indent-reference.json');
const sandbox = {module: {exports: {}}};
vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../client.js'), 'utf8'), sandbox);
// Anonymous row numbers retain the real repo's topology, not its history or personal data.
const commits = fixture.parents.map((parents, i) => ({hash: String(i), parents: parents.map(String), refs: []}));
for (const limit of [4, 12]) {
  test(`all 200 subject offsets match pi-toolkit geometry, lane limit ${limit}`, () => {
    const rows = sandbox.module.exports.layout(commits, limit);
    assert.equal(rows.length, 200);
    for (let i = 0; i < rows.length; i++) {
      assert.equal(rows[i].padding, fixture.expected[limit][i], `row ${i}, node on lane ${rows[i].lane}`);
    }
  });
}
