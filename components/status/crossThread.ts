/**
 * Cross-Thread Component Status Collection
 *
 * This module handles collecting component status information from all worker threads
 * and aggregating it into a unified view.
 */

import { sendItcEvent } from '../../server/threads/itc.js';
import { getWorkerIndex, onMessageByType, getWorkerCount } from '../../server/threads/manageThreads.js';
import { ITC_EVENT_TYPES } from '../../utility/hdbTerms.ts';
import { loggerWithTag } from '../../utility/logging/logger.js';
import { ComponentStatusRegistry } from './ComponentStatusRegistry.ts';
import {
	type ComponentStatusSummary,
	type WorkerComponentStatuses,
	type AggregatedComponentStatus,
	type ComponentStatusLevel,
	COMPONENT_STATUS_LEVELS,
	type ComponentStatusAbnormality,
} from './types.ts';
import { ITCError } from './errors.ts';

const logger = loggerWithTag('componentStatus.crossThread');

/**
 * CrossThreadStatusCollector Class
 * Handles collection of component status from all worker threads
 */
export class CrossThreadStatusCollector {
	private awaitingResponses = new Map<number, Array<WorkerComponentStatuses>>();
	private responseCheckers = new Map<number, () => void>();
	private nextRequestId = 1;
	private listenerAttached = false;
	private readonly timeout: number;
	private cleanupTimer: NodeJS.Timeout | null = null;

	constructor(timeoutMs: number = 5000) {
		this.timeout = timeoutMs;
	}

	/**
	 * Attach the message listener for cross-thread responses
	 * This is done once per collector instance to avoid duplicate listeners
	 */
	private attachListener(): void {
		if (this.listenerAttached) {
			return;
		}

		onMessageByType(ITC_EVENT_TYPES.COMPONENT_STATUS_RESPONSE, ({ message }: any) => {
			const workerLabel = message.isMainThread ? 'main' : `worker-${message.workerIndex}`;
			logger.trace?.('Received component status response from %s, with requestId: %d', workerLabel, message.requestId);

			// Find the pending request by requestId
			const pendingResponses = this.awaitingResponses.get(message.requestId);
			if (pendingResponses) {
				pendingResponses.push({
					workerIndex: message.workerIndex,
					isMainThread: message.isMainThread || false,
					statuses: message.statuses || [],
				});

				// Check if we've received all expected responses
				const checkComplete = this.responseCheckers.get(message.requestId);
				if (checkComplete) {
					checkComplete();
				}
			}
		});

		this.listenerAttached = true;
	}

	/**
	 * Schedule cleanup of stale requests if needed
	 */
	private scheduleCleanup(): void {
		// Clear any existing timer
		if (this.cleanupTimer) {
			clearTimeout(this.cleanupTimer);
		}

		// Schedule cleanup in 30 seconds if there are pending requests
		if (this.awaitingResponses.size > 0) {
			this.cleanupTimer = setTimeout(() => {
				if (this.awaitingResponses.size > 0) {
					logger.debug?.(`Cleaning up ${this.awaitingResponses.size} stale pending requests`);
					this.awaitingResponses.clear();
				}
				this.cleanupTimer = null;
			}, 30000);
		}
	}

	/**
	 * Collect component status information from all threads
	 * Returns a Map with component names namespaced by worker index
	 */
	public async collect(registry: ComponentStatusRegistry): Promise<Map<string, ComponentStatusSummary>> {
		try {
			// Ensure listener is attached
			this.attachListener();

			// Reset cleanup timer on each collect call
			this.scheduleCleanup();

			// Generate unique request ID and set up response collection
			const requestId = this.nextRequestId++;
			const responses: Array<WorkerComponentStatuses> = [];
			this.awaitingResponses.set(requestId, responses);

			// Calculate expected number of responses
			// Total threads = main thread (1) + worker threads (workerCount)
			const workerCount = getWorkerCount() || 1;
			const totalThreads = workerCount + 1;
			// We expect responses from all threads except ourselves
			const expectedResponses = totalThreads - 1;

			// Set up response collection with timeout
			const responsePromise = new Promise<Array<WorkerComponentStatuses>>((resolve, reject) => {
				let resolved = false;

				// Check if we've received all expected responses
				const checkComplete = () => {
					const collectedResponses = this.awaitingResponses.get(requestId);
					if (collectedResponses && collectedResponses.length >= expectedResponses && !resolved) {
						resolved = true;
						cleanup();
						logger.trace?.(`Collected all ${collectedResponses.length} expected responses for request ${requestId}`);
						resolve(collectedResponses);
					}
				};

				// Set up timeout as fallback
				const timeoutHandle = setTimeout(() => {
					if (!resolved) {
						resolved = true;
						const collectedResponses = this.awaitingResponses.get(requestId) || [];
						this.awaitingResponses.delete(requestId);
						// Log timeout with diagnostic info
						logger.debug?.(
							`Collection timeout for request ${requestId}: collected ${collectedResponses.length}/${expectedResponses} responses`
						);
						// Resolve with whatever we've collected so far
						resolve(collectedResponses);
					}
				}, this.timeout);

				// Ensure cleanup happens no matter what
				const cleanup = () => {
					this.awaitingResponses.delete(requestId);
					clearTimeout(timeoutHandle);
				};

				// Store check function for this request
				this.responseCheckers.set(requestId, checkComplete);

				// Broadcast to ALL threads
				sendItcEvent({
					type: ITC_EVENT_TYPES.COMPONENT_STATUS_REQUEST,
					message: { requestId },
				})
					.then(() => {
						// Request sent successfully, check if we already have all responses
						checkComplete();
					})
					.catch((error: Error) => {
						resolved = true;
						cleanup();
						this.responseCheckers.delete(requestId);
						reject(new ITCError('sendItcEvent', error));
					});
			});

			// Get the collected responses for this request
			const collectedResponses = await responsePromise;

			// Clean up response checker
			this.responseCheckers.delete(requestId);

			// Aggregate responses from all threads
			const aggregatedStatuses = new Map<string, ComponentStatusSummary>();

			// Add local thread's component status
			const localStatuses = registry.getAllStatuses();
			const localWorkerIndex = getWorkerIndex();
			const localThreadLabel = localWorkerIndex === undefined ? 'main' : `worker-${localWorkerIndex}`;

			for (const [name, status] of localStatuses) {
				aggregatedStatuses.set(`${name}@${localThreadLabel}`, {
					...status,
					workerIndex: localWorkerIndex,
				});
			}

			// Add responses from other threads
			for (const response of collectedResponses) {
				for (const [name, status] of response.statuses) {
					const threadLabel = response.isMainThread ? 'main' : `worker-${response.workerIndex}`;
					aggregatedStatuses.set(`${name}@${threadLabel}`, {
						...status,
						workerIndex: response.workerIndex,
					});
				}
			}

			logger.debug?.(`Collected component status from ${collectedResponses.length + 1} threads (including local)`);
			return aggregatedStatuses;
		} catch (error) {
			if (error instanceof ITCError) {
				logger.error?.(`ITC failure during component status collection: ${error.message}`);
			} else {
				logger.warn?.('Failed to collect component status from all threads:', error);
			}

			// Log diagnostic information
			logger.debug?.(
				`Collection failed for request. Error: ${error instanceof Error ? error.message : 'Unknown error'}`
			);

			// Fallback to local status only
			return this.getLocalStatusOnly(registry);
		}
	}

	/**
	 * Get status from local thread only (fallback when cross-thread collection fails)
	 */
	private getLocalStatusOnly(registry: ComponentStatusRegistry): Map<string, ComponentStatusSummary> {
		const localStatuses = registry.getAllStatuses();
		const fallbackStatuses = new Map<string, ComponentStatusSummary>();
		const localWorkerIndex = getWorkerIndex();
		const localThreadLabel = localWorkerIndex === undefined ? 'main' : `worker-${localWorkerIndex}`;

		for (const [name, status] of localStatuses) {
			fallbackStatuses.set(`${name}@${localThreadLabel}`, {
				...status,
				workerIndex: localWorkerIndex,
			});
		}
		return fallbackStatuses;
	}

	/**
	 * Clean up any pending requests and timers (useful for testing)
	 */
	public cleanup(): void {
		this.awaitingResponses.clear();
		this.responseCheckers.clear();
		if (this.cleanupTimer) {
			clearTimeout(this.cleanupTimer);
			this.cleanupTimer = null;
		}
	}
}

/**
 * StatusAggregator Class
 * Handles aggregation of component statuses from multiple threads
 */
export class StatusAggregator {
	/**
	 * Aggregate component statuses from multiple threads into aggregated view
	 */
	public static aggregate(allStatuses: Map<string, ComponentStatusSummary>): Map<string, AggregatedComponentStatus> {
		const aggregatedMap = new Map<string, AggregatedComponentStatus>();

		// Group statuses by component name (without thread suffix)
		const componentGroups = new Map<string, Array<[string, ComponentStatusSummary]>>();

		for (const [nameWithThread, status] of allStatuses) {
			// Extract component name without thread suffix (e.g., "myComponent@worker-1" -> "myComponent")
			const atIndex = nameWithThread.indexOf('@');
			const componentName = atIndex !== -1 ? nameWithThread.substring(0, atIndex) : nameWithThread;

			let group = componentGroups.get(componentName);
			if (!group) {
				group = [];
				componentGroups.set(componentName, group);
			}
			group.push([nameWithThread, status]);
		}

		// Process each component group
		for (const [componentName, statusEntries] of componentGroups) {
			const aggregated = this.aggregateComponentGroup(componentName, statusEntries);
			aggregatedMap.set(componentName, aggregated);
		}

		return aggregatedMap;
	}

	/**
	 * Aggregate status entries for a single component across threads
	 */
	private static aggregateComponentGroup(
		componentName: string,
		statusEntries: Array<[string, ComponentStatusSummary]>
	): AggregatedComponentStatus {
		const lastCheckedTimes: AggregatedComponentStatus['lastChecked'] = {
			workers: {},
		};
		let mostRecentCheckTime = 0;
		let latestMessage: string | undefined;
		let error: Error | string | undefined;
		const statusCounts = new Map<ComponentStatusLevel, number>();
		const abnormalities = new Map<string, ComponentStatusAbnormality>();

		// Analyze all instances of this component
		for (const [nameWithThread, status] of statusEntries) {
			const atIndex = nameWithThread.lastIndexOf('@');
			const threadLabel = atIndex !== -1 ? nameWithThread.substring(atIndex + 1) : '';

			// Convert lastChecked to ms since epoch
			const checkTime =
				status.lastChecked instanceof Date ? status.lastChecked.getTime() : new Date(status.lastChecked).getTime();

			// Store the last checked time based on thread label
			if (threadLabel === 'main') {
				lastCheckedTimes.main = checkTime;
			} else if (threadLabel && threadLabel.startsWith('worker-')) {
				const workerIndex = parseInt(threadLabel.substring(7)); // 'worker-'.length = 7
				if (!isNaN(workerIndex)) {
					lastCheckedTimes.workers[workerIndex] = checkTime;
				}
			}

			// Track status counts
			statusCounts.set(status.status, (statusCounts.get(status.status) || 0) + 1);

			// Track messages - prioritize non-healthy messages
			if (status.status !== COMPONENT_STATUS_LEVELS.HEALTHY && status.message) {
				if (!latestMessage || checkTime > mostRecentCheckTime) {
					mostRecentCheckTime = checkTime;
					latestMessage = status.message;
				}
			}

			// Capture any error
			if (status.error && !error) {
				error = status.error;
			}
		}

		// Determine overall status (priority: error > warning > loading > unknown > healthy)
		const determinedStatus = this.determineOverallStatus(statusCounts);

		// Check for abnormalities (inconsistent statuses across threads)
		const uniqueStatuses = Array.from(statusCounts.keys());
		if (uniqueStatuses.length > 1) {
			// There are inconsistencies - populate abnormalities
			for (const [nameWithThread, status] of statusEntries) {
				if (status.status !== determinedStatus) {
					abnormalities.set(nameWithThread, {
						workerIndex: status.workerIndex !== undefined ? status.workerIndex : -1,
						status: status.status,
						message: status.message,
						error: status.error,
					});
				}
			}
		}

		// Create aggregated status
		const aggregatedStatus: AggregatedComponentStatus = {
			componentName,
			status: determinedStatus,
			lastChecked: lastCheckedTimes,
			latestMessage,
			error,
		};

		// Only add abnormalities if there are any
		if (abnormalities.size > 0) {
			aggregatedStatus.abnormalities = abnormalities;
		}

		return aggregatedStatus;
	}

	/**
	 * Determine overall status based on priority
	 */
	private static determineOverallStatus(statusCounts: Map<ComponentStatusLevel, number>): ComponentStatusLevel {
		const statusPriority = [
			COMPONENT_STATUS_LEVELS.ERROR,
			COMPONENT_STATUS_LEVELS.WARNING,
			COMPONENT_STATUS_LEVELS.LOADING,
			COMPONENT_STATUS_LEVELS.UNKNOWN,
			COMPONENT_STATUS_LEVELS.HEALTHY,
		];

		for (const priorityStatus of statusPriority) {
			if (statusCounts.has(priorityStatus) && statusCounts.get(priorityStatus)! > 0) {
				return priorityStatus;
			}
		}

		return COMPONENT_STATUS_LEVELS.UNKNOWN;
	}
}

// Create singleton instances with configurable timeout
const TIMEOUT_MS = parseInt(process.env.COMPONENT_STATUS_TIMEOUT || '5000');
export const crossThreadCollector = new CrossThreadStatusCollector(TIMEOUT_MS);
