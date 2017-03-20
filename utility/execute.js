var async = require('async');
var exec  = require('child_process').exec;

(function ( ) {
    'use strict';

    /*
     * To execute multiple commands. Invokes provided callback with
     * results/error when done.
     *
     * Parameters:
     *    ([, arg1[, arg2[, ...]]], callback);
     *
     * Example:
     *    require('execute.js')('ffmpeg -i audio.mp3 -o audio.ogg', 'aws s3 sync S3://dir .', callback)
     */
    module.exports = function ( ) {

        exec(arguments.join('\n'), function(){

        });

        /*var commands  = Array.prototype.slice.call(arguments, 0, arguments.length - 1).map(execute);
        var done      = Array.prototype.slice.call(arguments).pop( );

        function execute (cmd) {
            return function (cb) {
                exec(cmd, cb);
            };
        }

        async.series(commands, done);*/
    };

}( ));