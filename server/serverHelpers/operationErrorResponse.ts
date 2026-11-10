import { ServerError, hdbErrors } from '../../utility/errors/hdbError.ts';

export function operationErrorResponse(error: any): { statusCode: number; body: unknown } {
	error ??= new ServerError(hdbErrors.DEFAULT_ERROR_MSGS[500], 500);
	let replicationUnconfirmed = false;
	try {
		replicationUnconfirmed = error.replicationUnconfirmed === true;
	} catch {}
	if (error.statusCode) {
		if (typeof error.http_resp_msg !== 'object') {
			const body: Record<string, unknown> = { error: error.http_resp_msg || error.message };
			if (replicationUnconfirmed) body.replicationUnconfirmed = true;
			// surface the machine-readable signal for errors that declare retryability (e.g. a
			// still-building index, IndexRebuildingError) so API callers can distinguish and retry
			try {
				if (replicationUnconfirmed || error.retryable !== undefined) {
					body.retryable = replicationUnconfirmed ? false : error.retryable;
					body.code = error.code;
				}
			} catch {
				try {
					body.code = error.code;
				} catch {}
			}
			return { statusCode: error.statusCode, body };
		}
		if (replicationUnconfirmed) {
			let body: Record<string, unknown>;
			try {
				body = Array.isArray(error.http_resp_msg) ? { error: error.http_resp_msg } : { ...error.http_resp_msg };
				body.code ??= error.code;
			} catch {
				body = { error: 'Replication confirmation failed' };
				try {
					if (typeof error.message === 'string') body.error = error.message;
				} catch {}
				try {
					body.code = error.code;
				} catch {}
			}
			return { statusCode: error.statusCode, body: { ...body, replicationUnconfirmed: true, retryable: false } };
		}
		return { statusCode: error.statusCode, body: error.http_resp_msg };
	}
	const statusCode = hdbErrors.HTTP_STATUS_CODES.INTERNAL_SERVER_ERROR;
	if (typeof error === 'string') return { statusCode, body: { error } };
	return { statusCode, body: error.message ? { error: error.message } : error };
}
