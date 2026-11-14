/**
 * What to log in place of an operation body whose content must stay out of the logs (an
 * `encrypted_operation`'s inner operation). Keyed by the body object, so the view never
 * rides in the body that validators and handlers see; built lazily, so a request that is not logged
 * builds nothing.
 */
import harperLogger from './logging/harper_logger.ts';
import { LOG_LEVELS } from './hdbTerms.ts';

export type OperationLogView = () => Record<string, unknown>;

const logViews = new WeakMap<object, OperationLogView>();

export function setOperationLogView(body: object, view: OperationLogView): void {
	logViews.set(body, view);
}

export function operationLogViewOf(body: unknown): OperationLogView | undefined {
	return body !== null && typeof body === 'object' ? logViews.get(body) : undefined;
}

export function isOperationLogEnabled(): boolean {
	const level = harperLogger.logLevel;
	return level === LOG_LEVELS.INFO || level === LOG_LEVELS.DEBUG || level === LOG_LEVELS.TRACE;
}
