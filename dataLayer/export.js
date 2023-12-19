'use strict';

const search = require('./search');
const sql = require('../sqlTranslator/index');
const AWSConnector = require('../utility/AWS/AWSConnector');
const { AsyncParser, Transform } = require('json2csv');
const stream = require('stream');
const hdb_utils = require('../utility/common_utils');
const fs = require('fs-extra');
const path = require('path');
const hdb_logger = require('../utility/logging/harper_logger');
const { promisify } = require('util');
const hdb_common = require('../utility/common_utils');
const { handleHDBError, hdb_errors } = require('../utility/errors/hdbError');
const { HDB_ERROR_MSGS, HTTP_STATUS_CODES } = hdb_errors;
const { streamAsJSON } = require('../server/serverHelpers/JSONStream');
const { Upload } = require('@aws-sdk/lib-storage');

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
const p_search_by_hash = search.searchByHash;
const p_search_by_value = search.searchByValue;
const p_sql = promisify(sql.evaluateSQL);
const stream_finished = promisify(stream.finished);

module.exports = {
	export_to_s3: export_to_s3,
	export_local: export_local,
	toCsvStream,
};

/**
 * Allows for exporting and saving to a file system the receiving system has access to
 *
 * @param export_object
 */
async function export_local(export_object) {
	hdb_logger.trace(
		`export_local request to path: ${export_object.path}, filename: ${export_object.filename}, format: ${export_object.format}`
	);
	let error_message = exportCoreValidation(export_object);
	if (!hdb_utils.isEmpty(error_message)) {
		hdb_logger.error(error_message);
		throw handleHDBError(new Error(), error_message, HTTP_STATUS_CODES.BAD_REQUEST, undefined, undefined, true);
	}

	if (hdb_utils.isEmpty(export_object.path)) {
		hdb_logger.error(HDB_ERROR_MSGS.MISSING_VALUE('path'));
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
		(hdb_utils.isEmpty(export_object.filename) ? new Date().getTime() : export_object.filename) +
		'.' +
		export_object.format;

	if (export_object.path.endsWith(path.sep)) {
		export_object.path = export_object.path.substring(0, export_object.path.length - 1);
	}

	let file_path = hdb_utils.buildFolderPath(export_object.path, filename);
	await confirmPath(export_object.path);
	let records = await getRecords(export_object);
	return await saveToLocal(file_path, export_object.format, records);
}

/**
 * stats the path sent in to verify the path exists, the user has access & the path is a directory
 * @param directory_path
 */
async function confirmPath(directory_path) {
	hdb_logger.trace('in confirmPath');
	if (hdb_utils.isEmptyOrZeroLength(directory_path)) {
		throw handleHDBError(
			new Error(),
			`Invalid path: ${directory_path}`,
			HTTP_STATUS_CODES.BAD_REQUEST,
			undefined,
			undefined,
			true
		);
	}
	let stats = undefined;
	try {
		stats = await fs.stat(directory_path);
	} catch (err) {
		let error_message;
		if (err.code === 'ENOENT') {
			error_message = `path '${directory_path}' does not exist`;
		} else if (err.code === 'EACCES') {
			error_message = `access to path '${directory_path}' is denied`;
		} else {
			error_message = err.message;
		}
		hdb_logger.error(error_message);
		throw handleHDBError(new Error(), error_message, HTTP_STATUS_CODES.BAD_REQUEST, undefined, undefined, true);
	}
	if (!stats.isDirectory()) {
		let err = `path '${directory_path}' is not a directory, please supply a valid folder path`;
		hdb_logger.error(err);
		throw handleHDBError(new Error(), err, HTTP_STATUS_CODES.BAD_REQUEST, undefined, undefined, true);
	}
	return true;
}

/**
 * takes the data and saves it to the file system
 * @param file_path
 * @param source_data_format
 * @param data
 */
async function saveToLocal(file_path, source_data_format, data) {
	hdb_logger.trace('in saveToLocal');
	if (hdb_common.isEmptyOrZeroLength(file_path)) {
		throw handleHDBError(
			new Error(),
			HDB_ERROR_MSGS.INVALID_VALUE('file_path'),
			HTTP_STATUS_CODES.BAD_REQUEST,
			undefined,
			undefined,
			true
		);
	}
	if (hdb_common.isEmptyOrZeroLength(source_data_format)) {
		throw handleHDBError(
			new Error(),
			HDB_ERROR_MSGS.INVALID_VALUE('Source format'),
			HTTP_STATUS_CODES.BAD_REQUEST,
			undefined,
			undefined,
			true
		);
	}
	if (hdb_common.isEmpty(data)) {
		throw handleHDBError(
			new Error(),
			HDB_ERROR_MSGS.NOT_FOUND('Data'),
			HTTP_STATUS_CODES.BAD_REQUEST,
			undefined,
			undefined,
			true
		);
	}

	if (source_data_format === JSON_TEXT) {
		// Create a write stream to the local export file.
		let write_stream = fs.createWriteStream(file_path);
		streamAsJSON(data).pipe(write_stream);
		// Wait until done. Throws if there are errors.
		await stream_finished(write_stream);

		return {
			message: LOCAL_JSON_EXPORT_MSG,
			path: file_path,
		};
	} else if (source_data_format === CSV) {
		// Create a write stream to the local export file.
		let write_stream = fs.createWriteStream(file_path);
		// Create a read stream with the data.
		let readable_stream = stream.Readable.from(data);
		let options = {};
		let transform_options = { objectMode: true };
		// Initialize json2csv parser
		let async_parser = new AsyncParser(options, transform_options);
		let parsing_processor = async_parser.fromInput(readable_stream).toOutput(write_stream);
		await parsing_processor.promise(false);

		return {
			message: LOCAL_CSV_EXPORT_MSG,
			path: file_path,
		};
	}

	throw handleHDBError(new Error(), HDB_ERROR_MSGS.INVALID_VALUE('format'), HTTP_STATUS_CODES.BAD_REQUEST);
}

/**
 *allows for exporting a result to s3
 * @param export_object
 * @returns {*}
 */
async function export_to_s3(export_object) {
	if (!export_object.s3 || Object.keys(export_object.s3).length === 0) {
		throw handleHDBError(new Error(), HDB_ERROR_MSGS.MISSING_VALUE('S3 object'), HTTP_STATUS_CODES.BAD_REQUEST);
	}

	if (hdb_utils.isEmptyOrZeroLength(export_object.s3.aws_access_key_id)) {
		throw handleHDBError(new Error(), HDB_ERROR_MSGS.MISSING_VALUE('aws_access_key_id'), HTTP_STATUS_CODES.BAD_REQUEST);
	}

	if (hdb_utils.isEmptyOrZeroLength(export_object.s3.aws_secret_access_key)) {
		throw handleHDBError(
			new Error(),
			HDB_ERROR_MSGS.MISSING_VALUE('aws_secret_access_key'),
			HTTP_STATUS_CODES.BAD_REQUEST
		);
	}

	if (hdb_utils.isEmptyOrZeroLength(export_object.s3.bucket)) {
		throw handleHDBError(new Error(), HDB_ERROR_MSGS.MISSING_VALUE('bucket'), HTTP_STATUS_CODES.BAD_REQUEST);
	}

	if (hdb_utils.isEmptyOrZeroLength(export_object.s3.key)) {
		throw handleHDBError(new Error(), HDB_ERROR_MSGS.MISSING_VALUE('key'), HTTP_STATUS_CODES.BAD_REQUEST);
	}

	if (hdb_utils.isEmptyOrZeroLength(export_object.s3.region)) {
		throw handleHDBError(new Error(), HDB_ERROR_MSGS.MISSING_VALUE('region'), HTTP_STATUS_CODES.BAD_REQUEST);
	}

	let error_message = exportCoreValidation(export_object);
	if (!hdb_utils.isEmpty(error_message)) {
		throw handleHDBError(new Error(), error_message, HTTP_STATUS_CODES.BAD_REQUEST);
	}
	hdb_logger.trace(
		`called export_to_s3 to bucket: ${export_object.s3.bucket} and query ${export_object.search_operation.sql}`
	);

	let data;
	try {
		data = await getRecords(export_object);
	} catch (err) {
		hdb_logger.error(err);
		throw err;
	}

	let s3_upload_results = undefined;
	let s3 = await AWSConnector.getS3AuthObj(
		export_object.s3.aws_access_key_id,
		export_object.s3.aws_secret_access_key,
		export_object.s3.region
	);
	let s3_name;
	let pass_through = new stream.PassThrough();

	if (export_object.format === CSV) {
		s3_name = export_object.s3.key + '.csv';
		// Create a read stream with the data.

		// Create a json2csv stream transform.
		const csv_stream = toCsvStream(data);
		csv_stream.on('error', (err) => {
			throw err;
		});
		// Pipe the data read stream through json2csv which converts it and then pipes it to a pass through which sends it to S3 upload method.
		csv_stream.pipe(pass_through);
	} else if (export_object.format === JSON_TEXT) {
		s3_name = export_object.s3.key + '.json';
		// Initialize an empty read stream.
		const readable_stream = new stream.Readable();
		// Pipe the read stream to a pass through, this is what sends it to the S3 upload method.
		readable_stream.pipe(pass_through);
		readable_stream.on('error', (err) => {
			throw err;
		});
		// Use push to add data into the read stream queue.
		readable_stream.push('[');
		let data_length = data.length;
		let chunk = '';
		// Loop through the data and build chunks to push to the read stream.
		for (const [index, record] of data.entries()) {
			let string_chunk = index === data_length - 1 ? JSON.stringify(record) : JSON.stringify(record) + ',';
			chunk += string_chunk;

			if (index !== 0 && index % S3_JSON_EXPORT_CHUNK_SIZE === 0) {
				// Use push to add data into the read stream queue.
				readable_stream.push(chunk);
				// Once the chunk has been pushed we no longer need that data. Clear it out for the next lot.
				chunk = '';
			}
		}

		// If the loop is finished and there are still items in the chunk var push it to stream.
		if (chunk.length !== 0) {
			readable_stream.push(chunk);
		}

		readable_stream.push(']');
		// Done writing data
		readable_stream.push(null);
	} else {
		throw handleHDBError(new Error(), HDB_ERROR_MSGS.INVALID_VALUE('format'), HTTP_STATUS_CODES.BAD_REQUEST);
	}

	// Multipart upload to S3
	// https://github.com/aws/aws-sdk-js-v3/tree/main/lib/lib-storage
	const parallel_upload = new Upload({
		client: s3,
		params: { Bucket: export_object.s3.bucket, Key: s3_name, Body: pass_through },
	});
	return parallel_upload.done();
}

/**
 * Converts JS objects/arrays/iterators to a CSV stream. Should support iterators with full backpressure handling
 * @param data
 * @returns stream
 */
function toCsvStream(data) {
	// ensure that we pass it an iterable
	let read_stream = stream.Readable.from(data?.[Symbol.iterator] || data?.[Symbol.asyncIterator] ? data : [data]);
	let options = {};
	let transform_options = { objectMode: true };
	// Create a json2csv stream transform.
	const json2csv = new Transform(options, transform_options);
	// Pipe the data read stream through json2csv which converts it to CSV
	return read_stream.pipe(json2csv);
}

/**
 * handles the core validation of the export_object variable
 * @param export_object
 * @returns {string}
 */
function exportCoreValidation(export_object) {
	hdb_logger.trace('in exportCoreValidation');
	if (hdb_utils.isEmpty(export_object.format)) {
		return 'format missing';
	}

	if (VALID_EXPORT_FORMATS.indexOf(export_object.format) < 0) {
		return `format invalid. must be one of the following values: ${VALID_EXPORT_FORMATS.join(', ')}`;
	}

	let search_operation = export_object.search_operation.operation;
	if (hdb_utils.isEmpty(search_operation)) {
		return 'search_operation.operation missing';
	}

	if (VALID_SEARCH_OPERATIONS.indexOf(search_operation) < 0) {
		return `search_operation.operation must be one of the following values: ${VALID_SEARCH_OPERATIONS.join(', ')}`;
	}
}

/**
 * determines which search operation to perform and executes it.
 * @param export_object
 */
async function getRecords(export_object) {
	hdb_logger.trace('in getRecords');
	let operation;
	let err_msg = undefined;
	if (
		hdb_common.isEmpty(export_object.search_operation) ||
		hdb_common.isEmptyOrZeroLength(export_object.search_operation.operation)
	) {
		throw handleHDBError(new Error(), HDB_ERROR_MSGS.INVALID_VALUE('Search operation'), HTTP_STATUS_CODES.BAD_REQUEST);
	}
	switch (export_object.search_operation.operation) {
		case 'search_by_value':
			operation = p_search_by_value;
			break;
		case 'search_by_hash':
			operation = p_search_by_hash;
			break;
		case 'search_by_conditions':
			operation = search.searchByConditions;
			break;
		case 'sql':
			operation = p_sql;
			break;
		default:
			err_msg = `Operation ${export_object.search_operation.operation} is not support by export.`;
			hdb_logger.error(err_msg);
			throw handleHDBError(new Error(), err_msg, HTTP_STATUS_CODES.BAD_REQUEST);
	}

	//in order to validate the search function and invoke permissions we need to add the hdb_user to the search_operation
	export_object.search_operation.hdb_user = export_object.hdb_user;

	return operation(export_object.search_operation);
}
