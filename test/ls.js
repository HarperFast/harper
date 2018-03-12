const alasql = require('alasql'),
    mathjs = require('mathjs');

let array = [
    {
        "else": "Penny Bernhardy",
        "age": 5,
        "owner_name": "Kyle",
        "adorable": true,
        "id": 1,
        "breed_id": 154,
        "weight_lbs": 35
    },
    {
        "else": "Harper",
        "age": 5,
        "owner_name": "Stephen",
        "adorable": true,
        "id": 2,
        "breed_id": 346,
        "weight_lbs": 55
    },
    {
        "else": "Alby",
        "age": 5,
        "owner_name": "Kaylan",
        "adorable": true,
        "id": 3,
        "breed_id": 348,
        "weight_lbs": 84
    },
    {
        "else": "Billy",
        "age": 4,
        "owner_name": "Zach",
        "adorable": true,
        "id": 4,
        "breed_id": 347,
        "weight_lbs": 60
    },
    {
        "else": "Rose Merry",
        "age": 6,
        "owner_name": "Zach",
        "adorable": true,
        "id": 5,
        "breed_id": 348,
        "weight_lbs": 15
    },
    {
        "else": "Kato",
        "age": 4,
        "owner_name": "Kyle",
        "adorable": true,
        "id": 6,
        "breed_id": 351,
        "weight_lbs": 28
    },
    {
        "else": "Simon",
        "age": 1,
        "owner_name": "Fred",
        "adorable": true,
        "id": 7,
        "breed_id": 349,
        "weight_lbs": 35
    },
    {
        "else": "Gemma",
        "age": 3,
        "owner_name": "Stephen",
        "adorable": true,
        "id": 8,
        "breed_id": 350,
        "weight_lbs": 55
    },
    {
        "else": "Gertrude",
        "age": 5,
        "owner_name": "Eli",
        "adorable": true,
        "id": 9,
        "breed_id": 158,
        "weight_lbs": 70
    },
    {
        "else": "Big Louie",
        "age": 11,
        "owner_name": "Eli",
        "adorable": true,
        "id": 10,
        "breed_id": 241,
        "weight_lbs": 20
    }
];
alasql.aggr.MEDIAN = (value, array, stage)=>{
    if(stage === 1){
        if(value === null || value === undefined){
            return [];
        }

        return [value];
    } else if(stage === 2){
        if(value !== null && value !== undefined){
            array.push(value);
        }
        return array;
    } else {
        if(array.length > 0){
            return mathjs.median(array);
        }

        return 0;

    }
};


console.log(alasql.parse('SELECT round(age) as `as` from ? order by round(age)'));

