/**
 * ComponentStatus Class
 *
 * This module contains the ComponentStatus class which represents an individual
 * component's status with methods for status management.
 */

import { type ComponentStatusLevel, COMPONENT_STATUS_LEVELS } from './types.ts';

/**
 * Component status information class
 */
export class ComponentStatus {
	/** Last time this status was checked/updated */
	public lastChecked: Date;
	/** Current status level */
	public status: ComponentStatusLevel;
	/** Human-readable status message */
	public message?: string;
	/** Error information if status is 'error' */
	public error?: Error | string;

	constructor(status: ComponentStatusLevel, message?: string, error?: Error | string) {
		this.lastChecked = new Date();
		this.status = status;
		this.message = message;
		this.error = error;
	}

	/**
	 * Update the status level and refresh the timestamp
	 */
	public updateStatus(status: ComponentStatusLevel, message?: string): void {
		this.status = status;
		this.message = message;
		this.lastChecked = new Date();
		// Clear error when status is not ERROR
		if (status !== COMPONENT_STATUS_LEVELS.ERROR) {
			this.error = undefined;
		}
	}

	/**
	 * Set status to healthy
	 */
	public markHealthy(message?: string): void {
		this.updateStatus(COMPONENT_STATUS_LEVELS.HEALTHY, message || 'Component is healthy');
	}

	/**
	 * Set status to error
	 */
	public markError(error: Error | string, message?: string): void {
		this.status = COMPONENT_STATUS_LEVELS.ERROR;
		this.error = error;
		this.message = message || (typeof error === 'string' ? error : error.message);
		this.lastChecked = new Date();
	}

	/**
	 * Set status to warning
	 */
	public markWarning(message: string): void {
		this.updateStatus(COMPONENT_STATUS_LEVELS.WARNING, message);
	}

	/**
	 * Set status to loading
	 */
	public markLoading(message?: string): void {
		this.updateStatus(COMPONENT_STATUS_LEVELS.LOADING, message || 'Component is loading');
	}

	/**
	 * Check if component is healthy
	 */
	public isHealthy(): boolean {
		return this.status === COMPONENT_STATUS_LEVELS.HEALTHY;
	}

	/**
	 * Check if component has an error
	 */
	public hasError(): boolean {
		return this.status === COMPONENT_STATUS_LEVELS.ERROR;
	}

	/**
	 * Check if component is loading
	 */
	public isLoading(): boolean {
		return this.status === COMPONENT_STATUS_LEVELS.LOADING;
	}

	/**
	 * Check if component has a warning
	 */
	public hasWarning(): boolean {
		return this.status === COMPONENT_STATUS_LEVELS.WARNING;
	}

	/**
	 * Get a summary string of the component status
	 */
	public getSummary(): string {
		const statusText = this.status.toUpperCase();
		const messageText = this.message ? `: ${this.message}` : '';
		return `${statusText}${messageText}`;
	}
}
