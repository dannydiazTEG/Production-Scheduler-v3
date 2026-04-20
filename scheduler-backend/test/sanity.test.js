const test = require('node:test');
const assert = require('node:assert/strict');

test('sanity: assert.strict works', () => {
    assert.equal(1 + 1, 2);
});
