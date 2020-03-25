"use strict";

const moment = require('moment');
const hdb_time_format = 'YYYY-MM-DDTHH:mm:ss.SSS';

module.exports = {
    current_date: () => {
        return moment().utc().format('YYYY-MM-DD');
    },
    current_time: () => {
        return moment().utc().format('HH:mm:ss.SSS');
    },
    extract: (date, date_part)=>{
        switch(date_part.toLowerCase()){
            case 'year':
                return moment(date).format('YYYY');
            case 'month':
                return moment(date).format('MM');
            case 'day':
                return moment(date).format('DD');
            case 'hour':
                return moment(date).format('HH');
            case 'minute':
                return moment(date).format('mm');
            case 'second':
                return moment(date).format('ss');
            case 'millisecond':
                return moment(date).format('SSS');
            default:
                break;
        }
    },
    date: (date) => {
        return moment(date).format(hdb_time_format);
    },
    date_format:(date, format)=>{
        return moment(date).format(format);
    },
    date_add:(date, value, interval)=>{
        return moment(date).add(interval, value).format(hdb_time_format);
    },
    date_sub:(date, value, interval)=>{
        return moment(date).subtract(interval, value).format(hdb_time_format);
    },
    date_diff:(date_1, date_2, interval)=>{
        let first_date = moment(date_1);
        let second_date = moment(date_2);
        if(interval){
            return first_date.diff(second_date, interval, true);
        } else {
            return first_date.diff(second_date);
        }
    },
    now:()=>{
        return moment().utc().format(hdb_time_format);
    },
};
