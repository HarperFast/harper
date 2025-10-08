import { basename, extname } from 'node:path';
import { createHash } from 'node:crypto';
import { parseDocument } from 'yaml';
import { Databases, databases, table, Tables, tables } from './databases.ts';
import { getWorkerIndex } from '../server/threads/manageThreads';
import { HTTP_STATUS_CODES } from '../utility/errors/commonErrors.js';
import { ClientError } from '../utility/errors/hdbError.js';
import harperLogger from '../utility/logging/harper_logger.js';
import { Attribute } from './Table.ts';
import { FileEntry } from '../components/EntryHandler.ts';

const dataLoaderLogger = harperLogger.forComponent('dataLoader');

/** System table name for storing data loader hashes */
const DATA_LOADER_HASH_TABLE = 'hdb_dataloader_hash';

/** Lazy-initialized cache for the hash tracking table */
let _hashTrackingTable: ReturnType<typeof table>;

/**
 * Computes a deterministic hash of a record's content for tracking data file changes.
 * The hash is computed from a stable JSON representation (sorted keys) to ensure
 * the same content always produces the same hash, regardless of key order.
 *
 * @param record - The record object to hash
 * @returns A hex string hash of the record content
 */
export function computeRecordHash(record: Record<string, any>): string {
	// Sort keys for deterministic hashing
	const sortedKeys = Object.keys(record).sort();
	const sortedRecord: Record<string, any> = {};
	for (const key of sortedKeys) {
		sortedRecord[key] = record[key];
	}

	// Compute hash of the stable JSON representation
	const content = JSON.stringify(sortedRecord);
	return createHash('sha256').update(content).digest('hex');
}

/**
 * Gets or creates the hash tracking table in the system database.
 * Lazy-initializes the table on first access.
 */
function getHashTrackingTable(databasesRef: Databases) {
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
			{ name: 'id', type: 'string', isPrimaryKey: true }, // Format: "database:table:recordId"
			{ name: 'hash', type: 'string' },
		],
	});

	return _hashTrackingTable;
}

/**
 * Gets the stored hash for a record from the tracking table
 */
async function getStoredHash(
	database: string | undefined,
	tableName: string,
	recordId: string,
	databasesRef: Databases
): Promise<string | null> {
	try {
		const trackingTable = getHashTrackingTable(databasesRef);
		const hashId = database ? `${database}:${tableName}:${recordId}` : `${tableName}:${recordId}`;
		const hashRecord = await trackingTable.get(hashId);
		return hashRecord?.hash || null;
	} catch (error) {
		dataLoaderLogger.error?.(`Failed to get stored hash: ${error.message}`);
		return null;
	}
}

/**
 * Stores the hash for a record in the tracking table
 */
async function storeHash(
	database: string | undefined,
	tableName: string,
	recordId: string,
	hash: string,
	databasesRef: Databases
): Promise<void> {
	try {
		const trackingTable = getHashTrackingTable(databasesRef);
		const hashId = database ? `${database}:${tableName}:${recordId}` : `${tableName}:${recordId}`;
		await trackingTable.put({ id: hashId, hash });
	} catch (error) {
		dataLoaderLogger.error?.(`Failed to store hash: ${error.message}`);
	}
}

/**
 * Set up file handlers for data files and loads them into the appropriate tables
 */
export const suppressHandleApplicationWarning = true;
export function handleApplication(scope) {
	// Early return if this isn't worker zero
	// Currently using getWorkerIndex() over server.workerIndex to appease ts. The latter defined in manageThreads.js.
	if (getWorkerIndex() !== 0) {
		// debug and return
		dataLoaderLogger.debug?.('Skipping data loader initialization on non-primary worker');
		return;
	}

	// Handle all files that match the pattern in the config
	scope.handleEntry((entry) => {
		// Return early if not adding or updating a file
		if (entry.entryType !== 'file' || entry.eventType === 'unlink') {
			return;
		}

		loadDataFile(entry, tables, databases).then((result) => {
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

export async function loadDataFile(
	{ contents, absolutePath, stats }: FileEntry,
	tablesRef: Tables,
	databasesRef: Databases
) {
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
		if (database && databasesRef[database] && databasesRef[database][tableName]) {
			dataLoaderLogger.debug?.(`Using existing table ${tableIdentifier} from database tables`);
			tableRef = databasesRef[database][tableName];
		}
		// If no database is specified, check if the table exists in the global tables
		else if (tablesRef && tablesRef[tableName]) {
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
						const recordId = newRecord.id;

						if (recordId !== undefined) {
							existingRecord = await tableRef.get(recordId);
						}

						// Compute hash of the new record from the data file
						const newRecordHash = computeRecordHash(newRecord);

						if (!existingRecord) {
							// If the record doesn't exist yet, insert it
							newRecords++;
							const result = await tableRef.put(newRecord);
							// Store the hash in the tracking table
							await storeHash(database, tableName, recordId, newRecordHash, databasesRef);
							return result;
						}

						// Check if there's a stored hash for this record
						const existingHash = await getStoredHash(database, tableName, recordId, databasesRef);

						if (!existingHash) {
							// No hash means this record wasn't loaded by the data loader
							// (likely created via operations API or other means)
							// Don't overwrite user-created records
							skippedRecords++;
							return Promise.resolve({ inserted: 0, updated: 0 });
						}

						// Compute hash of only the fields that exist in the data file
						// This allows users to add extra fields without triggering a "modified" detection
						// Note: This is a simple top-level field comparison - nested object changes
						// within data file fields will still be detected as modifications
						const existingRecordSubset: Record<string, any> = {};
						for (const key of Object.keys(newRecord)) {
							if (key in existingRecord) {
								existingRecordSubset[key] = existingRecord[key];
							}
						}
						const existingRecordHash = computeRecordHash(existingRecordSubset);

						if (existingRecordHash !== existingHash) {
							// The existing record's data file fields don't match the stored hash,
							// meaning those fields were modified externally (via operations API, etc.)
							// Don't overwrite user-modified records
							skippedRecords++;
							return Promise.resolve({ inserted: 0, updated: 0 });
						}

						// Compare hashes to detect actual content changes in the data file
						if (newRecordHash !== existingHash) {
							// Hash differs - the data file content has changed
							// Use patch to update only the fields from the data file,
							// preserving any additional fields the user may have added
							updatedRecords++;
							await tableRef.patch(recordId, newRecord);
							await storeHash(database, tableName, recordId, newRecordHash, databasesRef);
							// Return a result indicating update (patch doesn't return a value)
							return { updated: 1 };
						} else {
							// Hash matches - content hasn't changed, skip update
							skippedRecords++;
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
