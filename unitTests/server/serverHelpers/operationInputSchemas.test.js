const assert = require('node:assert');
const Ajv = require('ajv');
const { OPERATION_INPUT_SCHEMAS } = require('#src/server/serverHelpers/operationInputSchemas');
const { validateGetAnalytics } = require('#src/validation/analyticsValidator');
const readLogValidator = require('#src/validation/readLogValidator').default;
const { readTransactionLogValidator } = require('#src/validation/transactionLogValidator');

const contracts = [
	{
		name: 'get_analytics',
		validate: validateGetAnalytics,
		valid: [
			{ metric: 'cpu', start_time: 1000, end_time: 2000 },
			{ metric: 'cpu', get_attributes: ['id', 'value'] },
		],
		invalid: [
			{ metric: 'cpu', start_time: '2026-01-01T00:00:00Z' },
			{ metric: 'cpu', end_time: '2000' },
			{ metric: 'cpu', start_time: 0 },
		],
	},
	{
		name: 'read_log',
		validate: readLogValidator,
		valid: [{ from: '2026-01-01T00:00:00Z', limit: 10, order: 'asc', level: 'info' }],
		invalid: [{ limit: 0 }, { order: 'sideways' }],
	},
	{
		name: 'read_transaction_log',
		validate: readTransactionLogValidator,
		valid: [{ table: 'events', from: 1000, to: 2000, limit: 10 }],
		invalid: [{ table: 'events', limit: 0 }],
	},
];

describe('operation input schemas — runtime validator drift', function () {
	const ajv = new Ajv({ strict: false });
	for (const { name, validate, valid, invalid } of contracts) {
		it(`${name} agrees with its Joi validator on representative inputs`, function () {
			const accepts = ajv.compile(OPERATION_INPUT_SCHEMAS[name]);
			for (const input of valid) {
				assert.ifError(validate(input));
				assert.ok(accepts(input), `${name}: ${ajv.errorsText(accepts.errors)}`);
			}
			for (const input of invalid) {
				assert.ok(validate(input), `${name} validator must reject ${JSON.stringify(input)}`);
				assert.equal(accepts(input), false, `${name} must not advertise ${JSON.stringify(input)}`);
			}
		});

		it(`${name} required fields are recognized by its runtime validator`, function () {
			for (const field of OPERATION_INPUT_SCHEMAS[name].required ?? []) {
				const input = { ...valid[0] };
				delete input[field];
				const error = validate(input);
				assert.ok(error?.message.includes(field), `${name}.${field} must be recognized as required`);
			}
		});
	}
});
