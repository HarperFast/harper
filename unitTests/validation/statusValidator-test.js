'use strict';

const assert = require('node:assert/strict');
const { 
    validateStatus, 
    STATUS_SCHEMAS, 
    STATUS_ALLOWED, 
    STATUS_DEFAULT 
} = require('../../validation/statusValidator');

describe('statusValidator', function () {
    it('should export status constants', function() {
        assert.strictEqual(STATUS_DEFAULT, 'primary');
        assert.ok(STATUS_ALLOWED.includes('primary'));
        assert.ok(STATUS_ALLOWED.includes('maintenance'));
        assert.ok(STATUS_ALLOWED.includes('availability'));
    });

    it('should validate status schemas structure', function() {
        assert.ok(STATUS_SCHEMAS.primary);
        assert.ok(STATUS_SCHEMAS.maintenance);
        assert.ok(STATUS_SCHEMAS.availability);
        assert.strictEqual(STATUS_SCHEMAS.availability.allowedValues.length, 2);
        assert.ok(STATUS_SCHEMAS.availability.allowedValues.includes('Available'));
        assert.ok(STATUS_SCHEMAS.availability.allowedValues.includes('Unavailable'));
    });

    it('should accept valid status values', function() {
        // Primary status can be any string
        assert.strictEqual(validateStatus({ id: 'primary', status: 'Any Value' }), undefined);
        assert.strictEqual(validateStatus({ id: 'primary', status: 'Running' }), undefined);
        assert.strictEqual(validateStatus({ id: 'primary', status: 'Stopped' }), undefined);

        // Maintenance status can be any string
        assert.strictEqual(validateStatus({ id: 'maintenance', status: 'Any Value' }), undefined);
        assert.strictEqual(validateStatus({ id: 'maintenance', status: 'Scheduled' }), undefined);
        assert.strictEqual(validateStatus({ id: 'maintenance', status: 'In Progress' }), undefined);

        // Availability status must be specifically allowed values
        assert.strictEqual(validateStatus({ id: 'availability', status: 'Available' }), undefined);
        assert.strictEqual(validateStatus({ id: 'availability', status: 'Unavailable' }), undefined);
    });

    it('should reject invalid status values', function() {
        // Reject missing id
        const missingIdError = validateStatus({ status: 'Value' });
        assert.ok(missingIdError instanceof Error);
        assert.ok(missingIdError.message.includes('id'));

        // Reject missing status
        const missingStatusError = validateStatus({ id: 'primary' });
        assert.ok(missingStatusError instanceof Error);
        assert.ok(missingStatusError.message.includes('status'));

        // Reject invalid id
        const invalidIdError = validateStatus({ id: 'unknown', status: 'Value' });
        assert.ok(invalidIdError instanceof Error);
        assert.ok(invalidIdError.message.includes('id'));

        // Reject invalid availability status
        const invalidAvailabilityError = validateStatus({ id: 'availability', status: 'Partial' });
        assert.ok(invalidAvailabilityError instanceof Error);
        assert.strictEqual(
            invalidAvailabilityError.message,
            'Status "availability" only accepts these values: Available, Unavailable'
        );
    });
});