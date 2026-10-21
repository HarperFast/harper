import { get as envGet } from '../utility/environment/environmentManager.ts';
import { CONFIG_PARAMS } from '../utility/hdbTerms.ts';
import { ClientError } from '../utility/errors/hdbError.ts';

/**
 * Check if Harper is running in read-only mode.
 * Read-only mode can be enabled via:
 * - HARPER_READONLY environment variable (truthy value)
 * - --readonly CLI flag
 * - storage.readOnly config setting
 */
let _isReadOnlyMode: boolean | undefined;
export function __setReadOnlyModeForTest(value: boolean | undefined): void {
	_isReadOnlyMode = value;
}

export function isReadOnlyMode(): boolean {
	if (_isReadOnlyMode !== undefined) return _isReadOnlyMode;
	// Check environment variable
	const envReadOnly = process.env.HARPER_READONLY;
	if (envReadOnly && envReadOnly !== '0' && envReadOnly !== 'false') {
		_isReadOnlyMode = true;
		return true;
	}
	// Check CLI flag (simple argv check)
	if (process.argv.includes('--readonly') || process.argv.includes('--read-only')) {
		_isReadOnlyMode = true;
		return true;
	}
	// Check config setting
	if (envGet(CONFIG_PARAMS.STORAGE_READONLY)) {
		_isReadOnlyMode = true;
		return true;
	}
	_isReadOnlyMode = false;
	return false;
}

export function readOnlyModeError(): ClientError {
	return new ClientError('Server is in read-only mode', 405);
}
