'use strict';

const assert = require('node:assert/strict');
const sinon = require('sinon');
const { join } = require('path');
const fs = require('fs');
const { promises: fsPromises } = fs;
const dataLoader = require('../../resources/dataLoader.ts');

// Helper function to create a record with getUpdatedTime method
function createTestRecord(props) {
	const record = { ...props };
	// In the actual Table.ts implementation, getUpdatedTime() returns the private #version property
	// Since we can't use private fields in our mock, we'll use a non-enumerable property to simulate it
	if (!record.getUpdatedTime) {
		// Store updatedTime as a property (simulating #version in the real implementation)
		Object.defineProperty(record, '_updatedTime', {
			value: props._updatedTime || Date.now(),
			writable: true,
			enumerable: false // Make it non-enumerable like a private field
		});

		record.getUpdatedTime = function() {
			return this._updatedTime;
		};
	}
	return record;
}

describe('Data Loader', function () {
	const tempDir = join(__dirname, '../envDir/dataloader-test');
	const yamlDataFile = join(tempDir, 'test-data.yaml');
	const jsonDataFile = join(tempDir, 'test-data.json');
	const complexDataFile = join(tempDir, 'complex-data.json');

	// Mock tables
	let mockTables;
	
	// Create a base ensureTable function
	const baseEnsureTable = async (options) => {
		const tableName = `${options.database || 'default'}.${options.table}`;
		if (!mockTables[tableName]) {
			mockTables[tableName] = {
				name: options.table,
				schema: options.database,
				attributes: options.attributes || [],
				records: [],
				get: async (id) => {
					// Find record by ID
					return mockTables[tableName].records.find(r => r.id === id) || null;
				},
				put: async (record) => {
					// Make sure all records are properly formatted with our helper function
					const processedRecord = createTestRecord(record);
					mockTables[tableName].records.push(processedRecord);
					return { inserted: 1 };
				}
			};
		}
		return mockTables[tableName];
	};
	
	// Will hold the spy on ensureTable function
	let mockEnsureTable;
	
	
	before(async function () {
		// Create temp directory and files
		if (!fs.existsSync(tempDir)) {
			fs.mkdirSync(tempDir, { recursive: true });
		}

		// Create test YAML file
		const yamlContent = `
database: dev
table: test_table
records:
  - id: 1
    name: "Test Item 1"
    value: 100
  - id: 2
    name: "Test Item 2"
    value: 200
`;
		await fsPromises.writeFile(yamlDataFile, yamlContent);

		// Create test JSON file
		const jsonContent = `{
  "database": "dev",
  "table": "test_table_json",
  "records": [
    {
      "id": 1,
      "name": "JSON Item 1",
      "value": 300
    },
    {
      "id": 2,
      "name": "JSON Item 2",
      "value": 400
    }
  ]
}`;
		await fsPromises.writeFile(jsonDataFile, jsonContent);

		// Create complex JSON file with various data types
		const complexContent = `{
  "database": "test",
  "table": "complex",
  "records": [
    {
      "id": 1,
      "name": "Complex Item",
      "price": 199.99,
      "inStock": true,
      "tags": ["electronics", "gadget"],
      "details": {
        "weight": 1.5,
        "color": "black"
      },
      "nullValue": null,
      "integerValue": 42
    }
  ]
}`;
		await fsPromises.writeFile(complexDataFile, complexContent);
	});

	after(async function () {
		// Clean up test files
		if (fs.existsSync(tempDir)) {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	beforeEach(function () {
		// Reset mocks before each test
		mockTables = {};
		// Create a fresh spy on the ensureTable function for each test
		mockEnsureTable = sinon.spy(baseEnsureTable);
		
	});
	
	afterEach(function() {
		// Restore all spies
		sinon.restore();
	});

	it('should load data from YAML file into empty table', async function () {
		const loader = dataLoader.start({ ensureTable: mockEnsureTable });
		const fileContent = await fsPromises.readFile(yamlDataFile);

		const results = await loader.setupFile(fileContent, '/data/test', yamlDataFile);

		// Check results
		assert.ok(results instanceof dataLoader.DataLoaderResult);
		assert.equal(results.status, 'success');
		assert.equal(results.count, 2);

		// Check table
		assert.equal(mockTables['dev.test_table'].records.length, 2);
		assert.equal(mockTables['dev.test_table'].records[0].name, 'Test Item 1');

		// Verify ensureTable was called correctly
		assert.equal(mockEnsureTable.callCount, 1);

		// Verify database and table were correct
		const options = mockEnsureTable.firstCall.args[0];
		assert.equal(options.database, 'dev');
		assert.equal(options.table, 'test_table');

		// Verify attributes
		assert.ok(Array.isArray(options.attributes));
		assert.ok(options.attributes.length > 0);

		// Check that attributes include all fields from records
		const attributes = options.attributes.map(a => a.name);
		assert.ok(attributes.includes('id'));
		assert.ok(attributes.includes('name'));
		assert.ok(attributes.includes('value'));

		// Check that id is marked as primary key
		const idAttribute = options.attributes.find(a => a.name === 'id');
		assert.ok(idAttribute.isPrimaryKey);
	});

	it('should load data from JSON file into empty table', async function () {
		const loader = dataLoader.start({ ensureTable: mockEnsureTable });
		const fileContent = await fsPromises.readFile(jsonDataFile);

		const results = await loader.setupFile(fileContent, '/data/test', jsonDataFile);

		assert.ok(results instanceof dataLoader.DataLoaderResult);
		assert.equal(results.status, 'success');
		assert.equal(results.count, 2);
		assert.equal(mockTables['dev.test_table_json'].records.length, 2);
		assert.equal(mockTables['dev.test_table_json'].records[0].name, 'JSON Item 1');

		// Verify ensureTable was called
		assert.equal(mockEnsureTable.callCount, 1);
	});

	it('should handle complex data with different types', async function () {
		const loader = dataLoader.start({ ensureTable: mockEnsureTable });
		const fileContent = await fsPromises.readFile(complexDataFile);

		const results = await loader.setupFile(fileContent, '/data/test', complexDataFile);

		// Check results
		assert.ok(results instanceof dataLoader.DataLoaderResult);
		assert.equal(results.status, 'success');
		assert.equal(results.count, 1);

		// Verify our complex data was loaded correctly
		assert.equal(mockTables['test.complex'].records.length, 1);
		const record = mockTables['test.complex'].records[0];
		assert.equal(record.id, 1);
		assert.equal(record.name, 'Complex Item');
		assert.equal(record.price, 199.99);
		assert.equal(record.inStock, true);
		assert.ok(Array.isArray(record.tags));
		assert.equal(typeof record.details, 'object');
		assert.equal(record.nullValue, null);
		assert.equal(record.integerValue, 42);

		// Verify ensureTable was called correctly
		assert.equal(mockEnsureTable.callCount, 1);

		// Get the attributes from the ensureTable call
		const options = mockEnsureTable.firstCall.args[0];
		const attributeNames = options.attributes.map(a => a.name);
		assert.ok(attributeNames.includes('id'));
		assert.ok(attributeNames.includes('name'));
		assert.ok(attributeNames.includes('price'));
		assert.ok(attributeNames.includes('inStock'));
		assert.ok(attributeNames.includes('tags'));
		assert.ok(attributeNames.includes('details'));
		assert.ok(attributeNames.includes('nullValue'));
		assert.ok(attributeNames.includes('integerValue'));

		// Check that id is marked as primary key
		const idAttribute = options.attributes.find(a => a.name === 'id');
		assert.ok(idAttribute.isPrimaryKey);
	});

	it('should skip loading if table already has newer records', async function () {
		// Pre-populate the table with baseEnsureTable directly (not the spy)
		await baseEnsureTable({ database: 'dev', table: 'test_table' });

		// Create current time and a future time
		const now = Date.now();
		const future = now + 10000; // 10 seconds in the future

		// Add records with future timestamps to ensure they're newer than the test file data
		const record1 = createTestRecord({ id: 1, name: 'Existing 1', _updatedTime: future });
		const record2 = createTestRecord({ id: 2, name: 'Existing 2', _updatedTime: future });
		mockTables['dev.test_table'].records.push(record1, record2);

		const loader = dataLoader.start({ ensureTable: mockEnsureTable });
		const fileContent = await fsPromises.readFile(yamlDataFile);

		const results = await loader.setupFile(fileContent, '/data/test', yamlDataFile);

		assert.ok(results instanceof dataLoader.DataLoaderResult);
		assert.equal(results.status, 'skipped');
		assert.equal(mockTables['dev.test_table'].records.length, 2); // Still only the pre-existing records

		// Verify ensureTable was still called
		assert.equal(mockEnsureTable.callCount, 1);
	});

	it('should update records if timestamps are newer', async function () {
		// Pre-populate the table with baseEnsureTable directly (not the spy)
		await baseEnsureTable({ database: 'dev', table: 'test_table' });

		// Create time in the past
		const past = Date.now() - 10000; // 10 seconds in the past

		// Add records with older timestamps to ensure they get updated
		const record1 = createTestRecord({ id: 1, name: 'Old Version 1', _updatedTime: past });
		const record2 = createTestRecord({ id: 2, name: 'Old Version 2', _updatedTime: past });
		mockTables['dev.test_table'].records.push(record1, record2);

		// Add a current timestamp to the YAML file data
		const yamlContent = `
database: dev
table: test_table
records:
  - id: 1
    name: "Updated Item 1"
    value: 100
  - id: 2
    name: "Updated Item 2"
    value: 200
`;
		const updatedYamlFile = join(tempDir, 'updated-data.yaml');
		await fsPromises.writeFile(updatedYamlFile, yamlContent);

		const loader = dataLoader.start({ ensureTable: mockEnsureTable });
		const fileContent = await fsPromises.readFile(updatedYamlFile);

		const results = await loader.setupFile(fileContent, '/data/test', updatedYamlFile);

		assert.ok(results instanceof dataLoader.DataLoaderResult);
		assert.equal(results.status, 'success');
		assert.equal(mockTables['dev.test_table'].records.length, 4); // Our mock implementation adds new records instead of updating

		// Verify records were updated with new names
		// In our mock implementation, each update adds a new record instead of replacing
		// So let's check for the updated records by name
		const recordNames = mockTables['dev.test_table'].records.map(r => r.name);
		assert.ok(recordNames.includes('Updated Item 1'));
		assert.ok(recordNames.includes('Updated Item 2'));

		// Verify ensureTable was called
		assert.equal(mockEnsureTable.callCount, 1);
	});

	it('should handle invalid file format', async function () {
		const loader = dataLoader.start({ ensureTable: mockEnsureTable });
		const fileContent = Buffer.from('{ invalid: json }');

		// Now we expect it to throw an error, so we use try/catch
		try {
			await loader.setupFile(fileContent, '/data/test', join(tempDir, 'invalid.json'));
			// If we get here, the test should fail
			assert.fail('Expected an error to be thrown');
		} catch (error) {
			// Verify the error is the right type
			assert.ok(error instanceof dataLoader.FileParseError);
			assert.ok(error.message.includes('Failed to parse data file'));

			// Verify ensureTable was never called since parsing failed
			assert.equal(mockEnsureTable.callCount, 0);
		}
	});

	it('should handle tables with only a table name (no schema)', async function () {
		const invalidContent = `{
  "table": "invalid_no_dot",
  "records": [
    { "id": 1, "name": "Test" }
  ]
}`;
		const invalidFile = join(tempDir, 'invalid-format.json');
		await fsPromises.writeFile(invalidFile, invalidContent);

		const loader = dataLoader.start({ ensureTable: mockEnsureTable });
		const fileContent = await fsPromises.readFile(invalidFile);

		const results = await loader.setupFile(fileContent, '/data/test', invalidFile);
		
		assert.ok(results instanceof dataLoader.DataLoaderResult);
		assert.equal(results.status, 'success');
		assert.equal(results.table, 'invalid_no_dot');
		
		// Verify ensureTable was called correctly
		assert.equal(mockEnsureTable.callCount, 1);
		const options = mockEnsureTable.firstCall.args[0];
		assert.equal(options.database, undefined);
		assert.equal(options.table, 'invalid_no_dot');
	});

	it('should handle tables with non-array data', async function () {
		const invalidContent = `{
  "database": "test",
  "table": "non_array",
  "records": { "id": 1, "name": "Not an array" }
}`;
		const invalidFile = join(tempDir, 'non-array.json');
		await fsPromises.writeFile(invalidFile, invalidContent);

		const loader = dataLoader.start({ ensureTable: mockEnsureTable });
		const fileContent = await fsPromises.readFile(invalidFile);

		// Now we expect an error to be thrown
		try {
			await loader.setupFile(fileContent, '/data/test', invalidFile);
			// If we get here, the test should fail
			assert.fail('Expected an error to be thrown');
		} catch (error) {
			// Verify the error is the right type
			assert.ok(error instanceof dataLoader.InvalidPropertyTypeError);
			assert.ok(error.message.includes('invalid "records" property'));
			assert.ok(error.message.includes('expected array'));

			// Verify ensureTable was never called for invalid non-array data
			assert.equal(mockEnsureTable.callCount, 0);
		}
	});

	it('should handle errors during table creation', async function () {
		// Create an error-throwing ensureTable function
		const errorEnsureTable = sinon.spy(async (options) => {
			if (options.database === 'error' && options.table === 'table') {
				throw new Error('Failed to create table');
			}
			return await baseEnsureTable(options);
		});

		// Create test file that will trigger an error
		const errorContent = `{
  "database": "error",
  "table": "table",
  "records": [
    { "id": 1, "name": "Will fail" }
  ]
}`;
		const errorFile = join(tempDir, 'error-table.json');
		await fsPromises.writeFile(errorFile, errorContent);

		// Create a separate test file for success case
		const successContent = `{
  "database": "success",
  "table": "table",
  "records": [
    { "id": 1, "name": "Will succeed" }
  ]
}`;
		const successFile = join(tempDir, 'success-table.json');
		await fsPromises.writeFile(successFile, successContent);

		const loader = dataLoader.start({ ensureTable: errorEnsureTable });

		// Test error case - this should now throw a RecordProcessingError
		const errorFileContent = await fsPromises.readFile(errorFile);

		try {
			await loader.setupFile(errorFileContent, '/data/test', errorFile);
			// If we get here, the test should fail
			assert.fail('Expected an error to be thrown for table creation error');
		} catch (error) {
			// Verify the error is the right type
			assert.ok(error instanceof dataLoader.RecordProcessingError);
			assert.ok(error.message.includes('Failed to process record in error.table'));
			assert.ok(error.message.includes('Failed to create table'));
		}

		// Test success case - this should still work as before
		const successFileContent = await fsPromises.readFile(successFile);
		const successResults = await loader.setupFile(successFileContent, '/data/test', successFile);

		assert.ok(successResults instanceof dataLoader.DataLoaderResult);
		assert.equal(successResults.status, 'success');
		assert.equal(successResults.count, 1);

		// Verify ensureTable was called twice (once for each file)
		assert.equal(errorEnsureTable.callCount, 2);
	});
	
	it('should support table name without database prefix', async function () {
		const noDbContent = `{
  "table": "standalone_table",
  "records": [
    { "id": 1, "name": "No database prefix" }
  ]
}`;
		const noDbFile = join(tempDir, 'no-db.json');
		await fsPromises.writeFile(noDbFile, noDbContent);
		
		const loader = dataLoader.start({ ensureTable: mockEnsureTable });
		const fileContent = await fsPromises.readFile(noDbFile);
		
		const results = await loader.setupFile(fileContent, '/data/test', noDbFile);
		
		assert.ok(results instanceof dataLoader.DataLoaderResult);
		assert.equal(results.status, 'success');
		
		// Verify ensureTable was called correctly
		assert.equal(mockEnsureTable.callCount, 1);
		const options = mockEnsureTable.firstCall.args[0];
		assert.equal(options.database, undefined);
		assert.equal(options.table, 'standalone_table');
	});
	
	it('should handle system database rejection', async function () {
		const systemContent = `{
  "database": "system",
  "table": "test",
  "records": [
    { "id": 1, "name": "System table" }
  ]
}`;
		const systemFile = join(tempDir, 'system-db.json');
		await fsPromises.writeFile(systemFile, systemContent);

		const loader = dataLoader.start({ ensureTable: mockEnsureTable });
		const fileContent = await fsPromises.readFile(systemFile);

		// Now we expect an error to be thrown
		try {
			await loader.setupFile(fileContent, '/data/test', systemFile);
			// If we get here, the test should fail
			assert.fail('Expected an error to be thrown');
		} catch (error) {
			// Verify the error is the right type
			assert.ok(error instanceof dataLoader.SystemDatabaseError);
			assert.equal(error.name, 'SystemDatabaseError');
			assert.ok(error.message.includes('Cannot load data into system database'));
			assert.ok(error.message.includes('system.test'));

			// Verify ensureTable was never called for system database
			assert.equal(mockEnsureTable.callCount, 0);
		}
	});
	
	it('should properly process data files through the setupFile method', async function () {
		const loader = dataLoader.start({ ensureTable: mockEnsureTable });
		const fileContent = await fsPromises.readFile(yamlDataFile);

		// Process YAML data through setupFile
		const results = await loader.setupFile(fileContent, '/data/test', yamlDataFile);

		// Verify results are as expected
		assert.ok(results instanceof dataLoader.DataLoaderResult);
		assert.equal(results.status, 'success');
		assert.equal(results.count, 2);

		// Check table was updated
		assert.equal(mockTables['dev.test_table'].records.length, 2);

		// Verify ensureTable was called
		assert.equal(mockEnsureTable.callCount, 1);
	});

	it('should use existing table from tables override instead of ensureTable when available', async function () {
		// Create a new JSON file with a unique table name for this test
		const globalTableContent = `{
  "database": "dev",
  "table": "global_table_test",
  "records": [
    { "id": 1, "name": "Global Item 1" },
    { "id": 2, "name": "Global Item 2" }
  ]
}`;
		const globalTableFile = join(tempDir, 'global-table.json');
		await fsPromises.writeFile(globalTableFile, globalTableContent);

		// Create a spy for our table's put method
		const putSpy = sinon.spy(async (record) => {
			return { inserted: 1 };
		});

		// Create a mock table with our test data
		const mockTableOverride = {
			global_table_test: {
				get: async (id) => {
					// Return null to simulate no existing record
					return null;
				},
				put: putSpy
			}
		};

		// Create a spy ensureTable function that should throw an error if called
		const errorEnsureTable = sinon.spy(async () => {
			throw new Error('ensureTable should not be called when table exists in override');
		});

		// Create a loader with our tablesOverride parameter
		const loader = dataLoader.start({
			ensureTable: errorEnsureTable,
			tablesOverride: mockTableOverride
		});

		const fileContent = await fsPromises.readFile(globalTableFile);
		const results = await loader.setupFile(fileContent, '/data/test', globalTableFile);

		// Check results
		assert.ok(results instanceof dataLoader.DataLoaderResult);
		assert.equal(results.status, 'success');
		assert.equal(results.count, 2); // 2 records should be inserted

		// Verify errorEnsureTable was NOT called because we used the table from tablesOverride
		assert.equal(errorEnsureTable.callCount, 0);

		// Verify the table's put method was called twice (once for each record)
		assert.equal(putSpy.callCount, 2);
	});

	it('should use existing table from database override instead of ensureTable when available', async function () {
		// Create a new JSON file with a unique table name for this test
		const dbTableContent = `{
  "database": "dev",
  "table": "db_table_test",
  "records": [
    { "id": 1, "name": "DB Item 1" },
    { "id": 2, "name": "DB Item 2" }
  ]
}`;
		const dbTableFile = join(tempDir, 'db-table.json');
		await fsPromises.writeFile(dbTableFile, dbTableContent);

		// Create a spy for our table's put method
		const putSpy = sinon.spy(async (record) => {
			return { inserted: 1 };
		});

		// Create a mock table in a mock database
		const mockDb = {
			db_table_test: {
				get: async (id) => {
					// Return null to simulate no existing record
					return null;
				},
				put: putSpy
			}
		};

		// Create databases override with our mock database
		const mockDatabasesOverride = {
			dev: mockDb
		};

		// Create a spy ensureTable function that should throw an error if called
		const errorEnsureTable = sinon.spy(async () => {
			throw new Error('ensureTable should not be called when table exists in database override');
		});

		// Create a loader with our databasesOverride parameter
		const loader = dataLoader.start({
			ensureTable: errorEnsureTable,
			databasesOverride: mockDatabasesOverride
		});

		const fileContent = await fsPromises.readFile(dbTableFile);
		const results = await loader.setupFile(fileContent, '/data/test', dbTableFile);

		// Check results
		assert.ok(results instanceof dataLoader.DataLoaderResult);
		assert.equal(results.status, 'success');
		assert.equal(results.count, 2); // 2 records should be inserted

		// Verify errorEnsureTable was NOT called because we used the table from databasesOverride
		assert.equal(errorEnsureTable.callCount, 0);

		// Verify the table's put method was called twice (once for each record)
		assert.equal(putSpy.callCount, 2);
	});

	// Test the MissingRequiredPropertyError and DataLoaderResult classes
	it('should test MissingRequiredPropertyError constructor and properties', function () {
		const error = new dataLoader.MissingRequiredPropertyError('/path/to/file.json', 'testProperty');
		assert.equal(error.name, 'MissingRequiredPropertyError');
		assert.ok(error.message.includes('file.json'));
		assert.ok(error.message.includes('testProperty'));
		assert.equal(error.statusCode, 400); // BAD_REQUEST
	});

	it('should test DataLoaderResult getters', function () {
		const result = new dataLoader.DataLoaderResult(
			'/path/to/file.json',
			'testDb',
			'testTable',
			'success',
			42,
			'Test message'
		);

		// Test all getters
		assert.equal(result.filePath, '/path/to/file.json');
		assert.equal(result.database, 'testDb');
		assert.equal(result.table, 'testTable');
		assert.equal(result.status, 'success');
		assert.equal(result.count, 42);
		assert.equal(result.message, 'Test message');
	});

	it('should test DataLoaderResult toJSON method', function () {
		const result = new dataLoader.DataLoaderResult(
			'/path/to/file.json',
			'testDb',
			'testTable',
			'success',
			42,
			'Test message'
		);

		// Test toJSON method
		const json = result.toJSON();
		assert.equal(typeof json, 'object');
		assert.equal(json.filePath, '/path/to/file.json');
		assert.equal(json.database, 'testDb');
		assert.equal(json.table, 'testTable');
		assert.equal(json.status, 'success');
		assert.equal(json.count, 42);
		assert.equal(json.message, 'Test message');
	});

	it('should handle null or undefined values in DataLoaderResult constructor', function () {
		const result = new dataLoader.DataLoaderResult(
			'/path/to/file.json',
			null, // test null database
			null, // test null table
			'error',
			0,
			'Error message'
		);

		// Verify default values for null/undefined parameters
		assert.equal(result.database, 'unknown');
		assert.equal(result.table, 'unknown');

		// Test with undefined values
		const result2 = new dataLoader.DataLoaderResult(
			'/path/to/file.json',
			undefined, // test undefined database
			undefined, // test undefined table
			'error',
			0,
			'Error message'
		);

		// Verify default values for null/undefined parameters
		assert.equal(result2.database, 'unknown');
		assert.equal(result2.table, 'unknown');
	});

	it('should test UnsupportedFileExtensionError constructor and properties', function () {
		const error = new dataLoader.UnsupportedFileExtensionError('/path/to/file.txt', 'txt');
		assert.equal(error.name, 'UnsupportedFileExtensionError');
		assert.ok(error.message.includes('file.txt'));
		assert.ok(error.message.includes('txt'));
		assert.ok(error.message.includes('Only YAML and JSON files are supported'));
		assert.equal(error.statusCode, 400); // BAD_REQUEST
	});

	it('should test EmptyFileError constructor and properties', function () {
		const error = new dataLoader.EmptyFileError('/path/to/empty.json');
		assert.equal(error.name, 'EmptyFileError');
		assert.ok(error.message.includes('empty.json'));
		assert.ok(error.message.includes('empty or invalid'));
		assert.equal(error.statusCode, 400); // BAD_REQUEST
	});

	it('should handle error cases with empty records list', async function () {
		// Create a file with records that will cause different kinds of errors
		const emptyContentWithErrors = `{
  "table": "error_test",
  "records": []
}`;
		const emptyErrorFile = join(tempDir, 'empty-with-errors.json');
		await fsPromises.writeFile(emptyErrorFile, emptyContentWithErrors);

		// Create a mock function that gets called during record processing to test error handling branches
		const putWithError = sinon.spy(async () => {
			throw new Error('Test error during put');
		});

		// Create a mock table
		mockTables['default.error_test'] = {
			name: 'error_test',
			schema: undefined,
			attributes: [],
			records: [],
			get: async (id) => null,
			put: putWithError
		};

		const loader = dataLoader.start({ ensureTable: mockEnsureTable });
		const fileContent = await fsPromises.readFile(emptyErrorFile);

		// Since records array is empty, we'll just get a success result with 0 records
		const results = await loader.setupFile(fileContent, '/data/test', emptyErrorFile);

		// Verify results for empty records with error simulation
		assert.ok(results instanceof dataLoader.DataLoaderResult);
		assert.equal(results.status, 'success');
		assert.equal(results.count, 0);
		assert.ok(results.message.includes('No records to process'));

		// putWithError should not be called since there are no records
		assert.equal(putWithError.callCount, 0);
	});


	it('should handle files with empty records array', async function () {
		// Create a file with an empty records array
		const emptyRecordsContent = `{
  "table": "empty_records",
  "records": []
}`;
		const emptyRecordsFile = join(tempDir, 'empty-records.json');
		await fsPromises.writeFile(emptyRecordsFile, emptyRecordsContent);

		const loader = dataLoader.start({ ensureTable: mockEnsureTable });
		const fileContent = await fsPromises.readFile(emptyRecordsFile);

		const results = await loader.setupFile(fileContent, '/data/test', emptyRecordsFile);

		// Check results for empty records array
		assert.ok(results instanceof dataLoader.DataLoaderResult);
		assert.equal(results.status, 'success');
		assert.equal(results.count, 0); // No records processed
		assert.ok(results.message.includes('No records to process'));
	});

	it('should simulate an error during individual record processing', async function () {
		// Create a file with record to trigger error in put method
		const errorSimContent = `{
  "table": "simulated_error",
  "records": [
    { "id": 1, "name": "This will cause a put error" }
  ]
}`;
		const errorSimFile = join(tempDir, 'error-simulated.json');
		await fsPromises.writeFile(errorSimFile, errorSimContent);

		// Create a table with a put method that throws an error
		const errorTable = {
			name: 'simulated_error',
			schema: undefined,
			attributes: [],
			records: [],
			get: async (id) => null,
			put: sinon.stub().rejects(new Error('Simulated put error'))
		};

		// Create an ensureTable that returns our error table
		const errorEnsureTable = sinon.stub().resolves(errorTable);

		// Use the custom ensureTable
		const loader = dataLoader.start({ ensureTable: errorEnsureTable });
		const fileContent = await fsPromises.readFile(errorSimFile);

		// We now expect this to throw an error
		try {
			await loader.setupFile(fileContent, '/data/test', errorSimFile);
			// If we get here, the test should fail
			assert.fail('Expected an error to be thrown');
		} catch (error) {
			// Verify the error is the right type
			assert.ok(error instanceof dataLoader.RecordProcessingError);
			assert.ok(error.message.includes('Failed to process record in simulated_error'));
			assert.ok(error.message.includes('Simulated put error'));
		}

		// Verify our put method was called
		assert.equal(errorTable.put.callCount, 1);
	});

	it('should handle DataLoaderError rethrow branch', async function () {
		// Create a file to load
		const errorContent = `{
  "table": "error_rethrow_test",
  "records": [
    { "id": 1, "name": "Test" }
  ]
}`;
		const errorFile = join(tempDir, 'error-rethrow.json');
		await fsPromises.writeFile(errorFile, errorContent);

		// Create a DataLoaderError to throw
		const customError = new dataLoader.DataLoaderError('Custom DataLoaderError for testing');

		// Create a mock ensureTable that throws our custom DataLoaderError
		const errorThrowingEnsureTable = sinon.stub().rejects(customError);

		// Create a loader with our error-throwing ensureTable
		const loader = dataLoader.start({ ensureTable: errorThrowingEnsureTable });
		const fileContent = await fsPromises.readFile(errorFile);

		// Since we're throwing from ensureTable, it should be caught and rethrown
		try {
			await loader.setupFile(fileContent, '/data/test', errorFile);
			// If we get here, the test should fail
			assert.fail('Expected a DataLoaderError to be rethrown');
		} catch (error) {
			// Verify we caught the exact same error
			assert.strictEqual(error, customError);
			assert.equal(error.message, 'Custom DataLoaderError for testing');
		}
	});

	it('should handle mixed success/skipped records with message formatting', async function () {
		// Create a file with records that will have mixed results
		const mixedContent = `{
  "table": "mixed_results",
  "records": [
    { "id": 1, "name": "New record" },
    { "id": 2, "name": "New record 2" },
    { "id": 3, "name": "Will be skipped" }
  ]
}`;
		const mixedFile = join(tempDir, 'mixed-results.json');
		await fsPromises.writeFile(mixedFile, mixedContent);

		// Pre-populate a record that will be skipped due to timestamp
		const existingRecord = createTestRecord({ id: 3, name: "Existing record", _updatedTime: Date.now() + 10000 }); // Future timestamp
		
		mockTables['default.mixed_results'] = {
			name: 'mixed_results',
			schema: undefined,
			attributes: [],
			records: [existingRecord],
			get: async (id) => {
				// Return the existing record for id 3
				if (id === 3) {
					return existingRecord;
				}
				return null;
			},
			put: async (record) => {
				const processedRecord = createTestRecord(record);
				mockTables['default.mixed_results'].records.push(processedRecord);
				return { inserted: 1 };
			}
		};

		const loader = dataLoader.start({ ensureTable: mockEnsureTable });
		const fileContent = await fsPromises.readFile(mixedFile);

		const results = await loader.setupFile(fileContent, '/data/test', mixedFile);

		// Check results for mixed processing
		assert.ok(results instanceof dataLoader.DataLoaderResult);
		assert.equal(results.status, 'success');
		assert.equal(results.count, 2); // 2 records processed successfully
		assert.ok(results.message.includes('Loaded 2 new and updated 0 records'));
		assert.ok(results.message.includes('(1 records skipped)')); // Verify skipped message
	});
});