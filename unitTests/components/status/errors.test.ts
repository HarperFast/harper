import assert from 'node:assert/strict';
import {
	ComponentStatusError,
	CrossThreadTimeoutError,
	ITCError,
	AggregationError,
	ComponentStatusOperationError,
	CrossThreadCollectionError,
} from '@/components/status/errors';
import { HTTP_STATUS_CODES } from '@/utility/errors/commonErrors';
import { describe, it } from 'mocha';

describe('Component Status Errors', function () {
	describe('ComponentStatusError', function () {
		it('should create base error with default status code', function () {
			const error = new ComponentStatusError('Test error');

			assert.equal(error.name, 'ComponentStatusError');
			assert.equal(error.message, 'Test error');
			assert.equal(error.statusCode, HTTP_STATUS_CODES.INTERNAL_SERVER_ERROR);
			assert.ok(error.timestamp instanceof Date);
			assert.ok(error.stack);
		});

		it('should create base error with custom status code', function () {
			const error = new ComponentStatusError('Bad request', HTTP_STATUS_CODES.BAD_REQUEST);

			assert.equal(error.statusCode, HTTP_STATUS_CODES.BAD_REQUEST);
		});
	});

	describe('CrossThreadTimeoutError', function () {
		it('should create timeout error with details', function () {
			const error = new CrossThreadTimeoutError(123, 5000, 3);

			assert.equal(error.name, 'CrossThreadTimeoutError');
			assert.equal(error.requestId, 123);
			assert.equal(error.timeoutMs, 5000);
			assert.equal(error.collectedCount, 3);
			assert.equal(error.statusCode, HTTP_STATUS_CODES.GATEWAY_TIMEOUT);
			assert.ok(error.message.includes('5000ms'));
			assert.ok(error.message.includes('3 responses'));
			assert.ok(error.message.includes('request 123'));
		});
	});

	describe('ITCError', function () {
		it('should create ITC error without cause', function () {
			const error = new ITCError('sendEvent');

			assert.equal(error.name, 'ITCError');
			assert.equal(error.operation, 'sendEvent');
			assert.equal(error.statusCode, HTTP_STATUS_CODES.SERVICE_UNAVAILABLE);
			assert.ok(error.message.includes('sendEvent'));
			assert.ok(error.message.includes('Unknown error'));
		});

		it('should create ITC error with cause', function () {
			const cause = new Error('Network failure');
			const error = new ITCError('broadcastStatus', cause);

			assert.equal(error.cause, cause);
			assert.ok(error.message.includes('Network failure'));
		});
	});

	describe('AggregationError', function () {
		it('should create aggregation error', function () {
			const cause = new Error('Invalid data');
			const error = new AggregationError(10, cause);

			assert.equal(error.name, 'AggregationError');
			assert.equal(error.componentCount, 10);
			assert.equal(error.cause, cause);
			assert.ok(error.message.includes('10 components'));
			assert.ok(error.message.includes('Invalid data'));
		});
	});

	describe('ComponentStatusOperationError', function () {
		it('should create operation error', function () {
			const error = new ComponentStatusOperationError('my-component', 'setStatus', 'Invalid status level');

			assert.equal(error.name, 'ComponentStatusOperationError');
			assert.equal(error.componentName, 'my-component');
			assert.equal(error.operation, 'setStatus');
			assert.ok(error.message.includes('my-component'));
			assert.ok(error.message.includes('setStatus'));
			assert.ok(error.message.includes('Invalid status level'));
		});
	});

	describe('CrossThreadCollectionError', function () {
		it('should create collection error for partial success', function () {
			const result = {
				success: true,
				collectedFromThreads: 5,
				expectedThreads: 8,
				timedOutThreads: [6, 7, 8],
				errors: [],
			};

			const error = new CrossThreadCollectionError(result);

			assert.equal(error.name, 'CrossThreadCollectionError');
			assert.equal(error.result, result);
			assert.equal(error.statusCode, HTTP_STATUS_CODES.OK);
			assert.ok(error.message.includes('Partial collection success'));
			assert.ok(error.message.includes('5 threads responded'));
			assert.ok(error.message.includes('3 timed out'));
		});

		it('should create collection error for complete failure', function () {
			const result = {
				success: false,
				collectedFromThreads: 0,
				timedOutThreads: [],
				errors: [new Error('Connection refused'), new Error('Timeout')],
			};

			const error = new CrossThreadCollectionError(result);

			assert.ok(error.message.includes('Collection failed'));
			assert.ok(error.message.includes('Connection refused'));
			assert.ok(error.message.includes('Timeout'));
		});

		it('should provide detailed diagnostics', function () {
			const result = {
				success: true,
				collectedFromThreads: 3,
				expectedThreads: 5,
				timedOutThreads: [4, 5],
				errors: [new Error('Worker 4 failed')],
			};

			const error = new CrossThreadCollectionError(result);
			const diagnostics = error.getDiagnostics();

			assert.ok(diagnostics.includes('partially succeeded'));
			assert.ok(diagnostics.includes('Threads responded: 3'));
			assert.ok(diagnostics.includes('Expected threads: 5'));
			assert.ok(diagnostics.includes('Timed out threads: 4, 5'));
			assert.ok(diagnostics.includes('Worker 4 failed'));
		});
	});
});
