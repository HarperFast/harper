'use strict';

const search = require('./search.js');
const AWSConnector = require('../utility/AWS/AWSConnector.js');
const { AsyncParser } = require('json2csv');
const stream = require('stream');
const hdbUtils = require('../utility/common_utils.js');
const fs = require('fs-extra');
const path = require('path');
const hdbLogger = require('../utility/logging/harper_logger.js');
const { promisify } = require('util');
const hdbCommon = require('../utility/common_utils.js');
const { handleHDBError, hdbErrors } = require('../utility/errors/hdbError.js');
const { HDB_ERROR_MSGS, HTTP_STATUS_CODES } = hdbErrors;
const { streamAsJSON } = require('../server/serverHelpers/JSONStream.ts');
const { Upload } = require('@aws-sdk/lib-storage');
const { toCsvStream } = require('../server/serverHelpers/contentTypes.ts');

const VALID_SEARCH_OPERATIONS = ['search_by_value', 'search_by_hash', 'sql', 'search_by_conditions'];
const VALID_EXPORT_FORMATS = ['json', 'csv'];
const JSON_TEXT = 'json';
const CSV = 'csv';
const LOCAL_JSON_EXPORT_MSG = 'Successfully exported JSON locally.';
const LOCAL_CSV_EXPORT_MSG = 'Successfully exported CSV locally.';
// Size is number of records
const S3_JSON_EXPORT_CHUNK_SIZE = 1000;
const LOCAL_JSON_EXPORT_SIZE = 1000;

// Promisified function
const pSearchByHash = search.searchByHash;
const pSearchByValue = search.searchByValue;
const streamFinished = promisify(stream.finished);

module.exports = {
	export_to_s3,
	export_local,
};

/**
 * Allows for exporting and saving to a file system the receiving system has access to
 *
 * @param exportObject
 */
async function export_local(exportObject) {
	hdbLogger.trace(
		`export_local request to path: ${exportObject.path}, filename: ${exportObject.filename}, format: ${exportObject.format}`
	);
	let errorMessage = exportCoreValidation(exportObject);
	if (!hdbUtils.isEmpty(errorMessage)) {
		hdbLogger.error(errorMessage);
		throw handleHDBError(new Error(), errorMessage, HTTP_STATUS_CODES.BAD_REQUEST, undefined, undefined, true);
	}

	if (hdbUtils.isEmpty(exportObject.path)) {
		hdbLogger.error(HDB_ERROR_MSGS.MISSING_VALUE('path'));
		throw handleHDBError(
			new Error(),
			HDB_ERROR_MSGS.MISSING_VALUE('path'),
			HTTP_STATUS_CODES.BAD_REQUEST,
			undefined,
			undefined,
			true
		);
	}

	//we will allow for a missing filename and autogen one based on the epoch
	let filename =
		(hdbUtils.isEmpty(exportObject.filename) ? new Date().getTime() : exportObject.filename) +
		'.' +
		exportObject.format;

	if (exportObject.path.endsWith(path.sep)) {
		exportObject.path = exportObject.path.substring(0, exportObject.path.length - 1);
	}

	let filePath = hdbUtils.buildFolderPath(exportObject.path, filename);
	await confirmPath(exportObject.path);
	let records = await getRecords(exportObject);
	return await saveToLocal(filePath, exportObject.format, records);
}

/**
 * stats the path sent in to verify the path exists, the user has access & the path is a directory
 * @param directoryPath
 */
async function confirmPath(directoryPath) {
	hdbLogger.trace('in confirmPath');
	if (hdbUtils.isEmptyOrZeroLength(directoryPath)) {
		throw handleHDBError(
			new Error(),
			`Invalid path: ${directoryPath}`,
			HTTP_STATUS_CODES.BAD_REQUEST,
			undefined,
			undefined,
			true
		);
	}
	let stats = undefined;
	try {
		stats = await fs.stat(directoryPath);
	} catch (err) {
		let errorMessage;
		if (err.code === 'ENOENT') {
			errorMessage = `path '${directory_path}' does not exist`;
		} else if (err.code === 'EACCES') {
			errorMessage = `access to path '${directory_path}' is denied`;
		} else {
			errorMessage = err.message;
		}
		hdbLogger.error(errorMessage);
		throw handleHDBError(new Error(), errorMessage, HTTP_STATUS_CODES.BAD_REQUEST, undefined, undefined, true);
	}
	if (!stats.isDirectory()) {
		let err = `path '${directory_path}' is not a directory, please supply a valid folder path`;
		hdbLogger.error(err);
		throw handleHDBError(new Error(), err, HTTP_STATUS_CODES.BAD_REQUEST, undefined, undefined, true);
	}
	return true;
}

/**
 * takes the data and saves it to the file system
 * @param filePath
 * @param sourceDataFormat
 * @param data
 */
async function saveToLocal(filePath, sourceDataFormat, data) {
	hdbLogger.trace('in saveToLocal');
	if (hdbCommon.isEmptyOrZeroLength(filePath)) {
		throw handleHDBError(
			new Error(),
			HDB_ERROR_MSGS.INVALID_VALUE('file_path'),
			HTTP_STATUS_CODES.BAD_REQUEST,
			undefined,
			undefined,
			true
		);
	}
	if (hdbCommon.isEmptyOrZeroLength(sourceDataFormat)) {
		throw handleHDBError(
			new Error(),
			HDB_ERROR_MSGS.INVALID_VALUE('Source format'),
			HTTP_STATUS_CODES.BAD_REQUEST,
			undefined,
			undefined,
			true
		);
	}
	if (hdbCommon.isEmpty(data)) {
		throw handleHDBError(
			new Error(),
			HDB_ERROR_MSGS.NOT_FOUND('Data'),
			HTTP_STATUS_CODES.BAD_REQUEST,
			undefined,
			undefined,
			true
		);
	}

	if (sourceDataFormat === JSON_TEXT) {
		// Create a write stream to the local export file.
		let writeStream = fs.createWriteStream(filePath);
		streamAsJSON(data).pipe(writeStream);
		// Wait until done. Throws if there are errors.
		await streamFinished(writeStream);

		return {
			message: LOCAL_JSON_EXPORT_MSG,
			path: filePath,
		};
	} else if (sourceDataFormat === CSV) {
		// Create a write stream to the local export file.
		let writeStream = fs.createWriteStream(filePath);
		// Create a read stream with the data.
		let readableStream = stream.Readable.from(data);
		let options = {};
		const columns = data.getColumns?.();
		if (columns)
			options.fields = columns.map((column) => ({
				label: column,
				value: column,
			}));
		let transformOptions = { objectMode: true };
		// Initialize json2csv parser
		let asyncParser = new AsyncParser(options, transformOptions);
		let parsingProcessor = asyncParser.fromInput(readableStream).toOutput(writeStream);
		await parsingProcessor.promise(false);

		return {
			message: LOCAL_CSV_EXPORT_MSG,
			path: filePath,
		};
	}

	throw handleHDBError(new Error(), HDB_ERROR_MSGS.INVALID_VALUE('format'), HTTP_STATUS_CODES.BAD_REQUEST);
}

/**
 *allows for exporting a result to s3
 * @param exportObject
 * @returns {*}
 */
async function export_to_s3(exportObject) {
	if (!exportObject.s3 || Object.keys(exportObject.s3).length === 0) {
		throw handleHDBError(new Error(), HDB_ERROR_MSGS.MISSING_VALUE('S3 object'), HTTP_STATUS_CODES.BAD_REQUEST);
	}

	if (hdbUtils.isEmptyOrZeroLength(exportObject.s3.aws_access_key_id)) {
		throw handleHDBError(new Error(), HDB_ERROR_MSGS.MISSING_VALUE('aws_access_key_id'), HTTP_STATUS_CODES.BAD_REQUEST);
	}

	if (hdbUtils.isEmptyOrZeroLength(exportObject.s3.aws_secret_access_key)) {
		throw handleHDBError(
			new Error(),
			HDB_ERROR_MSGS.MISSING_VALUE('aws_secret_access_key'),
			HTTP_STATUS_CODES.BAD_REQUEST
		);
	}

	if (hdbUtils.isEmptyOrZeroLength(exportObject.s3.bucket)) {
		throw handleHDBError(new Error(), HDB_ERROR_MSGS.MISSING_VALUE('bucket'), HTTP_STATUS_CODES.BAD_REQUEST);
	}

	if (hdbUtils.isEmptyOrZeroLength(exportObject.s3.key)) {
		throw handleHDBError(new Error(), HDB_ERROR_MSGS.MISSING_VALUE('key'), HTTP_STATUS_CODES.BAD_REQUEST);
	}

	if (hdbUtils.isEmptyOrZeroLength(exportObject.s3.region)) {
		throw handleHDBError(new Error(), HDB_ERROR_MSGS.MISSING_VALUE('region'), HTTP_STATUS_CODES.BAD_REQUEST);
	}

	let errorMessage = exportCoreValidation(exportObject);
	if (!hdbUtils.isEmpty(errorMessage)) {
		throw handleHDBError(new Error(), errorMessage, HTTP_STATUS_CODES.BAD_REQUEST);
	}
	hdbLogger.trace(
		`called export_to_s3 to bucket: ${exportObject.s3.bucket} and query ${exportObject.search_operation.sql}`
	);

	let data;
	try {
		data = await getRecords(exportObject);
	} catch (err) {
		hdbLogger.error(err);
		throw err;
	}

	let s3UploadResults = undefined;
	let s3 = await AWSConnector.getS3AuthObj(
		exportObject.s3.aws_access_key_id,
		exportObject.s3.aws_secret_access_key,
		exportObject.s3.region
	);
	let s3Name;
	let passThrough = new stream.PassThrough();

	if (exportObject.format === CSV) {
		s3Name = exportObject.s3.key + '.csv';
		// Create a read stream with the data.

		// Create a json2csv stream transform.
		const csvStream = toCsvStream(data, data.getColumns?.());
		csvStream.on('error', (err) => {
			throw err;
		});
		// Pipe the data read stream through json2csv which converts it and then pipes it to a pass through which sends it to S3 upload method.
		csvStream.pipe(passThrough);
	} else if (exportObject.format === JSON_TEXT) {
		s3Name = exportObject.s3.key + '.json';
		// Initialize an empty read stream.
		const readableStream = new stream.Readable();
		// Pipe the read stream to a pass through, this is what sends it to the S3 upload method.
		readableStream.pipe(passThrough);
		readableStream.on('error', (err) => {
			throw err;
		});
		// Use push to add data into the read stream queue.
		readableStream.push('[');
		let dataLength = data.length;
		let chunk = '';
		// Loop through the data and build chunks to push to the read stream.
		for (const [index, record] of data.entries()) {
			let stringChunk = index === dataLength - 1 ? JSON.stringify(record) : JSON.stringify(record) + ',';
			chunk += stringChunk;

			if (index !== 0 && index % S3_JSON_EXPORT_CHUNK_SIZE === 0) {
				// Use push to add data into the read stream queue.
				readableStream.push(chunk);
				// Once the chunk has been pushed we no longer need that data. Clear it out for the next lot.
				chunk = '';
			}
		}

		// If the loop is finished and there are still items in the chunk var push it to stream.
		if (chunk.length !== 0) {
			readableStream.push(chunk);
		}

		readableStream.push(']');
		// Done writing data
		readableStream.push(null);
	} else {
		throw handleHDBError(new Error(), HDB_ERROR_MSGS.INVALID_VALUE('format'), HTTP_STATUS_CODES.BAD_REQUEST);
	}

	// Multipart upload to S3
	// https://github.com/aws/aws-sdk-js-v3/tree/main/lib/lib-storage
	const parallelUpload = new Upload({
		client: s3,
		params: { Bucket: exportObject.s3.bucket, Key: s3Name, Body: passThrough },
	});
	return parallelUpload.done();
}

/**
 * handles the core validation of the exportObject variable
 * @param exportObject
 * @returns {string}
 */
function exportCoreValidation(exportObject) {
	hdbLogger.trace('in exportCoreValidation');
	if (hdbUtils.isEmpty(exportObject.format)) {
		return 'format missing';
	}

	if (VALID_EXPORT_FORMATS.indexOf(exportObject.format) < 0) {
		return `format invalid. must be one of the following values: ${VALID_EXPORT_FORMATS.join(', ')}`;
	}

	let searchOperation = exportObject.search_operation.operation;
	if (hdbUtils.isEmpty(searchOperation)) {
		return 'search_operation.operation missing';
	}

	if (VALID_SEARCH_OPERATIONS.indexOf(searchOperation) < 0) {
		return `searchOperation.operation must be one of the following values: ${VALID_SEARCH_OPERATIONS.join(', ')}`;
	}
}

/**
 * determines which search operation to perform and executes it.
 * @param exportObject
 */
async function getRecords(exportObject) {
	hdbLogger.trace('in getRecords');
	let operation;
	let errMsg = undefined;
	if (
		hdbCommon.isEmpty(exportObject.search_operation) ||
		hdbCommon.isEmptyOrZeroLength(exportObject.search_operation.operation)
	) {
		throw handleHDBError(new Error(), HDB_ERROR_MSGS.INVALID_VALUE('Search operation'), HTTP_STATUS_CODES.BAD_REQUEST);
	}
	switch (exportObject.search_operation.operation) {
		case 'search_by_value':
			operation = pSearchByValue;
			break;
		case 'search_by_hash':
			operation = pSearchByHash;
			break;
		case 'search_by_conditions':
			operation = search.searchByConditions;
			break;
		case 'sql': {
			const sql = require('../sqlTranslator/index.js');
			operation = promisify(sql.evaluateSQL);
			break;
		}
		default:
			errMsg = `Operation ${exportObject.search_operation.operation} is not support by export.`;
			hdbLogger.error(errMsg);
			throw handleHDBError(new Error(), errMsg, HTTP_STATUS_CODES.BAD_REQUEST);
	}

	//in order to validate the search function and invoke permissions we need to add the hdb_user to the searchOperation
	exportObject.search_operation.hdb_user = exportObject.hdb_user;

	return operation(exportObject.search_operation);
}
