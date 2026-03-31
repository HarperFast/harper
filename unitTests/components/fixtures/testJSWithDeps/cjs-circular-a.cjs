// CommonJS circular dependency test - file A
const { valueB } = require('./cjs-circular-b.cjs');

const valueA = 'from-a';

// This should work even though B requires A
exports.valueA = valueA;
exports.valueB = valueB;
exports.combined = () => `${valueA}-${valueB}`;
