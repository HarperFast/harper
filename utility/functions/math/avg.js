//mathjs does not have a count function so we create our own

exports.name = 'avg';
exports.factory = function (type, config, load, typed) {
    let mean = load(require('mathjs/lib/function/statistics/mean'));
    return mean;
};
