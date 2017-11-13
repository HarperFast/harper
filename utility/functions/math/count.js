//mathjs does not have a count function so we create our own

exports.name = 'count';
exports.factory = function (type, config, load, typed) {
    let setSize = load(require('mathjs/lib/function/set/setSize'));
    return setSize;
};
