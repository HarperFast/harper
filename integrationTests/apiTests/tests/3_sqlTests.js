import { describe, it } from 'node:test';
import assert from 'node:assert';
import request from 'supertest';
import { envUrl, generic, headers } from '../config/envConfig.js';

describe('3. SQL Tests', () => {

	//SQL Tests Folder

	//Invalid Attribute Check

	it('insert invalid attribute name - single row', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({
				operation: 'sql',
				sql: "INSERT INTO dev.invalid_attribute (id, `some/attribute`) VALUES ('1', 'some_attribute')",
			})
			.expect((r) => assert.ok(r.body.error == 'Attribute names cannot include backticks or forward slashes'))
			.expect(400);
	});

	it('update single row w/ invalid attribute name', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({
				operation: 'sql',
				sql: "UPDATE dev.invalid_attribute SET `some/attribute` = 'some attribute' WHERE id = 100",
			})
			.expect((r) => assert.ok(r.body.error == 'Attribute names cannot include backticks or forward slashes'))
			.expect(400);
	});

	it('insert all invalid attribute names - multiple rows', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({
				operation: 'sql',
				sql: "INSERT INTO dev.invalid_attribute (id, `some/attribute1`, `some_/attribute2`, `some_attribute/3`) VALUES ('1', 'some_attribute', 'another_attribute', 'some_other_attribute'), ('2', 'some_attribute', 'another_attribute', 'some_other_attribute'), ('3', 'some_attribute', 'another_attribute', 'some_other_attribute'), ('4', 'some_attribute', 'another_attribute', 'some_other_attribute'), ('5', 'some_attribute', 'another_attribute', 'some_other_attribute'), ('6', 'some_attribute', 'another_attribute', 'some_other_attribute')",
			})
			.expect((r) => assert.ok(r.body.error == 'Attribute names cannot include backticks or forward slashes'))
			.expect(400);
	});

	it('update multiple rows with invalid attribute', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({
				operation: 'sql',
				sql: "UPDATE dev.invalid_attribute SET `/some_attribute` = 'new_value' WHERE id IN(100, 101)",
			})
			.expect((r) => assert.ok(r.body.error == 'Attribute names cannot include backticks or forward slashes'))
			.expect(400);
	});

	it('insert some invalid attribute names - multiple rows', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({
				operation: 'sql',
				sql: "INSERT INTO dev.invalid_attribute (id, some_attribute, another_attribute, `some_/other_attribute`) VALUES ('1', 'some_attribute', 'another_attribute', 'some_other_attribute'), ('2', 'some_attribute', 'another_attribute', 'some_other_attribute'), ('3', 'some_attribute', 'another_attribute', 'some_other_attribute'), ('4', 'some_attribute', 'another_attribute', 'some_other_attribute'), ('5', 'some_attribute', 'another_attribute', 'some_other_attribute'), ('6', 'some_attribute', 'another_attribute', 'some_other_attribute')",
			})
			.expect((r) => assert.ok(r.body.error == 'Attribute names cannot include backticks or forward slashes'))
			.expect(400);
	});

	//Search Response Data Type Check

	it('select by hash no result', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({
				operation: 'sql',
				sql: `SELECT *
                                  FROM ${generic.schema}.${generic.emps_tb}
                                  WHERE ${generic.emps_id} = 190`,
			})
			.expect((r) => assert.ok(r.body.length == 0))
			.expect(200);
	});

	it('select by hash one result', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({
				operation: 'sql',
				sql: `SELECT *
                                  FROM ${generic.schema}.${generic.emps_tb}
                                  WHERE ${generic.emps_id} = 3`,
			})
			.expect((r) => assert.ok(r.body.length == 1, 'Expected response message length to eql 1'))
			.expect((r) => assert.ok(typeof r.body[0] === 'object'))
			.expect(200);
	});

	it('select by hash multiple results', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({
				operation: 'sql',
				sql: `SELECT *
              FROM ${generic.schema}.${generic.emps_tb}
              WHERE ${generic.emps_id} = 3
                 OR ${generic.emps_id} = 5`,
			})
			.expect((r) => assert.ok(r.body.length == 2))
			.expect((r) => assert.ok(typeof r.body[0] === 'object'))
			.expect((r) => assert.ok(typeof r.body[1] === 'object'))
			.expect(200);
	});


	//Date Function Check


	it('insert initial date function data into table', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({
				operation: 'sql',
				sql: 'INSERT INTO dev.time_functions (id, c_date, c_time, c_timestamp, getdate, now) VALUES (1, CURRENT_DATE(), CURRENT_TIME(), CURRENT_TIMESTAMP, GETDATE(), NOW()), (2, CURRENT_DATE(), CURRENT_TIME(), CURRENT_TIMESTAMP, GETDATE(), NOW()), (3, CURRENT_DATE(), CURRENT_TIME(), CURRENT_TIMESTAMP, GETDATE(), NOW()), (4, CURRENT_DATE(), CURRENT_TIME(), CURRENT_TIMESTAMP, GETDATE(), NOW())',
			})
			.expect((r) => assert.ok(r.body.message == 'inserted 4 of 4 records'))
			.expect((r) => assert.ok(r.body.inserted_hashes[0] == 1))
			.expect(200);
	});

	it('check initial date function data in table', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({ operation: 'sql', sql: 'SELECT * FROM dev.time_functions' })
			.expect((r) => {
				assert.ok(r.body.length == 4);
				let current_date = new Date().getUTCDate();
				r.body.forEach((row) => {
					assert.ok([1, 2, 3, 4].includes(row.id));
					assert.ok(new Date(row.now).getUTCDate() == current_date);
					assert.ok(row.now.toString().length == 13);
					assert.ok(new Date(row.getdate).getUTCDate() == current_date);
					assert.ok(row.getdate.toString().length == 13);
					assert.ok(new Date(row.c_timestamp).getUTCDate() == current_date);
					assert.ok(row.c_timestamp.toString().length == 13);
					assert.ok(row.c_date.match(/\d{4}-[01]{1}\d{1}-[0-3]{1}\d{1}$/));
					assert.ok(row.c_time.match(/^[0-2]{1}\d{1}:[0-6]{1}\d{1}:[0-6]{1}\d{1}.\d{3}$/));
				});
			})
			.expect(200);
	});

	it('update w/ date function data to null in table', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({
				operation: 'sql',
				sql: 'UPDATE dev.time_functions SET c_date = null, c_time = null, c_timestamp = null, getdate = null, now = null',
			})
			.expect((r) => assert.ok(r.body.message == 'updated 4 of 4 records'))
			.expect((r) => assert.ok(r.body.update_hashes[0] == 1))
			.expect(200);
	});

	it('check data set to null in table', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({ operation: 'sql', sql: 'SELECT * FROM dev.time_functions' })
			.expect((r) => {
				assert.ok(r.body.length == 4);
				let current_date = new Date().getDate();
				r.body.forEach((row) => {
					assert.ok([1, 2, 3, 4].includes(row.id));
					assert.ok(!row.now);
					assert.ok(!row.getdate);
					assert.ok(!row.c_timestamp);
					assert.ok(!row.c_date);
					assert.ok(!row.c_time);
				});
			})
			.expect(200);
	});

	it('update w/ new date function data in table', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({
				operation: 'sql',
				sql: 'UPDATE dev.time_functions SET c_date = CURRENT_DATE(), c_time = CURRENT_TIME(), c_timestamp = CURRENT_TIMESTAMP, getdate = GETDATE(), now = NOW()',
			})
			.expect((r) => assert.ok(r.body.message == 'updated 4 of 4 records'))
			.expect((r) => assert.ok(r.body.update_hashes.length == 4))
			.expect(200);
	});

	it('check data updated to correct date values in table', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({ operation: 'sql', sql: 'SELECT * FROM dev.time_functions' })
			.expect((r) => {
				assert.ok(r.body.length == 4);
				let current_date = new Date().getUTCDate();
				r.body.forEach((row) => {
					assert.ok([1, 2, 3, 4].includes(row.id));
					assert.ok(new Date(row.now).getUTCDate() == current_date);
					assert.ok(row.now.toString().length == 13);
					assert.ok(new Date(row.getdate).getUTCDate() == current_date);
					assert.ok(row.getdate.toString().length == 13);
					assert.ok(new Date(row.c_timestamp).getUTCDate() == current_date);
					assert.ok(row.c_timestamp.toString().length == 13);
					assert.ok(row.c_date.match(/\d{4}-[01]{1}\d{1}-[0-3]{1}\d{1}$/));
					assert.ok(row.c_time.match(/^[0-2]{1}\d{1}:[0-6]{1}\d{1}:[0-6]{1}\d{1}.\d{3}$/));
				});
			})
			.expect(200);
	});

	it('update w/ other date functions', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({
				operation: 'sql',
				sql: "UPDATE dev.time_functions SET today = NOW(), add_day = DATE_ADD(CURRENT_TIMESTAMP, 1, 'days'), sub_3_years = DATE_SUB('2020-4-1', 3, 'years'), server_time = GET_SERVER_TIME(), offset_utc = OFFSET_UTC(NOW(), -6)",
			})
			.expect((r) => assert.ok(r.body.message == 'updated 4 of 4 records'))
			.expect((r) => assert.ok(r.body.update_hashes.length == 4))
			.expect(200);
	});

	it('check other date function updates are correct in table', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({ operation: 'sql', sql: 'SELECT * FROM dev.time_functions' })
			.expect((r) => {
				assert.ok(r.body.length == 4);
				let current_date = new Date();
				let current_day = current_date.getUTCDate();
				let c_date_plus1 = current_date.setUTCDate(current_day + 1);
				let c_day_plus1 = new Date(c_date_plus1).getUTCDate();
				r.body.forEach((row) => {
					assert.ok(row.c_timestamp.match(/\d{13}$/));
					assert.ok(new Date(row.add_day).getUTCDate() == c_day_plus1);
					assert.ok(row.add_day.match(/\d{13}$/));
					assert.ok(new Date(row.sub_3_years).getFullYear() == 2017);
					assert.ok(row.sub_3_years.match(/\d{13}$/));
					assert.ok(new Date(row.today).getUTCDate() == current_day);
					assert.ok(row.today.match(/\d{13}$/));
				});
			})
			.expect(200);
	});

	it('update w/ other date functions', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({
				operation: 'sql',
				sql: "UPDATE dev.time_functions SET add_day = DATE_ADD(DATE(), 5, 'days'), tomorrow_epoch = DATE_FORMAT(DATE_ADD(NOW(), 1, 'days'), 'x') WHERE id > 2",
			})
			.expect((r) => assert.ok(r.body.message == 'updated 2 of 2 records'))
			.expect((r) => assert.ok(r.body.update_hashes.length == 2))
			.expect(200);
	});

	it('select with date function in WHERE returns correct rows', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({
				operation: 'sql',
				sql: "SELECT * FROM dev.time_functions WHERE DATE_DIFF(add_day, c_timestamp, 'days') > 3 AND tomorrow_epoch > NOW()",
			})
			.expect((r) => {
				assert.ok(r.body.length == 2);
				let current_date = new Date().getDate();
				let date_plus_5 = new Date(new Date().setDate(current_date + 5));
				r.body.forEach((row) => {
					assert.ok([3, 4].includes(row.id));
					assert.ok(new Date(row.add_day).getDate() == date_plus_5.getDate());
				});
			})
			.expect(200);
	});

	it('delete with date function in WHERE deletes correct rows', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({
				operation: 'sql',
				sql: "DELETE FROM dev.time_functions WHERE DATE_DIFF(add_day, c_timestamp, 'days') < 3",
			})
			.expect((r) => assert.ok(r.body.message == '2 of 2 records successfully deleted'))
			.expect((r) => assert.ok(r.body.deleted_hashes.length == 2))
			.expect(200);
	});

	it('check that correct rows were deleted based on date function', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({ operation: 'sql', sql: 'SELECT * FROM dev.time_functions' })
			.expect((r) => {
				assert.ok(r.body.length == 2);
				let current_date = new Date().getDate();
				let date_plus_3 = new Date().setDate(current_date + 3);
				r.body.forEach((row) => {
					assert.ok([3, 4].includes(row.id));
					assert.ok(row.add_day > date_plus_3);
				});
			})
			.expect(200);
	});

	it('check that DATE(__createdtime__) returns correct value w/ correct alias', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({
				operation: 'sql',
				sql: 'SELECT id, DATE(__createdtime__), DATE(__updatedtime__) as updatedtime FROM dev.time_functions WHERE id = 3 OR id = 4',
			})
			.expect((r) => {
				assert.ok(r.body.length == 2);
				let current_date = new Date().getDate();
				r.body.forEach((row) => {
					assert.ok([3, 4].includes(row.id));
					assert.ok(new Date(row.updatedtime).getDate() == current_date);
					assert.ok(new Date(row['DATE(__createdtime__)']).getDate() == current_date);
					assert.ok(
						row.updatedtime.match(
							/\d{4}-[01]{1}\d{1}-[0-3]{1}\d{1}T[0-2]{1}\d{1}:[0-6]{1}\d{1}:[0-6]{1}\d{1}.\d{3}[+|-][0-1][0-9][0-5][0-9]$/
						)
					);
					assert.ok(
						row['DATE(__createdtime__)'].match(
							/\d{4}-[01]{1}\d{1}-[0-3]{1}\d{1}T[0-2]{1}\d{1}:[0-6]{1}\d{1}:[0-6]{1}\d{1}.\d{3}[+|-][0-1][0-9][0-5][0-9]$/
						)
					);
				});
			})
			.expect(200);
	});

	//SEARCH_JSON calls

	it('count movies where movie.keyword starts with super', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({
				operation: 'sql',
				sql: 'SELECT count(*) AS `count` from dev.movie where search_json(\'$[$substring(name,0, 5) = "super"].name\', keywords) is not null',
			})
			.expect((r) => assert.ok(r.body.length == 1, 'Expected response message length to eql 1'))
			.expect((r) => assert.ok(r.body[0].count == 161))
			.expect(200);
	});

	it('return array of just movie keywords', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({
				operation: 'sql',
				sql: "SELECT title, search_json('name', keywords) as keywords from dev.movie where title Like '%Avengers%'",
			})
			.expect((r) => {
				assert.ok(r.body.length == 2);
				r.body.forEach((data) => {
					assert.ok(Array.isArray(data.keywords));
					assert.ok(typeof data.keywords[0] === 'string');
				});
			})
			.expect(200);
	});

	it('filter on credits.cast with join to movie', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({
				operation: 'sql',
				sql: 'SELECT m.title, m.overview, m.release_date, search_json(\'$[name in ["Robert Downey Jr.", "Chris Evans", "Scarlett Johansson", "Mark Ruffalo", "Chris Hemsworth", "Jeremy Renner", "Clark Gregg", "Samuel L. Jackson", "Gwyneth Paltrow", "Don Cheadle"]].{"actor": name, "character": character}\', c.`cast`) as characters from dev.credits c inner join dev.movie m on c.movie_id = m.id where search_json(\'$count($[name in ["Robert Downey Jr.", "Chris Evans", "Scarlett Johansson", "Mark Ruffalo", "Chris Hemsworth", "Jeremy Renner", "Clark Gregg", "Samuel L. Jackson", "Gwyneth Paltrow", "Don Cheadle"]])\', c.`cast`) >= 2',
			})
			.expect((r) => {
				let titles = [
					'Out of Sight',
					'Iron Man',
					'Captain America: The First Avenger',
					'In Good Company',
					'Zodiac',
					'The Spirit',
					'S.W.A.T.',
					'Iron Man 2',
					'Thor',
					'The Avengers',
					'Iron Man 3',
					'Thor: The Dark World',
					'Avengers: Age of Ultron',
					'Captain America: The Winter Soldier',
					'Captain America: Civil War',
				];

				r.body.forEach((data) => {
					assert.ok(titles.indexOf(data.title) > -1);
				});
			})
			.expect(200);
	});


	//SQL INSERT/UPDATE with Expressions & Functions

	it('insert values into table dev.sql_function', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({
				operation: 'sql',
				sql: "INSERT INTO dev.sql_function (id, rando, week_day) VALUES (1, FLOOR(RANDOM() * (10 - 1)) + 1, date_format(NOW(), 'dddd')), (2, FLOOR(RANDOM() * (10 - 1)) + 1, date_format(NOW(), 'dddd'))",
			})
			.expect((r) => assert.ok(r.body.message == 'inserted 2 of 2 records'))
			.expect((r) => assert.ok(r.body.inserted_hashes[0] == 1))
			.expect((r) => assert.ok(r.body.inserted_hashes[1] == 2))
			.expect(200);
	});

	it('SELECT inserted values FROM dev.sql_function', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({ operation: 'sql', sql: 'SELECT * FROM dev.sql_function' })
			.expect((r) => {
				assert.ok(r.body.length == 2);
				r.body.forEach((record) => {
					assert.ok(typeof record.week_day == 'string');
					assert.ok(typeof record.rando == 'number');
					assert.ok(record.rando >= 1 && record.rando <= 10);
				});
			})
			.expect(200);
	});

	it('update values into table dev.sql_function', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({
				operation: 'sql',
				sql: 'UPDATE dev.sql_function SET rando = rando * 10, upper_week_day = UPPER(week_day)',
			})
			.expect((r) => assert.ok(r.body.message == 'updated 2 of 2 records'))
			.expect((r) => assert.ok(r.body.update_hashes[0] == 1))
			.expect((r) => assert.ok(r.body.update_hashes[1] == 2))
			.expect(200);
	});

	it('SELECT updated values FROM dev.sql_function', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({ operation: 'sql', sql: 'SELECT * FROM dev.sql_function' })
			.expect((r) => {
				assert.ok(r.body.length == 2);
				assert.ok(r.body[0].rando >= 10 && r.body[0].rando <= 100);
				assert.ok(r.body[1].rando >= 10 && r.body[1].rando <= 100);
				assert.ok(r.body[0].upper_week_day === r.body[0].week_day.toUpperCase());
				assert.ok(r.body[1].upper_week_day === r.body[1].week_day.toUpperCase());
			})
			.expect(200);
	});

	it('update value in table for non-existent row', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({
				operation: 'sql',
				sql: "UPDATE northnwd.customers SET companyname = 'Google' WHERE customerid = -100",
			})
			.expect((r) => assert.ok(r.body.message == 'updated 0 of 0 records'))
			.expect((r) => assert.deepEqual(r.body.skipped_hashes, []))
			.expect((r) => assert.deepEqual(r.body.update_hashes, []))
			.expect(200);
	});

	//Restricted Keywords

	it('Create table keywords for SQL tests', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({ operation: 'create_table', schema: 'dev', table: 'keywords', hash_attribute: 'id' })
			.expect((r) => assert.ok(r.body.message.includes('successfully created')))
			.expect(200);
	});

	it('Upsert keywords data for SQL tests', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({
				operation: 'upsert',
				schema: 'dev',
				table: 'keywords',
				records: [
					{
						ALL: 'yes',
						Inserted: true,
						__createdtime__: 1605111134623,
						__updatedtime__: 1605111134623,
						group: 'A',
						id: 1,
					},
					{
						ALL: 'no',
						Inserted: false,
						__createdtime__: 1605111134624,
						__updatedtime__: 1605111134624,
						group: 'B',
						id: 2,
					},
					{
						ALL: 'yes',
						Inserted: true,
						__createdtime__: 1605111134624,
						__updatedtime__: 1605111134624,
						group: 'C',
						id: 3,
					},
					{
						ALL: 'no',
						Inserted: false,
						__createdtime__: 1605111134624,
						__updatedtime__: 1605111134624,
						group: 'A',
						id: 4,
					},
					{
						ALL: 'yes',
						Inserted: true,
						__createdtime__: 1605111134624,
						__updatedtime__: 1605111134624,
						group: 'B',
						id: 5,
					},
					{
						ALL: 'no',
						Inserted: false,
						__createdtime__: 1605111134624,
						__updatedtime__: 1605111134624,
						group: 'C',
						id: 6,
					},
					{
						ALL: 'yes',
						Inserted: true,
						__createdtime__: 1605111134624,
						__updatedtime__: 1605111134624,
						group: 'A',
						id: 7,
					},
					{
						ALL: 'no',
						Inserted: false,
						__createdtime__: 1605111134624,
						__updatedtime__: 1605111134624,
						group: 'B',
						id: 8,
					},
					{
						ALL: 'yes',
						Inserted: true,
						__createdtime__: 1605111134624,
						__updatedtime__: 1605111134624,
						group: 'C',
						id: 9,
					},
					{
						ALL: 'no',
						Inserted: false,
						__createdtime__: 1605111134624,
						__updatedtime__: 1605111134624,
						group: 'D',
						id: 10,
					},
				],
			})
			.expect((r) => assert.ok(r.body.upserted_hashes.length == 10))
			.expect(200);
	});

	it('Delete row from table with reserverd word in WHERE clause', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({ operation: 'sql', sql: "DELETE FROM dev.keywords WHERE `group` = 'D'" })
			.expect((r) => assert.ok(r.body.message == '1 of 1 record successfully deleted'))
			.expect((r) => assert.ok(r.body.deleted_hashes[0] == 10))
			.expect((r) => assert.ok(r.body.deleted_hashes.length == 1))
			.expect((r) => assert.ok(r.body.skipped_hashes.length == 0))
			.expect(200);
	});

	it('Delete row from table with multiple reserverd words in WHERE clause', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({ operation: 'sql', sql: "DELETE FROM dev.keywords WHERE `group` = 'A' AND [Inserted] = true" })
			.expect((r) => assert.ok(r.body.message == '2 of 2 records successfully deleted'))
			.expect((r) => assert.ok(r.body.deleted_hashes[0] == 1))
			.expect((r) => assert.ok(r.body.deleted_hashes[1] == 7))
			.expect((r) => assert.ok(r.body.deleted_hashes.length == 2))
			.expect((r) => assert.ok(r.body.skipped_hashes.length == 0))
			.expect(200);
	});

	it('UPDATE rows from table with reserved word in SET and WHERE clause', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({ operation: 'sql', sql: "UPDATE dev.keywords SET `group` = 'D' WHERE [ALL] = 'no'" })
			.expect((r) => assert.ok(r.body.message == 'updated 4 of 4 records'))
			.expect((r) => assert.ok(r.body.update_hashes.length == 4))
			.expect((r) => assert.ok(r.body.skipped_hashes.length == 0))
			.expect(200);
	});

	it('Drop table keywords', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({ operation: 'drop_table', schema: 'dev', table: 'keywords' })
			.expect((r) => assert.ok(r.body.message.includes("successfully deleted table 'dev.keywords'")))
			.expect(200);
	});


	//SQL Update dev.cat

	it('Create table dev.cat for Update', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({ operation: 'create_table', schema: 'dev', table: 'cat', hash_attribute: 'id' })
			.expect((r) => assert.ok(r.body.message == "table 'dev.cat' successfully created."))
			.expect(200);
	});

	it('Insert data into dev.cat', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({
				operation: 'insert',
				schema: 'dev',
				table: 'cat',
				records: [
					{
						id: 1,
						weight_lbs: 8,
						cat_name: 'Sophie',
						age: 21,
						adorable: true,
						outdoor_privilages: null,
						owner_id: 2,
					},
					{
						id: 2,
						weight_lbs: 12,
						cat_name: 'George',
						age: 11,
						adorable: true,
						outdoor_privilages: null,
						owner_id: 2,
					},
					{
						id: 3,
						weight_lbs: 20,
						cat_name: 'Biggie Paws',
						age: 5,
						adorable: true,
						outdoor_privilages: null,
						owner_id: 4,
					},
					{
						id: 4,
						weight_lbs: 6,
						cat_name: 'Willow',
						age: 4,
						adorable: true,
						outdoor_privilages: null,
						owner_id: 1,
					},
					{
						id: 5,
						weight_lbs: 15,
						cat_name: 'Bird',
						age: 6,
						adorable: true,
						outdoor_privilages: null,
						owner_id: 2,
					},
					{
						id: 6,
						weight_lbs: 8,
						cat_name: 'Murph',
						age: 4,
						adorable: true,
						outdoor_privilages: null,
						owner_id: 3,
					},
					{
						id: 7,
						weight_lbs: 16,
						cat_name: 'Simba',
						age: 1,
						adorable: true,
						outdoor_privilages: null,
						owner_id: 4,
					},
					{
						id: 8,
						weight_lbs: 12,
						cat_name: 'Gemma',
						age: 3,
						adorable: true,
						outdoor_privilages: null,
						owner_id: 1,
					},
					{ id: 9, weight_lbs: 10, cat_name: 'Bob', age: 8, adorable: true, outdoor_privilages: null },
				],
			})
			.expect((r) => assert.ok(r.body.message == 'inserted 9 of 9 records'))
			.expect(200);
	});

	it('Update record basic where dev.cat', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({ operation: 'sql', sql: "UPDATE dev.cat SET cat_name = 'Bobby' WHERE id = 9" })
			.expect((r) =>
				assert.ok(
					r.body.message == 'updated 1 of 1 records',
					'Expected response message to eql "updated 1 of 1 records"'
				)
			)
			.expect((r) => assert.ok(r.body.update_hashes[0] == 9))
			.expect(200);
	});

	it('Confirm update record basic where dev.cat', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({ operation: 'sql', sql: 'SELECT cat_name, weight_lbs, age, id FROM dev.cat WHERE id = 9' })
			.expect((r) => assert.ok(r.body[0].id == 9))
			.expect((r) => assert.ok(r.body[0].weight_lbs == 10))
			.expect((r) => assert.ok(r.body[0].cat_name == 'Bobby'))
			.expect((r) => assert.ok(r.body[0].age == 8))
			.expect(200);
	});

	it('Update record "where x != y" dev.cat', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({ operation: 'sql', sql: 'UPDATE dev.cat SET adorable = false WHERE owner_id != 2' })
			.expect((r) => assert.ok(r.body.message == 'updated 5 of 5 records'))
			.expect((r) => assert.ok(r.body.update_hashes.includes(3, 4, 6, 7, 8)))
			.expect(200);
	});

	it('Confirm update record "where x != y" dev.cat', async () => {
		const cats = ['Biggie Paws', 'Willow', 'Murph', 'Simba', 'Gemma'];
		const ids = [3, 4, 6, 7, 8];

		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({ operation: 'sql', sql: 'SELECT cat_name, adorable, id FROM dev.cat WHERE owner_id != 2' })
			.expect((r) => assert.ok(r.body.length == 5))
			.expect((r) => {
				let cats_found = [];
				let ids_found = [];
				r.body.forEach((obj) => {
					assert.ok(Object.keys(obj).length == 3);
					assert.ok(obj.adorable == false);

					let cat_found = cats.filter((el) => obj.cat_name == el);
					if (cat_found.length > 0) cats_found.push(cat_found);
					let id_found = ids.filter((el) => obj.id == el);
					if (id_found.length > 0) ids_found.push(id_found);
				});
				assert.ok(cats_found.length > 0);
				assert.ok(ids_found.length > 0);
			})
			.expect(200);
	});

	it('Update record No where dev.cat', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({ operation: 'sql', sql: 'UPDATE dev.cat SET adorable = true' })
			.expect((r) => assert.ok(r.body.message == 'updated 9 of 9 records'))
			.expect((r) => assert.ok(r.body.update_hashes.includes(1, 2, 3, 4, 5, 6, 7, 8, 9)))
			.expect((r) => assert.deepEqual(r.body.skipped_hashes, []))
			.expect(200);
	});

	it('Confirm update record No where dev.cat', async () => {
		const cats = ['Sophie', 'George', 'Biggie Paws', 'Willow', 'Bird', 'Murph', 'Simba', 'Gemma', 'Bobby'];
		const ids = [1, 2, 3, 4, 5, 6, 7, 8, 9];
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({ operation: 'sql', sql: 'SELECT cat_name, adorable, id FROM dev.cat' })
			.expect((r) => assert.ok(r.body.length == 9))
			.expect((r) => {
				let cats_found = [];
				let ids_found = [];
				r.body.forEach((obj) => {
					assert.ok(Object.keys(obj).length == 3);
					assert.ok(obj.adorable);
					let cat_found = cats.filter((el) => obj.cat_name == el);
					if (cat_found.length > 0) cats_found.push(cat_found);
					let id_found = ids.filter((el) => obj.id == el);
					if (id_found.length > 0) ids_found.push(id_found);
				});
				assert.ok(cats_found.length > 0);
				assert.ok(ids_found.length > 0);
			})
			.expect(200);
	});

	it('Update record multiple wheres, multiple columns dev.cat', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({
				operation: 'sql',
				sql: "UPDATE dev.cat SET outdoor_privilages = false, weight_lbs = 6 WHERE owner_id = 2 AND cat_name = 'Sophie'",
			})
			.expect((r) =>
				assert.ok(
					r.body.message == 'updated 1 of 1 records',
					'Expected response message to eql "updated 1 of 1 records"'
				)
			)
			.expect((r) => assert.ok(r.body.update_hashes[0] == 1))
			.expect(200);
	});

	it('Confirm update record multiple wheres, multiple columns dev.cat', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({
				operation: 'sql',
				sql: "SELECT cat_name, weight_lbs, owner_id, outdoor_privilages, id FROM dev.cat WHERE owner_id = 2 AND cat_name = 'Sophie'",
			})
			.expect((r) => assert.ok(r.body[0].id == 1))
			.expect((r) => assert.ok(r.body[0].weight_lbs == 6))
			.expect((r) => assert.ok(r.body[0].cat_name == 'Sophie'))
			.expect((r) => assert.ok(r.body[0].owner_id == 2))
			.expect((r) => assert.ok(r.body[0].outdoor_privilages == false))
			.expect(200);
	});

	it('Update record "where x is NULL" dev.cat', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({
				operation: 'sql',
				sql: 'UPDATE dev.cat SET outdoor_privilages = true WHERE outdoor_privilages IS null',
			})
			.expect((r) => assert.ok(r.body.message == 'updated 8 of 8 records'))
			.expect((r) => assert.ok(r.body.update_hashes.includes(2, 3, 4, 5, 6, 7, 8, 9)))
			.expect(200);
	});

	it('Confirm update record "where x is NULL" dev.cat', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({
				operation: 'sql',
				sql: 'SELECT cat_name, outdoor_privilages, id FROM dev.cat WHERE outdoor_privilages IS null',
			})
			.expect((r) => assert.ok(r.body.length == 0))
			.expect(200);
	});

	it('Update record with nonexistant id dev.cat', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({ operation: 'sql', sql: "UPDATE dev.cat SET cat_name = 'Garfield' WHERE id = 75" })
			.expect((r) => assert.ok(r.body.message == 'updated 0 of 0 records'))
			.expect((r) => assert.deepEqual(r.body.update_hashes, []))
			.expect(200);
	});

	it('Confirm update record with nonexistant id dev.cat', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({ operation: 'sql', sql: 'SELECT cat_name, weight_lbs, age FROM dev.cat WHERE id = 75' })
			.expect((r) => assert.ok(r.body.length == 0))
			.expect(200);
	});

	it('Drop table cat from dev.cat', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({ operation: 'drop_table', schema: 'dev', table: 'cat' })
			.expect((r) => assert.ok(r.body.message == "successfully deleted table 'dev.cat'"))
			.expect(200);
	});


	//Geospatial

	it('Create table "geo"', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({ operation: 'create_table', table: 'geo', hash_attribute: 'id' })
			.expect((r) => assert.ok(r.body.message == "table 'data.geo' successfully created."))
			.expect(200);
	});

	it('Insert values into "geo" table', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send(
				'{\n   \n\t"operation":"insert",\n\t"table":"geo",\n\t"records": [\n        {\n            "id": 1,\n            "name": "Wellington",\n            "geo_point" : {\n                "type": "Point",\n                "coordinates": [174.776230, -41.286461]\n            },\n            "geo_poly": {\n                "type": "Polygon",\n                "coordinates": [[ [174.615474867904,-41.34148585702194],\n                    [174.8800567396483,-41.31574371071801],\n                    [174.6896944170223,-41.19759744824616],\n                    [174.615474867904,-41.34148585702194]\n                ]]\n            },\n            "geo_line": {\n                "type": "LineString",\n                "coordinates": [\n                    [174.615474867904,-41.34148585702194],\n                    [174.8800567396483,-41.31574371071801]\n                ]\n            }\n        },\n        {\n            "id": 2,\n            "name": "North Adams",\n            "geo_point" : {\n                "type": "Point",\n                "coordinates": [-73.108704, 42.700539]\n            },\n            "geo_poly": {\n                "type": "Polygon",\n                "coordinates": [[                  [-73.12391499193579,42.70656096680374],\n                    [-73.12255557219314,42.69646774251972],\n                    [-73.09908993001123,42.6984753377431],\n                    [-73.10369107948782,42.70876034407737],\n                    [-73.12391499193579,42.70656096680374]\n                ]]\n            }\n        },\n        {\n            "id": 3,\n            "name": "Denver",\n            "geo_point" : {\n                "type": "Point",\n                "coordinates": [-104.990250, 39.739235]\n            },\n            "geo_poly": {\n                "type": "Polygon",\n                "coordinates": [[          [-105.0487835030464,39.77676227285275],\n                    [-105.0175466672944,39.68744341857906],\n                    [-104.9113967289065,39.74637288224356],\n                    [-105.0487835030464,39.77676227285275]\n                ]]\n            }\n        },\n        {\n            "id": 4,\n            "name": "New York City",\n            "geo_point" : {\n                "type": "Point",\n                "coordinates": [-74.005974, 40.712776]\n            },\n            "geo_poly": {\n                "type": "Polygon",\n                "coordinates": [[             [-74.00852603549784,40.73107908806126],\n                    [-74.03702059033735,40.70472625054263],\n                    [-73.98786450714653,40.70419899758365],\n                    [-74.00852603549784,40.73107908806126]\n                ]]\n            }\n        },\n        {\n            "id": 5,\n            "name": "Salt Lake City",\n            "geo_point" : {\n                "type": "Point",\n                "coordinates": [-111.920485, 40.7766079]\n            },\n            "geo_poly": {\n                "type": "Polygon",\n                "coordinates": [[           [-112.8291507578281,40.88206673094385],\n                    [-112.8956858211181,40.30332102898777],\n                    [-111.6032172200158,40.02757615254776],\n                    [-111.1456265349256,40.95908300700454],\n                    [-111.9047878338339,41.3291504973315],\n                    [-112.8291507578281,40.88206673094385]\n                ]]\n            },\n            "geo_line": {\n                "type": "LineString",\n                "coordinates": [        [-112.8291507578281,40.88206673094385],\n                    [-112.8956858211181,40.30332102898777],\n                    [-111.6032172200158,40.02757615254776],\n                    [-111.1456265349256,40.95908300700454],\n                    [-111.9047878338339,41.3291504973315],\n                    [-112.8291507578281,40.88206673094385]\n                ]\n            }\n        },\n        {\n            "id": 6,\n            "name": "Null Island",\n            "geo_point" : {\n                "type": "Point",\n                "coordinates": [null, null]\n            },\n            "geo_poly": null,\n            "geo_line": {\n                "type": "LineString",\n                "coordinates": [\n                    [-112.8291507578281,40.88206673094385],\n                    [null, null]\n                ]\n            }\n        },\n        {\n            "id": 7\n        },\n        {\n            "id": 8,\n            "name": "Hobbiton",\n            "geo_point" : [174.776230, -41.286461],\n            "geo_poly": "Somewhere in the shire",\n            "geo_line": {\n                "type": "LineString"\n            }\n        }\n    ]\n}\n'
			)
			.expect((r) => assert.ok(r.body.message == 'inserted 8 of 8 records'))
			.expect(200);
	});

	it('geoArea test 1', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({ operation: 'sql', sql: 'SELECT id, name, geoArea(geo_poly) as area FROM data.geo ORDER BY area ASC' })
			.expect((r) =>
				assert.deepEqual(r.body, [
					{
						id: 6,
						name: 'Null Island',
					},
					{
						id: 7,
						name: null,
					},
					{
						id: 8,
						name: 'Hobbiton',
					},
					{
						id: 2,
						name: 'North Adams',
						area: 2084050.5321900067,
					},
					{
						id: 4,
						name: 'New York City',
						area: 6153970.008639627,
					},
					{
						id: 3,
						name: 'Denver',
						area: 53950986.64863105,
					},
					{
						id: 1,
						name: 'Wellington',
						area: 168404308.63474682,
					},
					{
						id: 5,
						name: 'Salt Lake City',
						area: 14011200847.709723,
					},
				])
			)
			.expect(200);
	});

	it('geoArea test 2', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({ operation: 'sql', sql: 'SELECT id, name FROM data.geo where geoArea(geo_poly) > 53950986.64863106' })
			.expect((r) =>
				assert.deepEqual(r.body, [
					{
						id: 1,
						name: 'Wellington',
					},
					{
						id: 5,
						name: 'Salt Lake City',
					},
				])
			)
			.expect(200);
	});

	it('geoArea test 3', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({
				operation: 'sql',
				sql: 'SELECT geoArea(\'{"type":"Feature","geometry":{"type":"Polygon","coordinates":[[[0,0],[0.123456,0],[0.123456,0.123456],[0,0.123456]]]}}\')',
			})
			.expect((r) =>
				assert.deepEqual(r.body, [
					{
						'geoArea(\'{"type":"Feature","geometry":{"type":"Polygon","coordinates":[[[0,0],[0.123456,0],[0.123456,0.123456],[0,0.123456]]]}}\')': 188871526.05092356,
					},
				])
			)
			.expect(200);
	});

	it('geoLength test 1', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({
				operation: 'sql',
				sql: 'SELECT geoLength(\'{"type": "Feature","geometry": {"type": "LineString","coordinates": [[-104.97963309288025,39.76163265441438],[-104.9823260307312,39.76365323407955],[-104.99193906784058,39.75616442110704]]}}\')',
			})
			.expect((r) =>
				assert.deepEqual(r.body, [
					{
						'geoLength(\'{"type": "Feature","geometry": {"type": "LineString","coordinates": [[-104.97963309288025,39.76163265441438],[-104.9823260307312,39.76365323407955],[-104.99193906784058,39.75616442110704]]}}\')': 1.491544504248235,
					},
				])
			)
			.expect(200);
	});

	it('geoLength test 2', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({ operation: 'sql', sql: "SELECT id, name, geoLength(geo_line, 'miles') FROM data.geo" })
			.expect((r) =>
				assert.deepEqual(r.body, [
					{
						'id': 1,
						'name': 'Wellington',
						'geoLength(geo_line,"miles")': 13.842468187961332,
					},
					{
						id: 2,
						name: 'North Adams',
					},
					{
						id: 3,
						name: 'Denver',
					},
					{
						id: 4,
						name: 'New York City',
					},
					{
						'id': 5,
						'name': 'Salt Lake City',
						'geoLength(geo_line,"miles")': 283.9341846273217,
					},
					{
						'id': 6,
						'name': 'Null Island',
						'geoLength(geo_line,"miles")': 7397.000649273201,
					},
					{
						id: 7,
						name: null,
					},
					{
						id: 8,
						name: 'Hobbiton',
					},
				])
			)
			.expect(200);
	});

	it('geoLength test 3', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({ operation: 'sql', sql: "SELECT id, name FROM data.geo WHERE geoLength(geo_line, 'miles') < 100" })
			.expect((r) =>
				assert.deepEqual(r.body, [
					{
						id: 1,
						name: 'Wellington',
					},
				])
			)
			.expect(200);
	});

	it('geoDifference test 1', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({
				operation: 'sql',
				sql: 'SELECT geoDifference(\'{"type": "Feature","properties": {"name":"Colorado"},"geometry": {"type": "Polygon","coordinates": [[[-109.072265625,37.00255267215955],[-102.01904296874999,37.00255267215955],[-102.01904296874999,41.0130657870063],[-109.072265625,41.0130657870063],[-109.072265625,37.00255267215955]]]}}\',\'{"type": "Feature","properties": {"name":"City Park"},"geometry": {"type": "Polygon","coordinates": [[[-104.95973110198975,39.7543828214657],[-104.95955944061278,39.744781185675386],[-104.95904445648193,39.74422022399989],[-104.95835781097412,39.74402223643582],[-104.94097709655762,39.74392324244047],[-104.9408483505249,39.75434982844515],[-104.95973110198975,39.7543828214657]]]}}\')',
			})
			.expect((r) =>
				assert.deepEqual(r.body, [
					{
						'geoDifference(\'{"type": "Feature","properties": {"name":"Colorado"},"geometry": {"type": "Polygon","coordinates": [[[-109.072265625,37.00255267215955],[-102.01904296874999,37.00255267215955],[-102.01904296874999,41.0130657870063],[-109.072265625,41.0130657870063],[-109.072265625,37.00255267215955]]]}}\',\'{"type": "Feature","properties": {"name":"City Park"},"geometry": {"type": "Polygon","coordinates": [[[-104.95973110198975,39.7543828214657],[-104.95955944061278,39.744781185675386],[-104.95904445648193,39.74422022399989],[-104.95835781097412,39.74402223643582],[-104.94097709655762,39.74392324244047],[-104.9408483505249,39.75434982844515],[-104.95973110198975,39.7543828214657]]]}}\')':
							{
								type: 'Feature',
								properties: {
									name: 'Colorado',
								},
								geometry: {
									type: 'Polygon',
									coordinates: [
										[
											[-109.072265625, 37.00255267215955],
											[-102.01904296874999, 37.00255267215955],
											[-102.01904296874999, 41.0130657870063],
											[-109.072265625, 41.0130657870063],
											[-109.072265625, 37.00255267215955],
										],
										[
											[-104.95973110198975, 39.7543828214657],
											[-104.9408483505249, 39.75434982844515],
											[-104.94097709655762, 39.74392324244047],
											[-104.95835781097412, 39.74402223643582],
											[-104.95904445648193, 39.74422022399989],
											[-104.95955944061278, 39.744781185675386],
											[-104.95973110198975, 39.7543828214657],
										],
									],
								},
							},
					},
				])
			)
			.expect(200);
	});

	it('geoDifference test 2', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({
				operation: 'sql',
				sql: 'SELECT geoDifference(\'{"type": "Feature","properties": {"name":"Colorado"},"geometry": {"type": "Polygon","coordinates": [[[-109.072265625,37.00255267215955],[-102.01904296874999,37.00255267215955],[-102.01904296874999,41.0130657870063],[-109.072265625,41.0130657870063],[-109.072265625,37.00255267215955]]]}}\', null)',
			})
			.expect((r) => assert.deepEqual(r.body, [{}]))
			.expect(200);
	});

	it('geoDistance test 1', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({
				operation: 'sql',
				sql: "SELECT geoDistance('[-104.979127,39.761563]', '[-77.035248,38.889475]', 'miles')",
			})
			.expect((r) =>
				assert.deepEqual(r.body, [
					{
						"geoDistance('[-104.979127,39.761563]','[-77.035248,38.889475]','miles')": 1488.6913067538915,
					},
				])
			)
			.expect(200);
	});

	it('geoDistance test 2', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({
				operation: 'sql',
				sql: "SELECT id, name, geoDistance('[-104.979127,39.761563]', geo_point, 'miles') as distance FROM data.geo WHERE geoDistance('[-104.979127,39.761563]', geo_point, 'kilometers') < 40 ORDER BY distance ASC",
			})
			.expect((r) =>
				assert.deepEqual(r.body, [
					{
						id: 3,
						name: 'Denver',
						distance: 1.6520011088478226,
					},
				])
			)
			.expect(200);
	});

	it('geoDistance test 3', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({
				operation: 'sql',
				sql: "SELECT id, name, geoDistance('[-104.979127,39.761563]', geo_point, 'miles') as distance FROM data.geo",
			})
			.expect((r) =>
				assert.deepEqual(r.body, [
					{
						id: 1,
						name: 'Wellington',
						distance: 7525.228704326891,
					},
					{
						id: 2,
						name: 'North Adams',
						distance: 1658.5109905949885,
					},
					{
						id: 3,
						name: 'Denver',
						distance: 1.6520011088478226,
					},
					{
						id: 4,
						name: 'New York City',
						distance: 1626.4974205601618,
					},
					{
						id: 5,
						name: 'Salt Lake City',
						distance: 372.4978228173876,
					},
					{
						id: 6,
						name: 'Null Island',
						distance: 7010.231359296063,
					},
					{
						id: 7,
						name: null,
					},
					{
						id: 8,
						name: 'Hobbiton',
						distance: 7525.228704326891,
					},
				])
			)
			.expect(200);
	});

	it('geoNear test 1', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({
				operation: 'sql',
				sql: "SELECT id, name FROM data.geo WHERE geoNear('[-104.979127,39.761563]', geo_point, 50, 'miles')",
			})
			.expect((r) =>
				assert.deepEqual(r.body, [
					{
						id: 3,
						name: 'Denver',
					},
				])
			)
			.expect(200);
	});

	it('geoNear test 2', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({
				operation: 'sql',
				sql: "SELECT id, name, geoDistance('[-104.979127,39.761563]', geo_point, 'miles') as distance FROM data.geo WHERE geoNear('[-104.979127,39.761563]', geo_point, 20, 'degrees') ORDER BY distance ASC",
			})
			.expect((r) =>
				assert.deepEqual(r.body, [
					{
						id: 3,
						name: 'Denver',
						distance: 1.6520011088478226,
					},
					{
						id: 5,
						name: 'Salt Lake City',
						distance: 372.4978228173876,
					},
				])
			)
			.expect(200);
	});

	it('geoContains test 1', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({
				operation: 'sql',
				sql: 'SELECT id, name FROM data.geo WHERE geoContains(\'{"type": "Feature","properties": {"name":"Colorado"},"geometry": {"type": "Polygon","coordinates": [[[-109.072265625,37.00255267],[-102.01904296874999,37.00255267],[-102.01904296874999,41.01306579],[-109.072265625,41.01306579],[-109.072265625,37.00255267]]]}}\', geo_point)',
			})
			.expect((r) =>
				assert.deepEqual(r.body, [
					{
						id: 3,
						name: 'Denver',
					},
				])
			)
			.expect(200);
	});

	it('geoContains test 2', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({
				operation: 'sql',
				sql: 'SELECT id, name FROM data.geo WHERE geoContains(geo_poly, \'{"type": "Feature","properties": {"name": "HarperDB Headquarters"},"geometry": {"type": "Polygon","coordinates": [[[-104.98060941696167,39.760704817357905],[-104.98053967952728,39.76065120861263],[-104.98055577278137,39.760642961109674],[-104.98037070035934,39.76049450588716],[-104.9802714586258,39.76056254790385],[-104.9805235862732,39.76076461167841],[-104.98060941696167,39.760704817357905]]]}}\')',
			})
			.expect((r) =>
				assert.deepEqual(r.body, [
					{
						id: 3,
						name: 'Denver',
					},
				])
			)
			.expect(200);
	});

	it('geoEqual test 1', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({
				operation: 'sql',
				sql: 'SELECT * FROM data.geo WHERE geoEqual(geo_poly, \'{"type": "Feature","properties": {"name": "HarperDB Headquarters"},"geometry": {"type": "Polygon","coordinates": [[[-104.98060941696167,39.760704817357905],[-104.98053967952728,39.76065120861263],[-104.98055577278137,39.760642961109674],[-104.98037070035934,39.76049450588716],[-104.9802714586258,39.76056254790385],[-104.9805235862732,39.76076461167841],[-104.98060941696167,39.760704817357905]]]}}\')',
			})
			.expect((r) => assert.ok(r.body.length == 0))
			.expect(200);
	});

	it('geoCrosses test 1', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({
				operation: 'sql',
				sql: 'SELECT id, name FROM data.geo WHERE geoCrosses(geo_poly,\'{"type": "Feature","properties": {"name": "Highway I-25"},"geometry": {"type": "LineString","coordinates": [[-104.9139404296875,41.00477542222947],[-105.0238037109375,39.715638134796336],[-104.853515625,39.53370327008705],[-104.853515625,38.81403111409755],[-104.61181640625,38.39764411353178],[-104.8974609375,37.68382032669382],[-104.501953125,37.00255267215955]]}}\')',
			})
			.expect((r) => assert.deepEqual(r.body, [{ id: 3, name: 'Denver' }]))
			.expect(200);
	});

	it('geoConvert test 1', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({
				operation: 'sql',
				sql: "SELECT geoConvert('[-104.979127,39.761563]','point','{\"name\": \"HarperDB Headquarters\"}')",
			})
			.expect((r) =>
				assert.deepEqual(r.body, [
					{
						"geoConvert('[-104.979127,39.761563]','point','{\"name\": \"HarperDB Headquarters\"}')": {
							type: 'Feature',
							properties: '{"name": "HarperDB Headquarters"}',
							geometry: {
								type: 'Point',
								coordinates: [-104.979127, 39.761563],
							},
						},
					},
				])
			)
			.expect(200);
	});

	it('Drop table "geo"', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({ operation: 'drop_table', schema: 'data', table: 'geo' })
			.expect((r) => assert.ok(r.body.message == "successfully deleted table 'data.geo'"))
			.expect(200);
	});

	//SQL Tests Main Folder

	it('insert value into table', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({
				operation: 'sql',
				sql: "INSERT INTO northnwd.customers (customerid, postalcode, companyname) VALUES ('TEST3', 11385, 'Microsoft')",
			})
			.expect((r) => assert.ok(r.body.message == 'inserted 1 of 1 records'))
			.expect((r) => assert.ok(r.body.inserted_hashes[0] == 'TEST3'))
			.expect(200);
	});

	it('insert value into table confirm', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({
				operation: 'sql',
				sql: "SELECT customerid, postalcode, companyname FROM northnwd.customers WHERE customerid = 'TEST3'",
			})
			.expect((r) => assert.ok(r.body[0].customerid == 'TEST3'))
			.expect((r) => assert.ok(r.body[0].postalcode == 11385))
			.expect((r) => assert.ok(r.body[0].companyname == 'Microsoft'))
			.expect(200);
	});

	it('update value in table', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({
				operation: 'sql',
				sql: "UPDATE northnwd.customers SET companyname = 'Google' WHERE customerid = 'TEST3'",
			})
			.expect((r) =>
				assert.ok(
					r.body.message == 'updated 1 of 1 records',
					'Expected response message to eql "updated 1 of 1 records"'
				)
			)
			.expect((r) => assert.ok(r.body.update_hashes[0] == 'TEST3'))
			.expect(200);
	});

	it('update value in table confirm', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({
				operation: 'sql',
				sql: "SELECT customerid, postalcode, companyname FROM northnwd.customers WHERE customerid = 'TEST3'",
			})
			.expect((r) => assert.ok(r.body[0].customerid == 'TEST3'))
			.expect((r) => assert.ok(r.body[0].postalcode == 11385))
			.expect((r) => assert.ok(r.body[0].companyname == 'Google'))
			.expect(200);
	});

	it('attempt to update __createdtime__ in table', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({
				operation: 'sql',
				sql: "UPDATE northnwd.customers SET __createdtime__ = 'bad value' WHERE customerid = 'TEST3'",
			})
			.expect((r) =>
				assert.ok(
					r.body.message == 'updated 1 of 1 records',
					'Expected response message to eql "updated 1 of 1 records"'
				)
			)
			.expect((r) => assert.ok(r.body.update_hashes[0] == 'TEST3'))
			.expect(200);
	});

	it('Confirm __createdtime__ did not get changed', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({ operation: 'sql', sql: "SELECT __createdtime__ FROM northnwd.customers WHERE customerid = 'TEST3'" })
			.expect((r) => assert.ok(r.body[0].__createdtime__ != 'bad value'))
			.expect(200);
	});

	it('delete value from table', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({ operation: 'sql', sql: "DELETE FROM northnwd.customers WHERE customerid = 'TEST3'" })
			.expect((r) => assert.ok(r.body.message.includes('successfully deleted')))
			.expect(200);
	});

	it('delete value from table confirm', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({
				operation: 'sql',
				sql: "SELECT customerid, postalcode, companyname FROM northnwd.customers WHERE companyname = 'Microsoft'",
			})
			.expect((r) => assert.ok(r.body.length == 0))
			.expect(200);
	});

	it('select w/ where in numeric values as strings', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({ operation: 'sql', sql: "select * from dev.books WHERE id IN('1','2','3') ORDER BY id" })
			.expect((r) => assert.ok(r.body.length == 3))
			.expect((r) => {
				r.body.forEach((row, i) => {
					assert.ok(row.id == i + 1);
				});
			})
			.expect(200);
	});

	it('select w/ where between', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({ operation: 'sql', sql: 'select * from dev.books WHERE id BETWEEN 1 AND 3 ORDER BY id' })
			.expect((r) => assert.ok(r.body.length == 3))
			.expect((r) => {
				r.body.forEach((row, i) => {
					assert.ok(row.id == i + 1);
				});
			})
			.expect(200);
	});

	it('select w/ where not between', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({ operation: 'sql', sql: 'select * from dev.books WHERE id NOT BETWEEN 1 AND 3 ORDER BY id' })
			.expect((r) => {
				assert.ok(r.body.length == 47);
				r.body.forEach((row, i) => {
					assert.ok(row.id > 3);
				});
			})
			.expect(200);
	});

	it('select w/ where value equals 0', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({ operation: 'sql', sql: 'select * from dev.books WHERE books_count = 0 ' })
			.expect((r) => assert.ok(r.body.length == 4))
			.expect((r) => {
				r.body.forEach((row) => {
					assert.ok(row.books_count == 0);
				});
			})
			.expect(200);
	});

	it('select w/ where value equals "false"', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({ operation: 'sql', sql: "select * from dev.books WHERE nytimes_best_seller = 'false' " })
			.expect((r) => assert.ok(r.body.length == 25))
			.expect((r) => {
				r.body.forEach((row) => {
					assert.ok(row.nytimes_best_seller == false);
				});
			})
			.expect(200);
	});

	it('select employees orderby id asc', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({
				operation: 'sql',
				sql: `select ${generic.emps_id}, *
              from ${generic.schema}.${generic.emps_tb}
              order by ${generic.emps_id} asc`,
			})
			.expect((r) => assert.ok(r.body.length == 10))
			.expect((r) => assert.ok(r.body[0].employeeid == 1))
			.expect((r) => assert.ok(r.body[1].employeeid == 2))
			.expect((r) => assert.ok(r.body[8].employeeid == 9))
			.expect((r) => assert.ok(r.body[9].employeeid == 25))
			.expect(200);
	});

	it('select 2 + 2', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({ operation: 'sql', sql: 'select 2 + 2 ' })
			.expect((r) => assert.ok(r.body[0]['2 + 2'] == 4))
			.expect(200);
	});

	it('select * FROM orders - test no schema', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({ operation: 'sql', sql: 'select * FROM orders' })
			.expect((r) => assert.ok(r.body.error == 'schema not defined for table orders'))
			.expect(500);
	});

	it('select * from call.aggr - reserved words', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({ operation: 'sql', sql: 'select * from call.aggr' })
			.expect(400);
	});

	it('select * from `call`.`aggr` - reserved words', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({
				operation: 'sql',
				sql: 'select age AS `alter`, * from `call`.`aggr` as `and` WHERE `all` > 3 ORDER BY `and`.`all` desc',
			})
			.expect((r) => assert.ok(r.body[0].all == 11))
			.expect(200);
	});

	it('select * from call.aggr where id = 11 - select dot & double dot', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({ operation: 'sql', sql: 'select * from `call`.`aggr` where `all` = 11' })
			.expect((r) => assert.ok(r.body.length == 1, 'Expected response message length to eql 1'))
			.expect((r) => assert.ok(r.body[0].owner_name == '..'))
			.expect((r) => assert.ok(r.body[0].dog_name == '.'))
			.expect(200);
	});

	it('select * from invalid schema - expect fail', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({ operation: 'sql', sql: 'select * from `braaah`.`aggr`' })
			.expect((r) => assert.ok(r.body.error == "database 'braaah' does not exist"))
			.expect(404);
	});

	it('select * from invalid table - expect fail', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({ operation: 'sql', sql: 'select * from `call`.`braaaah`' })
			.expect((r) => assert.ok(r.body.error == "Table 'call.braaaah' does not exist"))
			.expect(404);
	});

	it('select orders orderby id desc', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({
				operation: 'sql',
				sql: `select ${generic.ords_id}, *
              from ${generic.schema}.${generic.ords_tb}
              order by ${generic.ords_id} desc`,
			})
			.expect((r) => assert.ok(r.body[0].orderid == 11077))
			.expect(200);
	});

	it('select count(*) orders where shipregion is null', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({
				operation: 'sql',
				sql: `select count(*) as \`count\`
              from ${generic.schema}.${generic.ords_tb}
              where shipregion IS NULL`,
			})
			.expect((r) => assert.ok(r.body[0].count == 414))
			.expect(200);
	});

	it('select count(*) orders where shipregion is not null', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({
				operation: 'sql',
				sql: `select count(*) AS \`count\`
              from ${generic.schema}.${generic.ords_tb}
              where shipregion is not null`,
			})
			.expect((r) => assert.ok(r.body[0].count == 416))
			.expect(200);
	});

	it('select most buyer orderby price asc', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({
				operation: 'sql',
				sql: `select a.${generic.ords_id},
                     a.productid,
                     d.companyname,
                     d.contactmame,
                     b.productname,
                     sum(a.unitprice) as unitprice,
                     sum(a.quantity),
                     sum(a.discount)
              from ${generic.schema}.${generic.ordd_tb} a
                       join ${generic.schema}.${generic.prod_tb} b on a.${generic.prod_id} = b.${generic.prod_id}
                       join ${generic.schema}.${generic.ords_tb} c on a.${generic.ords_id} = c.${generic.ords_id}
                       join ${generic.schema}.${generic.cust_tb} d on c.${generic.cust_id} = d.${generic.cust_id}
              group by a.${generic.ords_id}, a.productid, d.companyname, d.contactmame, b.productname
              order by unitprice desc, d.companyname`,
			})
			.expect((r) => assert.ok(r.body[0].companyname == 'Berglunds snabbk\ufffdp'))
			.expect((r) => assert.ok(r.body[1].companyname == 'Great Lakes Food Market'))
			.expect(200);
	});

	it('select most buyer orderby price asc & companyname alias', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({
				operation: 'sql',
				sql: `select a.${generic.ords_id},
                     a.productid,
                     d.companyname    as compname,
                     d.contactmame,
                     b.productname,
                     sum(a.unitprice) as unitprice,
                     sum(a.quantity),
                     sum(a.discount)
              from ${generic.schema}.${generic.ordd_tb} a
                       join ${generic.schema}.${generic.prod_tb} b on a.${generic.prod_id} = b.${generic.prod_id}
                       join ${generic.schema}.${generic.ords_tb} c on a.${generic.ords_id} = c.${generic.ords_id}
                       join ${generic.schema}.${generic.cust_tb} d on c.${generic.cust_id} = d.${generic.cust_id}
              group by a.${generic.ords_id}, a.productid, d.companyname, d.contactmame, b.productname
              order by unitprice desc, compname`,
			})
			.expect((r) => assert.ok(r.body[0].compname == 'Berglunds snabbk\ufffdp'))
			.expect((r) => assert.ok(r.body[1].compname == 'Great Lakes Food Market'))
			.expect(200);
	});

	it('select most buyer orderby order_id asc & product_id desc', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({
				operation: 'sql',
				sql: `select a.${generic.ords_id} as ords_id,
                     a.productid,
                     d.companyname        as compname,
                     d.contactmame,
                     b.productname,
                     sum(a.unitprice)     as unitprice,
                     sum(a.quantity),
                     sum(a.discount)
              from ${generic.schema}.${generic.ordd_tb} a
                       join ${generic.schema}.${generic.prod_tb} b on a.${generic.prod_id} = b.${generic.prod_id}
                       join ${generic.schema}.${generic.ords_tb} c on a.${generic.ords_id} = c.${generic.ords_id}
                       join ${generic.schema}.${generic.cust_tb} d on c.${generic.cust_id} = d.${generic.cust_id}
              group by a.${generic.ords_id}, a.productid, d.companyname, d.contactmame, b.productname
              order by ords_id desc, a.productid desc`,
			})
			.expect((r) => assert.ok(r.body[0].ords_id == 10248))
			.expect((r) => assert.ok(r.body[1].ords_id == 10248))
			.expect((r) => assert.ok(r.body[19].ords_id == 10254))
			.expect((r) => assert.ok(r.body[0].companyname == 'Vins et alcools Chevalier'))
			.expect((r) => assert.ok(r.body[19].companyname == 'Chop-suey Chinese'))
			.expect((r) => assert.ok(r.body[0].productid == 72))
			.expect((r) => assert.ok(r.body[1].productid == 42))
			.expect((r) => assert.ok(r.body[19].productid == 24))
			.expect(200);
	});

	it('select product orderby id asc', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({
				operation: 'sql',
				sql: `select ${generic.prod_id}, *
              from ${generic.schema}.${generic.prod_tb}
              order by ${generic.prod_id} asc`,
			})
			.expect((r) => assert.ok(r.body[0].productid == 1))
			.expect(200);
	});

	it('select customers orderby id asc', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({
				operation: 'sql',
				sql: `select ${generic.cust_id}, *
              from ${generic.schema}.${generic.cust_tb}
              order by ${generic.cust_id} asc`,
			})
			.expect((r) => assert.ok(r.body[0].customerid == 'ALFKI'))
			.expect(200);
	});

	it('select all details join 5 table where customername', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({
				operation: 'sql',
				sql: `select a.${generic.cust_id},
                     a.companyname,
                     a.contactmame,
                     b.${generic.ords_id},
                     b.shipname,
                     d.productid,
                     d.productname,
                     d.unitprice,
                     c.quantity,
                     c.discount,
                     e.employeeid,
                     e.firstname,
                     e.lastname
              from ${generic.schema}.${generic.cust_tb} a
                       join ${generic.schema}.${generic.ords_tb} b on a.${generic.cust_id} = b.${generic.cust_id}
                       join ${generic.schema}.${generic.ordd_tb} c on b.${generic.ordd_id} = c.${generic.ordd_id}
                       join ${generic.schema}.${generic.prod_tb} d on c.${generic.prod_id} = d.${generic.prod_id}
                       join ${generic.schema}.${generic.emps_tb} e on b.${generic.emps_id} = e.${generic.emps_id}
              where a.companyname = 'Alfreds Futterkiste'`,
			})
			.expect((r) => assert.ok(r.body[0].customerid == 'ALFKI'))
			.expect(200);
	});

	it('select * with LEFT OUTER JOIN', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({ operation: 'sql', sql: 'SELECT * FROM dev.breed b LEFT JOIN dev.dog d ON b.id = d.breed_id' })
			.expect((r) => assert.ok(r.body.length == 351))
			.expect((r) => {
				r.body.forEach((row) => {
					const keys = Object.keys(row);
					assert.ok(keys.length == 16);
					Object.keys(row).forEach((key) => {
						assert.ok(row[key] != undefined);
					});
				});
			})
			.expect(200);
	});

	it('select specific columns with LEFT OUTER JOIN Copy', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({
				operation: 'sql',
				sql: 'SELECT b.name, b.id, d.* FROM dev.breed b LEFT JOIN dev.dog d ON b.id = d.breed_id',
			})
			.expect((r) => assert.ok(r.body.length == 351))
			.expect((r) => {
				r.body.forEach((row) => {
					const keys = Object.keys(row);
					assert.ok(keys.length == 11);
					Object.keys(row).forEach((key) => {
						assert.ok(row[key] != undefined);
					});
				});
			})
			.expect(200);
	});

	it('select order details', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({
				operation: 'sql',
				sql: `select ${generic.ordd_id}, productid, unitprice, quantity, discount
              from ${generic.schema}.${generic.ordd_tb}
              order by ${generic.ordd_id} asc`,
			})
			.expect((r) => assert.ok(r.body[0].orderid == 10248))
			.expect(200);
	});

	it('select count groupby country', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({
				operation: 'sql',
				sql: `select count(${generic.cust_id}) as counter, country
              from ${generic.schema}.${generic.cust_tb}
              group by country
              order by counter desc`,
			})
			.expect((r) => assert.ok(r.body[0].country == 'USA'))
			.expect(200);
	});

	it('select most have the extension employees', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({
				operation: 'sql',
				sql: `select extension, *
                                  from ${generic.schema}.${generic.emps_tb}
                                  order by extension desc`,
			})
			.expect((r) => assert.ok(r.body[0].firstname == 'Nancy'))
			.expect(200);
	});

	it('select top 10 most price of product', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({
				operation: 'sql',
				sql: `select categoryid, productname, quantityperunit, unitprice, *
              from ${generic.schema}.${generic.prod_tb}
              order by unitprice desc limit 10 `,
			})
			.expect((r) => assert.ok(r.body[0].productname == 'C\ufffdte de Blaye'))
			.expect(200);
	});

	it('select count min max avg sum price of products', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({
				operation: 'sql',
				sql: `select count(unitprice) as allproducts,
                     min(unitprice)   as minprice,
                     max(unitprice)   as maxprice,
                     avg(unitprice)   as avgprice,
                     sum(unitprice)   as sumprice
              from ${generic.schema}.${generic.prod_tb} `,
			})
			.expect((r) => assert.ok(r.body[0].allproducts == 77))
			.expect(200);
	});

	it('select round unit price using alias', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({
				operation: 'sql',
				sql: `SELECT ROUND(unitprice) AS Price
              FROM ${generic.schema}.${generic.prod_tb}
              GROUP BY ROUND(unitprice)`,
			})
			.expect((r) => {
				let objKeysData = Object.keys(r.body[0]);
				assert.ok(objKeysData[0] == 'Price');
			})
			.expect(200);
	});

	it('select where (like)and(<=>)', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({
				operation: 'sql',
				sql: `select *
              from ${generic.schema}.${generic.prod_tb}
              where (productname like 'T%')
                and (unitprice > 100) `,
			})
			.expect((r) => assert.ok(r.body[0].unitprice > 100))
			.expect(200);
	});

	it('select - where attr < comparator', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({
				operation: 'sql',
				sql: `select *
                                  from ${generic.schema}.${generic.prod_tb}
                                  where unitprice < 81`,
			})
			.expect((r) => {
				r.body.forEach((record) => {
					assert.ok(record.unitprice < 81);
				});
			})
			.expect(200);
	});

	it('select - where attr <= comparator', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({
				operation: 'sql',
				sql: `select *
                                  from ${generic.schema}.${generic.prod_tb}
                                  where unitprice <= 81`,
			})
			.expect((r) => {
				r.body.forEach((record) => {
					assert.ok(record.unitprice <= 81);
				});
			})
			.expect(200);
	});

	it('select - where attr > comparator', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({
				operation: 'sql',
				sql: `select *
                                  from ${generic.schema}.${generic.prod_tb}
                                  where unitprice > 81`,
			})
			.expect((r) => {
				r.body.forEach((record) => {
					assert.ok(record.unitprice > 81);
				});
			})
			.expect(200);
	});

	it('select - where attr >= comparator', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({
				operation: 'sql',
				sql: `select *
                                  from ${generic.schema}.${generic.prod_tb}
                                  where unitprice >= 81`,
			})
			.expect((r) => {
				r.body.forEach((record) => {
					assert.ok(record.unitprice >= 81);
				});
			})
			.expect(200);
	});

	it('select - where attr w/ multiple comparators', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({
				operation: 'sql',
				sql: `select *
              from ${generic.schema}.${generic.prod_tb}
              where unitprice > 20
                AND unitprice <= 81`,
			})
			.expect((r) => {
				r.body.forEach((record) => {
					assert.ok(record.unitprice > 20);
					assert.ok(record.unitprice <= 81);
				});
			})
			.expect(200);
	});

	it('select - where w/ multiple attr comparators', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({
				operation: 'sql',
				sql: `select *
              from ${generic.schema}.${generic.prod_tb}
              where unitprice > 10
                AND unitprice <= 81
                AND unitsinstock = 0`,
			})
			.expect((r) => {
				r.body.forEach((record) => {
					assert.ok(record.unitprice > 10);
					assert.ok(record.unitprice <= 81);
					assert.ok(record.unitsinstock == 0);
				});
			})
			.expect(200);
	});

	it('select - where w/ multiple comparators for multiple attrs', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({
				operation: 'sql',
				sql: `select *
              from ${generic.schema}.${generic.prod_tb}
              where unitprice > 10
                AND unitprice <= 81
                AND unitsinstock > 10`,
			})
			.expect((r) => {
				r.body.forEach((record) => {
					assert.ok(record.unitprice > 10);
					assert.ok(record.unitprice <= 81);
					assert.ok(record.unitsinstock > 10);
				});
			})
			.expect(200);
	});

	it('select - where w/ IN() and multiple of comparators for multiple attrs', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({
				operation: 'sql',
				sql: `select *
              from ${generic.schema}.${generic.prod_tb}
              where unitprice > 10
                AND unitprice <= 81
                AND unitsinstock > 10
                AND supplierid IN (1, 2, 3, 4)`,
			})
			.expect((r) => {
				r.body.forEach((record) => {
					assert.ok(record.unitprice > 10);
					assert.ok(record.unitprice <= 81);
					assert.ok(record.unitsinstock > 10);
					assert.ok([1, 2, 3, 4].includes(record.supplierid));
				});
			})
			.expect(200);
	});

	it('update SQL employee', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({
				operation: 'sql',
				sql: `update ${generic.schema}.${generic.emps_tb}
              set address = 'abc1234'
              where ${generic.emps_id} = 1`,
			})
			.expect((r) => assert.ok(r.body.update_hashes[0] == 1))
			.expect(200);
	});

	it('select verify SQL update', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({
				operation: 'sql',
				sql: `select address
                                  from ${generic.schema}.${generic.emps_tb}
                                  where ${generic.emps_id} = 1`,
			})
			.expect((r) => assert.ok(r.body[0].address == 'abc1234'))
			.expect(200);
	});

	it('select * dev.long_text', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({ operation: 'sql', sql: 'select * FROM dev.long_text' })
			.expect((r) => assert.ok(r.body.length == 25))
			.expect((r) => {
				r.body.forEach((record) => {
					assert.ok(record.remarks.length > 255);
				});
			})
			.expect(200);
	});

	it('select * dev.long_text regexp', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({ operation: 'sql', sql: "select * FROM dev.long_text where remarks regexp 'dock'" })
			.expect((r) => assert.ok(r.body.length == 3))
			.expect((r) => {
				r.body.forEach((record) => {
					assert.ok(record.remarks.indexOf('dock') >= 0);
				});
			})
			.expect(200);
	});

	it('update employee with falsey data', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({
				operation: 'sql',
				sql: `UPDATE ${generic.schema}.${generic.emps_tb}
              SET address   = false,
                  hireDate  = 0,
                  notes     = null,
                  birthdate = undefined
              WHERE ${generic.emps_id} = 1`,
			})
			.expect((r) => assert.ok(r.body.update_hashes[0] == 1))
			.expect(200);
	});

	it('select employee to confirm falsey update', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({
				operation: 'sql',
				sql: `SELECT *
                                  FROM ${generic.schema}.${generic.emps_tb}
                                  WHERE ${generic.emps_id} = 1`,
			})
			.expect((r) => assert.ok(!r.body[0].address))
			.expect((r) => assert.ok(r.body[0].hireDate == 0))
			.expect((r) => assert.ok(!r.body.hasOwnProperty('notes')))
			.expect((r) => assert.ok(!r.body.hasOwnProperty('birthdate')))
			.expect(200);
	});

	it('setup for next test - insert array', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({
				operation: 'insert',
				schema: `${generic.schema}`,
				table: `${generic.cust_tb}`,
				records: [{ array: ['arr1', 'arr2', 'arr3'], customerid: 'arrayTest' }],
			})
			.expect((r) => assert.ok(r.body.message == 'inserted 1 of 1 records'))
			.expect((r) => assert.ok(r.body.inserted_hashes[0] == 'arrayTest'))
			.expect(200);
	});

	it('select array from table', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({
				operation: 'sql',
				sql: `select *
                                  from ${generic.schema}.${generic.cust_tb}
                                  where ${generic.cust_id} = 'arrayTest'`,
			})
			.expect((r) => assert.deepEqual(r.body[0].array, ['arr1', 'arr2', 'arr3']))
			.expect((r) => assert.ok(r.body[0].customerid == 'arrayTest'))
			.expect(200);
	});

	it('setup for next test - insert object', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({
				operation: 'insert',
				schema: `${generic.schema}`,
				table: `${generic.cust_tb}`,
				records: [{ object: { red: '1', white: '2', blue: '3' }, customerid: 'objTest' }],
			})
			.expect((r) => assert.ok(r.body.message == 'inserted 1 of 1 records'))
			.expect((r) => assert.ok(r.body.inserted_hashes[0] == 'objTest'))
			.expect(200);
	});

	it('select object from table', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({
				operation: 'sql',
				sql: `select *
                                  from ${generic.schema}.${generic.cust_tb}
                                  where ${generic.cust_id} = 'objTest'`,
			})
			.expect((r) => assert.deepEqual(r.body[0].object, { red: '1', white: '2', blue: '3' }))
			.expect((r) => assert.ok(r.body[0].customerid == 'objTest'))
			.expect(200);
	});

	it('select without sql parameter', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({
				operation: 'sql',
				slq: `select *
                                  from ${generic.schema}.${generic.cust_tb}`,
			})
			.expect((r) => assert.ok(r.body.error == "The 'sql' parameter is missing from the request body"))
			.expect(400);
	});

	it('select * dev.remarks_blob like w/ special chars pt1', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({ operation: 'sql', sql: "select * FROM dev.remarks_blob where remarks like '%4 Bedroom/2.5+ bath%'" })
			.expect((r) => assert.ok(r.body.length == 3))
			.expect((r) => {
				r.body.forEach((record) => {
					let keys = Object.keys(record);
					if (keys.indexOf('__updatedtime__') > -1 && keys.indexOf('__createdtime__') > -1) {
						assert.ok(keys.length == 5);
					} else {
						assert.ok(keys.length == 3);
					}
					assert.ok(record.remarks.includes('4 Bedroom/2.5+ bath'));
				});
			})
			.expect(200);
	});

	it('select * dev.remarks_blob like w/ special chars pt2', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({
				operation: 'sql',
				sql: "select * FROM dev.remarks_blob where remarks like 'This custom built dream home is stunningly gorgeous!  It is a 5+ acres luxury equestrian property with access to Jennings State Forest from your backyard, no need to trailer your horses anywhere for a beautifully scenic peaceful ride.%'",
			})
			.expect((r) => assert.ok(r.body.length == 2))
			.expect((r) => {
				r.body.forEach((record) => {
					let keys = Object.keys(record);
					if (keys.indexOf('__updatedtime__') > -1 && keys.indexOf('__createdtime__') > -1) {
						assert.ok(keys.length == 5);
					} else {
						assert.ok(keys.length == 3);
					}
					assert.ok(
						record.remarks.includes(
							'This custom built dream home is stunningly gorgeous!  It is a 5+ acres luxury equestrian property with access to' +
								' Jennings State Forest from your backyard, no need to trailer your horses anywhere for a beautifully scenic peaceful ride.'
						)
					);
				});
			})
			.expect(200);
	});

	it('select * dev.remarks_blob like w/ special chars pt3', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({
				operation: 'sql',
				sql: "select * FROM dev.remarks_blob where remarks like '%...GOURGEOUS HOME in a Heart of MANDARIN,Next to Loretto Magnet schoolClose to I-295, shopping & entertainment. Gated community! Loaded with upgrades:%'",
			})
			.expect((r) => assert.ok(r.body.length == 2))
			.expect((r) => {
				r.body.forEach((record) => {
					let keys = Object.keys(record);
					if (keys.indexOf('__updatedtime__') > -1 && keys.indexOf('__createdtime__') > -1) {
						assert.ok(keys.length == 5);
					} else {
						assert.ok(keys.length == 3);
					}
					assert.ok(
						record.remarks.includes(
							'...GOURGEOUS HOME in a Heart of MANDARIN,Next to Loretto Magnet schoolClose to I-295, ' +
								'shopping & entertainment. Gated community! Loaded with upgrades:'
						)
					);
				});
			})
			.expect(200);
	});

	it('select * dev.remarks_blob like w/ special chars pt4', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({
				operation: 'sql',
				sql: "select * FROM dev.remarks_blob where remarks like '**Spacious & updated 2-story home on large preserve lot nearly 1/2 acre! Concrete block constr. & desirable ICW location near JTB, shopping, dining & the beach! Great split BD flrpln w/soaring ceilings features 4BD + office, upstairs loft & 3 full BA.'",
			})
			.expect((r) => assert.ok(r.body.length == 1, 'Expected response message length to eql 1'))
			.expect((r) => {
				r.body.forEach((record) => {
					let keys = Object.keys(record);
					if (keys.indexOf('__updatedtime__') > -1 && keys.indexOf('__createdtime__') > -1) {
						assert.ok(keys.length == 5);
					} else {
						assert.ok(keys.length == 3);
					}
					assert.ok(
						record.remarks.includes(
							'**Spacious & updated 2-story home on large preserve ' +
								'lot nearly 1/2 acre! Concrete block constr. & desirable ICW location near JTB, shopping, ' +
								'dining & the beach! Great split BD flrpln w/soaring ceilings features 4BD + office, upstairs loft & 3 full BA.'
						)
					);
				});
			})
			.expect(200);
	});

	it('select * dev.remarks_blob like w/ special chars pt5', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({ operation: 'sql', sql: "select * FROM dev.remarks_blob where remarks like '%'" })
			.expect((r) => assert.ok(r.body.length == 11))
			.expect((r) => {
				r.body.forEach((record) => {
					let keys = Object.keys(record);
					if (keys.indexOf('__updatedtime__') > -1 && keys.indexOf('__createdtime__') > -1) {
						assert.ok(keys.length == 5);
					} else {
						assert.ok(keys.length == 3);
					}
				});
			})
			.expect(200);
	});

	it('select * FROM schema.ords_tb LIMIT 100 OFFSET 0', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({
				operation: 'sql',
				sql: `select *
                                  FROM ${generic.schema}.${generic.ords_tb} LIMIT 100
                                  OFFSET 0`,
			})
			.expect((r) => assert.ok(r.body.length == 100))
			.expect((r) => assert.ok(r.body[0].orderid == 10248))
			.expect((r) => assert.ok(r.body[99].orderid == 10347))
			.expect(200);
	});

	it('select * FROM schema.ords_tb LIMIT 100 OFFSET 0 Copy', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({
				operation: 'sql',
				sql: `select *
                                  FROM ${generic.schema}.${generic.ords_tb} LIMIT 100
                                  OFFSET 100`,
			})
			.expect((r) => assert.ok(r.body.length == 100))
			.expect((r) => assert.ok(r.body[0].orderid == 10348))
			.expect((r) => assert.ok(r.body[99].orderid == 10447))
			.expect(200);
	});

	it('select AVE(rating) w/ join, group by and order by (1 of 2)', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({
				operation: 'sql',
				sql: 'select b.authors as authors, AVG(r.rating) as rating from dev.ratings as r join dev.books as b on r.book_id = b.id group by b.authors order by rating desc',
			})
			.expect((r) => assert.ok(r.body.length == 26))
			.expect((r) => assert.ok(r.body[0].rating == 4.46))
			.expect((r) => assert.ok(r.body[1].rating == 4.42))
			.expect((r) => assert.ok(r.body[25].rating == 2.77))
			.expect((r) => assert.ok(r.body[0].authors == 'J.K. Rowling, Mary GrandPré, Rufus Beck'))
			.expect((r) => assert.ok(r.body[1].authors == 'Gabriel García Márquez, Gregory Rabassa'))
			.expect((r) => assert.ok(r.body[25].authors == 'Henry James, Patricia Crick'))
			.expect(200);
	});

	it('select AVE(rating) w/ join, group by and order by (2 of 2)', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({
				operation: 'sql',
				sql: 'select b.id, b.authors as authors, AVG(r.rating) from dev.ratings as r join dev.books as b on r.book_id = b.id group by b.authors, b.id order by b.id',
			})
			.expect((r) => assert.ok(r.body.length == 50))
			.expect((r) => assert.ok(r.body[0].id == 1))
			.expect((r) => assert.ok(r.body[49].id == 50))
			.expect((r) => assert.ok(r.body[5].id == 6))
			.expect((r) => assert.ok(r.body[5].authors == 'J.K. Rowling, Mary GrandPré'))
			.expect((r) => assert.ok(r.body[5][`AVG(r.rating)`] == 4.09))
			.expect((r) => assert.ok(r.body[21].id == 22))
			.expect((r) => assert.ok(r.body[21].authors == 'Edward P. Jones'))
			.expect((r) => assert.ok(r.body[21][`AVG(r.rating)`] == 3.73))
			.expect(200);
	});

	it('select AVE(rating) w/ join and group by (1 of 2)', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({
				operation: 'sql',
				sql: 'select b.id, b.authors as authors, AVG(r.rating) from dev.ratings as r join dev.books as b on r.book_id = b.id group by b.authors, b.id',
			})
			.expect((r) => assert.ok(r.body.length == 50))
			.expect((r) => assert.ok(Object.keys(r.body[0]).length == 3))
			.expect((r) => assert.ok(Object.keys(r.body[49]).length == 3))
			.expect(200);
	});

	it('select AVE(rating) w/ join, gb, ob, and LIMIT', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({
				operation: 'sql',
				sql: 'select b.id as id, b.authors as authors, AVG(r.rating) as rating from dev.ratings as r join dev.books as b on r.book_id = b.id group by b.id, b.authors order by id limit 10',
			})
			.expect((r) => assert.ok(r.body.length == 10))
			.expect((r) => assert.ok(r.body[0].id == 1))
			.expect((r) => assert.ok(r.body[9].id == 10))
			.expect((r) => assert.ok(Object.keys(r.body[0]).length == 3))
			.expect((r) => assert.ok(Object.keys(r.body[8]).length == 3))
			.expect(200);
	});

	it('select COUNT(rating) w/ join, gb, ob, limit, and OFFSET', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({
				operation: 'sql',
				sql: 'select b.authors as authors, COUNT(r.rating) as rating_count from dev.ratings as r join dev.books as b on r.book_id = b.id group by b.authors order by b.authors limit 15 offset 5',
			})
			.expect((r) => assert.ok(r.body.length == 15))
			.expect((r) => assert.ok(r.body[0].authors == 'Frank Herbert'))
			.expect((r) => assert.ok(r.body[14].authors == 'Marguerite Duras, Barbara Bray, Maxine Hong Kingston'))
			.expect((r) => assert.ok(r.body[9].authors == 'J.K. Rowling, Mary GrandPré'))
			.expect((r) => assert.ok(r.body[0].rating_count == 400))
			.expect((r) => assert.ok(r.body[11].rating_count == 300))
			.expect(200);
	});

	it('select w/ function alias in ORDER BY and LIMIT', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({
				operation: 'sql',
				sql: `select a.${generic.ords_id} as ords_id,
                   a.productid,
                   d.companyname        as companyname,
                   d.contactmame,
                   b.productname,
                   ROUND(a.unitprice)   as unitprice
            from ${generic.schema}.${generic.ordd_tb} a
                     join ${generic.schema}.${generic.prod_tb} b on a.${generic.prod_id} = b.${generic.prod_id}
                     join ${generic.schema}.${generic.ords_tb} c on a.${generic.ords_id} = c.${generic.ords_id}
                     join ${generic.schema}.${generic.cust_tb} d on c.${generic.cust_id} = d.${generic.cust_id}
            order by unitprice DESC LIMIT 25`,
			})
			.expect((r) => assert.ok(r.body.length == 25))
			.expect((r) => assert.ok(r.body[0].ords_id == 10518))
			.expect((r) => assert.ok(r.body[0].unitprice == 264))
			.expect((r) => assert.ok(r.body[24].ords_id == 10510))
			.expect((r) => assert.ok(r.body[24].unitprice == 124))
			.expect((r) => assert.ok(r.body[15].unitprice == 264))
			.expect((r) => assert.ok(r.body[16].unitprice == 211))
			.expect((r) => assert.ok(r.body[20].unitprice == 211))
			.expect(200);
	});

	it('select w/ inconsistent table refs & ORDER BY column not in SELECT', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({
				operation: 'sql',
				sql: `SELECT a.productid, a.unitprice as unitprice
              FROM ${generic.schema}.${generic.ordd_tb} a
              ORDER BY a.${generic.ords_id} DESC`,
			})
			.expect((r) => assert.ok(r.body.length == 2155))
			.expect((r) => assert.ok(r.body[0].productid == 2))
			.expect((r) => assert.ok(r.body[0].unitprice == 19))
			.expect((r) => assert.ok(r.body[1].productid == 3))
			.expect((r) => assert.ok(r.body[1].unitprice == 10))
			.expect((r) => assert.ok(r.body[3].productid == 6))
			.expect((r) => assert.ok(r.body[3].unitprice == 25))
			.expect((r) => assert.ok(r.body[15].unitprice == 9.65))
			.expect((r) => assert.ok(r.body[996].unitprice == 18))
			.expect((r) => assert.ok(r.body[1255].unitprice == 9.5))
			.expect(200);
	});

	it('select w/ inconsistent table refs, ORDER BY column not in SELECT & LIMIT/OFFSET', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({
				operation: 'sql',
				sql: `SELECT productid, a.unitprice as unitprice
              FROM ${generic.schema}.${generic.ordd_tb} a
              ORDER BY ${generic.ords_id} DESC LIMIT 250
              OFFSET 5`,
			})
			.expect((r) => assert.ok(r.body.length == 250))
			.expect((r) => assert.ok(r.body[0].productid == 8))
			.expect((r) => assert.ok(r.body[0].unitprice == 40))
			.expect((r) => assert.ok(r.body[1].productid == 10))
			.expect((r) => assert.ok(r.body[1].unitprice == 31))
			.expect((r) => assert.ok(r.body[5].productid == 16))
			.expect((r) => assert.ok(r.body[5].unitprice == 17.45))
			.expect((r) => assert.ok(r.body[10].unitprice == 9.65))
			.expect((r) => assert.ok(r.body[216].unitprice == 7.75))
			.expect((r) => assert.ok(r.body[249].unitprice == 17.45))
			.expect(200);
	});

	it('select w/ inconsistent table refs & second ORDER BY column not included in SELECT', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({
				operation: 'sql',
				sql: `SELECT a.${generic.ords_id} as ords_id, a.unitprice as unitprice
              FROM ${generic.schema}.${generic.ordd_tb} a
              ORDER BY productid DESC, a.${generic.ords_id} DESC`,
			})
			.expect((r) => assert.ok(r.body.length == 2155))
			.expect((r) => assert.ok(r.body[0].ords_id == 11077))
			.expect((r) => assert.ok(r.body[0].unitprice == 13))
			.expect((r) => assert.ok(r.body[1].ords_id == 11068))
			.expect((r) => assert.ok(r.body[1].unitprice == 13))
			.expect((r) => assert.ok(r.body[3].ords_id == 11015))
			.expect((r) => assert.ok(r.body[3].unitprice == 13))
			.expect((r) => assert.ok(r.body[15].unitprice == 13))
			.expect((r) => assert.ok(r.body[996].unitprice == 46))
			.expect((r) => assert.ok(r.body[1255].unitprice == 14.4))
			.expect(200);
	});

	it('select w/ inconsistent table refs, second ORDER BY column not included in SELECT & LIMIT/OFFSETS', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({
				operation: 'sql',
				sql: `SELECT a.${generic.ords_id} as ords_id, a.unitprice as unitprice
              FROM ${generic.schema}.${generic.ordd_tb} a
              ORDER BY productid DESC, a.${generic.ords_id} DESC LIMIT 205
              OFFSET 50`,
			})
			.expect((r) => assert.ok(r.body.length == 205))
			.expect((r) => assert.ok(r.body[0].ords_id == 10808))
			.expect((r) => assert.ok(r.body[0].unitprice == 18))
			.expect((r) => assert.ok(r.body[1].ords_id == 10749))
			.expect((r) => assert.ok(r.body[1].unitprice == 18))
			.expect((r) => assert.ok(r.body[3].ords_id == 10732))
			.expect((r) => assert.ok(r.body[3].unitprice == 18))
			.expect((r) => assert.ok(r.body[16].unitprice == 14.4))
			.expect((r) => assert.ok(r.body[66].unitprice == 6.2))
			.expect((r) => assert.ok(r.body[204].unitprice == 15))
			.expect(200);
	});

	it('Select * on 3 table INNER JOIN', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({
				operation: 'sql',
				sql: 'SELECT `d`.*, `b`.*, `o`.* FROM `dev`.`dog` AS `d` INNER JOIN `dev`.`breed` AS `b` ON `d`.`breed_id` = `b`.`id` INNER JOIN `dev`.`owner` AS `o` ON `d`.`owner_id` = `o`.`id` ORDER BY `dog_name`',
			})
			.expect((r) => {
				assert.ok(r.body.length == 7);
				r.body.forEach((row) => {
					assert.ok(row.id);
					assert.ok(row.id1);
					assert.ok(row.id2);
					assert.ok(row.name);
					assert.ok(row.name1);
				});
			})
			.expect((r) => assert.ok(r.body[1].name1 == 'Sam'))
			.expect((r) => assert.ok(r.body[1].id2 == 1))
			.expect((r) => assert.ok(r.body[4].id1 == 154))
			.expect(200);
	});

	it('Select with basic CROSS SCHEMA JOIN', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({
				operation: 'sql',
				sql: 'SELECT d.id, d.dog_name, d.age, d.adorable, o.id, o.name FROM dev.dog AS d INNER JOIN other.owner AS o ON d.owner_id = o.id',
			})
			.expect((r) => assert.ok(r.body.length == 8))
			.expect((r) => {
				r.body.forEach((row) => {
					assert.ok(row.id);
					assert.ok(row.id1);
					assert.ok(row.dog_name);
					assert.ok(row.age);
					assert.ok(row.name);
				});
			})
			.expect((r) => assert.ok(r.body[1].name == 'David'))
			.expect((r) => assert.ok(r.body[1].id1 == 3))
			.expect((r) => assert.ok(r.body[4].id1 == 2))
			.expect(200);
	});

	it('Select with complex CROSS SCHEMA JOIN', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({
				operation: 'sql',
				sql: 'SELECT d.id, d.dog_name, d.age, d.adorable, o.* FROM dev.dog AS d INNER JOIN other.owner AS o ON d.owner_id = o.id ORDER BY o.name, o.id LIMIT 5 OFFSET 1',
			})
			.expect((r) => {
				assert.ok(r.body.length == 5);
				r.body.forEach((row) => {
					assert.ok(row.id);
					assert.ok(row.id1);
					assert.ok(row.dog_name);
					assert.ok(row.age);
					assert.ok(row.name);
				});
			})
			.expect((r) => assert.ok(r.body[0].name == 'David'))
			.expect((r) => assert.ok(r.body[0].id == 6))
			.expect((r) => assert.ok(r.body[0].id1 == 3))
			.expect((r) => assert.ok(r.body[4].name == 'Kyle'))
			.expect((r) => assert.ok(r.body[4].id == 5))
			.expect((r) => assert.ok(r.body[4].id1 == 2))
			.expect(200);
	});

	it('Select with basic CROSS 3 SCHEMA JOINS', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({
				operation: 'sql',
				sql: 'SELECT d.id, d.dog_name, d.age, d.adorable, o.id, o.name, b.id, b.name FROM dev.dog AS d INNER JOIN other.owner AS o ON d.owner_id = o.id INNER JOIN another.breed AS b ON d.breed_id = b.id',
			})
			.expect((r) => {
				assert.ok(r.body.length == 7);
				r.body.forEach((row) => {
					assert.ok(row.id);
					assert.ok(row.id1);
					assert.ok(row.id2);
					assert.ok(row.dog_name);
					assert.ok(row.age);
					assert.ok(row.name);
					assert.ok(row.name1);
				});
			})
			.expect((r) => assert.ok(r.body[1].name == 'David'))
			.expect((r) => assert.ok(r.body[1].id1 == 3))
			.expect((r) => assert.ok(r.body[4].id1 == 2))
			.expect((r) => assert.ok(r.body[6].id1 == 1))
			.expect((r) => assert.ok(r.body[6].name1 == 'MASTIFF'))
			.expect(200);
	});

	it('Select with complex CROSS 3 SCHEMA JOINS', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({
				operation: 'sql',
				sql: 'SELECT d.age AS dog_age, AVG(d.weight_lbs) AS dog_weight, o.name AS owner_name, b.name FROM dev.dog AS d INNER JOIN other.owner AS o ON d.owner_id = o.id INNER JOIN another.breed AS b ON d.breed_id = b.id GROUP BY o.name, b.name, d.age ORDER BY b.name',
			})
			.expect((r) => {
				assert.ok(r.body.length == 7);
				r.body.forEach((row) => {
					assert.ok(row.dog_age);
					assert.ok(row.dog_weight);
					assert.ok(row.owner_name);
					assert.ok(row.name);
				});
			})
			.expect((r) => assert.ok(r.body[0].dog_age == 1))
			.expect((r) => assert.ok(r.body[0].dog_weight == 35))
			.expect((r) => assert.ok(r.body[0].owner_name == 'Kaylan'))
			.expect((r) => assert.ok(r.body[0].name == 'BEAGLE MIX'))
			.expect((r) => assert.ok(r.body[6].dog_age == 5))
			.expect((r) => assert.ok(r.body[6].dog_weight == 35))
			.expect((r) => assert.ok(r.body[6].owner_name == 'Kyle'))
			.expect((r) => assert.ok(r.body[6].name == 'WHIPPET'))
			.expect(200);
	});

	it('Select - simple full table query', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({ operation: 'sql', sql: 'SELECT * FROM dev.dog' })
			.expect((r) => assert.ok(r.body.length == 9))
			.expect((r) => {
				r.body.forEach((row) => {
					assert.ok(Object.keys(row).length == 9);
				});
			})
			.expect(200);
	});

	it('Select - simple full table query w/ * and alias', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({ operation: 'sql', sql: 'SELECT *, dog_name as dname FROM dev.dog' })
			.expect((r) => assert.ok(r.body.length == 9))
			.expect((r) => {
				r.body.forEach((row) => {
					assert.ok(Object.keys(row).length == 9);
					assert.ok(row.dname);
					assert.ok(!row.dog_name);
				});
			})
			.expect(200);
	});

	it('Select - simple full table query w/ single alias', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({ operation: 'sql', sql: 'SELECT dog_name as dname FROM dev.dog' })
			.expect((r) => assert.ok(r.body.length == 9))
			.expect((r) => {
				r.body.forEach((row) => {
					assert.ok(Object.keys(row).length == 1);
					assert.ok(row.dname);
					assert.ok(!row.dog_name);
				});
			})
			.expect(200);
	});

	it('Select - simple full table query w/ multiple aliases', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({ operation: 'sql', sql: 'SELECT id as dog_id, dog_name as dname, age as dog_age FROM dev.dog' })
			.expect((r) => assert.ok(r.body.length == 9))
			.expect((r) => {
				r.body.forEach((row) => {
					assert.ok(Object.keys(row).length == 3);
					assert.ok(row.dname);
					assert.ok(!row.dog_name);
					assert.ok(row.dog_id);
					assert.ok(!row.id);
					assert.ok(row.dog_age);
					assert.ok(!row.age);
				});
			})
			.expect(200);
	});

	it('Select - simple full table query from leading_zero', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({ operation: 'sql', sql: 'SELECT * FROM dev.leading_zero' })
			.expect((r) => assert.ok(r.body.length == 3))
			.expect((r) => {
				let ids = [];
				let expected_ids = [0, '00011', '011'];
				r.body.forEach((row) => {
					ids.push(row.id);
				});
				assert.deepEqual(ids, expected_ids);
			})
			.expect(200);
	});

	it('Select - basic self JOIN', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({
				operation: 'sql',
				sql: 'SELECT a.* FROM dev.owner as a INNER JOIN dev.owner as b ON a.name = b.best_friend',
			})
			.expect((r) => assert.ok(r.body.length == 1, 'Expected response message length to eql 1'))
			.expect((r) => assert.ok(r.body[0].id == 1))
			.expect(200);
	});

	it('Select - basic self JOIN - reverse scenario', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({
				operation: 'sql',
				sql: 'SELECT b.* FROM dev.owner as a INNER JOIN dev.owner as b ON a.name = b.best_friend',
			})
			.expect((r) => assert.ok(r.body.length == 1, 'Expected response message length to eql 1'))
			.expect((r) => assert.ok(r.body[0].id == 3))
			.expect(200);
	});

	it('query from leading_zero where id = 0', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({ operation: 'sql', sql: 'SELECT * FROM dev.leading_zero where id = 0' })
			.expect((r) => assert.ok(r.body.length == 1, 'Expected response message length to eql 1'))
			.expect((r) => assert.ok(r.body[0].id == 0))
			.expect((r) => assert.ok(r.body[0].another_attribute == 'another_1'))
			.expect((r) => assert.ok(r.body[0].some_attribute == 'some_att1'))
			.expect(200);
	});

	it("query from leading_zero where id = '011'", async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({ operation: 'sql', sql: "SELECT * FROM dev.leading_zero where id = '011'" })
			.expect((r) => assert.ok(r.body.length == 1, 'Expected response message length to eql 1'))
			.expect((r) => assert.ok(r.body[0].id == '011'))
			.expect((r) => assert.ok(r.body[0].another_attribute == 'another_2'))
			.expect((r) => assert.ok(r.body[0].some_attribute == 'some_att2'))
			.expect(200);
	});

	it('query from leading_zero where id = 011', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({ operation: 'sql', sql: 'SELECT * FROM dev.leading_zero where id = 011' })
			.expect((r) => assert.ok(r.body.length == 0))
			.expect(200);
	});

	it('insert record with dog_name =  single space value & empty string', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({ operation: 'sql', sql: "INSERT INTO dev.dog (id, dog_name) VALUES (1111, ' '), (2222, '')" })
			.expect((r) => assert.ok(r.body.message == 'inserted 2 of 2 records'))
			.expect((r) => assert.deepEqual(r.body.inserted_hashes, [1111, 2222]))
			.expect(200);
	});

	it('SELECT record with dog_name = single space and validate value', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({ operation: 'sql', sql: "SELECT id, dog_name FROM dev.dog  WHERE dog_name = ' '" })
			.expect((r) => assert.deepEqual(r.body, [{ id: 1111, dog_name: ' ' }]))
			.expect(200);
	});

	it('SELECT record with dog_name = empty string and validate value', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({ operation: 'sql', sql: "SELECT id, dog_name FROM dev.dog  WHERE dog_name = ''" })
			.expect((r) => assert.deepEqual(r.body, [{ id: 2222, dog_name: '' }]))
			.expect(200);
	});

	it('Delete dev.dog records previously created', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({ operation: 'sql', sql: 'DELETE FROM dev.dog WHERE id IN (1111, 2222)' })
			.expect((r) => assert.deepEqual(r.body.deleted_hashes, [1111, 2222]))
			.expect(200);
	});
});
