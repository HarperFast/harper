'use strict';

const { join } = require('node:path');
const { scopedImport } = require('#src/security/jsLoader');
const { expect } = require('chai');

const SYMLINK_FIXTURE = join(__dirname, 'fixtures', 'symlink-test', 'node_modules', 'proxyTransform');
// Minimal scope that routes through the VM loader without requiring a full Harper server context
const vmScope = () => ({ mode: 'vm-current-context' });

describe('scopedImport', () => {
	it('should import a module', async () => {
		const result = await scopedImport(join(__dirname, 'fixtures', 'good.cjs'));
		expect(result.foo).to.equal('bar');
	});

	it('should throw an error importing an invalid CommonJS module', async () => {
		try {
			await scopedImport(join(__dirname, 'fixtures', 'invalid1.cjs'));
		} catch (e) {
			expect(e).to.be.instanceOf(SyntaxError);
			expect(e.toString()).to.match(/SyntaxError: Unexpected identifier( 'is')?/);
			// note: `rewire` (called from `testUtils`) is wrapping commonjs modules
			expect(e.stack).to.match(
				/invalid1\.cjs:1\n(?:\(function \(exports, require, module, __filename, __dirname\) \{ )?This is not a valid module.\n +\^\^\n+SyntaxError: Unexpected identifier(?: 'is')?/
			);
		}
	});

	it('should throw an error importing a CommonJS module with invalid dependency', async () => {
		try {
			await scopedImport(join(__dirname, 'fixtures', 'invalid2.cjs'));
		} catch (e) {
			expect(e).to.be.instanceOf(SyntaxError);
			expect(e.toString()).to.equal("SyntaxError: Unexpected token '='");
			// note: `rewire` (called from `testUtils`) is wrapping commonjs modules
			expect(e.stack).to.match(
				/libbad\.cjs:1\n(?:\(function \(exports, require, module, __filename, __dirname\) \{ )?module.exports.baz ====\n +\^\n+SyntaxError: Unexpected token '='/
			);
		}
	});

	it('should throw an error importing an invalid ESM module', async () => {
		try {
			await scopedImport(join(__dirname, 'fixtures', 'invalid3.mjs'));
		} catch (e) {
			expect(e).to.be.instanceOf(SyntaxError);
			expect(e.toString()).to.match(/SyntaxError: Unexpected identifier( 'is')?/);
			expect(e.stack).to.match(
				/invalid3\.mjs:1\nThis is not a valid module.\n +\^\^\n+SyntaxError: Unexpected identifier(?: 'is')?/
			);
		}
	});

	it('should resolve require("harperdb") to harper exports', async () => {
		const scope = {
			mode: 'vm-current-context',
			allowedPath: '',
			moduleCache: null,
			server: { authenticateUser: null, operation: null },
			logger: {},
			resources: {},
			config: {},
		};
		const result = await scopedImport(join(__dirname, 'fixtures', 'uses-harperdb.cjs'), scope);
		expect(result.Resource).to.be.a('function');
		expect(result.tables).to.exist;
	});

	it('should throw an error importing an ESM module with invalid dependency', async () => {
		try {
			await scopedImport(join(__dirname, 'fixtures', 'invalid4.mjs'));
		} catch (e) {
			expect(e).to.be.instanceOf(SyntaxError);
			expect(e.toString()).to.equal('SyntaxError: Missing initializer in const declaration');
			expect(e.stack).to.match(
				/libbad\.mjs:1\nexport const baz ====\n +\^\^\^\n+SyntaxError: Missing initializer in const declaration/
			);
		}
	});
});

describe('symlinked module resolution', () => {
	it('should resolve relative CJS require through a symlinked module', async () => {
		// proxyTransform is a symlink to ../harper-modules/proxy-transform-module
		// index.cjs does require('../cache.cjs') which must resolve via the real path,
		// not the symlink path (node_modules/proxyTransform/../cache.cjs would not exist)
		const result = await scopedImport(join(SYMLINK_FIXTURE, 'index.cjs'), vmScope());
		expect(result.default.cached).to.equal('hit');
	});

	it('should resolve relative ESM import through a symlinked module', async () => {
		// Same scenario for ESM: import cache from '../cache.mjs' must resolve via realpath
		const result = await scopedImport(join(SYMLINK_FIXTURE, 'index.mjs'), vmScope());
		expect(result.cached).to.equal('hit');
	});
});
