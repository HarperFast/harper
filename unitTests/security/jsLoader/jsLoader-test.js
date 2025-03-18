'use strict';

const { join } = require('node:path');
const { secureImport } = require('../../../security/jsLoader');
const { expect } = require('chai');

describe('secureImport', () => {
	it('should import a module', async () => {
		const result = await secureImport(join(__dirname, 'fixtures', 'good.cjs'));
		expect(result.foo).to.equal('bar');
	});

	it('should throw an error importing an invalid CommonJS module', async () => {
		try {
			await secureImport(join(__dirname, 'fixtures', 'invalid1.cjs'));
		} catch (e) {
			expect(e).to.be.instanceOf(SyntaxError);
			expect(e.toString()).to.match(/SyntaxError: Unexpected identifier( \'is\')?/);
			// note: `rewire` (called from `test_utils`) is wrapping commonjs modules
			expect(e.stack).to.match(
				/invalid1\.cjs:1\n(?:\(function \(exports, require, module, __filename, __dirname\) \{ )?This is not a valid module.\n +\^\^\n+SyntaxError: Unexpected identifier(?: 'is')?/
			);
		}
	});

	it('should throw an error importing a CommonJS module with invalid dependency', async () => {
		try {
			await secureImport(join(__dirname, 'fixtures', 'invalid2.cjs'));
		} catch (e) {
			expect(e).to.be.instanceOf(SyntaxError);
			expect(e.toString()).to.equal('SyntaxError: Unexpected token \'=\'');
			// note: `rewire` (called from `test_utils`) is wrapping commonjs modules
			expect(e.stack).to.match(
				/libbad\.cjs:1\n(?:\(function \(exports, require, module, __filename, __dirname\) \{ )?module.exports.baz ====\n +\^\n+SyntaxError: Unexpected token '='/
			);
		}
	});

	it('should throw an error importing an invalid ESM module', async () => {
		try {
			await secureImport(join(__dirname, 'fixtures', 'invalid3.mjs'));
		} catch (e) {
			expect(e).to.be.instanceOf(SyntaxError);
			expect(e.toString()).to.match(/SyntaxError: Unexpected identifier( \'is\')?/);
			expect(e.stack).to.match(
				/invalid3\.mjs:1\nThis is not a valid module.\n +\^\^\n+SyntaxError: Unexpected identifier(?: 'is')?/
			);
		}
	});

	it('should throw an error importing an ESM module with invalid dependency', async () => {
		try {
			await secureImport(join(__dirname, 'fixtures', 'invalid4.mjs'));
		} catch (e) {
			expect(e).to.be.instanceOf(SyntaxError);
			expect(e.toString()).to.equal('SyntaxError: Missing initializer in const declaration');
			expect(e.stack).to.match(
				/libbad\.mjs:1\nexport const baz ====\n +\^\^\^\n+SyntaxError: Missing initializer in const declaration/
			);
		}
	});
});
