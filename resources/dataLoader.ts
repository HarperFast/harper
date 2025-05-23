import { stat } from 'node:fs/promises';
import { basename } from 'node:path';
import { parseDocument } from 'yaml';
import { Databases, databases, Tables, tables } from './databases.ts';
import { HTTP_STATUS_CODES } from '../utility/errors/commonErrors.js';
import { ClientError } from '../utility/errors/hdbError.js';
import { loggerWithTag } from '../utility/logging/logger.js';
import { Attribute } from './Table.ts';

const dataLoaderLogger = loggerWithTag('dataLoader');

/**
 * This component handles data loading from YAML or JSON files into user-defined tables.
 */
export function start({ ensureTable, tablesOverride, databasesOverride }) {
	// Allow databasesOverride for testing purposes
	const databasesRef = databasesOverride || databases;
	// Allow tablesOverride for testing purposes
	const tablesRef = tablesOverride || tables;

	return {
		setupFile: (dataContent, _urlPath, filePath) => handleFile(dataContent, filePath, tablesRef, databasesRef),
	};

	/**
	 * This function will handle the data file content that has been read, and
	 * ensure that the records are loaded into the appropriate table.
	 * @param dataContent - The content of the data file as a Buffer
	 * @param filePath - The absolute file path
	 * @param resources - Resources object - *NOT USED*
	 * @param tablesRef - Reference to tables object (local const for testing)
	 * @param databasesRef - Reference to databases object (local const for testing)
	 */
	async function handleFile(dataContent: Buffer, filePath: string, tablesRef: Tables, databasesRef: Databases) {
		const fileExt = filePath.toLowerCase().split('.').pop() || 'unknown';
		let data: DataFileFormat;

		// Need to grab the file extension to determine how to parse the content
		try {
			if (fileExt === 'yaml' || fileExt === 'yml') {
				data = parseDocument(dataContent.toString()).toJSON();
			} else if (fileExt === 'json') {
				data = JSON.parse(dataContent.toString());
			} else {
				throw new UnsupportedFileExtensionError(filePath, fileExt);
			}

			// Get the last modified time from the file
			data.mtime = (await stat(filePath)).mtimeMs;
		} catch (error) {
			// Re-throw DataLoaderErrors
			if (error instanceof DataLoaderError) {
				throw error;
			}

			// Otherwise wrap in a FileParseError and throw
			throw new FileParseError(filePath, error);
		}

		// Ensure data exists. I.E. the file is not empty
		if (!data) {
			throw new EmptyFileError(filePath);
		}

		const { database, table: tableName, records } = data;

		// Validate the data format
		if (!tableName) {
			throw new MissingRequiredPropertyError(filePath, 'table');
		}

		if (!records) {
			throw new MissingRequiredPropertyError(filePath, 'records');
		}

		if (!Array.isArray(records)) {
			throw new InvalidPropertyTypeError(filePath, 'records', 'array');
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
				dataLoaderLogger.info(`Using existing table ${tableIdentifier} from database tables`);
				tableRef = databasesRef[database][tableName];
			}
			// If no database is specified, check if the table exists in the global tables
			else if (tablesRef && tablesRef[tableName]) {
				dataLoaderLogger.info(`Using existing table ${tableIdentifier} from global tables`);
				tableRef = tablesRef[tableName];
			} else {
				// Table doesn't exist. Try to infer the schema from the first record
				dataLoaderLogger.info(`Table ${tableIdentifier} not found, creating new table`);

				// Extract attributes from the first record for the ensureTable call
				const attributes: Attribute[] = [];
				if (records.length > 0) {
					const firstRecord = records[0];
					Object.keys(firstRecord).map(attrName => {
						const attr: Attribute = { name: attrName, type: typeof firstRecord[attrName] };
						// If the attribute is 'id', mark it as primary key
						if (attrName === 'id') {
							attr.isPrimaryKey = true;
						}
						return attr;
					}).forEach(attr => {
						attributes.push(attr);
					});
				}
				
				tableRef = await ensureTable({
					database,
					table: tableName,
					attributes
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

							if (!existingRecord) {
								// If the record doesn't exist yet, insert it
								newRecords++;
								return tableRef.put(newRecord);
							}

							// Check timestamps to see if we should update
							const existingTimestamp = existingRecord.getUpdatedTime();
							const updateRecord = data.mtime > existingTimestamp;

							if (updateRecord) {
								// New record is newer, update it
								updatedRecords++;
								return tableRef.put(newRecord);
							} else {
								// Existing record is newer or same age, skip
								skippedRecords++;
								return Promise.resolve({ inserted: 0, updated: 0 });
							}
						} catch (error) {
							// For individual record errors, we log but continue processing other records
							// This allows partial success in data loading
							if (error instanceof DataLoaderError) {
								dataLoaderLogger.error(`Record processing error: ${error.message}`);
							} else {
								const recError = new RecordProcessingError(tableIdentifier, error);
								dataLoaderLogger.error(`Record processing error: ${recError.message}`);
							}

							// Don't throw, just return a failed operation result
							return Promise.resolve({ inserted: 0, updated: 0, error: error.message });
						}
					});
				}
				
				// Execute batch promises. Currently not doing anything about errors or the put() results.
				await Promise.all(batchPromises.map(fn => fn()));
			}
			
			// Return a single result object
			if (newRecords > 0 || updatedRecords > 0) {
				let message = `Loaded ${newRecords} new and updated ${updatedRecords} records in ${tableIdentifier}`;
				if (skippedRecords > 0) {
					message += ` (${skippedRecords} records skipped)`;
				}
				dataLoaderLogger.info(message);
				
				return new DataLoaderResult(filePath, database, tableName, 'success', newRecords + updatedRecords, message);
			} else if (skippedRecords > 0) {
				const message = `All ${skippedRecords} records in ${tableIdentifier} already up-to-date`;
				dataLoaderLogger.info(message);
				
				return new DataLoaderResult(filePath, database, tableName, 'skipped', dataFIleRecords, message);
			} else {
				const message = `No records to process in ${tableIdentifier}`;
				dataLoaderLogger.info(message);
				
				return new DataLoaderResult(filePath, database, tableName, 'success', 0, message);
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
		super(`Unsupported file extension in ${basename(filePath)}: ${extension}. Only YAML and JSON files are supported.`, HTTP_STATUS_CODES.BAD_REQUEST);
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
		super(`Data file ${basename(filePath)} has invalid "${property}" property, expected ${expectedType}`, HTTP_STATUS_CODES.BAD_REQUEST);
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
		super(`Failed to process record in ${tableIdentifier}: ${originalError.message}`, HTTP_STATUS_CODES.INTERNAL_SERVER_ERROR);
		this.name = 'RecordProcessingError';
	}
}

// Define the structure of the data file format
export interface DataFileFormat {
	database?: string;               // Optional database name
	table: string;                   // Required table name
	records: Record<string, any>[];  // Array of records to load
	mtime: number;                   // Last modified time
}

// Define the class for data loader results
export class DataLoaderResult {
	#filePath: string;  // Path to the data file
	#database: string;  // Database name
	#table: string;     // Table name
	#status: string;    // Status of the operation
	#count: number;     // Number of records processed
	#message: string;   // Message about the operation

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
	get filePath(): string { return this.#filePath; }
	get database(): string { return this.#database; }
	get table(): string { return this.#table; }
	get status(): string { return this.#status; }
	get count(): number { return this.#count; }
	get message(): string { return this.#message; }
	
	// Methods to convert to JSON (for serialization)
	toJSON() {
		return {
			filePath: this.#filePath,
			database: this.#database,
			table: this.#table,
			status: this.#status,
			count: this.#count,
			message: this.#message
		};
	}
}

// we can define these on the main thread
export const startOnMainThread = start;