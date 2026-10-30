'use strict';

const assert = require('node:assert');
const {
	ARCHIVE_MANIFEST_ENTRY,
	ARCHIVE_SCHEMA_VERSION,
	SUPPORTED_ARCHIVE_CAPABILITIES,
	assertArchiveRestorable,
	buildArchiveManifest,
	describeArchiveProvenance,
	parseArchiveManifest,
	serializeArchiveManifest,
} = require('#src/dataLayer/backupArchiveManifest');

function manifestFor(overrides = {}) {
	return {
		...buildArchiveManifest({ databaseName: 'orders', blobs: true, blobRootCount: 2, roles: [] }),
		...overrides,
	};
}

describe('backupArchiveManifest', function () {
	describe('buildArchiveManifest', function () {
		it('identifies the producer and what a reader needs', function () {
			const manifest = buildArchiveManifest({
				databaseName: 'orders',
				blobs: true,
				blobRootCount: 2,
				roles: ['analyst', 'super_user'],
			});

			assert.strictEqual(manifest.archive_schema_version, ARCHIVE_SCHEMA_VERSION);
			assert.strictEqual(manifest.database, 'orders');
			assert.strictEqual(manifest.blobs, true);
			assert.strictEqual(manifest.blob_root_count, 2);
			assert.deepStrictEqual(manifest.roles, ['analyst', 'super_user']);
			assert.ok(manifest.harper_version, 'the producing Harper version is recorded');
			assert.ok(manifest.rocksdb_js_version, 'the binding version fixes the engine and log formats');
			assert.ok(manifest.created_at > 0);
		});

		it('declares blob capabilities only for an archive that carries blobs', function () {
			const withBlobs = buildArchiveManifest({ databaseName: 'a', blobs: true, blobRootCount: 1, roles: null });
			const engineOnly = buildArchiveManifest({ databaseName: 'a', blobs: false, blobRootCount: 0, roles: null });

			assert.ok(withBlobs.requires.includes('blob-root-index'));
			assert.ok(withBlobs.requires.includes('blob-deflate'));
			assert.deepStrictEqual(engineOnly.requires, ['rocksdb-stream-backup']);
		});

		it('only declares capabilities this build can actually satisfy', function () {
			const manifest = manifestFor();
			for (const capability of manifest.requires) {
				assert.ok(
					SUPPORTED_ARCHIVE_CAPABILITIES.includes(capability),
					`${capability} is declared but not in the supported set`
				);
			}
		});
	});

	describe('source provenance', function () {
		const originalBuiltIns = process.env.HARPER_BUILTIN_COMPONENTS;

		afterEach(function () {
			if (originalBuiltIns === undefined) delete process.env.HARPER_BUILTIN_COMPONENTS;
			else process.env.HARPER_BUILTIN_COMPONENTS = originalBuiltIns;
		});

		it('records the runtime the archive was produced on', function () {
			const { source } = manifestFor();
			assert.strictEqual(source.node_version, process.version);
			assert.strictEqual(source.platform, process.platform);
			assert.strictEqual(source.arch, process.arch);
		});

		it('names the built-in components, which is the only pro-vs-OSS signal there is', function () {
			process.env.HARPER_BUILTIN_COMPONENTS = 'replication=@/dist/replication/replicator.js,secretCustody=@/dist/x.js';
			assert.deepStrictEqual(manifestFor().source.built_in_components, ['replication', 'secretCustody']);
		});

		it('reports no built-ins on OSS core, rather than omitting the field', function () {
			delete process.env.HARPER_BUILTIN_COMPONENTS;
			assert.deepStrictEqual(manifestFor().source.built_in_components, []);
		});

		it('tolerates a trailing separator in the registry', function () {
			process.env.HARPER_BUILTIN_COMPONENTS = 'replication=@/dist/replication/replicator.js,';
			assert.deepStrictEqual(manifestFor().source.built_in_components, ['replication']);
		});

		it('records no path, host, or credential — the archive leaves the box', function () {
			const serialized = serializeArchiveManifest(manifestFor());
			for (const key of Object.keys(JSON.parse(serialized).source.settings)) {
				assert.ok(
					!/path|paths|host|url|key|secret|token|cert/i.test(key),
					`${key} is recorded in archive provenance but names a location or credential`
				);
			}
		});

		it('survives a build with no config loaded', function () {
			assert.ok(manifestFor().source.settings);
		});
	});

	describe('serialize / parse', function () {
		it('round-trips', function () {
			const manifest = manifestFor();
			assert.deepStrictEqual(parseArchiveManifest(serializeArchiveManifest(manifest)), manifest);
		});

		it('rejects a document that is not JSON', function () {
			assert.throws(
				() => parseArchiveManifest('{not json'),
				(error) => error.statusCode === 400 && error.message.includes(ARCHIVE_MANIFEST_ENTRY)
			);
		});

		it('rejects a document with no schema version', function () {
			assert.throws(() => parseArchiveManifest('{"requires":[]}'), /archive_schema_version/);
		});

		it('rejects a document whose requires list is not usable', function () {
			assert.throws(() => parseArchiveManifest('{"archive_schema_version":1}'), /requires/);
			assert.throws(() => parseArchiveManifest('{"archive_schema_version":1,"requires":[3]}'), /requires/);
		});
	});

	describe('assertArchiveRestorable', function () {
		it('accepts an archive this build produced', function () {
			assertArchiveRestorable(manifestFor());
		});

		it('refuses a newer manifest schema', function () {
			assert.throws(
				() => assertArchiveRestorable(manifestFor({ archive_schema_version: ARCHIVE_SCHEMA_VERSION + 1 })),
				(error) => error.statusCode === 400 && /manifest schema version/.test(error.message)
			);
		});

		it('refuses a capability this build does not have, naming it', function () {
			assert.throws(
				() => assertArchiveRestorable(manifestFor({ requires: ['rocksdb-stream-backup', 'blob-encryption-v2'] })),
				(error) => error.statusCode === 400 && /blob-encryption-v2/.test(error.message)
			);
		});

		it('accepts an older archive that requires less', function () {
			assertArchiveRestorable(manifestFor({ requires: ['rocksdb-stream-backup'] }));
		});
	});

	describe('describeArchiveProvenance', function () {
		it('reports an archive that predates manifests as unidentified', function () {
			assert.deepStrictEqual(describeArchiveProvenance(null), { identified: false });
		});

		it('reports what the manifest recorded', function () {
			const described = describeArchiveProvenance(manifestFor({ roles: ['analyst'] }));
			assert.strictEqual(described.identified, true);
			assert.strictEqual(described.source_database, 'orders');
			assert.deepStrictEqual(described.roles, ['analyst']);
		});

		it('omits roles the producer could not enumerate, rather than reporting none', function () {
			const described = describeArchiveProvenance(manifestFor({ roles: null }));
			assert.ok(!('roles' in described), 'an unrecorded role list must not read as an empty one');
		});
	});
});
