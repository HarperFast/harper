import { describe, it } from 'mocha';
import assert from 'node:assert/strict';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import sinon from 'sinon';

// These still need to use require due to how the test doubles (e.g. loggerStub) are setup
// TODO: Do all this in a better / ESM-compatible way
const harperLogger = require('@/utility/logging/harper_logger');
const loggerStub = {
	info: sinon.stub(),
	error: sinon.stub(),
	debug: sinon.stub(),
	trace: sinon.stub(),
};
const forComponentStub = sinon.stub(harperLogger, 'forComponent').returns(loggerStub);
const {
	DataLoaderError,
	UnsupportedFileExtensionError,
	FileParseError,
	EmptyFileError,
	MissingRequiredPropertyError,
	InvalidPropertyTypeError,
	SystemDatabaseError,
	RecordProcessingError,
	DataLoaderResult,
	loadDataFile,
	handleApplication,
	computeRecordHash,
} = require('@/resources/dataLoader');

// Restore the forComponent stub immediately after import to prevent it from affecting other modules
forComponentStub.restore();

// Helper function to create a mock record with getUpdatedTime method
function createMockRecord(props) {
	const record = { ...props };
	// Simulate the private #version field with a non-enumerable property
	Object.defineProperty(record, '_updatedTime', {
		value: props._updatedTime || Date.now(),
		writable: true,
		enumerable: false,
	});

	record.getUpdatedTime = function () {
		return this._updatedTime;
	};

	return record;
}

// Helper function to create a FileEntry object
async function createFileEntry(filePath, contents = null) {
	const fileContent = contents || (await readFile(filePath));
	const fileStat = await stat(filePath); // Let errors propagate

	return {
		contents: fileContent,
		absolutePath: filePath,
		stats: fileStat,
		urlPath: filePath,
	};
}

describe('Data Loader', function () {
	const tempDir = join(__dirname, '../envDir/dataloader-test');
	const yamlDataFile = join(tempDir, 'test-data.yaml');
	const jsonDataFile = join(tempDir, 'test-data.json');
	const ymlDataFile = join(tempDir, 'test-data.yml');
	const invalidDataFile = join(tempDir, 'test-data.txt');

	let mockTables;
	let mockDatabases;

	// Re-stub the logger for this test suite since we restored it after import
	before(function () {
		sinon.stub(harperLogger, 'forComponent').returns(loggerStub);
	});

	before(async function () {
		// Create temp directory
		await mkdir(tempDir, { recursive: true }).catch(() => {});

		// Create test YAML file
		const yamlContent = `database: dev
table: test_table
records:
  - id: 1
    name: "Test Item 1"
    value: 100
  - id: 2
    name: "Test Item 2"
    value: 200`;
		await writeFile(yamlDataFile, yamlContent);

		// Create test JSON file
		const jsonContent = JSON.stringify({
			database: 'dev',
			table: 'test_table_json',
			records: [
				{ id: 1, name: 'JSON Item 1', value: 300 },
				{ id: 2, name: 'JSON Item 2', value: 400 },
			],
		});
		await writeFile(jsonDataFile, jsonContent);

		// Create test YML file (alternative YAML extension)
		const ymlContent = `table: test_yml
records:
  - id: 1
    name: "YML Item"`;
		await writeFile(ymlDataFile, ymlContent);

		// Create invalid file type
		await writeFile(invalidDataFile, 'This is not JSON or YAML');
	});

	after(async function () {
		// Clean up test files
		await rm(tempDir, { recursive: true, force: true }).catch(() => {});
	});

	beforeEach(function () {
		// Reset mocks
		mockTables = {};
		mockDatabases = {};
	});

	afterEach(function () {
		sinon.restore();
	});

	describe('loadDataFile', function () {
		it('should load data from YAML file', async function () {
			// Create mock table
			const mockTable = {
				get: sinon.stub().resolves(null),
				put: sinon.stub().resolves({ inserted: 1 }),
			};

			mockDatabases.dev = {
				test_table: mockTable,
			};

			const result = await loadDataFile(await createFileEntry(yamlDataFile), mockTables, mockDatabases);

			assert.ok(result instanceof DataLoaderResult);
			assert.equal(result.status, 'success');
			assert.equal(result.count, 2);
			assert.equal(result.table, 'test_table');
			assert.equal(result.database, 'dev');

			assert.equal(mockTable.put.callCount, 2);
		});

		it('should load data from JSON file', async function () {
			// Create mock table
			const mockTable = {
				get: sinon.stub().resolves(null),
				put: sinon.stub().resolves({ inserted: 1 }),
			};

			mockDatabases.dev = {
				test_table_json: mockTable,
			};

			const result = await loadDataFile(await createFileEntry(jsonDataFile), mockTables, mockDatabases);

			assert.ok(result instanceof DataLoaderResult);
			assert.equal(result.status, 'success');
			assert.equal(result.count, 2);

			assert.equal(mockTable.put.callCount, 2);
		});

		it('should load data from YML file', async function () {
			// Create mock table
			const mockTable = {
				get: sinon.stub().resolves(null),
				put: sinon.stub().resolves({ inserted: 1 }),
			};

			mockTables.test_yml = mockTable;

			const result = await loadDataFile(await createFileEntry(ymlDataFile), mockTables, mockDatabases);

			assert.ok(result instanceof DataLoaderResult);
			assert.equal(result.status, 'success');
			assert.equal(result.count, 1);
		});

		it('should throw UnsupportedFileExtensionError for invalid file type', async function () {
			const fileEntry = await createFileEntry(invalidDataFile);

			await assert.rejects(loadDataFile(fileEntry, mockTables, mockDatabases), {
				name: 'UnsupportedFileExtensionError',
				message: /Unsupported file extension.*txt.*Only YAML and JSON files are supported/,
			});
		});

		it('should throw FileParseError for invalid JSON', async function () {
			const invalidJsonFile = join(tempDir, 'invalid.json');
			await writeFile(invalidJsonFile, '{ invalid json }');
			const fileEntry = await createFileEntry(invalidJsonFile);

			await assert.rejects(loadDataFile(fileEntry, mockTables, mockDatabases), {
				name: 'FileParseError',
				message: /Failed to parse data file/,
			});
		});

		it('should throw FileParseError for invalid YAML', async function () {
			const invalidYamlFile = join(tempDir, 'invalid.yaml');
			// Create YAML with parse error - invalid anchor reference
			await writeFile(invalidYamlFile, 'table: *unknown_anchor');
			const fileEntry = await createFileEntry(invalidYamlFile);

			await assert.rejects(loadDataFile(fileEntry, mockTables, mockDatabases), {
				name: 'FileParseError',
				message: /Failed to parse data file/,
			});
		});

		it('should throw MissingRequiredPropertyError when table is missing', async function () {
			const noTableFile = join(tempDir, 'no-table.json');
			await writeFile(noTableFile, JSON.stringify({ records: [{ id: 1 }] }));
			const fileEntry = await createFileEntry(noTableFile);

			await assert.rejects(loadDataFile(fileEntry, mockTables, mockDatabases), {
				name: 'MissingRequiredPropertyError',
				message: /missing required "table" property/,
			});
		});

		it('should throw MissingRequiredPropertyError when records is missing', async function () {
			const noRecordsFile = join(tempDir, 'no-records.json');
			await writeFile(noRecordsFile, JSON.stringify({ table: 'test' }));
			const fileEntry = await createFileEntry(noRecordsFile);

			await assert.rejects(loadDataFile(fileEntry, mockTables, mockDatabases), {
				name: 'MissingRequiredPropertyError',
				message: /missing required "records" property/,
			});
		});

		it('should throw InvalidPropertyTypeError when records is not an array', async function () {
			const invalidRecordsFile = join(tempDir, 'invalid-records.json');
			await writeFile(invalidRecordsFile, JSON.stringify({ table: 'test', records: { id: 1 } }));
			const fileEntry = await createFileEntry(invalidRecordsFile);

			await assert.rejects(loadDataFile(fileEntry, mockTables, mockDatabases), {
				name: 'InvalidPropertyTypeError',
				message: /invalid "records" property, expected array/,
			});
		});

		it('should throw SystemDatabaseError when trying to load into system database', async function () {
			const systemDbFile = join(tempDir, 'system-db.json');
			await writeFile(
				systemDbFile,
				JSON.stringify({
					database: 'system',
					table: 'test',
					records: [{ id: 1 }],
				})
			);
			const fileEntry = await createFileEntry(systemDbFile);

			await assert.rejects(loadDataFile(fileEntry, mockTables, mockDatabases), {
				name: 'SystemDatabaseError',
				message: /Cannot load data into system database/,
			});
		});

		it('should throw SystemDatabaseError for case-insensitive system database', async function () {
			const systemDbFile = join(tempDir, 'system-db-case.json');
			await writeFile(
				systemDbFile,
				JSON.stringify({
					database: 'SYSTEM',
					table: 'test',
					records: [{ id: 1 }],
				})
			);
			const fileEntry = await createFileEntry(systemDbFile);

			await assert.rejects(loadDataFile(fileEntry, mockTables, mockDatabases), {
				name: 'SystemDatabaseError',
				message: /Cannot load data into system database/,
			});
		});

		it('should use existing table from global tables', async function () {
			// Create mock table in global tables
			const mockTable = {
				get: sinon.stub().resolves(null),
				put: sinon.stub().resolves({ inserted: 1 }),
			};

			mockTables.test_table_json = mockTable;

			const result = await loadDataFile(await createFileEntry(jsonDataFile), mockTables, mockDatabases);

			assert.ok(result instanceof DataLoaderResult);
			assert.equal(result.status, 'success');
			assert.equal(mockTable.put.callCount, 2);
		});

		it('should handle empty records array', async function () {
			const emptyRecordsFile = join(tempDir, 'empty-records.json');
			await writeFile(
				emptyRecordsFile,
				JSON.stringify({
					table: 'empty_table',
					records: [],
				})
			);

			// Mock the table - even with empty records, the table lookup still happens
			const mockTable = {
				get: sinon.stub().resolves(null),
				put: sinon.stub().resolves({ inserted: 1 }),
			};

			mockTables.empty_table = mockTable;

			const result = await loadDataFile(await createFileEntry(emptyRecordsFile), mockTables, mockDatabases);

			assert.ok(result instanceof DataLoaderResult);
			assert.equal(result.status, 'success');
			assert.equal(result.count, 0);
			assert.ok(result.message.includes('No records to process'));
		});

		it('should skip records with matching hash (no content changes)', async function () {
			// Create the hash that would be generated for the records in jsonDataFile
			// jsonDataFile has: { id: 1, name: 'JSON Item 1', value: 300 } and { id: 2, name: 'JSON Item 2', value: 400 }
			const hash1 = computeRecordHash({ id: 1, name: 'JSON Item 1', value: 300 });
			const hash2 = computeRecordHash({ id: 2, name: 'JSON Item 2', value: 400 });

			const existingRecord1 = createMockRecord({
				id: 1,
				name: 'JSON Item 1',
				value: 300,
			});
			const existingRecord2 = createMockRecord({
				id: 2,
				name: 'JSON Item 2',
				value: 400,
			});

			// Create mock hash tracking table with matching hashes
			const mockHashTable = {
				get: sinon.stub().callsFake((id) => {
					if (id === 'dev:test_table_json:1') {
						return Promise.resolve({ id: 'dev:test_table_json:1', hash: hash1 });
					} else if (id === 'dev:test_table_json:2') {
						return Promise.resolve({ id: 'dev:test_table_json:2', hash: hash2 });
					}
					return Promise.resolve(null);
				}),
				put: sinon.stub().resolves(),
			};

			// Create mock table
			const mockTable = {
				get: sinon.stub().onCall(0).resolves(existingRecord1).onCall(1).resolves(existingRecord2),
				put: sinon.stub().resolves({ inserted: 1 }),
			};

			// Mock the system database with hash tracking table
			mockDatabases.system = {
				hdb_dataloader_hash: mockHashTable,
			};
			mockDatabases.dev = {
				test_table_json: mockTable,
			};

			const result = await loadDataFile(await createFileEntry(jsonDataFile), mockTables, mockDatabases);

			assert.ok(result instanceof DataLoaderResult);
			assert.equal(result.status, 'skipped');
			assert.ok(result.message.includes('already up-to-date'));
			assert.equal(mockTable.put.callCount, 0);
			// Verify hash table was queried for both records
			assert.equal(mockHashTable.get.callCount, 2);
		});

		it('should update records with different hash (content changed)', async function () {
			// Create records with different hashes (representing old content)
			// Old hashes for different content
			const oldHash1 = computeRecordHash({ id: 1, name: 'Old Name 1', value: 100 });
			const oldHash2 = computeRecordHash({ id: 2, name: 'Old Name 2', value: 200 });

			const existingRecord1 = createMockRecord({
				id: 1,
				name: 'Old Name 1',
				value: 100,
			});
			const existingRecord2 = createMockRecord({
				id: 2,
				name: 'Old Name 2',
				value: 200,
			});

			// Create mock hash tracking table with database:table:id format
			const mockHashTable = {
				get: sinon.stub().callsFake((id) => {
					if (id === 'dev:test_table_json:1') {
						return Promise.resolve({ id: 'dev:test_table_json:1', hash: oldHash1 });
					} else if (id === 'dev:test_table_json:2') {
						return Promise.resolve({ id: 'dev:test_table_json:2', hash: oldHash2 });
					}
					return Promise.resolve(null);
				}),
				put: sinon.stub().resolves(),
			};

			// Create mock table
			const mockTable = {
				get: sinon.stub().onCall(0).resolves(existingRecord1).onCall(1).resolves(existingRecord2),
				put: sinon.stub().resolves({ updated: 1 }),
				patch: sinon.stub().resolves(),
			};

			// Mock the system database with hash tracking table
			mockDatabases.system = {
				hdb_dataloader_hash: mockHashTable,
			};
			mockDatabases.dev = {
				test_table_json: mockTable,
			};

			const result = await loadDataFile(await createFileEntry(jsonDataFile), mockTables, mockDatabases);

			assert.ok(result instanceof DataLoaderResult);
			assert.equal(result.status, 'success');
			assert.equal(result.count, 2);
			assert.ok(result.message.includes('updated 2 records'));
			// Should use patch instead of put for updates
			assert.equal(mockTable.patch.callCount, 2);
		});

		it('should handle mixed new, updated, and skipped records', async function () {
			const mixedFile = join(tempDir, 'mixed.json');
			await writeFile(
				mixedFile,
				JSON.stringify({
					table: 'mixed_table',
					records: [
						{ id: 1, name: 'New' },
						{ id: 2, name: 'To Update' },
						{ id: 3, name: 'To Skip' },
					],
				})
			);

			// Record 2 has old hash (will be updated)
			// The stored hash should be for the fields that were originally in the data file
			const oldHash2 = computeRecordHash({ id: 2, name: 'Old Name' });
			const existingRecord2 = createMockRecord({
				id: 2,
				name: 'Old Name',
				extraField: 'user added this', // User added extra field
			});

			// Record 3 has matching hash (will be skipped)
			const hash3 = computeRecordHash({ id: 3, name: 'To Skip' });
			const existingRecord3 = createMockRecord({ id: 3, name: 'To Skip' });

			// Create mock hash tracking table
			const mockHashTable = {
				get: sinon.stub().callsFake((id) => {
					if (id === 'mixed_table:2') {
						return Promise.resolve({ id: 'mixed_table:2', hash: oldHash2 });
					} else if (id === 'mixed_table:3') {
						return Promise.resolve({ id: 'mixed_table:3', hash: hash3 });
					}
					return Promise.resolve(null);
				}),
				put: sinon.stub().resolves(),
			};

			// Create mock table
			const mockTable = {
				get: sinon
					.stub()
					.onCall(0)
					.resolves(null)
					.onCall(1)
					.resolves(existingRecord2)
					.onCall(2)
					.resolves(existingRecord3),
				put: sinon.stub().resolves({ inserted: 1 }),
				patch: sinon.stub().resolves(),
			};

			// Mock the system database with hash tracking table
			mockDatabases.system = {
				hdb_dataloader_hash: mockHashTable,
			};
			mockTables.mixed_table = mockTable;

			const result = await loadDataFile(await createFileEntry(mixedFile), mockTables, mockDatabases);

			assert.ok(result instanceof DataLoaderResult);
			assert.equal(result.status, 'success');
			assert.equal(result.count, 2); // 1 new + 1 updated
			assert.ok(result.message.includes('Loaded 1 new and updated 1 records'));
			assert.ok(result.message.includes('(1 records skipped)'));
			// 1 put for new record, 1 patch for updated record
			assert.equal(mockTable.put.callCount, 1);
			assert.equal(mockTable.patch.callCount, 1);
		});

		it('should skip records without hash (user-created via operations API)', async function () {
			// Simulate records that were created via operations API
			// These won't have a hash in the system table
			const userRecord1 = createMockRecord({ id: 1, name: 'User Created', value: 999 });
			const userRecord2 = createMockRecord({ id: 2, name: 'User Modified', value: 888 });

			// Create mock table
			const mockTable = {
				get: sinon.stub().onCall(0).resolves(userRecord1).onCall(1).resolves(userRecord2),
				put: sinon.stub().resolves({ inserted: 1 }),
			};

			mockDatabases.dev = {
				test_table_json: mockTable,
			};

			const result = await loadDataFile(await createFileEntry(jsonDataFile), mockTables, mockDatabases);

			assert.ok(result instanceof DataLoaderResult);
			assert.equal(result.status, 'skipped');
			assert.ok(result.message.includes('already up-to-date'));
			// Should not call put since records don't have hash (user-created)
			assert.equal(mockTable.put.callCount, 0);
		});

		it('should skip records modified by user after data loader created them', async function () {
			// Simulate records that were originally loaded by data loader,
			// but then modified by user via operations API
			// Original hashes when data loader first loaded them
			const originalHash1 = computeRecordHash({ id: 1, name: 'JSON Item 1', value: 300 });
			const originalHash2 = computeRecordHash({ id: 2, name: 'JSON Item 2', value: 400 });

			// Current records - user has modified them
			const modifiedRecord1 = createMockRecord({
				id: 1,
				name: 'User Modified Name',
				value: 9999,
			});
			const modifiedRecord2 = createMockRecord({
				id: 2,
				name: 'Another User Change',
				value: 8888,
			});

			// Create mock hash tracking table with original hashes
			const mockHashTable = {
				get: sinon.stub().callsFake((id) => {
					if (id === 'dev:test_table_json:1') {
						return Promise.resolve({ id: 'dev:test_table_json:1', hash: originalHash1 });
					} else if (id === 'dev:test_table_json:2') {
						return Promise.resolve({ id: 'dev:test_table_json:2', hash: originalHash2 });
					}
					return Promise.resolve(null);
				}),
				put: sinon.stub().resolves(),
			};

			// Create mock table returning the modified records
			const mockTable = {
				get: sinon.stub().onCall(0).resolves(modifiedRecord1).onCall(1).resolves(modifiedRecord2),
				put: sinon.stub().resolves({ updated: 1 }),
			};

			// Mock the system database with hash tracking table
			mockDatabases.system = {
				hdb_dataloader_hash: mockHashTable,
			};
			mockDatabases.dev = {
				test_table_json: mockTable,
			};

			const result = await loadDataFile(await createFileEntry(jsonDataFile), mockTables, mockDatabases);

			assert.ok(result instanceof DataLoaderResult);
			assert.equal(result.status, 'skipped');
			assert.ok(result.message.includes('already up-to-date'));
			// Should not call put - user modifications should be preserved
			assert.equal(mockTable.put.callCount, 0);
			// Verify hash table was queried
			assert.equal(mockHashTable.get.callCount, 2);
		});

		it('should update records when user added extra fields but did not modify original fields', async function () {
			// Simulate records where user added extra fields but didn't modify the original fields from the data file
			// Original hashes when data loader first loaded them (only id, name, value)
			const originalHash1 = computeRecordHash({ id: 1, name: 'JSON Item 1', value: 300 });
			const originalHash2 = computeRecordHash({ id: 2, name: 'JSON Item 2', value: 400 });

			// Current records - user has added extra fields but NOT modified original fields
			const recordWithExtraFields1 = createMockRecord({
				id: 1,
				name: 'JSON Item 1', // Same as original
				value: 300, // Same as original
				customField: 'User added this', // Extra field
				anotherField: 999, // Extra field
			});
			const recordWithExtraFields2 = createMockRecord({
				id: 2,
				name: 'JSON Item 2', // Same as original
				value: 400, // Same as original
				userMetadata: { added: true }, // Extra field
			});

			// Now the data file has changed (new values for original fields)
			const newHash1 = computeRecordHash({ id: 1, name: 'JSON Item 1', value: 350 }); // value changed to 350
			const newHash2 = computeRecordHash({ id: 2, name: 'JSON Item 2', value: 450 }); // value changed to 450

			// Update the jsonDataFile content
			const updatedJsonFile = join(tempDir, 'updated-with-extra-fields.json');
			await writeFile(
				updatedJsonFile,
				JSON.stringify({
					database: 'dev',
					table: 'test_table_json',
					records: [
						{ id: 1, name: 'JSON Item 1', value: 350 },
						{ id: 2, name: 'JSON Item 2', value: 450 },
					],
				})
			);

			// Create mock hash tracking table with original hashes
			const mockHashTable = {
				get: sinon.stub().callsFake((id) => {
					if (id === 'dev:test_table_json:1') {
						return Promise.resolve({ id: 'dev:test_table_json:1', hash: originalHash1 });
					} else if (id === 'dev:test_table_json:2') {
						return Promise.resolve({ id: 'dev:test_table_json:2', hash: originalHash2 });
					}
					return Promise.resolve(null);
				}),
				put: sinon.stub().resolves(),
			};

			// Create mock table returning the records with extra fields
			const mockTable = {
				get: sinon.stub().onCall(0).resolves(recordWithExtraFields1).onCall(1).resolves(recordWithExtraFields2),
				put: sinon.stub().resolves({ inserted: 1 }),
				patch: sinon.stub().resolves(),
			};

			// Mock the system database with hash tracking table
			mockDatabases.system = {
				hdb_dataloader_hash: mockHashTable,
			};
			mockDatabases.dev = {
				test_table_json: mockTable,
			};

			const result = await loadDataFile(await createFileEntry(updatedJsonFile), mockTables, mockDatabases);

			assert.ok(result instanceof DataLoaderResult);
			assert.equal(result.status, 'success');
			assert.equal(result.count, 2);
			assert.ok(result.message.includes('updated 2 records'));
			// Should call patch to update the original fields while preserving extra fields
			assert.equal(mockTable.patch.callCount, 2);
			assert.equal(mockTable.put.callCount, 0); // Should not use put
			// Verify hash table was queried and updated
			assert.equal(mockHashTable.get.callCount, 2);
			assert.equal(mockHashTable.put.callCount, 2); // New hashes stored
		});

		it('should handle errors during record processing', async function () {
			const errorFile = join(tempDir, 'error.json');
			await writeFile(
				errorFile,
				JSON.stringify({
					table: 'error_table',
					records: [{ id: 1, name: 'Will fail' }],
				})
			);

			// Create mock table that throws error
			const mockTable = {
				get: sinon.stub().rejects(new Error('Database error')),
				put: sinon.stub().resolves({ inserted: 1 }),
			};

			mockTables.error_table = mockTable;

			// With the current implementation, individual record errors are logged but don't fail the whole operation
			const result = await loadDataFile(await createFileEntry(errorFile), mockTables, mockDatabases);

			assert.ok(result instanceof DataLoaderResult);
			assert.equal(result.status, 'success');
			assert.equal(result.count, 0); // No records successfully processed
		});

		it('should handle DataLoaderError during record processing', async function () {
			const errorFile = join(tempDir, 'dataloader_error.json');
			await writeFile(
				errorFile,
				JSON.stringify({
					table: 'dataloader_error_table',
					records: [{ id: 1, name: 'Will fail with DataLoaderError' }],
				})
			);

			// Create mock table that throws a DataLoaderError
			const mockTable = {
				get: sinon.stub().rejects(new MissingRequiredPropertyError('id')),
				put: sinon.stub().resolves({ inserted: 1 }),
			};

			mockTables.dataloader_error_table = mockTable;

			// Reset the logger stub to ensure clean state
			loggerStub.error.resetHistory();

			// With the current implementation, individual record errors are logged but don't fail the whole operation
			const result = await loadDataFile(await createFileEntry(errorFile), mockTables, mockDatabases);

			assert.ok(result instanceof DataLoaderResult);
			assert.equal(result.status, 'success');
			assert.equal(result.count, 0); // No records successfully processed
			assert.equal(
				loggerStub.error.callCount,
				1,
				`Logger error should be called once, but was called ${loggerStub.error.callCount} times`
			);
			assert.ok(loggerStub.error.firstCall.args[0].includes('Record processing error:'));
		});

		it('should process records in batches', async function () {
			// Create a file with many records
			const manyRecords = [];
			for (let i = 1; i <= 250; i++) {
				manyRecords.push({ id: i, name: `Item ${i}` });
			}

			const batchFile = join(tempDir, 'batch.json');
			await writeFile(
				batchFile,
				JSON.stringify({
					table: 'batch_table',
					records: manyRecords,
				})
			);

			// Create mock table
			const mockTable = {
				get: sinon.stub().resolves(null),
				put: sinon.stub().resolves({ inserted: 1 }),
			};

			mockTables.batch_table = mockTable;

			const result = await loadDataFile(await createFileEntry(batchFile), mockTables, mockDatabases);

			assert.ok(result instanceof DataLoaderResult);
			assert.equal(result.status, 'success');
			assert.equal(result.count, 250);
			assert.equal(mockTable.put.callCount, 250);
		});

		it('should handle records without id field', async function () {
			const noIdFile = join(tempDir, 'no-id.json');
			await writeFile(
				noIdFile,
				JSON.stringify({
					table: 'no_id_table',
					records: [{ name: 'No ID' }],
				})
			);

			// Mock table
			const mockTable = {
				get: sinon.stub().resolves(null),
				put: sinon.stub().resolves({ inserted: 1 }),
			};

			mockTables.no_id_table = mockTable;

			const result = await loadDataFile(await createFileEntry(noIdFile), mockTables, mockDatabases);

			assert.ok(result instanceof DataLoaderResult);
			assert.equal(result.status, 'success');
			assert.equal(result.count, 1);

			// Verify get was NOT called since the record has no id field
			assert.equal(mockTable.get.callCount, 0);
			// Verify put was called once
			assert.equal(mockTable.put.callCount, 1);
		});

		it('should handle empty file', async function () {
			const emptyYamlFile = join(tempDir, 'empty.yaml');
			await writeFile(emptyYamlFile, '');

			// Empty YAML file returns null which should throw EmptyFileError
			await assert.rejects(loadDataFile(await createFileEntry(emptyYamlFile), mockTables, mockDatabases), {
				name: 'EmptyFileError',
				message: /is empty or invalid/,
			});
		});

		it('should handle null YAML content', async function () {
			const nullYamlFile = join(tempDir, 'null.yaml');
			await writeFile(nullYamlFile, 'null');

			// null YAML should throw EmptyFileError
			await assert.rejects(loadDataFile(await createFileEntry(nullYamlFile), mockTables, mockDatabases), {
				name: 'EmptyFileError',
				message: /is empty or invalid/,
			});
		});

		it('should handle file extension with no extension', async function () {
			const noExtFile = join(tempDir, 'noext');
			await writeFile(noExtFile, 'content');
			const fileEntry = await createFileEntry(noExtFile);

			await assert.rejects(loadDataFile(fileEntry, mockTables, mockDatabases), {
				name: 'UnsupportedFileExtensionError',
				message: /Only YAML and JSON files are supported/,
			});
		});

		it('should create new table when table does not exist', async function () {
			const newTableFile = join(tempDir, 'new_table.json');
			await writeFile(
				newTableFile,
				JSON.stringify({
					database: 'testdb',
					table: 'new_table',
					records: [
						{ id: 1, name: 'First', active: true },
						{ id: 2, name: 'Second', active: false },
					],
				})
			);

			// Mock the table function from databases module
			const databasesModule = require('@/resources/databases');
			const mockNewTable = {
				put: sinon.stub().resolves({ inserted: 1 }),
				get: sinon.stub().resolves(null),
				batchPut: sinon.stub().resolves(),
			};

			// Mock hash tracking table
			const mockHashTable = {
				get: sinon.stub().resolves(null),
				put: sinon.stub().resolves(),
			};

			// Add system database with hash tracking table to mockDatabases
			mockDatabases.system = {
				hdb_dataloader_hash: mockHashTable,
			};

			const originalTable = databasesModule.table;
			sinon.stub(databasesModule, 'table').callsFake(async (options) => {
				if (options.table === 'new_table' && options.database === 'testdb') {
					// Verify attributes were passed correctly
					assert.equal(options.attributes.length, 3);
					assert.equal(options.attributes[0].name, 'id');
					assert.equal(options.attributes[0].isPrimaryKey, true);
					assert.equal(options.attributes[1].name, 'name');
					assert.equal(options.attributes[2].name, 'active');
					return mockNewTable;
				}
				return originalTable.call(databasesModule, options);
			});

			try {
				const result = await loadDataFile(await createFileEntry(newTableFile), mockTables, mockDatabases);

				assert.ok(result instanceof DataLoaderResult);
				assert.equal(result.status, 'success');
				assert.equal(result.count, 2);
				assert.ok(
					result.message.includes('Loaded 2 new') || result.message.includes('Loaded 0 new and updated 2 records'),
					`Unexpected message: ${result.message}`
				);

				// Verify table was called once (hash tracking table is provided via mock)
				assert.ok(databasesModule.table.calledOnce);
			} finally {
				// Restore the stub
				databasesModule.table.restore();
			}
		});
	});

	describe('Error Classes', function () {
		it('should create DataLoaderError with default status code', function () {
			const error = new DataLoaderError('Test error');
			assert.equal(error.name, 'DataLoaderError');
			assert.equal(error.message, 'Test error');
			assert.equal(error.statusCode, 400);
		});

		it('should create DataLoaderError with custom status code', function () {
			const error = new DataLoaderError('Test error', 500);
			assert.equal(error.statusCode, 500);
		});

		it('should create UnsupportedFileExtensionError', function () {
			const error = new UnsupportedFileExtensionError('/path/to/file.doc', 'doc');
			assert.equal(error.name, 'UnsupportedFileExtensionError');
			assert.ok(error.message.includes('file.doc'));
			assert.ok(error.message.includes('doc'));
			assert.ok(error.message.includes('Only YAML and JSON files are supported'));
			assert.equal(error.statusCode, 400);
		});

		it('should create FileParseError', function () {
			const originalError = new Error('Parse failed');
			const error = new FileParseError('/path/to/file.json', originalError);
			assert.equal(error.name, 'FileParseError');
			assert.ok(error.message.includes('file.json'));
			assert.ok(error.message.includes('Parse failed'));
			assert.equal(error.statusCode, 400);
		});

		it('should create EmptyFileError', function () {
			const error = new EmptyFileError('/path/to/empty.yaml');
			assert.equal(error.name, 'EmptyFileError');
			assert.ok(error.message.includes('empty.yaml'));
			assert.ok(error.message.includes('empty or invalid'));
			assert.equal(error.statusCode, 400);
		});

		it('should create MissingRequiredPropertyError', function () {
			const error = new MissingRequiredPropertyError('/path/to/file.json', 'table');
			assert.equal(error.name, 'MissingRequiredPropertyError');
			assert.ok(error.message.includes('file.json'));
			assert.ok(error.message.includes('missing required "table" property'));
			assert.equal(error.statusCode, 400);
		});

		it('should create InvalidPropertyTypeError', function () {
			const error = new InvalidPropertyTypeError('/path/to/file.json', 'records', 'array');
			assert.equal(error.name, 'InvalidPropertyTypeError');
			assert.ok(error.message.includes('file.json'));
			assert.ok(error.message.includes('invalid "records" property'));
			assert.ok(error.message.includes('expected array'));
			assert.equal(error.statusCode, 400);
		});

		it('should create SystemDatabaseError', function () {
			const error = new SystemDatabaseError('system', 'users');
			assert.equal(error.name, 'SystemDatabaseError');
			assert.ok(error.message.includes('Cannot load data into system database'));
			assert.ok(error.message.includes('system.users'));
			assert.equal(error.statusCode, 403);
		});

		it('should create RecordProcessingError', function () {
			const originalError = new Error('DB connection failed');
			const error = new RecordProcessingError('dev.users', originalError);
			assert.equal(error.name, 'RecordProcessingError');
			assert.ok(error.message.includes('Failed to process record in dev.users'));
			assert.ok(error.message.includes('DB connection failed'));
			assert.equal(error.statusCode, 500);
		});
	});

	describe('handleApplication', function () {
		let originalGetWorkerIndex;

		// Import required modules for mocking
		const manageThreads = require('@/server/threads/manageThreads');

		beforeEach(function () {
			// Save original function
			originalGetWorkerIndex = manageThreads.getWorkerIndex;

			// Clear any previous stub calls to the logger
			loggerStub.info.resetHistory();
			loggerStub.error.resetHistory();
			loggerStub.debug.resetHistory();
		});

		afterEach(function () {
			// Restore original functions
			manageThreads.getWorkerIndex = originalGetWorkerIndex;
		});

		it('should set up file handler on primary worker', function () {
			// Mock getWorkerIndex to return zero
			manageThreads.getWorkerIndex = sinon.stub().returns(0);

			const mockScope = {
				handleEntry: sinon.stub(),
			};

			handleApplication(mockScope);

			assert.equal(mockScope.handleEntry.callCount, 1);
			assert.equal(typeof mockScope.handleEntry.firstCall.args[0], 'function');
		});

		it('should skip non-file entries', async function () {
			manageThreads.getWorkerIndex = sinon.stub().returns(0);

			const mockScope = {
				handleEntry: sinon.stub(),
			};

			handleApplication(mockScope);

			// Get the handler function
			const handler = mockScope.handleEntry.firstCall.args[0];

			// Test with directory entry
			const result = await handler({
				entryType: 'directory',
				eventType: 'add',
			});

			assert.equal(result, undefined);
		});

		it('should skip unlink events', async function () {
			manageThreads.getWorkerIndex = sinon.stub().returns(0);

			const mockScope = {
				handleEntry: sinon.stub(),
			};

			handleApplication(mockScope);

			// Get the handler function
			const handler = mockScope.handleEntry.firstCall.args[0];

			// Test with unlink event
			const result = await handler({
				entryType: 'file',
				eventType: 'unlink',
			});

			assert.equal(result, undefined);
		});
	});

	describe('DataLoaderResult', function () {
		it('should create result with all properties', function () {
			const result = new DataLoaderResult(
				'/path/to/file.json',
				'testDb',
				'testTable',
				'success',
				42,
				'Loaded 42 records'
			);

			assert.equal(result.filePath, '/path/to/file.json');
			assert.equal(result.database, 'testDb');
			assert.equal(result.table, 'testTable');
			assert.equal(result.status, 'success');
			assert.equal(result.count, 42);
			assert.equal(result.message, 'Loaded 42 records');
		});

		it('should handle null database and table', function () {
			const result = new DataLoaderResult('/path/to/file.json', null, null, 'error', 0, 'Error occurred');

			assert.equal(result.database, 'unknown');
			assert.equal(result.table, 'unknown');
		});

		it('should handle undefined database and table', function () {
			const result = new DataLoaderResult('/path/to/file.json', undefined, undefined, 'error', 0, 'Error occurred');

			assert.equal(result.database, 'unknown');
			assert.equal(result.table, 'unknown');
		});

		it('should serialize to JSON', function () {
			const result = new DataLoaderResult(
				'/path/to/file.json',
				'testDb',
				'testTable',
				'success',
				42,
				'Loaded 42 records'
			);

			const json = result.toJSON();

			assert.equal(typeof json, 'object');
			assert.equal(json.filePath, '/path/to/file.json');
			assert.equal(json.database, 'testDb');
			assert.equal(json.table, 'testTable');
			assert.equal(json.status, 'success');
			assert.equal(json.count, 42);
			assert.equal(json.message, 'Loaded 42 records');
		});
	});

	// Clean up module-level stubs after all tests
	after(function () {
		sinon.restore();
	});
});
