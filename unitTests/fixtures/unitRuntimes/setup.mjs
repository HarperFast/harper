import assert from 'node:assert';
before(() => assert.strictEqual(typeof process.env.ROOTPATH, 'string'));
