// A component resolves `harper` through one of two independent lists — the package's own exports, or
// the object `getHarperExports` builds for a VM compartment — and a value on only one of them fails at
// component load. Identity matters as much as presence: a second copy of a module carries a second
// drain registry and a second private Symbol, both of which fail silently (#2715).
const assert = require('node:assert');
const { join } = require('node:path');
const { scopedImport } = require('#src/security/jsLoader');
const harper = require('#src/index');
const { registerShutdownDrain } = require('#src/components/shutdownDrain');
const { verifyCertificate } = require('#src/security/certificateVerification/index');
const { isCredentialRejection } = require('#src/security/credentialRejection');
const {
	assertNoDeferredCredentialRejection,
	getAuthenticationRejectedInPlace,
	getDeferredCredentialRejection,
	settleDeferredCredentialRejection,
} = require('#src/security/deferredAuthentication');

const PLUGIN_PARITY_EXPORTS = {
	registerShutdownDrain,
	verifyCertificate,
	isCredentialRejection,
	assertNoDeferredCredentialRejection,
	getAuthenticationRejectedInPlace,
	getDeferredCredentialRejection,
	settleDeferredCredentialRejection,
};
// The producers: only security/auth.ts turns a principal-resolution failure into a decision.
const INTERNAL_ONLY = ['deferCredentialRejection', 'markAuthenticationRejectedInPlace'];
// Package exports a compartment deliberately does not get (consumed by harper-pro through core/).
const PACKAGE_ONLY = new Set([
	'flushDatabases',
	'registerReplicatedApplyFailureListener',
	'unregisterReplicatedApplyFailureListener',
	'threads',
]);

describe("the 'harper' module a plugin imports (#2715)", () => {
	let compartment;
	before(async () => {
		// what `require('harperdb')` resolves to inside a VM compartment: the getHarperExports object
		compartment = await scopedImport(join(__dirname, 'jsLoader', 'fixtures', 'uses-harperdb.cjs'), {
			mode: 'vm-current-context',
			allowedPath: '',
			moduleCache: null,
			server: { authenticateUser: null, operation: null },
			logger: {},
			resources: {},
			config: {},
		});
	});

	it('exports the plugin-parity helpers from the package as the identical live functions core uses', () => {
		for (const [name, internal] of Object.entries(PLUGIN_PARITY_EXPORTS)) {
			assert.strictEqual(typeof internal, 'function', name);
			assert.strictEqual(harper[name], internal, `package export '${name}' is not core's own function`);
		}
	});

	it('offers the same functions, by identity, to a VM compartment', () => {
		for (const [name, internal] of Object.entries(PLUGIN_PARITY_EXPORTS)) {
			assert.strictEqual(compartment[name], internal, `compartment export '${name}' is not core's own function`);
		}
	});

	it('keeps the credential-rejection producers internal on both paths', () => {
		for (const name of INTERNAL_ONLY) {
			assert.strictEqual(harper[name], undefined, `package exports ${name}`);
			assert.strictEqual(compartment[name], undefined, `compartment exports ${name}`);
		}
	});

	it('offers every package value export to a compartment unless it is package-only', () => {
		for (const name of Object.keys(harper)) {
			if (name.startsWith('_') || PACKAGE_ONLY.has(name)) continue;
			assert.ok(name in compartment, `'harper' in a compartment lacks '${name}': add it to getHarperExports`);
		}
	});

	it('lists as package-only exactly the exports a compartment lacks', () => {
		for (const name of PACKAGE_ONLY) {
			assert.ok(name in harper, `${name} is not a package export`);
			assert.ok(!(name in compartment), `${name} reaches a compartment now; drop it from PACKAGE_ONLY`);
		}
	});
});
