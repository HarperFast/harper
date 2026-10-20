import { handleHDBError, hdbErrors } from '../../utility/errors/hdbError.ts';

export function operationErrorResponse(error: any): { statusCode: number; body: unknown } {
	error ??= handleHDBError(new Error('The request failed without an error'), undefined, 500);
	if (error.statusCode) {
		if (typeof error.http_resp_msg !== 'object') {
			const body: Record<string, unknown> = { error: error.http_resp_msg || error.message };
			// surface the machine-readable signal for errors that declare retryability (e.g. a
			// still-building index, IndexRebuildingError) so API callers can distinguish and retry
			if (error.retryable !== undefined) {
				body.code = error.code;
				body.retryable = error.retryable;
			}
			return { statusCode: error.statusCode, body };
		}
		return { statusCode: error.statusCode, body: error.http_resp_msg };
	}
	const statusCode = hdbErrors.HTTP_STATUS_CODES.INTERNAL_SERVER_ERROR;
	if (typeof error === 'string') return { statusCode, body: { error } };
	return { statusCode, body: error.message ? { error: error.message } : error };
}
