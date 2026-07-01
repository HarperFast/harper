'use strict';
import logger from '../logging/harper_logger.ts';
import * as hdbErrors from './commonErrors.ts';
import * as hdbTerms from '../hdbTerms.ts';

/**
 * Custom error class used for better error and log handling.  Caught errors that evaluate to an instanceof HdbError can
 * be handled differently - e.g. in most cases caught HdbError likely would not need to be logged since that should have
 * already been handled when the custom error was constructed.
 */
export class HdbError extends Error {
	statusCode: number;
	http_resp_msg: string;
	type: string;
	logLevel: string;
	/**
	 * @param {Error} errOrig -  Error to be translated into HdbError. If manually throwing an error, pass `new Error()` to ensure stack trace is maintained
	 * @param {String} [httpMsg] - optional -  response message that will be returned via the API
	 * @param {Number} [httpCode] - optional -  response status code that will be returned via the API
	 * @param {String} [logLevel] - optional -  log level that will be used for logging of this error
	 * @param {String} [logMsg] - optional - log message that, if provided, will be logged at the `logLevel` above
	 */
	constructor(errOrig: any, httpMsg?: any, httpCode?: number, logLevel?: string, logMsg?: string) {
		super();

		//This line ensures the original stack trace is captured and does not include the 'handle' or 'constructor' methods
		Error.captureStackTrace(this, handleHDBError);

		this.statusCode = httpCode ? httpCode : hdbErrors.HTTP_STATUS_CODES.INTERNAL_SERVER_ERROR;
		this.http_resp_msg = httpMsg
			? httpMsg
			: hdbErrors.DEFAULT_ERROR_MSGS[httpCode]
				? hdbErrors.DEFAULT_ERROR_MSGS[httpCode]
				: hdbErrors.DEFAULT_ERROR_MSGS[hdbErrors.HTTP_STATUS_CODES.INTERNAL_SERVER_ERROR];
		this.message = errOrig.message ? errOrig.message : this.http_resp_msg;
		this.type = errOrig.name;
		if (logLevel) this.logLevel = logLevel;

		//This ensures that the error stack does not include [object Object] if the error message is not a string
		if (typeof this.message !== 'string') {
			this.stack = errOrig.stack;
		}

		if (logMsg) {
			logger[logLevel](logMsg);
		}
	}
}
export class ClientError extends Error {
	statusCode: number;
	constructor(message: string | Error, statusCode?: number) {
		if (message instanceof Error) {
			(message as any).statusCode = statusCode || 400;
			return message as any;
		}
		super(message as any);
		this.statusCode = statusCode || 400;
	}
}

export class ServerError extends Error {
	statusCode: number;
	constructor(message: string | Error, statusCode?: number) {
		super(message as any);
		this.statusCode = statusCode || 500;
	}
}

/**
 * Thrown when a query targets an attribute whose secondary index is still being (re)built. It is a
 * distinct, retryable 503 so callers can tell a transient "index rebuilding" condition apart from a
 * permanent failure and retry, rather than mis-handling the generic 503 (e.g. as a "no result").
 * See issue #1355.
 */
export class IndexRebuildingError extends ServerError {
	code: string;
	retryable: boolean;
	constructor(message: string) {
		super(message, 503);
		// Set name explicitly: ServerError/Error leave it as 'Error', so without this the stack
		// trace, JSON serialization, and any caller keying on error.name would not identify it.
		this.name = 'IndexRebuildingError';
		this.code = 'INDEX_REBUILDING';
		this.retryable = true;
	}
}

/**
 * This handler method is used to effectively evaluate caught errors and either translates them into a custom HdbError or,
 * if it is already a HdbError, just returns the error to continue being thrown up the stack
 *
 * See above for params descriptions
 * @param e
 * @param httpMsg
 * @param httpCode
 * @param logLevel
 * @param logMsg
 * @param deleteStack
 * @returns {HdbError|*}
 */
export function handleHDBError(
	e: any,
	httpMsg?: any,
	httpCode?: number,
	logLevel: string = (hdbTerms as any).LOG_LEVELS.ERROR,
	logMsg: any = null,
	deleteStack: boolean = false
) {
	if (isHDBError(e)) {
		return e;
	}

	const error = new HdbError(e, httpMsg, httpCode, logLevel, logMsg);

	// In some situations, such as validation errors, the stack does not need to be thrown/logged.
	if (deleteStack) {
		delete error.stack;
	}

	return error;
}

/**
 * Represents a general violation of validation/authorization. This is used in situations where we are performing
 * expected verification. Extends Error for TypeScript class compatibility.
 * @param {Object} user - user object that caused the access violation
 * @constructor
 */
export class Violation extends Error {
	constructor(message: string) {
		super(message);
		this.name = this.constructor.name;
	}
}

/**
 * Represents an access violation. This is used to return a 403 or 401 response to the client.
 * @param {Object} user - user object that caused the access violation
 * @constructor
 */
export class AccessViolation extends Violation {
	statusCode: number;
	constructor(user?: any) {
		if (user) {
			super('Unauthorized access to resource');
			this.statusCode = 403;
		} else {
			super('Must login');
			this.statusCode = 401;
			// TODO: Optionally allow a Location header to redirect to
		}
	}
}

export function isHDBError(e: any) {
	return e.__proto__.constructor.name === HdbError.name;
}

export { hdbErrors };
