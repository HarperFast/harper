/**
 * Component Status Error Types
 * 
 * This module defines specific error types for the component status system,
 * providing better diagnostics and error handling capabilities.
 */

import { HTTP_STATUS_CODES } from '../../utility/errors/commonErrors.js';

/**
 * Base error class for component status system
 */
export class ComponentStatusError extends Error {
	public readonly statusCode: number;
	public readonly timestamp: Date;

	constructor(message: string, statusCode: number = HTTP_STATUS_CODES.INTERNAL_SERVER_ERROR) {
		super(message);
		this.name = 'ComponentStatusError';
		this.statusCode = statusCode;
		this.timestamp = new Date();
		Error.captureStackTrace(this, this.constructor);
	}
}

/**
 * Error thrown when cross-thread status collection times out
 */
export class CrossThreadTimeoutError extends ComponentStatusError {
	public readonly requestId: number;
	public readonly timeoutMs: number;
	public readonly collectedCount: number;

	constructor(requestId: number, timeoutMs: number, collectedCount: number) {
		super(
			`Component status collection timeout after ${timeoutMs}ms. ` +
			`Collected ${collectedCount} responses for request ${requestId}.`,
			HTTP_STATUS_CODES.GATEWAY_TIMEOUT
		);
		this.name = 'CrossThreadTimeoutError';
		this.requestId = requestId;
		this.timeoutMs = timeoutMs;
		this.collectedCount = collectedCount;
	}
}

/**
 * Error thrown when ITC (Inter-Thread Communication) fails
 */
export class ITCError extends ComponentStatusError {
	public readonly operation: string;
	public readonly cause?: Error;

	constructor(operation: string, cause?: Error) {
		super(
			`Inter-thread communication failed during ${operation}: ${cause?.message || 'Unknown error'}`,
			HTTP_STATUS_CODES.SERVICE_UNAVAILABLE
		);
		this.name = 'ITCError';
		this.operation = operation;
		this.cause = cause;
	}
}

/**
 * Error thrown when component status aggregation fails
 */
export class AggregationError extends ComponentStatusError {
	public readonly componentCount: number;
	public readonly cause?: Error;

	constructor(componentCount: number, cause?: Error) {
		super(
			`Failed to aggregate status for ${componentCount} components: ${cause?.message || 'Unknown error'}`,
			HTTP_STATUS_CODES.INTERNAL_SERVER_ERROR
		);
		this.name = 'AggregationError';
		this.componentCount = componentCount;
		this.cause = cause;
	}
}

/**
 * Error thrown when a component status operation fails
 */
export class ComponentStatusOperationError extends ComponentStatusError {
	public readonly componentName: string;
	public readonly operation: string;

	constructor(componentName: string, operation: string, message: string) {
		super(
			`Component '${componentName}' ${operation} failed: ${message}`,
			HTTP_STATUS_CODES.INTERNAL_SERVER_ERROR
		);
		this.name = 'ComponentStatusOperationError';
		this.componentName = componentName;
		this.operation = operation;
	}
}

/**
 * Information about cross-thread collection results
 */
export interface CrossThreadCollectionResult {
	success: boolean;
	collectedFromThreads: number;
	expectedThreads?: number;
	timedOutThreads: number[];
	errors: Error[];
}

/**
 * Error thrown with detailed cross-thread collection diagnostics
 */
export class CrossThreadCollectionError extends ComponentStatusError {
	public readonly result: CrossThreadCollectionResult;

	constructor(result: CrossThreadCollectionResult) {
		const message = result.success
			? `Partial collection success: ${result.collectedFromThreads} threads responded` +
			  (result.timedOutThreads.length > 0 ? `, ${result.timedOutThreads.length} timed out` : '')
			: `Collection failed: ${result.errors.map(e => e.message).join(', ')}`;

		super(message, HTTP_STATUS_CODES.OK); // 200 - partial success is still success
		this.name = 'CrossThreadCollectionError';
		this.result = result;
	}

	/**
	 * Get detailed diagnostic information
	 */
	getDiagnostics(): string {
		const lines = [
			`Cross-thread collection ${this.result.success ? 'partially succeeded' : 'failed'}`,
			`Threads responded: ${this.result.collectedFromThreads}`,
		];

		if (this.result.expectedThreads) {
			lines.push(`Expected threads: ${this.result.expectedThreads}`);
		}

		if (this.result.timedOutThreads.length > 0) {
			lines.push(`Timed out threads: ${this.result.timedOutThreads.join(', ')}`);
		}

		if (this.result.errors.length > 0) {
			lines.push('Errors:');
			this.result.errors.forEach((error, index) => {
				lines.push(`  ${index + 1}. ${error.name}: ${error.message}`);
			});
		}

		return lines.join('\n');
	}
}