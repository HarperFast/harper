'use strict';

const insert = require('./insert.js');
const validator = require('../validation/fileLoadValidator.js');
const needle = require('needle');
const hdbTerms = require('../utility/hdbTerms.ts');
const hdbUtils = require('../utility/common_utils.js');
const { handleHDBError, hdbErrors } = require('../utility/errors/hdbError.js');
const { HTTP_STATUS_CODES, HDB_ERROR_MSGS, CHECK_LOGS_WRAPPER } = hdbErrors;
const logger = require('../utility/logging/harper_logger.js');
const papaParse = require('papaparse');
hdbUtils.promisifyPapaParse();
const fs = require('fs-extra');
const path = require('path');
const { chain } = require('stream-chain');
const StreamArray = require('stream-json/streamers/StreamArray');
const Batch = require('stream-json/utils/Batch');
const comp = require('stream-chain/utils/comp');
const { finished } = require('stream');
const env = require('../utility/environment/environmentManager.js');
const opFuncCaller = require('../utility/OperationFunctionCaller.js');
const AWSConnector = require('../utility/AWS/AWSConnector.js');
const { BulkLoadFileObject, BulkLoadDataObject } = require('./dataObjects/BulkLoadObjects.js');
const PermissionResponseObject = require('../security/data_objects/PermissionResponseObject.js');
const { verifyBulkLoadAttributePerms } = require('../utility/operation_authorization.js');
const { databases } = require('../resources/databases.ts');
const { coerceType } = require('../resources/Table.ts');

const CSV_NO_RECORDS_MSG = 'No records parsed from csv file.';
const TEMP_DOWNLOAD_DIR = `${env.get('HDB_ROOT')}/tmp`;
const { schemaRegex } = require('../validation/common_validators.js');
const HIGHWATERMARK = 1024 * 1024 * 2;
const MAX_JSON_ARRAY_SIZE = 5000;

const ACCEPTABLE_URL_CONTENT_TYPE_ENUM = {
	'text/csv': true,
	'application/octet-stream': true,
	'text/plain': true,
	'application/vnd.ms-excel': true,
};

module.exports = {
	csvDataLoad,
	csvURLLoad,
	csvFileLoad,
	importFromS3,
};

/**
 * Load csv values specified as a string in the message 'data' field.
 * @param jsonMessage
 * @returns {Promise<string>}
 */
async function csvDataLoad(jsonMessage) {
	let validationMsg = validator.dataObject(jsonMessage);
	if (validationMsg) {
		throw handleHDBError(
			validationMsg,
			validationMsg.message,
			HTTP_STATUS_CODES.BAD_REQUEST,
			undefined,
			undefined,
			true
		);
	}

	let bulkLoadResult = {};
	try {
		const mapOfTransforms = createTransformMap(jsonMessage.schema, jsonMessage.table);
		let parseResults = papaParse.parse(jsonMessage.data, {
			header: true,
			skipEmptyLines: true,
			transform: typeFunction.bind(null, mapOfTransforms),
			dynamicTyping: false,
		});

		const attrsPermsErrors = new PermissionResponseObject();

		if (
			jsonMessage.hdb_user &&
			jsonMessage.hdb_user?.role &&
			jsonMessage.hdb_user?.role?.permission &&
			jsonMessage.hdb_user?.role?.permission?.super_user !== true
		) {
			verifyBulkLoadAttributePerms(
				jsonMessage.hdb_user?.role?.permission,
				this.job_operation_function.name,
				jsonMessage.action,
				jsonMessage.schema,
				jsonMessage.table,
				parseResults.meta.fields,
				attrsPermsErrors
			);
		}

		const attrPermsErrors = attrsPermsErrors.getPermsResponse();
		if (attrPermsErrors) {
			throw handleHDBError(new Error(), attrPermsErrors, HTTP_STATUS_CODES.BAD_REQUEST, undefined, undefined, true);
		}

		let convertedMsg = new BulkLoadDataObject(
			jsonMessage.action,
			jsonMessage.schema,
			jsonMessage.table,
			parseResults.data
		);

		bulkLoadResult = await opFuncCaller.callOperationFunctionAsAwait(callBulkFileLoad, convertedMsg, null);

		if (bulkLoadResult.message === CSV_NO_RECORDS_MSG) {
			return CSV_NO_RECORDS_MSG;
		}

		return buildResponseMsg(bulkLoadResult.records, bulkLoadResult.number_written);
	} catch (err) {
		throw buildTopLevelErrMsg(err);
	}
}

/**
 * Orchestrates a CSV data load via a file URL. First downloads the file to a temporary folder/file, then calls fileLoad on the
 * downloaded file. Finally deletes temporary file.
 * @param jsonMessage
 * @returns {Promise<string>}
 */
async function csvURLLoad(jsonMessage) {
	let validationMsg = validator.urlObject(jsonMessage);
	if (validationMsg) {
		throw handleHDBError(
			validationMsg,
			validationMsg.message,
			HTTP_STATUS_CODES.BAD_REQUEST,
			undefined,
			undefined,
			true
		);
	}

	let csvFileName = `${Date.now()}.csv`;
	const tempFilePath = `${TEMP_DOWNLOAD_DIR}/${csvFileName}`;

	try {
		await downloadCSVFile(jsonMessage, csvFileName);
	} catch (err) {
		logger.error(HDB_ERROR_MSGS.DOWNLOAD_FILE_ERR(csvFileName) + ' - ' + err);
		throw handleHDBError(err, CHECK_LOGS_WRAPPER(HDB_ERROR_MSGS.DOWNLOAD_FILE_ERR(csvFileName)));
	}

	try {
		let csvFileLoadObj = new BulkLoadFileObject(
			this.job_operation_function.name,
			jsonMessage.action,
			jsonMessage.schema,
			jsonMessage.table,
			tempFilePath,
			hdbTerms.VALID_S3_FILE_TYPES.CSV,
			jsonMessage.hdb_user?.role?.permission
		);

		let bulkLoadResult = await fileLoad(csvFileLoadObj);

		// Remove the downloaded temporary CSV file and directory once fileLoad complete
		await deleteTempFile(tempFilePath);

		return bulkLoadResult;
	} catch (err) {
		await deleteTempFile(tempFilePath);
		throw buildTopLevelErrMsg(err);
	}
}

/**
 * This is the top-level API method to handle the local csv file load operation.
 *
 * @param jsonMessage
 * @returns {Promise<string>}
 */
async function csvFileLoad(jsonMessage) {
	let validationMsg = validator.fileObject(jsonMessage);
	if (validationMsg) {
		throw handleHDBError(
			validationMsg,
			validationMsg.message,
			HTTP_STATUS_CODES.BAD_REQUEST,
			undefined,
			undefined,
			true
		);
	}

	let csvFileLoadObj = new BulkLoadFileObject(
		this.job_operation_function.name,
		jsonMessage.action,
		jsonMessage.schema,
		jsonMessage.table,
		jsonMessage.file_path,
		hdbTerms.VALID_S3_FILE_TYPES.CSV,
		jsonMessage.hdb_user?.role?.permission
	);

	try {
		return await fileLoad(csvFileLoadObj);
	} catch (err) {
		throw buildTopLevelErrMsg(err);
	}
}

/**
 * This is the top-level API method that handles CSV and JSON file imports from private S3 buckets.  First downloads
 * the file to a temporary folder/file, then calls fileLoad on the downloaded file. Finally deletes temporary file.
 *
 * @param jsonMessage
 * @returns {Promise<string>}
 */
async function importFromS3(jsonMessage) {
	let validationMsg = validator.s3FileObject(jsonMessage);
	if (validationMsg) {
		throw handleHDBError(
			validationMsg,
			validationMsg.message,
			HTTP_STATUS_CODES.BAD_REQUEST,
			undefined,
			undefined,
			true
		);
	}

	let tempFilePath;
	try {
		let s3FileType = path.extname(jsonMessage.s3.key);
		let s3FileName = `${Date.now()}${s3FileType}`;
		tempFilePath = `${TEMP_DOWNLOAD_DIR}/${s3FileName}`;

		let s3FileLoadObj = new BulkLoadFileObject(
			this.job_operation_function.name,
			jsonMessage.action,
			jsonMessage.schema,
			jsonMessage.table,
			tempFilePath,
			s3FileType,
			jsonMessage.hdb_user?.role?.permission
		);

		await downloadFileFromS3(s3FileName, jsonMessage);

		let bulkLoadResult = await fileLoad(s3FileLoadObj);

		// Remove the downloaded temporary file once fileLoad complete
		await deleteTempFile(tempFilePath);

		return bulkLoadResult;
	} catch (err) {
		await deleteTempFile(tempFilePath);
		throw buildTopLevelErrMsg(err);
	}
}

/**
 * Gets a file via URL, then creates a temporary directory in hdb root and writes file to disk.
 * @param req
 * @param csvFileName
 * @returns {Promise<void>}
 */
async function downloadCSVFile(req, csvFileName) {
	let response;
	try {
		const options = req.passthrough_headers ? { headers: req.passthrough_headers } : undefined;
		response = await needle('get', req.csv_url, options);
	} catch (err) {
		const errMsg = `Error downloading CSV file from ${req.csv_url}, status code: ${err.statusCode}. Check the log for more information.`;
		throw handleHDBError(err, errMsg, err.statusCode, hdbTerms.LOG_LEVELS.ERROR, 'Error downloading CSV file - ' + err);
	}

	validateURLResponse(response, req.csv_url);

	await writeFileToTempFolder(csvFileName, response.raw);
}

/**
 * Used to create the read stream from the S3 bucket to pipe into a local write stream.
 * @param s3FileName - file name used to save the downloaded file locally in the tmp file
 * @param jsonMessage
 * @returns {Promise<void>}
 */
async function downloadFileFromS3(s3FileName, jsonMessage) {
	try {
		const tempDownloadLocation = `${TEMP_DOWNLOAD_DIR}/${s3FileName}`;
		await fs.mkdirp(TEMP_DOWNLOAD_DIR);
		await fs.writeFile(`${TEMP_DOWNLOAD_DIR}/${s3FileName}`, '', { flag: 'a+' });
		let tempFileStream = await fs.createWriteStream(tempDownloadLocation);
		let s3Stream = await AWSConnector.getFileStreamFromS3(jsonMessage);

		await new Promise((resolve, reject) => {
			s3Stream.on('error', function (err) {
				reject(err);
			});

			s3Stream
				.pipe(tempFileStream)
				.on('error', function (err) {
					reject(err);
				})
				.on('close', function () {
					logger.info(`${jsonMessage.s3.key} successfully downloaded to ${tempDownloadLocation}`);
					resolve();
				});
		});
	} catch (err) {
		logger.error(HDB_ERROR_MSGS.S3_DOWNLOAD_ERR + ' - ' + err);
		throw handleHDBError(err, CHECK_LOGS_WRAPPER(HDB_ERROR_MSGS.S3_DOWNLOAD_ERR));
	}
}

/**
 * Used to write the CSV data in the body.data from an http request to the local tmp file for processing
 *
 * @param fileName - file name used to save the downloaded file locally in the tmp file
 * @param responseBody - body.data value in response from http request
 * @returns {Promise<void>}
 */
async function writeFileToTempFolder(fileName, responseBody) {
	try {
		await fs.mkdirp(TEMP_DOWNLOAD_DIR);
		await fs.writeFile(`${TEMP_DOWNLOAD_DIR}/${fileName}`, responseBody);
	} catch (err) {
		logger.error(HDB_ERROR_MSGS.WRITE_TEMP_FILE_ERR);
		throw handleHDBError(err, CHECK_LOGS_WRAPPER(HDB_ERROR_MSGS.DEFAULT_BULK_LOAD_ERR));
	}
}

/**
 * Deletes temp file downloaded to the tmp dir
 *
 * @param filePath
 * @returns {Promise<void>}
 */
async function deleteTempFile(filePath) {
	if (filePath) {
		try {
			await fs.access(filePath);
			await fs.unlink(filePath);
		} catch {
			logger.warn(`could not delete temp csv file at ${filePath}, file does not exist`);
		}
	}
}

/**
 * Runs multiple validations on response from HTTP client.
 * @param response
 * @param url
 */
function validateURLResponse(response, url) {
	if (response.statusCode !== hdbErrors.HTTP_STATUS_CODES.OK) {
		throw handleHDBError(
			new Error(),
			`CSV Load failed from URL: ${url}, status code: ${response.statusCode}, message: ${response.statusMessage}`,
			HTTP_STATUS_CODES.BAD_REQUEST
		);
	}

	if (!ACCEPTABLE_URL_CONTENT_TYPE_ENUM[response.headers['content-type']]) {
		throw handleHDBError(
			new Error(),
			`CSV Load failed from URL: ${url}, unsupported content type: ${response.headers['content-type']}`,
			HTTP_STATUS_CODES.BAD_REQUEST
		);
	}

	if (!response.raw) {
		throw handleHDBError(
			new Error(),
			`CSV Load failed from URL: ${url}, no csv found at url`,
			HTTP_STATUS_CODES.BAD_REQUEST
		);
	}
}

/**
 * Parse and load CSV or JSON values.
 *
 * @param jsonMessage - An object representing the CSV file.
 * @returns validationMsg - Contains any validation errors found
 * @returns error - any errors found reading the csv file
 * @return err - any errors found during the bulk load
 *
 */
async function fileLoad(jsonMessage) {
	try {
		let bulkLoadResult;

		switch (jsonMessage.file_type) {
			case hdbTerms.VALID_S3_FILE_TYPES.CSV:
				bulkLoadResult = await callPapaParse(jsonMessage);
				break;
			case hdbTerms.VALID_S3_FILE_TYPES.JSON:
				bulkLoadResult = await insertJson(jsonMessage);
				break;
			default:
				//we should never get here but here just incase something changes is validation and slips through
				throw handleHDBError(
					new Error(),
					HDB_ERROR_MSGS.DEFAULT_BULK_LOAD_ERR,
					HTTP_STATUS_CODES.BAD_REQUEST,
					hdbTerms.LOG_LEVELS.ERROR,
					HDB_ERROR_MSGS.INVALID_FILE_EXT_ERR(jsonMessage)
				);
		}

		return buildResponseMsg(bulkLoadResult.records, bulkLoadResult.number_written);
	} catch (err) {
		throw buildTopLevelErrMsg(err);
	}
}

/**
 * Passed to papaparse to validate chunks of csv data from a read stream.
 *
 * @param jsonMessage - An object representing the CSV file.
 * @param reject - A promise object bound to function through hdbUtils.promisifyPapaParse()
 * @param results - An object returned by papaparse containing parsed csv data, errors and meta.
 * @param parser - An  object returned by papaparse contains abort, pause and resume.
 * @returns if validation error found returns Promise<error>, if no error nothing is returned.
 */
async function validateChunk(jsonMessage, permsValidationResp, reject, results, parser) {
	const resultsData = results.data ? results.data : results;
	if (resultsData.length === 0) {
		return;
	}

	// parser pause and resume prevent the parser from getting ahead of validation.
	if (parser) {
		parser.pause();
	}
	let writeObject = {
		operation: jsonMessage.action,
		schema: jsonMessage.schema,
		table: jsonMessage.table,
		records: resultsData,
	};

	try {
		const { attributes } = await insert.validation(writeObject);
		if (jsonMessage.role_perms && jsonMessage.role_perms.super_user !== true) {
			verifyBulkLoadAttributePerms(
				jsonMessage.role_perms,
				jsonMessage.op,
				jsonMessage.action,
				jsonMessage.schema,
				jsonMessage.table,
				attributes,
				permsValidationResp
			);
		}

		if (parser) {
			parser.resume();
		}
	} catch (err) {
		// reject is a promise object bound to chunk function through hdbUtils.promisifyPapaParse(). In the case of an error
		// reject will bubble up to hdbUtils.promisifyPapaParse() and return a reject promise object with given error.
		const errResp = handleHDBError(err);
		reject(errResp);
	}
}

/**
 * Passed to papaparse to insert, update, or upsert chunks of csv data from a read stream.
 *
 * @param jsonMessage - An object representing the CSV file.
 * @param insertResults - An object passed by reference used to accumulate results from insert, update, or upsert function.
 * @param reject - A promise object bound to function through hdbUtils.promisifyPapaParse().
 * @param results - An object returned by papaparse containing parsed csv data, errors and meta.
 * @param parser - An  object returned by papaparse contains abort, pause and resume.
 * @returns if validation error found returns Promise<error>, if no error nothing is returned.
 */
async function insertChunk(jsonMessage, insertResults, reject, results, parser) {
	const resultsData = results.data ? results.data : results;
	if (resultsData.length === 0) {
		return;
	}
	hdbUtils.autoCastJSONDeep(resultsData);
	// parser pause and resume prevent the parser from getting ahead of insert.
	if (parser) {
		parser.pause();
	}

	let fields = results.meta ? results.meta.fields : null;

	if (fields) {
		resultsData.forEach((record) => {
			if (!hdbUtils.isEmpty(record) && !hdbUtils.isEmpty(record['__parsed_extra'])) {
				delete record['__parsed_extra'];
			}
		});
	} else {
		const fieldsSet = new Set();
		resultsData.forEach((record) => {
			Object.keys(record).forEach((key) => fieldsSet.add(key));
		});
		fields = [...fieldsSet];
	}

	try {
		let convertedMsg = {
			schema: jsonMessage.schema,
			table: jsonMessage.table,
			action: jsonMessage.action,
			data: resultsData,
		};
		let bulkLoadChunkResult = await opFuncCaller.callOperationFunctionAsAwait(callBulkFileLoad, convertedMsg, null);
		insertResults.records += bulkLoadChunkResult.records;
		insertResults.number_written += bulkLoadChunkResult.number_written;
		if (parser) {
			parser.resume();
		}
	} catch (err) {
		// reject is a promise object bound to chunk function through hdbUtils.promisifyPapaParse(). In the case of an error
		// reject will bubble up to hdbUtils.promisifyPapaParse() and return a reject promise object with given error.
		const errResp = handleHDBError(
			err,
			CHECK_LOGS_WRAPPER(HDB_ERROR_MSGS.INSERT_CSV_ERR),
			HTTP_STATUS_CODES.INTERNAL_SERVER_ERROR,
			hdbTerms.LOG_LEVELS.ERROR,
			HDB_ERROR_MSGS.INSERT_CSV_ERR + ' - ' + err
		);
		reject(errResp);
	}
}

/**
 * Handles two asynchronous calls to csv parser papaparse.
 * First call validates the full read stream from csv file by calling papaparse with validateChunk function. The entire
 * stream is consumed by validate because all rows must be validated before calling insert.
 * Second call inserts a new csv file read stream by calling papaparse with insertChunk function.
 *
 * @param jsonMessage - An object representing the CSV file.
 * @returns {Promise<{records: number, number_written: number}>}
 */
async function callPapaParse(jsonMessage) {
	// passing insertResults object by reference to insertChunk function where it accumulate values from bulk load results.
	let insertResults = {
		records: 0,
		number_written: 0,
	};
	const mapOfTransforms = createTransformMap(jsonMessage.schema, jsonMessage.table);
	try {
		const attrsPermsErrors = new PermissionResponseObject();
		let stream = fs.createReadStream(jsonMessage.file_path, { highWaterMark: HIGHWATERMARK });
		stream.setEncoding('utf8');

		await papaParse.parsePromise(
			stream,
			validateChunk.bind(null, jsonMessage, attrsPermsErrors),
			typeFunction.bind(null, mapOfTransforms)
		);

		const attrPermsErrors = attrsPermsErrors.getPermsResponse();
		if (attrPermsErrors) {
			throw handleHDBError(new Error(), attrPermsErrors, HTTP_STATUS_CODES.BAD_REQUEST);
		}

		stream = fs.createReadStream(jsonMessage.file_path, { highWaterMark: HIGHWATERMARK });
		stream.setEncoding('utf8');

		await papaParse.parsePromise(
			stream,
			insertChunk.bind(null, jsonMessage, insertResults),
			typeFunction.bind(null, mapOfTransforms)
		);
		stream.destroy();

		return insertResults;
	} catch (err) {
		throw handleHDBError(
			err,
			CHECK_LOGS_WRAPPER(HDB_ERROR_MSGS.PAPA_PARSE_ERR),
			HTTP_STATUS_CODES.INTERNAL_SERVER_ERROR,
			hdbTerms.LOG_LEVELS.ERROR,
			HDB_ERROR_MSGS.PAPA_PARSE_ERR + err
		);
	}
}

function createTransformMap(schema, table) {
	const attributes = databases[schema][table].attributes;
	let mapOfTransforms = new Map(); // I don't know if this should be a Map, but this just makes a map of attributes with type coercions that we want
	for (let attribute of attributes) {
		if (attribute.type && !attribute.computed && !attribute.relationship)
			mapOfTransforms.set(attribute.name, (value) => coerceType(value, attribute)); // here is
		// the transform to use
	}
	return mapOfTransforms;
}

function typeFunction(mapOfTransforms, value, header) {
	let transform = mapOfTransforms.get(header);
	if (transform) return transform(value);
	return hdbUtils.autoCast(value);
}

async function insertJson(jsonMessage) {
	// passing insertResults object by reference to insertChunk function where it accumulate values from bulk load results.
	let insertResults = {
		records: 0,
		number_written: 0,
	};

	const throwErr = (e) => {
		throw e;
	};

	try {
		const attrsPermsErrors = new PermissionResponseObject();
		let jsonStreamer = chain([
			fs.createReadStream(jsonMessage.file_path, { encoding: 'utf-8' }),
			StreamArray.withParser(),
			(data) => data.value,
			new Batch({ batchSize: MAX_JSON_ARRAY_SIZE }),
			comp(async (chunk) => {
				await validateChunk(jsonMessage, attrsPermsErrors, throwErr, chunk);
			}),
		]);

		await new Promise((resolve, reject) => {
			finished(jsonStreamer, (err) => {
				if (err) {
					reject(err);
				} else {
					resolve();
				}
			});
			jsonStreamer.resume();
		});

		const attrPermsErrors = attrsPermsErrors.getPermsResponse();
		if (attrPermsErrors) {
			throw handleHDBError(new Error(), attrPermsErrors, HTTP_STATUS_CODES.BAD_REQUEST);
		}

		let jsonStreamerInsert = chain([
			fs.createReadStream(jsonMessage.file_path, { encoding: 'utf-8' }),
			StreamArray.withParser(),
			(data) => data.value,
			new Batch({ batchSize: MAX_JSON_ARRAY_SIZE }),
			comp(async (chunk) => {
				await insertChunk(jsonMessage, insertResults, throwErr, chunk);
			}),
		]);

		await new Promise((resolve, reject) => {
			finished(jsonStreamerInsert, (err) => {
				if (err) {
					reject(err);
				} else {
					resolve();
				}
			});
			jsonStreamerInsert.resume();
		});

		return insertResults;
	} catch (err) {
		throw handleHDBError(
			err,
			CHECK_LOGS_WRAPPER(HDB_ERROR_MSGS.INSERT_JSON_ERR),
			HTTP_STATUS_CODES.INTERNAL_SERVER_ERROR,
			hdbTerms.LOG_LEVELS.ERROR,
			HDB_ERROR_MSGS.INSERT_JSON_ERR + err
		);
	}
}

async function callBulkFileLoad(jsonMsg) {
	let bulkLoadResult = {};
	try {
		if (jsonMsg.data && jsonMsg.data.length > 0 && validateColumnNames(jsonMsg.data[0])) {
			bulkLoadResult = await bulkFileLoad(jsonMsg.data, jsonMsg.schema, jsonMsg.table, jsonMsg.action);
		} else {
			bulkLoadResult.message = 'No records parsed from csv file.';
			logger.info(bulkLoadResult.message);
		}
	} catch (err) {
		throw buildTopLevelErrMsg(err);
	}
	return bulkLoadResult;
}

/**
 * Validate all attribute names about to be created are valid.  Returns true if valid, throws an exception
 * if not.
 * @param createdRecord - A single instance of a record created during csv load.
 * @returns {boolean} - True if valid, throws exception if not.
 */
function validateColumnNames(createdRecord) {
	let columnNames = Object.keys(createdRecord);
	for (let key of columnNames) {
		if (!schemaRegex.test(key)) {
			throw new Error(`Invalid column name '${key}', cancelling load operation`);
		}
	}
	return true;
}

/**
 * Performs a bulk insert, update, or upsert depending on the action passed to the function.
 * @param records - The records to be inserted/updated/upserted
 * @param schema - The schema containing the specified table
 * @param table - The table to perform the insert/update/upsert
 * @param action - Specify insert/update/upsert the specified records
 * @returns {Promise<{records: *, new_attributes: *, number_written: number}>}
 */
async function bulkFileLoad(records, schema, table, action) {
	if (!action) {
		action = 'insert';
	}

	let targetObject = {
		operation: action,
		schema,
		table,
		records,
	};

	let writeFunction;
	switch (action) {
		case 'insert':
			writeFunction = insert.insert;
			break;
		case 'update':
			writeFunction = insert.update;
			break;
		case 'upsert':
			writeFunction = insert.upsert;
			break;
		default:
			throw handleHDBError(
				new Error(),
				HDB_ERROR_MSGS.INVALID_ACTION_PARAM_ERR(action),
				HTTP_STATUS_CODES.BAD_REQUEST,
				hdbTerms.LOG_LEVELS.ERROR,
				HDB_ERROR_MSGS.INVALID_ACTION_PARAM_ERR(action)
			);
	}

	try {
		let writeResponse = await writeFunction(targetObject);

		let modifiedHashes;
		switch (action) {
			case 'insert':
				modifiedHashes = writeResponse.inserted_hashes;
				break;
			case 'update':
				modifiedHashes = writeResponse.update_hashes;
				break;
			case 'upsert':
				modifiedHashes = writeResponse.upserted_hashes;
				break;
			default:
				//We should never get here based on the error thrown in the switch above
				break;
		}

		if (Array.isArray(writeResponse.skipped_hashes) && writeResponse.skipped_hashes.length > 0) {
			let tableInfo = global.hdb_schema[schema][table];
			let hash_attribute = tableInfo.hash_attribute;

			let x = records.length;
			while (x--) {
				if (writeResponse.skipped_hashes.indexOf(records[x][hash_attribute]) >= 0) {
					records.splice(x, 1);
				}
			}
		}

		let number_written = hdbUtils.isEmptyOrZeroLength(modifiedHashes) ? 0 : modifiedHashes.length;
		return {
			records: records.length,
			number_written,
			new_attributes: writeResponse.new_attributes,
		};
	} catch (err) {
		throw buildTopLevelErrMsg(err);
	}
}

/**
 * Builds the response message returned by bulk load operations.
 * @param totalRecords
 * @param number_written
 */
function buildResponseMsg(totalRecords, number_written) {
	return `successfully loaded ${number_written} of ${totalRecords} records`;
}

/**
 * Uses handleHDBError here to ensure the specific error that has already been created when thrown lower down
 * the stack is used OR, if it hasn't been handled yet, will create and return the generic error message for bulk load
 * and log the error
 *
 * @param err - error caught to be turned into a HDBError (if not already) or passed through via HDBError
 * @returns {HdbError}
 */
function buildTopLevelErrMsg(err) {
	return handleHDBError(
		err,
		CHECK_LOGS_WRAPPER(HDB_ERROR_MSGS.DEFAULT_BULK_LOAD_ERR),
		HTTP_STATUS_CODES.INTERNAL_SERVER_ERROR,
		hdbTerms.LOG_LEVELS.ERROR,
		HDB_ERROR_MSGS.DEFAULT_BULK_LOAD_ERR + ' - ' + err
	);
}
