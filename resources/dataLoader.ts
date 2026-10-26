import { basename, extname } from 'node:path';
import { createHash } from 'node:crypto';
import { parseDocument } from 'yaml';
import { toBufferKey } from 'ordered-binary';
import { type Databases, databases, table, type Tables, tables } from './databases.ts';
import { isApplicationPrimaryWorker } from '../server/threads/manageThreads.ts';
import { HTTP_STATUS_CODES } from '../utility/errors/commonErrors.ts';
import { ClientError } from '../utility/errors/hdbError.ts';
import { DEFAULT_DATABASE_NAME } from '../utility/hdbTerms.ts';
import harperLogger from '../utility/logging/harper_logger.ts';
import { type Attribute } from './Table.ts';
import { type FileEntry } from '../components/EntryHandler.ts';

// Resolve the logger lazily so unit tests can stub `forComponent` between
// module load and first use (otherwise transitive importers — componentLoader
// pulled in via http.ts / threadServer.ts / operations.ts — capture the real
// logger before dataLoader.test.js installs its stub).
let _dataLoaderLogger: any;
function getDataLoaderLogger() {
	if (!_dataLoaderLogger) _dataLoaderLogger = harperLogger.forComponent('dataLoader');
	return _dataLoaderLogger;
}
const dataLoaderLogger = new Proxy(
	{},
	{
		get(_t, prop) {
			return getDataLoaderLogger()[prop];
		},
	}
) as any;

/** System table name for storing data loader hashes */
const DATA_LOADER_HASH_TABLE = 'hdb_dataloader_hash';

/** Lazy-initialized cache for the hash tracking table */
let _hashTrackingTable: ReturnType<typeof table>;

/**
 * Computes a deterministic hash of a record's content for tracking data file changes.
 * Object keys are sorted at every depth (arrays keep their order), so the same content
 * always produces the same hash regardless of key order.
 *
 * @param record - The record object to hash
 * @returns A hex string hash of the record content
 */
export function computeRecordHash(record: Record<string, any>): string {
	return createHash('sha256')
		.update(JSON.stringify(sortTopLevelKeys(record), sortObjectKeys))
		.digest('hex');
}

/** The hash earlier versions stored, which sorted only top-level keys */
function computeLegacyRecordHash(record: Record<string, any>): string {
	return createHash('sha256')
		.update(JSON.stringify(sortTopLevelKeys(record)))
		.digest('hex');
}

// A plain object, so a top-level `__proto__` is left out of the hash as it always has been: tables do not
// store that field under its own name
function sortTopLevelKeys(record: Record<string, any>): Record<string, any> {
	const sortedRecord: Record<string, any> = {};
	for (const key of Object.keys(record).sort()) sortedRecord[key] = record[key];
	return sortedRecord;
}

function sortObjectKeys(_key: string, value: any) {
	if (value === null || typeof value !== 'object' || Array.isArray(value)) return value;
	// null prototype, so a nested `__proto__` key stays an own property and in the hash
	const sorted = Object.create(null);
	for (const key of Object.keys(value).sort()) sorted[key] = value[key];
	return sorted;
}

/**
 * Gets or creates the hash tracking table in the system database.
 * Lazy-initializes the table on first access.
 */
function getHashTrackingTable(databasesRef: Databases): any {
	// Always check databasesRef first (important for testing with mocks)
	if (databasesRef.system && databasesRef.system[DATA_LOADER_HASH_TABLE]) {
		return databasesRef.system[DATA_LOADER_HASH_TABLE];
	}

	// Use cached table if available
	if (_hashTrackingTable) {
		return _hashTrackingTable;
	}

	// Create the system table for tracking hashes
	_hashTrackingTable = table({
		database: 'system',
		table: DATA_LOADER_HASH_TABLE,
		attributes: [
			{ name: 'id', type: 'string', isPrimaryKey: true }, // getHashKey(); earlier versions: "database:table:id"
			{ name: 'hash', type: 'string' },
		],
	});

	return _hashTrackingTable;
}

/**
 * The tracking key for a record: a digest of its database, table and primary key as the stores encode it, so
 * distinct records never share a key, and no key contains the `:` that every key earlier versions wrote does.
 */
function getHashKey(database: string | undefined, tableName: string, recordId: any): string {
	return createHash('sha256')
		.update(JSON.stringify([database || DEFAULT_DATABASE_NAME, tableName]))
		.update(toBufferKey(recordId))
		.digest('hex');
}

/**
 * Hashes stored by earlier versions, which keyed `table:id` (`database:table:id` when the file named a
 * database) by the record's `id` field whatever the primary key, so a custom-key record without one shared
 * `table:undefined` with its whole table. Their hashes cover the primary key, so a matching one belongs to
 * this record unless another table wrote the same key: refused when a name contains `:`, when a default-database
 * table is named like the key's prefix, and, for a named database, when the default database has a same-named
 * table that those versions would have written the file's records to instead.
 */
async function getLegacyHashes(
	trackingTable: any,
	database: string | undefined,
	tableName: string,
	existingRecordSubset: Record<string, any>,
	tablesRef: Tables
): Promise<string[]> {
	const isDefaultDatabase = !database || database === DEFAULT_DATABASE_NAME;
	if (tableName.includes(':') || (!isDefaultDatabase && (database.includes(':') || tablesRef?.[tableName]))) {
		return [];
	}
	// a default-database table named `data:table` or `database:table` wrote keys of the same form
	const prefixes = (
		isDefaultDatabase ? [tableName, `${DEFAULT_DATABASE_NAME}:${tableName}`] : [`${database}:${tableName}`]
	)
		.filter((prefix) => prefix === tableName || !tablesRef?.[prefix])
		.map((prefix) => prefix + ':');
	// The `id` an earlier version keyed by is the stored one, so it is among the compared fields: any other reading
	// of the same key has a different `id`. A record compared without one used the shared slot
	const id = 'id' in existingRecordSubset ? existingRecordSubset.id : undefined;
	const hashes: string[] = [];
	for (const prefix of prefixes) {
		let hashRecord;
		try {
			hashRecord = await trackingTable.get(prefix + id);
		} catch (error) {
			// an unreadable entry is no evidence (a key over the size limit was never writable either)
			dataLoaderLogger.debug?.(`Skipping unreadable earlier hash for ${tableName}: ${error.message}`);
			continue;
		}
		if (hashRecord) hashes.push(hashRecord.hash);
	}
	return hashes;
}

/**
 * Stores the hash for a record in the tracking table
 */
async function storeHash(trackingTable: any, hashKey: string, hash: string): Promise<void> {
	try {
		await trackingTable.put({ id: hashKey, hash });
	} catch (error) {
		dataLoaderLogger.error?.(`Failed to store hash: ${error.message}`);
	}
}

/**
 * Set up file handlers for data files and loads them into the appropriate tables
 */
export function handleApplication(scope) {
	// only the application's primary worker loads data: pool worker 0, or an isolated application's own worker
	if (!isApplicationPrimaryWorker(scope.applicationScope?.name)) {
		// debug and return
		dataLoaderLogger.debug?.('Skipping data loader initialization on non-primary worker');
		return;
	}

	// Handle all files that match the pattern in the config
	// Note: Using .then() instead of async/await to avoid the performance overhead
	// of additional promise wrappers created by the async/await syntax sugar
	scope.handleEntry(function handleDataLoaderEntry(entry) {
		// Return early if not adding or updating a file
		if (entry.entryType !== 'file' || entry.eventType === 'unlink') {
			return Promise.resolve();
		}

		return loadDataFile(entry, tables, databases).then((result) => {
			dataLoaderLogger.debug?.('Data loader processed file: %s: %s', basename(entry.absolutePath), result.message);
		});
	});
}

/**
 * This component handles data loading from YAML or JSON files into user-defined tables.
 * @param { contents, absolutePath, stats } - File entry content buffer, absolute path, and stats
 * @param tablesRef - Reference to tables object (local const for testing)
 * @param databasesRef - Reference to databases object (local const for testing)
 */

export async function loadDataFile({ contents, absolutePath }: FileEntry, tablesRef: Tables, databasesRef: Databases) {
	const fileExt = extname(absolutePath) || 'unknown';
	let data: DataFileFormat;

	// Need to grab the file extension to determine how to parse the content
	try {
		if (fileExt === '.yaml' || fileExt === '.yml') {
			data = parseDocument(contents.toString()).toJSON();
		} else if (fileExt === '.json') {
			data = JSON.parse(contents.toString());
		} else {
			throw new UnsupportedFileExtensionError(absolutePath, fileExt);
		}
	} catch (error) {
		// Re-throw DataLoaderErrors
		if (error instanceof DataLoaderError) {
			throw error;
		}

		// Otherwise wrap in a FileParseError and throw
		throw new FileParseError(absolutePath, error);
	}

	// Ensure data exists. I.E. the file is not empty
	if (!data) {
		throw new EmptyFileError(absolutePath);
	}

	const { database, table: tableName, records } = data;

	// Validate the data format
	if (!tableName) {
		throw new MissingRequiredPropertyError(absolutePath, 'table');
	}

	if (!records) {
		throw new MissingRequiredPropertyError(absolutePath, 'records');
	}

	if (!Array.isArray(records)) {
		throw new InvalidPropertyTypeError(absolutePath, 'records', 'array');
	}

	// tableIdentifier is used for logging and error messages
	const tableIdentifier = database ? `${database}.${tableName}` : tableName;

	// Don't allow loading data into the system database
	if (database?.toLowerCase() === 'system') {
		throw new SystemDatabaseError(database, tableName);
	}

	try {
		// Try to get the table from global tables if it exists
		let tableRef;

		// If a database is specified, check if the table exists in that database
		if (database && databasesRef[database]?.[tableName]) {
			dataLoaderLogger.debug?.(`Using existing table ${tableIdentifier} from database tables`);
			tableRef = databasesRef[database][tableName];
		}
		// If no database is specified, check if the table exists in the global tables
		else if (!database && tablesRef?.[tableName]) {
			dataLoaderLogger.debug?.(`Using existing table ${tableIdentifier} from global tables`);
			tableRef = tablesRef[tableName];
		} else {
			// Table doesn't exist. Try to infer the schema from the first record
			dataLoaderLogger.debug?.(`Table ${tableIdentifier} not found, creating new table`);

			// Extract attributes from the first record for the ensureTable call
			const attributes: Attribute[] = [];
			if (records.length > 0) {
				const firstRecord = records[0];
				Object.keys(firstRecord)
					.map((attrName) => {
						const attr: Attribute = { name: attrName, type: typeof firstRecord[attrName] };
						// If the attribute is 'id', mark it as primary key
						if (attrName === 'id') {
							attr.isPrimaryKey = true;
						}
						return attr;
					})
					.forEach((attr) => {
						attributes.push(attr);
					});
			}

			tableRef = await table({
				database,
				table: tableName,
				attributes,
			});
		}

		const primaryKey = tableRef.primaryKey ?? 'id';
		const trackingTable = getHashTrackingTable(databasesRef);

		// Process records with timestamp comparison
		// Count metrics
		const dataFIleRecords = records.length;
		let newRecords = 0;
		let updatedRecords = 0;
		let skippedRecords = 0;

		// Process each record in a batch to avoid excessive memory usage
		const batchSize = 100; // Process in batches of 100 records

		for (let i = 0; i < records.length; i += batchSize) {
			const batch = records.slice(i, i + batchSize);
			const batchPromises: Array<() => Promise<any>> = [];

			for (const newRecord of batch) {
				// Wrap in an async function to handle errors individually
				batchPromises.push(async () => {
					try {
						// Get existing record with the same ID if it exists
						let existingRecord: Record<string, any> | null = null;
						const recordId = newRecord[primaryKey];

						if (recordId !== undefined) {
							existingRecord = await tableRef.get(recordId);
						}

						const hashKey = recordId === undefined ? undefined : getHashKey(database, tableName, recordId);

						if (!existingRecord) {
							// If the record doesn't exist yet, insert it
							newRecords++;
							// before the put, which stamps @createdTime/@updatedTime fields into the record it is given
							const newRecordHash = computeRecordHash(newRecord);
							const result = await tableRef.put(newRecord);
							// A record without a primary key value can't be looked up again, so there is nothing to track
							if (hashKey) await storeHash(trackingTable, hashKey, newRecordHash);
							return result;
						}

						// Compute hash of only the fields that exist in the data file
						// This allows users to add extra fields without triggering a "modified" detection
						const existingRecordSubset: Record<string, any> = {};
						for (const key of Object.keys(newRecord)) {
							if (key in existingRecord) {
								existingRecordSubset[key] = existingRecord[key];
							}
						}
						const existingRecordHash = computeRecordHash(existingRecordSubset);

						const storedHash = (await trackingTable.get(hashKey))?.hash;
						let loadedByDataLoader: boolean;
						if (storedHash !== undefined) {
							loadedByDataLoader = storedHash === existingRecordHash;
						} else {
							const legacyHashes = await getLegacyHashes(
								trackingTable,
								database,
								tableName,
								existingRecordSubset,
								tablesRef
							);
							loadedByDataLoader =
								legacyHashes.length > 0 &&
								(legacyHashes.includes(existingRecordHash) ||
									legacyHashes.includes(computeLegacyRecordHash(existingRecordSubset)));
						}

						if (!loadedByDataLoader) {
							// No matching hash means this record wasn't loaded by the data loader
							// (created via operations API or other means), or its data file fields
							// were modified externally since. Don't overwrite user-created or user-modified records
							skippedRecords++;
							return Promise.resolve({ inserted: 0, updated: 0 });
						}

						const newRecordHash = computeRecordHash(newRecord);
						if (newRecordHash !== existingRecordHash) {
							// Hash differs - the data file content has changed
							// Use patch to update only the fields from the data file,
							// preserving any additional fields the user may have added
							updatedRecords++;
							await tableRef.patch(recordId, newRecord);
							await storeHash(trackingTable, hashKey, newRecordHash);
							// Return a result indicating update (patch doesn't return a value)
							return { updated: 1 };
						} else {
							// Hash matches - content hasn't changed, skip update
							skippedRecords++;
							if (storedHash === undefined) await storeHash(trackingTable, hashKey, newRecordHash);
							return Promise.resolve({ inserted: 0, updated: 0 });
						}
					} catch (error) {
						// For individual record errors, we log but continue processing other records
						// This allows partial success in data loading
						if (error instanceof DataLoaderError) {
							dataLoaderLogger.error?.(`Record processing error: ${error.message}`);
						} else {
							const recError = new RecordProcessingError(tableIdentifier, error);
							dataLoaderLogger.error?.(`Record processing error: ${recError.message}`);
						}

						// Don't throw, just return a failed operation result
						return Promise.resolve({ inserted: 0, updated: 0, error: error.message });
					}
				});
			}

			// Execute batch promises. Currently not doing anything about errors or the put() results.
			await Promise.all(batchPromises.map((fn) => fn()));
		}

		// Return a single result object
		if (newRecords > 0 || updatedRecords > 0) {
			let message = `Loaded ${newRecords} new and updated ${updatedRecords} records in ${tableIdentifier}`;
			if (skippedRecords > 0) {
				message += ` (${skippedRecords} records skipped)`;
			}
			dataLoaderLogger.info?.(message);

			return new DataLoaderResult(absolutePath, database, tableName, 'success', newRecords + updatedRecords, message);
		} else if (skippedRecords > 0) {
			const message = `All ${skippedRecords} records in ${tableIdentifier} already up-to-date`;
			dataLoaderLogger.info?.(message);

			return new DataLoaderResult(absolutePath, database, tableName, 'skipped', dataFIleRecords, message);
		} else {
			const message = `No records to process in ${tableIdentifier}`;
			dataLoaderLogger.info?.(message);

			return new DataLoaderResult(absolutePath, database, tableName, 'success', 0, message);
		}
	} catch (error) {
		// If it's already one of our custom errors, just rethrow
		if (error instanceof DataLoaderError) {
			throw error;
		}

		// Wrap and throw other errors
		throw new RecordProcessingError(tableIdentifier, error);
	}
}

/**
 * Custom errors for the dataLoader. These are thrown during startup validation to fail early
 * rather than continuing with invalid data.
 */

/**
 * Base class for DataLoader specific errors
 */
export class DataLoaderError extends ClientError {
	constructor(message: string, statusCode: number = HTTP_STATUS_CODES.BAD_REQUEST) {
		super(message, statusCode);
		this.name = 'DataLoaderError';
	}
}

/**
 * Error thrown when a file has an unsupported extension
 */
export class UnsupportedFileExtensionError extends DataLoaderError {
	constructor(filePath: string, extension: string) {
		super(
			`Unsupported file extension in ${basename(filePath)}: ${extension}. Only YAML and JSON files are supported.`,
			HTTP_STATUS_CODES.BAD_REQUEST
		);
		this.name = 'UnsupportedFileExtensionError';
	}
}

/**
 * Error thrown when a file cannot be parsed
 */
export class FileParseError extends DataLoaderError {
	constructor(filePath: string, originalError: Error) {
		super(`Failed to parse data file ${basename(filePath)}: ${originalError.message}`, HTTP_STATUS_CODES.BAD_REQUEST);
		this.name = 'FileParseError';
	}
}

/**
 * Error thrown when a file is empty or invalid
 */
export class EmptyFileError extends DataLoaderError {
	constructor(filePath: string) {
		super(`Data file ${basename(filePath)} is empty or invalid`, HTTP_STATUS_CODES.BAD_REQUEST);
		this.name = 'EmptyFileError';
	}
}

/**
 * Error thrown when a data file is missing required properties
 */
export class MissingRequiredPropertyError extends DataLoaderError {
	constructor(filePath: string, property: string) {
		super(`Data file ${basename(filePath)} is missing required "${property}" property`, HTTP_STATUS_CODES.BAD_REQUEST);
		this.name = 'MissingRequiredPropertyError';
	}
}

/**
 * Error thrown when a property has an invalid type
 */
export class InvalidPropertyTypeError extends DataLoaderError {
	constructor(filePath: string, property: string, expectedType: string) {
		super(
			`Data file ${basename(filePath)} has invalid "${property}" property, expected ${expectedType}`,
			HTTP_STATUS_CODES.BAD_REQUEST
		);
		this.name = 'InvalidPropertyTypeError';
	}
}

/**
 * Error thrown when trying to load data into the system database
 */
export class SystemDatabaseError extends DataLoaderError {
	constructor(database: string, table: string) {
		super(`Cannot load data into system database: ${database}.${table}`, HTTP_STATUS_CODES.FORBIDDEN);
		this.name = 'SystemDatabaseError';
	}
}

/**
 * Error thrown when record processing fails
 */
export class RecordProcessingError extends DataLoaderError {
	constructor(tableIdentifier: string, originalError: Error) {
		super(
			`Failed to process record in ${tableIdentifier}: ${originalError.message}`,
			HTTP_STATUS_CODES.INTERNAL_SERVER_ERROR
		);
		this.name = 'RecordProcessingError';
	}
}

// Define the structure of the data file format
export interface DataFileFormat {
	database?: string; // Optional database name
	table: string; // Required table name
	records: Record<string, any>[]; // Array of records to load
}

// Define the class for data loader results
export class DataLoaderResult {
	#filePath: string; // Path to the data file
	#database: string; // Database name
	#table: string; // Table name
	#status: string; // Status of the operation
	#count: number; // Number of records processed
	#message: string; // Message about the operation

	constructor(
		filePath: string,
		database: string | null | undefined,
		table: string | null,
		status: string,
		count: number,
		message: string
	) {
		this.#filePath = filePath;
		this.#database = database || 'unknown';
		this.#table = table || 'unknown';
		this.#status = status;
		this.#count = count;
		this.#message = message;
	}

	// Getters
	get filePath(): string {
		return this.#filePath;
	}
	get database(): string {
		return this.#database;
	}
	get table(): string {
		return this.#table;
	}
	get status(): string {
		return this.#status;
	}
	get count(): number {
		return this.#count;
	}
	get message(): string {
		return this.#message;
	}

	// Methods to convert to JSON (for serialization)
	toJSON() {
		return {
			filePath: this.#filePath,
			database: this.#database,
			table: this.#table,
			status: this.#status,
			count: this.#count,
			message: this.#message,
		};
	}
}
