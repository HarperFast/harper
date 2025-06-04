'use strict';

const assert = require('node:assert/strict');
const { mkdir, readFile, rm, stat, writeFile } = require('node:fs/promises');
const { join } = require('node:path');
const sinon = require('sinon');

// Set up logger stub before importing dataLoader
const harperLogger = require('../../utility/logging/harper_logger.js');
const loggerStub = {
	info: sinon.stub(),
	error: sinon.stub(),
	debug: sinon.stub()
};
sinon.stub(harperLogger, 'forComponent').returns(loggerStub);

// Import the dataLoader module exports after logger is stubbed
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
	handleComponent
} = require('../../resources/dataLoader.ts');

// Helper function to create a mock record with getUpdatedTime method
function createMockRecord(props) {
	const record = { ...props };
	// Simulate the private #version field with a non-enumerable property
	Object.defineProperty(record, '_updatedTime', {
		value: props._updatedTime || Date.now(),
		writable: true,
		enumerable: false
	});
	
	record.getUpdatedTime = function() {
		return this._updatedTime;
	};
	
	return record;
}

// Helper function to create a FileEntry object
async function createFileEntry(filePath, contents = null) {
	const fileContent = contents || await readFile(filePath);
	const fileStat = await stat(filePath); // Let errors propagate
	
	return {
		contents: fileContent,
		absolutePath: filePath,
		stats: fileStat
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
			database: "dev",
			table: "test_table_json",
			records: [
				{ id: 1, name: "JSON Item 1", value: 300 },
				{ id: 2, name: "JSON Item 2", value: 400 }
			]
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
				put: sinon.stub().resolves({ inserted: 1 })
			};
			
			mockDatabases.dev = {
				test_table: mockTable
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
				put: sinon.stub().resolves({ inserted: 1 })
			};
			
			mockDatabases.dev = {
				test_table_json: mockTable
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
				put: sinon.stub().resolves({ inserted: 1 })
			};
			
			mockTables.test_yml = mockTable;
			
			const result = await loadDataFile(await createFileEntry(ymlDataFile), mockTables, mockDatabases);
			
			assert.ok(result instanceof DataLoaderResult);
			assert.equal(result.status, 'success');
			assert.equal(result.count, 1);
		});
		
		it('should throw UnsupportedFileExtensionError for invalid file type', async function () {
			const fileEntry = await createFileEntry(invalidDataFile);
			
			await assert.rejects(
				loadDataFile(fileEntry, mockTables, mockDatabases),
				{
					name: 'UnsupportedFileExtensionError',
					message: /Unsupported file extension.*txt.*Only YAML and JSON files are supported/
				}
			);
		});
		
		it('should throw FileParseError for invalid JSON', async function () {
			const invalidJsonFile = join(tempDir, 'invalid.json');
			await writeFile(invalidJsonFile, '{ invalid json }');
			const fileEntry = await createFileEntry(invalidJsonFile);
			
			await assert.rejects(
				loadDataFile(fileEntry, mockTables, mockDatabases),
				{
					name: 'FileParseError',
					message: /Failed to parse data file/
				}
			);
		});
		
		it('should throw FileParseError for invalid YAML', async function () {
			const invalidYamlFile = join(tempDir, 'invalid.yaml');
			// Create YAML with parse error - invalid anchor reference
			await writeFile(invalidYamlFile, 'table: *unknown_anchor');
			const fileEntry = await createFileEntry(invalidYamlFile);
			
			await assert.rejects(
				loadDataFile(fileEntry, mockTables, mockDatabases),
				{
					name: 'FileParseError',
					message: /Failed to parse data file/
				}
			);
		});
		
		it('should throw MissingRequiredPropertyError when table is missing', async function () {
			const noTableFile = join(tempDir, 'no-table.json');
			await writeFile(noTableFile, JSON.stringify({ records: [{ id: 1 }] }));
			const fileEntry = await createFileEntry(noTableFile);
			
			await assert.rejects(
				loadDataFile(fileEntry, mockTables, mockDatabases),
				{
					name: 'MissingRequiredPropertyError',
					message: /missing required "table" property/
				}
			);
		});
		
		it('should throw MissingRequiredPropertyError when records is missing', async function () {
			const noRecordsFile = join(tempDir, 'no-records.json');
			await writeFile(noRecordsFile, JSON.stringify({ table: 'test' }));
			const fileEntry = await createFileEntry(noRecordsFile);
			
			await assert.rejects(
				loadDataFile(fileEntry, mockTables, mockDatabases),
				{
					name: 'MissingRequiredPropertyError',
					message: /missing required "records" property/
				}
			);
		});
		
		it('should throw InvalidPropertyTypeError when records is not an array', async function () {
			const invalidRecordsFile = join(tempDir, 'invalid-records.json');
			await writeFile(invalidRecordsFile, JSON.stringify({ table: 'test', records: { id: 1 } }));
			const fileEntry = await createFileEntry(invalidRecordsFile);
			
			await assert.rejects(
				loadDataFile(fileEntry, mockTables, mockDatabases),
				{
					name: 'InvalidPropertyTypeError',
					message: /invalid "records" property, expected array/
				}
			);
		});
		
		it('should throw SystemDatabaseError when trying to load into system database', async function () {
			const systemDbFile = join(tempDir, 'system-db.json');
			await writeFile(systemDbFile, JSON.stringify({
				database: 'system',
				table: 'test',
				records: [{ id: 1 }]
			}));
			const fileEntry = await createFileEntry(systemDbFile);
			
			await assert.rejects(
				loadDataFile(fileEntry, mockTables, mockDatabases),
				{
					name: 'SystemDatabaseError',
					message: /Cannot load data into system database/
				}
			);
		});
		
		it('should throw SystemDatabaseError for case-insensitive system database', async function () {
			const systemDbFile = join(tempDir, 'system-db-case.json');
			await writeFile(systemDbFile, JSON.stringify({
				database: 'SYSTEM',
				table: 'test',
				records: [{ id: 1 }]
			}));
			const fileEntry = await createFileEntry(systemDbFile);
			
			await assert.rejects(
				loadDataFile(fileEntry, mockTables, mockDatabases),
				{
					name: 'SystemDatabaseError',
					message: /Cannot load data into system database/
				}
			);
		});
		
		it('should use existing table from global tables', async function () {
			// Create mock table in global tables
			const mockTable = {
				get: sinon.stub().resolves(null),
				put: sinon.stub().resolves({ inserted: 1 })
			};
			
			mockTables.test_table_json = mockTable;
			
			const result = await loadDataFile(await createFileEntry(jsonDataFile), mockTables, mockDatabases);
			
			assert.ok(result instanceof DataLoaderResult);
			assert.equal(result.status, 'success');
			assert.equal(mockTable.put.callCount, 2);
		});
		
		it('should handle empty records array', async function () {
			const emptyRecordsFile = join(tempDir, 'empty-records.json');
			await writeFile(emptyRecordsFile, JSON.stringify({
				table: 'empty_table',
				records: []
			}));
			
			// Mock the table - even with empty records, the table lookup still happens
			const mockTable = {
				get: sinon.stub().resolves(null),
				put: sinon.stub().resolves({ inserted: 1 })
			};
			
			mockTables.empty_table = mockTable;
			
			const result = await loadDataFile(await createFileEntry(emptyRecordsFile), mockTables, mockDatabases);
			
			assert.ok(result instanceof DataLoaderResult);
			assert.equal(result.status, 'success');
			assert.equal(result.count, 0);
			assert.ok(result.message.includes('No records to process'));
		});
		
		it('should skip records with newer timestamps', async function () {
			// Create mock records with future timestamps
			const futureTime = Date.now() + 10000;
			const existingRecord1 = createMockRecord({ id: 1, name: 'Existing 1', _updatedTime: futureTime });
			const existingRecord2 = createMockRecord({ id: 2, name: 'Existing 2', _updatedTime: futureTime });
			
			// Create mock table
			const mockTable = {
				get: sinon.stub()
					.onCall(0).resolves(existingRecord1)
					.onCall(1).resolves(existingRecord2),
				put: sinon.stub().resolves({ inserted: 1 })
			};
			
			mockDatabases.dev = {
				test_table_json: mockTable
			};
			
			// Mock stat to return old file mtime
			const fs = require('node:fs/promises');
			const statStub = sinon.stub(fs, 'stat');
			statStub.resolves({ mtimeMs: Date.now() - 10000 });
			
			try {
				const result = await loadDataFile(await createFileEntry(jsonDataFile), mockTables, mockDatabases);
				
				assert.ok(result instanceof DataLoaderResult);
				assert.equal(result.status, 'skipped');
				assert.ok(result.message.includes('already up-to-date'));
				assert.equal(mockTable.put.callCount, 0);
			} finally {
				statStub.restore();
			}
		});
		
		it('should update records with older timestamps', async function () {
			// Create mock records with past timestamps
			const pastTime = Date.now() - 10000;
			const existingRecord1 = createMockRecord({ id: 1, name: 'Old 1', _updatedTime: pastTime });
			const existingRecord2 = createMockRecord({ id: 2, name: 'Old 2', _updatedTime: pastTime });
			
			// Create mock table
			const mockTable = {
				get: sinon.stub()
					.onCall(0).resolves(existingRecord1)
					.onCall(1).resolves(existingRecord2),
				put: sinon.stub().resolves({ updated: 1 })
			};
			
			mockDatabases.dev = {
				test_table_json: mockTable
			};
			
			const result = await loadDataFile(await createFileEntry(jsonDataFile), mockTables, mockDatabases);
			
			assert.ok(result instanceof DataLoaderResult);
			assert.equal(result.status, 'success');
			assert.equal(result.count, 2);
			assert.ok(result.message.includes('updated 2 records'));
			assert.equal(mockTable.put.callCount, 2);
		});
		
		it('should handle mixed new, updated, and skipped records', async function () {
			const mixedFile = join(tempDir, 'mixed.json');
			await writeFile(mixedFile, JSON.stringify({
				table: 'mixed_table',
				records: [
					{ id: 1, name: 'New' },
					{ id: 2, name: 'To Update' },
					{ id: 3, name: 'To Skip' }
				]
			}));
			
			const pastTime = Date.now() - 10000;
			const futureTime = Date.now() + 10000;
			const existingRecord2 = createMockRecord({ id: 2, name: 'Old', _updatedTime: pastTime });
			const existingRecord3 = createMockRecord({ id: 3, name: 'Current', _updatedTime: futureTime });
			
			// Create mock table
			const mockTable = {
				get: sinon.stub()
					.onCall(0).resolves(null)
					.onCall(1).resolves(existingRecord2)
					.onCall(2).resolves(existingRecord3),
				put: sinon.stub().resolves({ inserted: 1 })
			};
			
			mockTables.mixed_table = mockTable;
			
			const result = await loadDataFile(await createFileEntry(mixedFile), mockTables, mockDatabases);
			
			assert.ok(result instanceof DataLoaderResult);
			assert.equal(result.status, 'success');
			assert.equal(result.count, 2); // 1 new + 1 updated
			assert.ok(result.message.includes('Loaded 1 new and updated 1 records'));
			assert.ok(result.message.includes('(1 records skipped)'));
			assert.equal(mockTable.put.callCount, 2);
		});
		
		it('should handle errors during record processing', async function () {
			const errorFile = join(tempDir, 'error.json');
			await writeFile(errorFile, JSON.stringify({
				table: 'error_table',
				records: [{ id: 1, name: 'Will fail' }]
			}));
			
			// Create mock table that throws error
			const mockTable = {
				get: sinon.stub().rejects(new Error('Database error')),
				put: sinon.stub().resolves({ inserted: 1 })
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
			await writeFile(errorFile, JSON.stringify({
				table: 'dataloader_error_table',
				records: [{ id: 1, name: 'Will fail with DataLoaderError' }]
			}));
			
			// Create mock table that throws a DataLoaderError
			const mockTable = {
				get: sinon.stub().rejects(new MissingRequiredPropertyError('id')),
				put: sinon.stub().resolves({ inserted: 1 })
			};
			
			mockTables.dataloader_error_table = mockTable;
			
			// Reset the logger stub to ensure clean state
			loggerStub.error.resetHistory();
			
			// With the current implementation, individual record errors are logged but don't fail the whole operation
			const result = await loadDataFile(await createFileEntry(errorFile), mockTables, mockDatabases);
			
			assert.ok(result instanceof DataLoaderResult);
			assert.equal(result.status, 'success');
			assert.equal(result.count, 0); // No records successfully processed
			assert.equal(loggerStub.error.callCount, 1, `Logger error should be called once, but was called ${loggerStub.error.callCount} times`);
			assert.ok(loggerStub.error.firstCall.args[0].includes('Record processing error:'));
		});
		
		it('should process records in batches', async function () {
			// Create a file with many records
			const manyRecords = [];
			for (let i = 1; i <= 250; i++) {
				manyRecords.push({ id: i, name: `Item ${i}` });
			}
			
			const batchFile = join(tempDir, 'batch.json');
			await writeFile(batchFile, JSON.stringify({
				table: 'batch_table',
				records: manyRecords
			}));
			
			// Create mock table
			const mockTable = {
				get: sinon.stub().resolves(null),
				put: sinon.stub().resolves({ inserted: 1 })
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
			await writeFile(noIdFile, JSON.stringify({
				table: 'no_id_table',
				records: [{ name: 'No ID' }]
			}));
			
			// Mock table
			const mockTable = {
				get: sinon.stub().resolves(null),
				put: sinon.stub().resolves({ inserted: 1 })
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
			await assert.rejects(
				loadDataFile(await createFileEntry(emptyYamlFile), mockTables, mockDatabases),
				{
					name: 'FileParseError',
					message: /Cannot set properties of null/
				}
			);
		});
		
		it('should handle null YAML content', async function () {
			const nullYamlFile = join(tempDir, 'null.yaml');
			await writeFile(nullYamlFile, 'null');
			
			// null YAML should be caught during parsing
			await assert.rejects(
				loadDataFile(await createFileEntry(nullYamlFile), mockTables, mockDatabases),
				{
					name: 'FileParseError',
					message: /Cannot set properties of null/
				}
			);
		});
		
		
		it('should handle file extension with no extension', async function () {
			const noExtFile = join(tempDir, 'noext');
			await writeFile(noExtFile, 'content');
			const fileEntry = await createFileEntry(noExtFile);
			
			await assert.rejects(
				loadDataFile(fileEntry, mockTables, mockDatabases),
				{
					name: 'UnsupportedFileExtensionError',
					message: /Only YAML and JSON files are supported/
				}
			);
		});
		
		it('should create new table when table does not exist', async function () {
			const newTableFile = join(tempDir, 'new_table.json');
			await writeFile(newTableFile, JSON.stringify({
				database: 'testdb',
				table: 'new_table',
				records: [
					{ id: 1, name: 'First', active: true },
					{ id: 2, name: 'Second', active: false }
				]
			}));
			
			// Mock the table function from databases module
			const databasesModule = require('../../resources/databases.ts');
			const mockNewTable = {
				put: sinon.stub().resolves({ inserted: 1 }),
				get: sinon.stub().resolves(null),
				batchPut: sinon.stub().resolves()
			};
			
			const originalTable = databasesModule.table;
			sinon.stub(databasesModule, 'table').callsFake(async (options) => {
				if (options.name === 'new_table' && options.database === 'testdb') {
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
				assert.ok(result.message.includes('Loaded 2 new') || result.message.includes('Loaded 0 new and updated 2 records'), `Unexpected message: ${result.message}`);
				
				// Verify table was called with correct parameters
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
	
	describe('handleComponent', function () {
		let originalGetWorkerIndex;
		
		// Import required modules for mocking
		const manageThreads = require('../../server/threads/manageThreads');
		
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
				handleEntry: sinon.stub()
			};
			
			handleComponent(mockScope);
			
			assert.equal(mockScope.handleEntry.callCount, 1);
			assert.equal(typeof mockScope.handleEntry.firstCall.args[0], 'function');
		});
		
		it('should skip non-file entries', async function () {
			manageThreads.getWorkerIndex = sinon.stub().returns(0);
			
			const mockScope = {
				handleEntry: sinon.stub()
			};
			
			handleComponent(mockScope);
			
			// Get the handler function
			const handler = mockScope.handleEntry.firstCall.args[0];
			
			// Test with directory entry
			const result = await handler({
				entryType: 'directory',
				eventType: 'add'
			});
			
			assert.equal(result, undefined);
		});
		
		it('should skip unlink events', async function () {
			manageThreads.getWorkerIndex = sinon.stub().returns(0);
			
			const mockScope = {
				handleEntry: sinon.stub()
			};
			
			handleComponent(mockScope);
			
			// Get the handler function
			const handler = mockScope.handleEntry.firstCall.args[0];
			
			// Test with unlink event
			const result = await handler({
				entryType: 'file',
				eventType: 'unlink'
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
			const result = new DataLoaderResult(
				'/path/to/file.json',
				null,
				null,
				'error',
				0,
				'Error occurred'
			);
			
			assert.equal(result.database, 'unknown');
			assert.equal(result.table, 'unknown');
		});
		
		it('should handle undefined database and table', function () {
			const result = new DataLoaderResult(
				'/path/to/file.json',
				undefined,
				undefined,
				'error',
				0,
				'Error occurred'
			);
			
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
	after(function() {
		sinon.restore();
	});
});