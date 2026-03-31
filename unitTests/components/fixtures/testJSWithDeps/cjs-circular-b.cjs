// CommonJS circular dependency test - file B
const { valueA } = require('./cjs-circular-a.cjs');

const valueB = 'from-b';

exports.valueB = valueB;
exports.valueA = valueA; // This will be undefined during initial load, but available after both modules load
