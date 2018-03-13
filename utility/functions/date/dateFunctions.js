"use strict";

const moment = require('moment');

module.exports = {
    current_date: () => {
        return moment().format('YYYY-MM-DD');
    },
    current_time: () => {
        return moment().format('HH:mm:ss');
    },
    extract: (date, date_part)=>{
        switch(date_part.toLowerCase()){
            case 'year':
                return moment(date).format('YYYY');
                break;
            case 'month':
                return moment(date).format('MM');
                break;
            case 'day':
                return moment(date).format('DD');
                break;
            case 'hour':
                return moment(date).format('HH');
                break;
            case 'minute':
                return moment(date).format('mm');
                break;
            case 'second':
                return moment(date).format('ss');
                break;
            case 'millisecond':
                return moment(date).format('SSS');
                break;
            default:
                break;
        }
    },
    'date_format':(date, format)=>{
        return moment(date).format(format);
    },
    'date_add':(date, value, interval)=>{
        return moment(date).add(value, interval).format();
    },
    'date_diff':(date_1, date_2, interval)=>{
        let first_date = moment(date_1);
        let second_date = moment(date_2);
        if(interval){
            return first_date.diff(second_date, interval, true);
        } else {
            return first_date.diff(second_date);
        }

    }
};