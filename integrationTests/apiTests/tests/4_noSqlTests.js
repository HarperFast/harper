import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { testData } from '../config/envConfig.js';
import { setTimeout } from 'node:timers/promises';
import { req } from '../utils/request.js';

describe('4. NoSQL Tests', () => {


	//NoSQL Tests Folder


	//Invalid Attribute Check

	it('insert invalid attribute name - single row',  () => {
		return req()
			.send({
				operation: 'insert',
				schema: 'dev',
				table: 'invalid_attribute',
				records: [{ 'id': 1, 'some`$`attribute': 'some_attribute' }],
			})
			.expect((r) => assert.equal(r.body.error, 'Attribute names cannot include backticks or forward slashes', r.text))
			.expect(400);
	});

	it('update single row w/ invalid attribute name',  () => {
		return req()
			.send({
				operation: 'update',
				schema: 'dev',
				table: 'invalid_attribute',
				records: [{ 'id': 100, 'some/attribute': 'some_attribute' }],
			})
			.expect((r) => assert.equal(r.body.error, 'Attribute names cannot include backticks or forward slashes', r.text))
			.expect(400);
	});

	it('insert all invalid attribute names - multiple rows',  () => {
		return req()
			.send({
				operation: 'insert',
				schema: 'dev',
				table: 'invalid_attribute',
				records: [
					{
						'id': 1,
						'some/attribute1': 'some_attribute1',
						'some/attribute2': 'some_attribute2',
						'some/attribute3': 'some_attribute3',
						'some_attribute4': 'some_attribute4',
					},
					{
						'id': 2,
						'some/attribute1': 'some_attribute1',
						'some/attribute2': 'some_attribute2',
						'some/attribute3': 'some_attribute3',
						'some_attribute4': 'some_attribute4',
					},
					{
						'id': 3,
						'some/attribute1': 'some_attribute1',
						'some/attribute2': 'some_attribute2',
						'some/attribute3': 'some_attribute3',
						'some_attribute4': 'some_attribute4',
					},
					{
						'id': 4,
						'some/attribute1': 'some_attribute1',
						'some/attribute2': 'some_attribute2',
						'some/attribute3': 'some_attribute3',
						'some_attribute4': 'some_attribute4',
					},
					{
						'id': 5,
						'some/attribute1': 'some_attribute1',
						'some/attribute2': 'some_attribute2',
						'some/attribute3': 'some_attribute3',
						'some_attribute4': 'some_attribute4',
					},
					{
						'id': 6,
						'some/attribute1': 'some_attribute1',
						'some/attribute2': 'some_attribute2',
						'some/attribute3': 'some_attribute3',
						'some_attribute4': 'some_attribute4',
					},
				],
			})
			.expect((r) => assert.equal(r.body.error, 'Attribute names cannot include backticks or forward slashes', r.text))
			.expect(400);
	});

	it('update multiple rows with invalid attribute',  () => {
		return req()
			.send({
				operation: 'update',
				schema: 'dev',
				table: 'invalid_attribute',
				records: [
					{ 'id': 100, 'some/attribute': 'some_attribute' },
					{
						'id': 101,
						'some-`attribute`': 'some_attribute',
					},
				],
			})
			.expect((r) => assert.equal(r.body.error, 'Attribute names cannot include backticks or forward slashes', r.text))
			.expect(400);
	});

	it('upsert multiple rows with invalid attribute key',  () => {
		return req()
			.send({
				operation: 'upsert',
				schema: 'dev',
				table: 'invalid_attribute',
				records: [
					{ 'id': 100, 'some/attribute': 'some_attribute' },
					{
						'id': 101,
						'some-`attribute`': 'some_attribute',
					},
				],
			})
			.expect((r) => assert.equal(r.body.error, 'Attribute names cannot include backticks or forward slashes', r.text))
			.expect(400);
	});

	it('insert some invalid attribute names - multiple rows',  () => {
		return req()
			.send({
				operation: 'insert',
				schema: 'dev',
				table: 'invalid_attribute',
				records: [
					{
						'id': 1,
						'some_attribute1': 'some_attribute1',
						'some_attribute2': 'some_attribute2',
						'$ome-attribute3': 'some_attribute3',
						'some_attribute4': 'some_attribute4',
					},
					{
						'id': 2,
						'some_attribute1': 'some_attribute1',
						'some_attribute2': 'some_attribute2',
						'$ome-attribute3': 'some_attribute3',
						'some_attribute4': 'some_attribute4',
					},
					{
						'id': 3,
						'some_attribute1': 'some_attribute1',
						'some_attribute2': 'some_attribute2',
						'some-attribute3': 'some_attribute3',
						'some_attribute4/': 'some_attribute4',
					},
					{
						'id': 4,
						'some_attribute1': 'some_attribute1',
						'some_attribute2': 'some_attribute2',
						'some-attribute3/': 'some_attribute3',
						'some_attribute4': 'some_attribute4',
					},
					{
						'id': 5,
						'some_attribute1': 'some_attribute1',
						'some_attribute2': 'some_attribute2',
						'some-attribute3': 'some_attribute3',
						'some_`attribute4`': 'some_attribute4',
					},
					{
						'id': 6,
						'some_attribute1': 'some_attribute1',
						'some_attribute2': 'some_attribute2',
						'some-attribute3`': 'some_attribute3',
						'some_attribute4': 'some_attribute4',
					},
				],
			})
			.expect((r) => assert.equal(r.body.error, 'Attribute names cannot include backticks or forward slashes', r.text))
			.expect(400);
	});


	//Search Response Data Type Check

	it('NoSQL search by hash no result',  () => {
		return req()
			.send({
				operation: 'search_by_hash',
				schema: `${testData.schema}`,
				table: `${testData.emps_tb}`,
				hash_attribute: `${testData.emps_id}`,
				hash_values: [100],
				get_attributes: ['firstname', 'lastname'],
			})
			.expect((r) => assert.equal(r.body.length, 0, r.text))
			.expect(200);
	});

	it('NoSQL search by hash one result',  () => {
		return req()
			.send({
				operation: 'search_by_hash',
				schema: `${testData.schema}`,
				table: `${testData.emps_tb}`,
				hash_attribute: `${testData.emps_id}`,
				hash_values: [1],
				get_attributes: ['firstname', 'lastname'],
			})
			.expect((r) => assert.equal(r.body.length, 1, r.text))
			.expect((r) => assert.equal(typeof r.body[0], 'object', r.text))
			.expect(200);
	});

	it('NoSQL search by hash multiple results',  () => {
		return req()
			.send({
				operation: 'search_by_hash',
				schema: `${testData.schema}`,
				table: `${testData.emps_tb}`,
				hash_attribute: `${testData.emps_id}`,
				hash_values: [1, 5],
				get_attributes: ['firstname', 'lastname'],
			})
			.expect((r) => {
				assert.equal(r.body.length, 2, r.text);
				assert.equal(typeof r.body[0], 'object', r.text);
				assert.equal(typeof r.body[1], 'object', r.text);
			})
			.expect(200);
	});

	it('NoSQL search by value no result',  () => {
		return req()
			.send({
				operation: 'search_by_value',
				schema: `${testData.schema}`,
				table: `${testData.emps_tb}`,
				hash_attribute: `${testData.emps_id}`,
				search_attribute: 'lastname',
				search_value: 'Xyz',
				get_attributes: ['firstname', 'lastname'],
			})
			.expect((r) => assert.equal(r.body.length, 0, r.text))
			.expect(200);
	});

	it('NoSQL search by value one result',  () => {
		return req()
			.send({
				operation: 'search_by_value',
				schema: `${testData.schema}`,
				table: `${testData.emps_tb}`,
				hash_attribute: `${testData.emps_id}`,
				search_attribute: 'lastname',
				search_value: 'King',
				get_attributes: ['firstname', 'lastname'],
			})
			.expect((r) => assert.equal(r.body.length, 1, r.text))
			.expect((r) => assert.equal(typeof r.body[0], 'object', r.text))
			.expect(200);
	});

	it('NoSQL search by value multiple results',  () => {
		return req()
			.send({
				operation: 'search_by_value',
				schema: `${testData.schema}`,
				table: `${testData.emps_tb}`,
				hash_attribute: `${testData.emps_id}`,
				search_attribute: 'lastname',
				search_value: 'D*',
				get_attributes: ['firstname', 'lastname'],
			})
			.expect((r) => {
				assert.equal(r.body.length, 2, r.text);
				assert.equal(typeof r.body[0], 'object', r.text);
				assert.equal(typeof r.body[1], 'object', r.text);
			})
			.expect(200);
	});


	//Test desc / offset / limit

	it('NoSQL search by value limit 20',  () => {
		return req()
			.send({
				operation: 'search_by_value',
				schema: `${testData.schema}`,
				table: `${testData.ords_tb}`,
				search_attribute: `${testData.ordd_id}`,
				search_value: '*',
				get_attributes: ['*'],
				limit: 20,
			})
			.expect((r) => assert.equal(r.body.length, 20, r.text))
			.expect((r) => {
				let ids = [
					10248, 10249, 10250, 10251, 10252, 10253, 10254, 10255, 10256, 10257, 10258, 10259, 10260, 10261, 10262,
					10263, 10264, 10265, 10266, 10267,
				];
				for (let x = 0, length = ids.length; x < length; x++) {
					assert.equal(r.body[x].orderid, ids[x], r.text);
				}
			})
			.expect(200);
	});

	it('NoSQL search by value offset 20',  () => {
		return req()
			.send({
				operation: 'search_by_value',
				schema: `${testData.schema}`,
				table: `${testData.ords_tb}`,
				search_attribute: `${testData.ordd_id}`,
				search_value: '*',
				get_attributes: ['*'],
				offset: 20,
			})
			.expect((r) => assert.equal(r.body.length, 810, r.text))
			.expect((r) => {
				let ids = [
					10268, 10269, 10270, 10271, 10272, 10273, 10274, 10275, 10276, 10277, 10278, 10279, 10280, 10281, 10282,
					10283, 10284, 10285, 10286, 10287, 10288, 10289, 10290, 10291, 10292, 10293, 10294, 10295, 10296, 10297,
					10298, 10299, 10300, 10301, 10302, 10303, 10304, 10305, 10306, 10307, 10308, 10309, 10310, 10311, 10312,
					10313, 10314, 10315, 10316, 10317, 10318, 10319, 10320, 10321, 10322, 10323, 10324, 10325, 10326, 10327,
					10328, 10329, 10330, 10331, 10332, 10333, 10334, 10335, 10336, 10337, 10338, 10339, 10340, 10341, 10342,
					10343, 10344, 10345, 10346, 10347, 10348, 10349, 10350, 10351, 10352, 10353, 10354, 10355, 10356, 10357,
					10358, 10359, 10360, 10361, 10362, 10363, 10364, 10365, 10366, 10367, 10368, 10369, 10370, 10371, 10372,
					10373, 10374, 10375, 10376, 10377, 10378, 10379, 10380, 10381, 10382, 10383, 10384, 10385, 10386, 10387,
					10388, 10389, 10390, 10391, 10392, 10393, 10394, 10395, 10396, 10397, 10398, 10399, 10400, 10401, 10402,
					10403, 10404, 10405, 10406, 10407, 10408, 10409, 10410, 10411, 10412, 10413, 10414, 10415, 10416, 10417,
					10418, 10419, 10420, 10421, 10422, 10423, 10424, 10425, 10426, 10427, 10428, 10429, 10430, 10431, 10432,
					10433, 10434, 10435, 10436, 10437, 10438, 10439, 10440, 10441, 10442, 10443, 10444, 10445, 10446, 10447,
					10448, 10449, 10450, 10451, 10452, 10453, 10454, 10455, 10456, 10457, 10458, 10459, 10460, 10461, 10462,
					10463, 10464, 10465, 10466, 10467, 10468, 10469, 10470, 10471, 10472, 10473, 10474, 10475, 10476, 10477,
					10478, 10479, 10480, 10481, 10482, 10483, 10484, 10485, 10486, 10487, 10488, 10489, 10490, 10491, 10492,
					10493, 10494, 10495, 10496, 10497, 10498, 10499, 10500, 10501, 10502, 10503, 10504, 10505, 10506, 10507,
					10508, 10509, 10510, 10511, 10512, 10513, 10514, 10515, 10516, 10517, 10518, 10519, 10520, 10521, 10522,
					10523, 10524, 10525, 10526, 10527, 10528, 10529, 10530, 10531, 10532, 10533, 10534, 10535, 10536, 10537,
					10538, 10539, 10540, 10541, 10542, 10543, 10544, 10545, 10546, 10547, 10548, 10549, 10550, 10551, 10552,
					10553, 10554, 10555, 10556, 10557, 10558, 10559, 10560, 10561, 10562, 10563, 10564, 10565, 10566, 10567,
					10568, 10569, 10570, 10571, 10572, 10573, 10574, 10575, 10576, 10577, 10578, 10579, 10580, 10581, 10582,
					10583, 10584, 10585, 10586, 10587, 10588, 10589, 10590, 10591, 10592, 10593, 10594, 10595, 10596, 10597,
					10598, 10599, 10600, 10601, 10602, 10603, 10604, 10605, 10606, 10607, 10608, 10609, 10610, 10611, 10612,
					10613, 10614, 10615, 10616, 10617, 10618, 10619, 10620, 10621, 10622, 10623, 10624, 10625, 10626, 10627,
					10628, 10629, 10630, 10631, 10632, 10633, 10634, 10635, 10636, 10637, 10638, 10639, 10640, 10641, 10642,
					10643, 10644, 10645, 10646, 10647, 10648, 10649, 10650, 10651, 10652, 10653, 10654, 10655, 10656, 10657,
					10658, 10659, 10660, 10661, 10662, 10663, 10664, 10665, 10666, 10667, 10668, 10669, 10670, 10671, 10672,
					10673, 10674, 10675, 10676, 10677, 10678, 10679, 10680, 10681, 10682, 10683, 10684, 10685, 10686, 10687,
					10688, 10689, 10690, 10691, 10692, 10693, 10694, 10695, 10696, 10697, 10698, 10699, 10700, 10701, 10702,
					10703, 10704, 10705, 10706, 10707, 10708, 10709, 10710, 10711, 10712, 10713, 10714, 10715, 10716, 10717,
					10718, 10719, 10720, 10721, 10722, 10723, 10724, 10725, 10726, 10727, 10728, 10729, 10730, 10731, 10732,
					10733, 10734, 10735, 10736, 10737, 10738, 10739, 10740, 10741, 10742, 10743, 10744, 10745, 10746, 10747,
					10748, 10749, 10750, 10751, 10752, 10753, 10754, 10755, 10756, 10757, 10758, 10759, 10760, 10761, 10762,
					10763, 10764, 10765, 10766, 10767, 10768, 10769, 10770, 10771, 10772, 10773, 10774, 10775, 10776, 10777,
					10778, 10779, 10780, 10781, 10782, 10783, 10784, 10785, 10786, 10787, 10788, 10789, 10790, 10791, 10792,
					10793, 10794, 10795, 10796, 10797, 10798, 10799, 10800, 10801, 10802, 10803, 10804, 10805, 10806, 10807,
					10808, 10809, 10810, 10811, 10812, 10813, 10814, 10815, 10816, 10817, 10818, 10819, 10820, 10821, 10822,
					10823, 10824, 10825, 10826, 10827, 10828, 10829, 10830, 10831, 10832, 10833, 10834, 10835, 10836, 10837,
					10838, 10839, 10840, 10841, 10842, 10843, 10844, 10845, 10846, 10847, 10848, 10849, 10850, 10851, 10852,
					10853, 10854, 10855, 10856, 10857, 10858, 10859, 10860, 10861, 10862, 10863, 10864, 10865, 10866, 10867,
					10868, 10869, 10870, 10871, 10872, 10873, 10874, 10875, 10876, 10877, 10878, 10879, 10880, 10881, 10882,
					10883, 10884, 10885, 10886, 10887, 10888, 10889, 10890, 10891, 10892, 10893, 10894, 10895, 10896, 10897,
					10898, 10899, 10900, 10901, 10902, 10903, 10904, 10905, 10906, 10907, 10908, 10909, 10910, 10911, 10912,
					10913, 10914, 10915, 10916, 10917, 10918, 10919, 10920, 10921, 10922, 10923, 10924, 10925, 10926, 10927,
					10928, 10929, 10930, 10931, 10932, 10933, 10934, 10935, 10936, 10937, 10938, 10939, 10940, 10941, 10942,
					10943, 10944, 10945, 10946, 10947, 10948, 10949, 10950, 10951, 10952, 10953, 10954, 10955, 10956, 10957,
					10958, 10959, 10960, 10961, 10962, 10963, 10964, 10965, 10966, 10967, 10968, 10969, 10970, 10971, 10972,
					10973, 10974, 10975, 10976, 10977, 10978, 10979, 10980, 10981, 10982, 10983, 10984, 10985, 10986, 10987,
					10988, 10989, 10990, 10991, 10992, 10993, 10994, 10995, 10996, 10997, 10998, 10999, 11000, 11001, 11002,
					11003, 11004, 11005, 11006, 11007, 11008, 11009, 11010, 11011, 11012, 11013, 11014, 11015, 11016, 11017,
					11018, 11019, 11020, 11021, 11022, 11023, 11024, 11025, 11026, 11027, 11028, 11029, 11030, 11031, 11032,
					11033, 11034, 11035, 11036, 11037, 11038, 11039, 11040, 11041, 11042, 11043, 11044, 11045, 11046, 11047,
					11048, 11049, 11050, 11051, 11052, 11053, 11054, 11055, 11056, 11057, 11058, 11059, 11060, 11061, 11062,
					11063, 11064, 11065, 11066, 11067, 11068, 11069, 11070, 11071, 11072, 11073, 11074, 11075, 11076, 11077,
				];
				for (let x = 0, length = ids.length; x < length; x++) {
					assert.equal(r.body[x].orderid, ids[x], r.text);
				}
			})
			.expect(200);
	});

	it('NoSQL search by value limit 20 offset 20',  () => {
		return req()
			.send({
				operation: 'search_by_value',
				schema: `${testData.schema}`,
				table: `${testData.ords_tb}`,
				search_attribute: `${testData.ordd_id}`,
				search_value: '*',
				get_attributes: ['*'],
				limit: 20,
				offset: 20,
			})
			.expect((r) => assert.equal(r.body.length, 20, r.text))
			.expect((r) => {
				let ids = [
					10268, 10269, 10270, 10271, 10272, 10273, 10274, 10275, 10276, 10277, 10278, 10279, 10280, 10281, 10282,
					10283, 10284, 10285, 10286, 10287,
				];
				for (let x = 0, length = ids.length; x < length; x++) {
					assert.equal(r.body[x].orderid, ids[x], r.text);
				}
			})
			.expect(200);
	});

	it('NoSQL search by value reverse',  () => {
		return req()
			.send({
				operation: 'search_by_value',
				schema: `${testData.schema}`,
				table: `${testData.ords_tb}`,
				search_attribute: `${testData.ordd_id}`,
				search_value: '*',
				get_attributes: ['*'],
				reverse: true,
			})
			.expect((r) => assert.equal(r.body.length, 830, r.text))
			.expect((r) => {
				let ids = [
					11077, 11076, 11075, 11074, 11073, 11072, 11071, 11070, 11069, 11068, 11067, 11066, 11065, 11064, 11063,
					11062, 11061, 11060, 11059, 11058, 11057, 11056, 11055, 11054, 11053, 11052, 11051, 11050, 11049, 11048,
					11047, 11046, 11045, 11044, 11043, 11042, 11041, 11040, 11039, 11038, 11037, 11036, 11035, 11034, 11033,
					11032, 11031, 11030, 11029, 11028, 11027, 11026, 11025, 11024, 11023, 11022, 11021, 11020, 11019, 11018,
					11017, 11016, 11015, 11014, 11013, 11012, 11011, 11010, 11009, 11008, 11007, 11006, 11005, 11004, 11003,
					11002, 11001, 11000, 10999, 10998, 10997, 10996, 10995, 10994, 10993, 10992, 10991, 10990, 10989, 10988,
					10987, 10986, 10985, 10984, 10983, 10982, 10981, 10980, 10979, 10978, 10977, 10976, 10975, 10974, 10973,
					10972, 10971, 10970, 10969, 10968, 10967, 10966, 10965, 10964, 10963, 10962, 10961, 10960, 10959, 10958,
					10957, 10956, 10955, 10954, 10953, 10952, 10951, 10950, 10949, 10948, 10947, 10946, 10945, 10944, 10943,
					10942, 10941, 10940, 10939, 10938, 10937, 10936, 10935, 10934, 10933, 10932, 10931, 10930, 10929, 10928,
					10927, 10926, 10925, 10924, 10923, 10922, 10921, 10920, 10919, 10918, 10917, 10916, 10915, 10914, 10913,
					10912, 10911, 10910, 10909, 10908, 10907, 10906, 10905, 10904, 10903, 10902, 10901, 10900, 10899, 10898,
					10897, 10896, 10895, 10894, 10893, 10892, 10891, 10890, 10889, 10888, 10887, 10886, 10885, 10884, 10883,
					10882, 10881, 10880, 10879, 10878, 10877, 10876, 10875, 10874, 10873, 10872, 10871, 10870, 10869, 10868,
					10867, 10866, 10865, 10864, 10863, 10862, 10861, 10860, 10859, 10858, 10857, 10856, 10855, 10854, 10853,
					10852, 10851, 10850, 10849, 10848, 10847, 10846, 10845, 10844, 10843, 10842, 10841, 10840, 10839, 10838,
					10837, 10836, 10835, 10834, 10833, 10832, 10831, 10830, 10829, 10828, 10827, 10826, 10825, 10824, 10823,
					10822, 10821, 10820, 10819, 10818, 10817, 10816, 10815, 10814, 10813, 10812, 10811, 10810, 10809, 10808,
					10807, 10806, 10805, 10804, 10803, 10802, 10801, 10800, 10799, 10798, 10797, 10796, 10795, 10794, 10793,
					10792, 10791, 10790, 10789, 10788, 10787, 10786, 10785, 10784, 10783, 10782, 10781, 10780, 10779, 10778,
					10777, 10776, 10775, 10774, 10773, 10772, 10771, 10770, 10769, 10768, 10767, 10766, 10765, 10764, 10763,
					10762, 10761, 10760, 10759, 10758, 10757, 10756, 10755, 10754, 10753, 10752, 10751, 10750, 10749, 10748,
					10747, 10746, 10745, 10744, 10743, 10742, 10741, 10740, 10739, 10738, 10737, 10736, 10735, 10734, 10733,
					10732, 10731, 10730, 10729, 10728, 10727, 10726, 10725, 10724, 10723, 10722, 10721, 10720, 10719, 10718,
					10717, 10716, 10715, 10714, 10713, 10712, 10711, 10710, 10709, 10708, 10707, 10706, 10705, 10704, 10703,
					10702, 10701, 10700, 10699, 10698, 10697, 10696, 10695, 10694, 10693, 10692, 10691, 10690, 10689, 10688,
					10687, 10686, 10685, 10684, 10683, 10682, 10681, 10680, 10679, 10678, 10677, 10676, 10675, 10674, 10673,
					10672, 10671, 10670, 10669, 10668, 10667, 10666, 10665, 10664, 10663, 10662, 10661, 10660, 10659, 10658,
					10657, 10656, 10655, 10654, 10653, 10652, 10651, 10650, 10649, 10648, 10647, 10646, 10645, 10644, 10643,
					10642, 10641, 10640, 10639, 10638, 10637, 10636, 10635, 10634, 10633, 10632, 10631, 10630, 10629, 10628,
					10627, 10626, 10625, 10624, 10623, 10622, 10621, 10620, 10619, 10618, 10617, 10616, 10615, 10614, 10613,
					10612, 10611, 10610, 10609, 10608, 10607, 10606, 10605, 10604, 10603, 10602, 10601, 10600, 10599, 10598,
					10597, 10596, 10595, 10594, 10593, 10592, 10591, 10590, 10589, 10588, 10587, 10586, 10585, 10584, 10583,
					10582, 10581, 10580, 10579, 10578, 10577, 10576, 10575, 10574, 10573, 10572, 10571, 10570, 10569, 10568,
					10567, 10566, 10565, 10564, 10563, 10562, 10561, 10560, 10559, 10558, 10557, 10556, 10555, 10554, 10553,
					10552, 10551, 10550, 10549, 10548, 10547, 10546, 10545, 10544, 10543, 10542, 10541, 10540, 10539, 10538,
					10537, 10536, 10535, 10534, 10533, 10532, 10531, 10530, 10529, 10528, 10527, 10526, 10525, 10524, 10523,
					10522, 10521, 10520, 10519, 10518, 10517, 10516, 10515, 10514, 10513, 10512, 10511, 10510, 10509, 10508,
					10507, 10506, 10505, 10504, 10503, 10502, 10501, 10500, 10499, 10498, 10497, 10496, 10495, 10494, 10493,
					10492, 10491, 10490, 10489, 10488, 10487, 10486, 10485, 10484, 10483, 10482, 10481, 10480, 10479, 10478,
					10477, 10476, 10475, 10474, 10473, 10472, 10471, 10470, 10469, 10468, 10467, 10466, 10465, 10464, 10463,
					10462, 10461, 10460, 10459, 10458, 10457, 10456, 10455, 10454, 10453, 10452, 10451, 10450, 10449, 10448,
					10447, 10446, 10445, 10444, 10443, 10442, 10441, 10440, 10439, 10438, 10437, 10436, 10435, 10434, 10433,
					10432, 10431, 10430, 10429, 10428, 10427, 10426, 10425, 10424, 10423, 10422, 10421, 10420, 10419, 10418,
					10417, 10416, 10415, 10414, 10413, 10412, 10411, 10410, 10409, 10408, 10407, 10406, 10405, 10404, 10403,
					10402, 10401, 10400, 10399, 10398, 10397, 10396, 10395, 10394, 10393, 10392, 10391, 10390, 10389, 10388,
					10387, 10386, 10385, 10384, 10383, 10382, 10381, 10380, 10379, 10378, 10377, 10376, 10375, 10374, 10373,
					10372, 10371, 10370, 10369, 10368, 10367, 10366, 10365, 10364, 10363, 10362, 10361, 10360, 10359, 10358,
					10357, 10356, 10355, 10354, 10353, 10352, 10351, 10350, 10349, 10348, 10347, 10346, 10345, 10344, 10343,
					10342, 10341, 10340, 10339, 10338, 10337, 10336, 10335, 10334, 10333, 10332, 10331, 10330, 10329, 10328,
					10327, 10326, 10325, 10324, 10323, 10322, 10321, 10320, 10319, 10318, 10317, 10316, 10315, 10314, 10313,
					10312, 10311, 10310, 10309, 10308, 10307, 10306, 10305, 10304, 10303, 10302, 10301, 10300, 10299, 10298,
					10297, 10296, 10295, 10294, 10293, 10292, 10291, 10290, 10289, 10288, 10287, 10286, 10285, 10284, 10283,
					10282, 10281, 10280, 10279, 10278, 10277, 10276, 10275, 10274, 10273, 10272, 10271, 10270, 10269, 10268,
					10267, 10266, 10265, 10264, 10263, 10262, 10261, 10260, 10259, 10258, 10257, 10256, 10255, 10254, 10253,
					10252, 10251, 10250, 10249, 10248,
				];
				for (let x = 0, length = ids.length; x < length; x++) {
					assert.equal(r.body[x].orderid, ids[x], r.text);
				}
			})
			.expect(200);
	});

	it('NoSQL search by value reverse offset 20',  () => {
		return req()
			.send({
				operation: 'search_by_value',
				schema: `${testData.schema}`,
				table: `${testData.ords_tb}`,
				search_attribute: `${testData.ordd_id}`,
				search_value: '*',
				get_attributes: ['*'],
				reverse: true,
				offset: 20,
			})
			.expect((r) => assert.equal(r.body.length, 810, r.text))
			.expect((r) => {
				let ids = [
					11057, 11056, 11055, 11054, 11053, 11052, 11051, 11050, 11049, 11048, 11047, 11046, 11045, 11044, 11043,
					11042, 11041, 11040, 11039, 11038, 11037, 11036, 11035, 11034, 11033, 11032, 11031, 11030, 11029, 11028,
					11027, 11026, 11025, 11024, 11023, 11022, 11021, 11020, 11019, 11018, 11017, 11016, 11015, 11014, 11013,
					11012, 11011, 11010, 11009, 11008, 11007, 11006, 11005, 11004, 11003, 11002, 11001, 11000, 10999, 10998,
					10997, 10996, 10995, 10994, 10993, 10992, 10991, 10990, 10989, 10988, 10987, 10986, 10985, 10984, 10983,
					10982, 10981, 10980, 10979, 10978, 10977, 10976, 10975, 10974, 10973, 10972, 10971, 10970, 10969, 10968,
					10967, 10966, 10965, 10964, 10963, 10962, 10961, 10960, 10959, 10958, 10957, 10956, 10955, 10954, 10953,
					10952, 10951, 10950, 10949, 10948, 10947, 10946, 10945, 10944, 10943, 10942, 10941, 10940, 10939, 10938,
					10937, 10936, 10935, 10934, 10933, 10932, 10931, 10930, 10929, 10928, 10927, 10926, 10925, 10924, 10923,
					10922, 10921, 10920, 10919, 10918, 10917, 10916, 10915, 10914, 10913, 10912, 10911, 10910, 10909, 10908,
					10907, 10906, 10905, 10904, 10903, 10902, 10901, 10900, 10899, 10898, 10897, 10896, 10895, 10894, 10893,
					10892, 10891, 10890, 10889, 10888, 10887, 10886, 10885, 10884, 10883, 10882, 10881, 10880, 10879, 10878,
					10877, 10876, 10875, 10874, 10873, 10872, 10871, 10870, 10869, 10868, 10867, 10866, 10865, 10864, 10863,
					10862, 10861, 10860, 10859, 10858, 10857, 10856, 10855, 10854, 10853, 10852, 10851, 10850, 10849, 10848,
					10847, 10846, 10845, 10844, 10843, 10842, 10841, 10840, 10839, 10838, 10837, 10836, 10835, 10834, 10833,
					10832, 10831, 10830, 10829, 10828, 10827, 10826, 10825, 10824, 10823, 10822, 10821, 10820, 10819, 10818,
					10817, 10816, 10815, 10814, 10813, 10812, 10811, 10810, 10809, 10808, 10807, 10806, 10805, 10804, 10803,
					10802, 10801, 10800, 10799, 10798, 10797, 10796, 10795, 10794, 10793, 10792, 10791, 10790, 10789, 10788,
					10787, 10786, 10785, 10784, 10783, 10782, 10781, 10780, 10779, 10778, 10777, 10776, 10775, 10774, 10773,
					10772, 10771, 10770, 10769, 10768, 10767, 10766, 10765, 10764, 10763, 10762, 10761, 10760, 10759, 10758,
					10757, 10756, 10755, 10754, 10753, 10752, 10751, 10750, 10749, 10748, 10747, 10746, 10745, 10744, 10743,
					10742, 10741, 10740, 10739, 10738, 10737, 10736, 10735, 10734, 10733, 10732, 10731, 10730, 10729, 10728,
					10727, 10726, 10725, 10724, 10723, 10722, 10721, 10720, 10719, 10718, 10717, 10716, 10715, 10714, 10713,
					10712, 10711, 10710, 10709, 10708, 10707, 10706, 10705, 10704, 10703, 10702, 10701, 10700, 10699, 10698,
					10697, 10696, 10695, 10694, 10693, 10692, 10691, 10690, 10689, 10688, 10687, 10686, 10685, 10684, 10683,
					10682, 10681, 10680, 10679, 10678, 10677, 10676, 10675, 10674, 10673, 10672, 10671, 10670, 10669, 10668,
					10667, 10666, 10665, 10664, 10663, 10662, 10661, 10660, 10659, 10658, 10657, 10656, 10655, 10654, 10653,
					10652, 10651, 10650, 10649, 10648, 10647, 10646, 10645, 10644, 10643, 10642, 10641, 10640, 10639, 10638,
					10637, 10636, 10635, 10634, 10633, 10632, 10631, 10630, 10629, 10628, 10627, 10626, 10625, 10624, 10623,
					10622, 10621, 10620, 10619, 10618, 10617, 10616, 10615, 10614, 10613, 10612, 10611, 10610, 10609, 10608,
					10607, 10606, 10605, 10604, 10603, 10602, 10601, 10600, 10599, 10598, 10597, 10596, 10595, 10594, 10593,
					10592, 10591, 10590, 10589, 10588, 10587, 10586, 10585, 10584, 10583, 10582, 10581, 10580, 10579, 10578,
					10577, 10576, 10575, 10574, 10573, 10572, 10571, 10570, 10569, 10568, 10567, 10566, 10565, 10564, 10563,
					10562, 10561, 10560, 10559, 10558, 10557, 10556, 10555, 10554, 10553, 10552, 10551, 10550, 10549, 10548,
					10547, 10546, 10545, 10544, 10543, 10542, 10541, 10540, 10539, 10538, 10537, 10536, 10535, 10534, 10533,
					10532, 10531, 10530, 10529, 10528, 10527, 10526, 10525, 10524, 10523, 10522, 10521, 10520, 10519, 10518,
					10517, 10516, 10515, 10514, 10513, 10512, 10511, 10510, 10509, 10508, 10507, 10506, 10505, 10504, 10503,
					10502, 10501, 10500, 10499, 10498, 10497, 10496, 10495, 10494, 10493, 10492, 10491, 10490, 10489, 10488,
					10487, 10486, 10485, 10484, 10483, 10482, 10481, 10480, 10479, 10478, 10477, 10476, 10475, 10474, 10473,
					10472, 10471, 10470, 10469, 10468, 10467, 10466, 10465, 10464, 10463, 10462, 10461, 10460, 10459, 10458,
					10457, 10456, 10455, 10454, 10453, 10452, 10451, 10450, 10449, 10448, 10447, 10446, 10445, 10444, 10443,
					10442, 10441, 10440, 10439, 10438, 10437, 10436, 10435, 10434, 10433, 10432, 10431, 10430, 10429, 10428,
					10427, 10426, 10425, 10424, 10423, 10422, 10421, 10420, 10419, 10418, 10417, 10416, 10415, 10414, 10413,
					10412, 10411, 10410, 10409, 10408, 10407, 10406, 10405, 10404, 10403, 10402, 10401, 10400, 10399, 10398,
					10397, 10396, 10395, 10394, 10393, 10392, 10391, 10390, 10389, 10388, 10387, 10386, 10385, 10384, 10383,
					10382, 10381, 10380, 10379, 10378, 10377, 10376, 10375, 10374, 10373, 10372, 10371, 10370, 10369, 10368,
					10367, 10366, 10365, 10364, 10363, 10362, 10361, 10360, 10359, 10358, 10357, 10356, 10355, 10354, 10353,
					10352, 10351, 10350, 10349, 10348, 10347, 10346, 10345, 10344, 10343, 10342, 10341, 10340, 10339, 10338,
					10337, 10336, 10335, 10334, 10333, 10332, 10331, 10330, 10329, 10328, 10327, 10326, 10325, 10324, 10323,
					10322, 10321, 10320, 10319, 10318, 10317, 10316, 10315, 10314, 10313, 10312, 10311, 10310, 10309, 10308,
					10307, 10306, 10305, 10304, 10303, 10302, 10301, 10300, 10299, 10298, 10297, 10296, 10295, 10294, 10293,
					10292, 10291, 10290, 10289, 10288, 10287, 10286, 10285, 10284, 10283, 10282, 10281, 10280, 10279, 10278,
					10277, 10276, 10275, 10274, 10273, 10272, 10271, 10270, 10269, 10268, 10267, 10266, 10265, 10264, 10263,
					10262, 10261, 10260, 10259, 10258, 10257, 10256, 10255, 10254, 10253, 10252, 10251, 10250, 10249, 10248,
				];
				for (let x = 0, length = ids.length; x < length; x++) {
					assert.equal(r.body[x].orderid, ids[x], r.text);
				}
			})
			.expect(200);
	});

	it('NoSQL search by value reverse limit 20',  () => {
		return req()
			.send({
				operation: 'search_by_value',
				schema: `${testData.schema}`,
				table: `${testData.ords_tb}`,
				search_attribute: `${testData.ordd_id}`,
				search_value: '*',
				get_attributes: ['*'],
				reverse: true,
				limit: 20,
			})
			.expect((r) => assert.equal(r.body.length, 20, r.text))
			.expect((r) => {
				let ids = [
					11077, 11076, 11075, 11074, 11073, 11072, 11071, 11070, 11069, 11068, 11067, 11066, 11065, 11064, 11063,
					11062, 11061, 11060, 11059, 11058,
				];
				for (let x = 0, length = ids.length; x < length; x++) {
					assert.equal(r.body[x].orderid, ids[x], r.text);
				}
			})
			.expect(200);
	});

	it('NoSQL search by value reverse offset 20 limit 20',  () => {
		return req()
			.send({
				operation: 'search_by_value',
				schema: `${testData.schema}`,
				table: `${testData.ords_tb}`,
				search_attribute: `${testData.ordd_id}`,
				search_value: '*',
				get_attributes: ['*'],
				reverse: true,
				offset: 20,
				limit: 20,
			})
			.expect((r) => assert.equal(r.body.length, 20, r.text))
			.expect((r) => {
				let ids = [
					11057, 11056, 11055, 11054, 11053, 11052, 11051, 11050, 11049, 11048, 11047, 11046, 11045, 11044, 11043,
					11042, 11041, 11040, 11039, 11038,
				];
				for (let x = 0, length = ids.length; x < length; x++) {
					assert.equal(r.body[x].orderid, ids[x], r.text);
				}
			})
			.expect(200);
	});

	//NoSQL Tests Main Folder

	it('update NoSQL employee',  () => {
		return req()
			.send({
				operation: 'update',
				schema: `${testData.schema}`,
				table: `${testData.emps_tb}`,
				records: [{ [testData.emps_id]: 1, address: 'def1234' }],
			})
			.expect((r) => assert.equal(r.body.update_hashes[0], 1, r.text))
			.expect(200);
	});

	it('update NoSQL employee confirm',  () => {
		return req()
			.send({
				operation: 'search_by_hash',
				schema: `${testData.schema}`,
				table: `${testData.emps_tb}`,
				hash_attribute: `${testData.emps_id}`,
				hash_values: [1],
				get_attributes: [`${testData.emps_id}`, 'address'],
			})
			.expect((r) => assert.equal(r.body[0].employeeid, 1, r.text))
			.expect((r) => assert.equal(r.body[0].address, 'def1234', r.text))
			.expect(200);
	});

	it('update NoSQL call.aggr set data to dot & double dot',  () => {
		return req()
			.send({
				operation: 'update',
				schema: 'call',
				table: 'aggr',
				records: [{ all: 4, dog_name: '.', owner_name: '..' }],
			})
			.expect((r) => assert.equal(r.body.update_hashes[0], 4, r.text))
			.expect(200);
	});

	it('update NoSQL employee add new attribute', async () => {
		await req()
			.send({
				operation: 'update',
				schema: `${testData.schema}`,
				table: `${testData.emps_tb}`,
				records: [{ [testData.emps_id]: 1, address: 'def1234', test_record: "I'mATest" }],
			})
			.expect((r) => assert.equal(r.body.update_hashes[0], 1, r.text))
			.expect(200);
		await setTimeout(200);
	});

	it('Insert with duplicate records to make sure both are not added',  () => {
		return req()
			.send({
				operation: 'insert',
				schema: `${testData.schema}`,
				table: `${testData.emps_tb}`,
				records: [
					{
						[testData.emps_id]: 212,
						address: 'def1234',
						lastname: 'dobolina',
						firstname: 'bob',
					},
					{
						[testData.emps_id]: 212,
						address: 'def1234',
						lastname: 'dobolina2',
						firstname: 'bob',
					},
				],
			})
			.expect((r) => assert.equal(r.body.skipped_hashes[0], 212, r.text))
			.expect(200);
	});

	it('Insert with no hash',  () => {
		return req()
			.send({
				operation: 'insert',
				schema: `${testData.schema}`,
				table: `${testData.emps_tb}`,
				records: [{ address: '1 North Street', lastname: 'Dog', firstname: 'Harper' }],
			})
			.expect((r) => assert.equal(r.body.inserted_hashes.length, 1, r.text))
			.expect((r) => assert.equal(r.body.message, 'inserted 1 of 1 records', r.text))
			.expect(200);
	});

	it('Insert with empty hash',  () => {
		return req()
			.send({
				operation: 'insert',
				schema: `${testData.schema}`,
				table: `${testData.emps_tb}`,
				records: [{ [testData.emps_id]: '', address: '23 North Street', lastname: 'Cat', firstname: 'Brian' }],
			})
			.expect((r) => assert.equal(r.body.inserted_hashes.length, 1, r.text))
			.expect((r) => assert.equal(r.body.message, 'inserted 1 of 1 records', r.text))
			.expect(200);
	});

	it('NoSQL search by hash',  () => {
		return req()
			.send({
				operation: 'search_by_hash',
				schema: `${testData.schema}`,
				table: `${testData.emps_tb}`,
				hash_attribute: `${testData.emps_id}`,
				hash_values: [1],
				get_attributes: ['address', 'test_record'],
			})
			.expect((r) => assert.equal(r.body[0].address, 'def1234', r.text))
			.expect((r) => assert.equal(r.body[0].test_record, "I'mATest", r.text))
			.expect(200);
	});

	it('NoSQL search by hash - check dot & double dot',  () => {
		return req()
			.send({
				operation: 'search_by_hash',
				schema: 'call',
				table: 'aggr',
				hash_values: [4],
				get_attributes: ['*'],
			})
			.expect((r) => assert.equal(r.body[0].dog_name, '.', r.text))
			.expect((r) => assert.equal(r.body[0].owner_name, '..', r.text))
			.expect(200);
	});

	it('NoSQL search by hash no schema',  () => {
		return req()
			.send({
				operation: 'search_by_hash',
				schema: 'callABC',
				table: 'aggr',
				hash_values: [4],
				get_attributes: ['*'],
			})
			.expect((r) => assert.equal(r.body.error, "database 'callABC' does not exist", r.text))
			.expect(404);
	});

	it('NoSQL search by hash no table',  () => {
		return req()
			.send({
				operation: 'search_by_hash',
				schema: 'call',
				table: 'aggrABC',
				hash_values: [4],
				get_attributes: ['*'],
			})
			.expect((r) => assert.equal(r.body.error, "Table 'call.aggrABC' does not exist", r.text))
			.expect(404);
	});

	it('NoSQL search by hash hash_value bad data type',  () => {
		return req()
			.send({
				operation: 'search_by_hash',
				schema: 'call',
				table: 'aggr',
				hash_values: 4,
				get_attributes: ['*'],
			})
			.expect((r) => assert.equal(r.body.error, "'hash_values' must be an array", r.text))
			.expect(500);
	});

	it('NoSQL search by hash get_attributes bad data type',  () => {
		return req()
			.send({
				operation: 'search_by_hash',
				schema: 'call',
				table: 'aggr',
				hash_values: [4],
				get_attributes: '*',
			})
			.expect((r) => assert.equal(r.body.error, "'get_attributes' must be an array", r.text))
			.expect(500);
	});

	it('update NoSQL employee with falsey attributes',  () => {
		return req()
			.send({
				operation: 'update',
				schema: `${testData.schema}`,
				table: `${testData.emps_tb}`,
				records: [{ [testData.emps_id]: 2, address: 0, hireDate: null, notes: false }],
			})
			.expect((r) =>
				assert.equal(r.body.message, 'updated 1 of 1 records',
					'Expected response message to eql "updated 1 of 1 records"'
				)
			)
			.expect((r) => assert.equal(r.body.update_hashes[0], 2, r.text))
			.expect(200);
	});

	it('NoSQL search by hash to confirm falsey update',  () => {
		return req()
			.send({
				operation: 'search_by_hash',
				schema: `${testData.schema}`,
				table: `${testData.emps_tb}`,
				hash_attribute: `${testData.emps_id}`,
				hash_values: [2],
				get_attributes: ['address', 'hireDate', 'notes'],
			})
			.expect((r) => {
				assert.equal(r.body[0].address, 0, r.text);
				assert.equal(r.body[0].hireDate, null, r.text);
				assert.equal(r.body[0].notes, false, r.text);
			})
			.expect(200);
	});

	it('update NoSQL one employee record with no hash attribute',  () => {
		return req()
			.send({
				operation: 'update',
				schema: `${testData.schema}`,
				table: `${testData.emps_tb}`,
				records: [{ address: '3000 Dog Place' }],
			})
			.expect((r) => assert.equal(r.body.error, 'a valid hash attribute must be provided with update record, check log for more info', r.text))
			.expect(400);
	});

	it('update NoSQL one employee record with empty hash attribute',  () => {
		return req()
			.send({
				operation: 'update',
				schema: `${testData.schema}`,
				table: `${testData.emps_tb}`,
				records: [{ [testData.emps_id]: '', address: '123 North Blvd', notes: 'This guy is the real deal' }],
			})
			.expect((r) => assert.equal(r.body.error, 'a valid hash attribute must be provided with update record, check log for more info', r.text))
			.expect(400);
	});

	it('update NoSQL multiple employee records with no hash attribute',  () => {
		return req()
			.send({
				operation: 'update',
				schema: `${testData.schema}`,
				table: `${testData.emps_tb}`,
				records: [
					{
						[testData.emps_id]: 2,
						address: '123 North Blvd',
						notes: 'This guy is the real deal',
					},
					{ address: '45 Lost St', notes: "This person doesn't even have an id!" },
					{
						[testData.emps_id]: 3,
						address: '1 Main St',
						notes: 'This guy okay',
					},
				],
			})
			.expect((r) => assert.equal(r.body.error, 'a valid hash attribute must be provided with update record, check log for more info', r.text))
			.expect(400);
	});

	it('update NoSQL employee with valid nonexistent hash',  () => {
		return req()
			.send({
				operation: 'update',
				schema: `${testData.schema}`,
				table: `${testData.emps_tb}`,
				records: [{ [testData.emps_id]: 'There is no way this exists', notes: 'who is this fella?' }],
			})
			.expect((r) => {
				if (r.body.message === 'updated 0 of 1 records') {
					assert.equal(r.body.message, 'updated 0 of 1 records', r.text);
					assert.deepEqual(r.body.update_hashes, [], r.text);
					assert.equal(r.body.skipped_hashes[0], 'There is no way this exists', r.text);
				} else if (r.body.message === 'updated 1 of 1 records') {
					assert.equal(r.body.message, 'updated 1 of 1 records',
						'Expected response message to eql "updated 1 of 1 records"'
					);
					assert.equal(r.body.update_hashes[0], 'There is no way this exists', r.text);
					assert.deepEqual(r.body.skipped_hashes, [], r.text);
				}
			})
			.expect(200);
	});

	it('NoSQL search by value - * at end',  () => {
		return req()
			.send({
				operation: 'search_by_value',
				schema: 'dev',
				table: 'remarks_blob',
				search_attribute: 'remarks',
				search_value:
					'Location ... Location ...GOURGEOUS HOME in a Heart of MANDARIN,Next to Loretto Magnet schoolClose to I-295, shopping & entertainment. Gated community! Loaded with upgrades:*',
				get_attributes: ['*'],
			})
			.expect((r) => assert.equal(r.body.length, 2, r.text))
			.expect((r) => {
				r.body.forEach((record) => {
					let keys = Object.keys(record);
					if (keys.indexOf('__updatedtime__') > -1 && keys.indexOf('__createdtime__') > -1) {
						assert.equal(keys.length, 5, r.text);
					} else {
						assert.equal(keys.length, 3, r.text);
					}
					assert.ok(
						record.remarks.includes(
							'Location ... Location ...GOURGEOUS HOME in a Heart of MANDARIN,Next to Loretto Magnet ' +
								'schoolClose to I-295, shopping & entertainment. Gated community! Loaded with upgrades:'
						)
					);
				});
			})
			.expect(200);
	});

	it('NoSQL search by value - * at start',  () => {
		return req()
			.send({
				operation: 'search_by_value',
				schema: 'dev',
				table: 'remarks_blob',
				search_attribute: 'remarks',
				search_value:
					"**DON'T MISS THIS BEAUTIFUL DAVID WEEKLEY BELMONTE MODEL*ONE OF THE LARGEST LOTS IN CROSSWATER*GREAT FOR OUTDOOR FUN!*LUXURIOUS LIVING!*HIGH TECH HOME*CROWN MOLDING, CUSTOM PLANTATION SHUTTERS, 18'' TILE & CUSTOM WHITE OAK HARDWOOD FLOORING...",
				get_attributes: ['*'],
			})
			.expect((r) => assert.equal(r.body.length, 1, r.text))
			.expect((r) => {
				r.body.forEach((record) => {
					let keys = Object.keys(record);
					if (keys.indexOf('__updatedtime__') > -1 && keys.indexOf('__createdtime__') > -1) {
						assert.equal(keys.length, 5, r.text);
					} else {
						assert.equal(keys.length, 3, r.text);
					}
					assert.ok(
						record.remarks.includes(
							"*DON'T MISS THIS BEAUTIFUL DAVID WEEKLEY BELMONTE MODEL*ONE OF THE LARGEST LOTS IN " +
								'CROSSWATER*GREAT FOR OUTDOOR FUN!*LUXURIOUS LIVING!*HIGH TECH HOME*CROWN MOLDING, ' +
								"CUSTOM PLANTATION SHUTTERS, 18'' TILE & CUSTOM WHITE OAK HARDWOOD FLOORING..."
						)
					);
				});
			})
			.expect(200);
	});

	it('NoSQL search by value - * at start and end',  () => {
		return req()
			.send({
				operation: 'search_by_value',
				schema: 'dev',
				table: 'remarks_blob',
				search_attribute: 'remarks',
				search_value: '*4 Bedroom/2.5+*',
				get_attributes: ['*'],
			})
			.expect((r) => assert.equal(r.body.length, 3, r.text))
			.expect((r) => {
				r.body.forEach((record) => {
					let keys = Object.keys(record);
					if (keys.indexOf('__updatedtime__') > -1 && keys.indexOf('__createdtime__') > -1) {
						assert.equal(keys.length, 5, r.text);
					} else {
						assert.equal(keys.length, 3, r.text);
					}
					assert.ok(record.remarks.includes('4 Bedroom/2.5+'), r.text);
				});
			})
			.expect(200);
	});

	it('NoSQL search by value - * as search_value',  () => {
		return req()
			.send({
				operation: 'search_by_value',
				schema: 'dev',
				table: 'remarks_blob',
				search_attribute: 'remarks',
				search_value: '*',
				get_attributes: ['*'],
			})
			.expect((r) => assert.equal(r.body.length, 11, r.text))
			.expect((r) => {
				r.body.forEach((record) => {
					let keys = Object.keys(record);
					if (keys.indexOf('__updatedtime__') > -1 && keys.indexOf('__createdtime__') > -1) {
						assert.equal(keys.length, 5, r.text);
					} else {
						assert.equal(keys.length, 3, r.text);
					}
				});
			})
			.expect(200);
	});

	it('NoSQL search by value - *** at start',  () => {
		return req()
			.send({
				operation: 'search_by_value',
				schema: 'dev',
				table: 'remarks_blob',
				search_attribute: 'remarks',
				search_value:
					'***Spacious & updated 2-story home on large preserve lot nearly 1/2 acre! Concrete block constr. & desirable ICW location near JTB, shopping, dining & the beach! Great split BD flrpln w/soaring ceilings features 4BD + office, upstairs loft & 3 full BA.',
				get_attributes: ['*'],
			})
			.expect((r) => assert.equal(r.body.length, 1, r.text))
			.expect((r) => {
				r.body.forEach((record) => {
					let keys = Object.keys(record);
					if (keys.indexOf('__updatedtime__') > -1 && keys.indexOf('__createdtime__') > -1) {
						assert.equal(keys.length, 5, r.text);
					} else {
						assert.equal(keys.length, 3, r.text);
					}
					assert.ok(
						record.remarks.includes(
							'**Spacious & updated 2-story home on large preserve lot nearly 1/2 acre! ' +
								'Concrete block constr. & desirable ICW location near JTB, shopping, dining & the beach! ' +
								'Great split BD flrpln w/soaring ceilings features 4BD + office, upstairs loft & 3 full BA.'
						)
					);
				});
			})
			.expect(200);
	});

	it('NoSQL search by hash on leading_zero, value = 0',  () => {
		return req()
			.send({
				operation: 'search_by_hash',
				schema: 'dev',
				table: 'leading_zero',
				hash_attribute: 'id',
				hash_values: [0],
				get_attributes: ['*'],
			})
			.expect((r) => assert.equal(r.body.length, 1, r.text))
			.expect((r) => {
				let record = r.body[0];
				assert.equal(record.id, 0, r.text);
				assert.equal(record.another_attribute, 'another_1', r.text);
				assert.equal(record.some_attribute, 'some_att1', r.text);
			})
			.expect(200);
	});

	it('NoSQL search by hash on leading_zero, values "011","00011"',  () => {
		return req()
			.send({
				operation: 'search_by_hash',
				schema: 'dev',
				table: 'leading_zero',
				hash_attribute: 'id',
				hash_values: ['011', '00011'],
				get_attributes: ['*'],
			})
			.expect((r) => assert.equal(r.body.length, 2, r.text))
			.expect((r) => {
				let record = r.body[0];
				assert.equal(record.id, '011', r.text);
				assert.equal(record.another_attribute, 'another_2', r.text);
				assert.equal(record.some_attribute, 'some_att2', r.text);
				let record2 = r.body[1];
				assert.equal(record2.id, '00011', r.text);
				assert.equal(record2.another_attribute, 'another_3', r.text);
				assert.equal(record2.some_attribute, 'some_att3', r.text);
			})
			.expect(200);
	});

	it('NoSQL search by value leading_zero - value = 0',  () => {
		return req()
			.send({
				operation: 'search_by_value',
				schema: 'dev',
				table: 'leading_zero',
				search_attribute: 'id',
				search_value: 0,
				get_attributes: ['*'],
			})
			.expect((r) => {
				assert.equal(r.body.length, 1, r.text);
				assert.equal(r.body[0].id, 0, r.text);
				assert.equal(r.body[0].another_attribute, 'another_1', r.text);
				assert.equal(r.body[0].some_attribute, 'some_att1', r.text);
			})
			.expect(200);
	});

	it('NoSQL search by value leading_zero - value = "011"',  () => {
		return req()
			.send({
				operation: 'search_by_value',
				schema: 'dev',
				table: 'leading_zero',
				search_attribute: 'id',
				search_value: '011',
				get_attributes: ['*'],
			})
			.expect((r) => {
				assert.equal(r.body.length, 1, r.text);
				assert.equal(r.body[0].id, '011', r.text);
				assert.equal(r.body[0].another_attribute, 'another_2', r.text);
				assert.equal(r.body[0].some_attribute, 'some_att2', r.text);
			})
			.expect(200);
	});

	it('NoSQL search by value leading_zero - value = "0*"',  () => {
		return req()
			.send({
				operation: 'search_by_value',
				schema: 'dev',
				table: 'leading_zero',
				search_attribute: 'id',
				search_value: '0*',
				get_attributes: ['*'],
			})
			.expect((r) => assert.equal(r.body.length, 2, r.text))
			.expect((r) => {
				let record2 = r.body[0];
				assert.equal(record2.id, '00011', r.text);
				assert.equal(record2.another_attribute, 'another_3', r.text);
				assert.equal(record2.some_attribute, 'some_att3', r.text);

				let record1 = r.body[1];
				assert.equal(record1.id, '011', r.text);
				assert.equal(record1.another_attribute, 'another_2', r.text);
				assert.equal(record1.some_attribute, 'some_att2', r.text);
			})
			.expect(200);
	});

	it('Upsert into products 1 new record & 2 that exist',  () => {
		return req()
			.send({
				operation: 'upsert',
				schema: `${testData.schema}`,
				table: `${testData.prod_tb}`,
				records: [
					{
						categoryid: 1,
						unitsnnorder: 0,
						unitsinstock: 39,
						supplierid: 1,
						productid: 1,
						discontinued: true,
						reorderlevel: 10,
						productname: 'Chai',
						quantityperunit: '10 boxes x 20 bags',
						unitprice: 18,
					},
					{
						productid: 100,
						categoryid: 1,
						unitsnnorder: 0,
						unitsinstock: 39,
						supplierid: 1,
						discontinued: true,
						reorderlevel: 10,
						productname: 'Chai',
						quantityperunit: '10 boxes x 20 bags',
						unitprice: 18,
					},
					{
						productid: 101,
						categoryid: 1,
						unitsnnorder: 0,
						unitsinstock: 39,
						supplierid: 1,
						discontinued: true,
						reorderlevel: 10,
						productname: 'Chai',
						quantityperunit: '10 boxes x 20 bags',
						unitprice: 18,
					},
				],
			})
			.expect((r) => {
				assert.equal(r.body.upserted_hashes.length, 3, r.text);
				assert.deepEqual(r.body.upserted_hashes, [1, 100, 101], r.text);
				assert.ok(!r.body.skipped_hashes, r.text);
				assert.equal(r.body.message, 'upserted 3 of 3 records', r.text);
			})
			.expect(200);
	});

	it('Confirm upserted records exist and are updated',  () => {
		return req()
			.send({
				operation: 'search_by_value',
				schema: `${testData.schema}`,
				table: `${testData.prod_tb}`,
				search_attribute: 'discontinued',
				search_value: true,
				get_attributes: ['*'],
			})
			.expect((r) => {
				const expectedHashes = [1, 100, 101];
				r.body.forEach((row) => {
					assert.ok(expectedHashes.includes(row.productid), r.text);
					assert.ok(row.discontinued, r.text);
				});
			})
			.expect(200);
	});

	it('Upsert into products 3 new records w/o hash vals',  () => {
		return req()
			.send({
				operation: 'upsert',
				schema: `${testData.schema}`,
				table: `${testData.prod_tb}`,
				records: [
					{
						categoryid: 1,
						unitsnnorder: 0,
						unitsinstock: 39,
						supplierid: 1,
						discontinued: 'True',
						reorderlevel: 10,
						productname: 'Chai',
						quantityperunit: '10 boxes x 20 bags',
						unitprice: 18,
					},
					{
						categoryid: 1,
						unitsnnorder: 0,
						unitsinstock: 39,
						supplierid: 1,
						discontinued: 'True',
						reorderlevel: 10,
						productname: 'Chai',
						quantityperunit: '10 boxes x 20 bags',
						unitprice: 18,
					},
					{
						categoryid: 1,
						unitsnnorder: 0,
						unitsinstock: 39,
						supplierid: 1,
						discontinued: 'True',
						reorderlevel: 10,
						productname: 'Chai',
						quantityperunit: '10 boxes x 20 bags',
						unitprice: 18,
					},
				],
			})
			.expect((r) => {
				assert.equal(r.body.upserted_hashes.length, 3, r.text);
				assert.ok(!r.body.skipped_hashes, r.text);
				assert.equal(r.body.message, 'upserted 3 of 3 records', r.text);
			})
			.expect(200);
	});

	it('Remove added record from products',  () => {
		return req()
			.send({ operation: 'delete', schema: `${testData.schema}`, table: `${testData.prod_tb}`, hash_values: [100] })
			.expect((r) => {
				assert.equal(r.body.deleted_hashes.length, 1, r.text);
				assert.deepEqual(r.body.deleted_hashes, [100], r.text);
				assert.equal(r.body.skipped_hashes.length, 0, r.text);
				assert.deepEqual(r.body.skipped_hashes, [], r.text);
				assert.equal(r.body.message, '1 of 1 record successfully deleted', r.text);
			})
			.expect(200);
	});

	it('Update products 1 existing record & one that does not exist',  () => {
		return req()
			.send({
				operation: 'update',
				schema: `${testData.schema}`,
				table: `${testData.prod_tb}`,
				records: [
					{ productid: 1, discontinued: true },
					{
						categoryid: 1,
						unitsnnorder: 0,
						unitsinstock: 39,
						supplierid: 1,
						productid: 100,
						discontinued: 'False',
						reorderlevel: 10,
						productname: 'Chai',
						quantityperunit: '10 boxes x 20 bags',
						unitprice: 18,
					},
				],
			})
			.expect((r) => {
				assert.equal(r.body.update_hashes.length, 1, r.text);
				assert.deepEqual(r.body.update_hashes, [1], r.text);
				assert.equal(r.body.skipped_hashes.length, 1, r.text);
				assert.deepEqual(r.body.skipped_hashes, [100], r.text);
				assert.equal(r.body.message, 'updated 1 of 2 records', r.text);
			})
			.expect(200);
	});

	it('Restore Product record',  () => {
		return req()
			.send({
				operation: 'update',
				schema: `${testData.schema}`,
				table: `${testData.prod_tb}`,
				records: [{ productid: 1, discontinued: 'False' }],
			})
			.expect((r) =>
				assert.equal(r.body.message, 'updated 1 of 1 records',
					'Expected response message to eql "updated 1 of 1 records"'
				)
			)
			.expect((r) => {
				assert.equal(r.body.update_hashes.length, 1, r.text);
				assert.deepEqual(r.body.update_hashes, [1], r.text);
				assert.equal(r.body.skipped_hashes.length, 0, r.text);
				assert.deepEqual(r.body.skipped_hashes, [], r.text);
			})
			.expect(200);
	});

	it('attempt to update __createdtime__',  () => {
		return req()
			.send({
				operation: 'update',
				schema: `${testData.schema}`,
				table: `${testData.emps_tb}`,
				records: [{ [testData.emps_id]: 1, __createdtime__: 'bad value' }],
			})
			.expect((r) => assert.equal(r.body.update_hashes[0], 1, r.text))
			.expect(200);
	});

	it('confirm __createdtime__ did not change',  () => {
		return req()
			.send({
				operation: 'search_by_hash',
				schema: `${testData.schema}`,
				table: `${testData.emps_tb}`,
				hash_attribute: `${testData.emps_id}`,
				hash_values: [1],
				get_attributes: [`${testData.emps_id}`, '__createdtime__'],
			})
			.expect((r) => assert.equal(r.body[0].employeeid, 1, r.text))
			.expect((r) => assert.notEqual(r.body[0].__createdtime__, 'bad value', r.text))
			.expect(200);
	});

	it('insert record with dog_name =  single space value & empty string',  () => {
		return req()
			.send({
				operation: 'insert',
				schema: 'dev',
				table: 'dog',
				records: [
					{ id: 1111, dog_name: ' ' },
					{ id: 2222, dog_name: '' },
				],
			})
			.expect((r) => assert.equal(r.body.message, 'inserted 2 of 2 records', r.text))
			.expect((r) => assert.deepEqual(r.body.inserted_hashes, [1111, 2222], r.text))
			.expect(200);
	});

	it('search by value dog_name = single space string',  () => {
		return req()
			.send({
				operation: 'search_by_value',
				schema: 'dev',
				table: 'dog',
				search_attribute: 'dog_name',
				search_value: ' ',
				get_attributes: ['id', 'dog_name'],
			})
			.expect((r) => assert.deepEqual(r.body, [{ id: 1111, dog_name: ' ' }], r.text))
			.expect(200);
	});

	it('search by value dog_name = empty string',  () => {
		return req()
			.send({
				operation: 'search_by_value',
				schema: 'dev',
				table: 'dog',
				search_attribute: 'dog_name',
				search_value: '',
				get_attributes: ['id', 'dog_name'],
			})
			.expect((r) => assert.deepEqual(r.body, [{ id: 2222, dog_name: '' }], r.text))
			.expect(200);
	});

	it('Delete dev.dog records previously created',  () => {
		return req()
			.send({ operation: 'delete', schema: 'dev', table: 'dog', hash_values: [1111, 2222] })
			.expect((r) => assert.deepEqual(r.body.deleted_hashes, [1111, 2222], r.text))
			.expect(200);
	});

	it('Search by value 123.4',  () => {
		return req()
			.send({
				operation: 'search_by_value',
				schema: '123',
				table: '4',
				search_attribute: 'name',
				search_value: 'Hot Diddy Dawg',
				get_attributes: ['id', 'name'],
			})
			.expect((r) => assert.deepEqual(r.body, [{ id: 987654321, name: 'Hot Diddy Dawg' }], r.text))
			.expect(200);
	});

	it('Search by hash 123.4',  () => {
		return req()
			.send({
				operation: 'search_by_hash',
				schema: '123',
				table: '4',
				hash_values: [987654321],
				get_attributes: ['name'],
			})
			.expect((r) => assert.deepEqual(r.body, [{ name: 'Hot Diddy Dawg' }], r.text))
			.expect(200);
	});

	it('Delete 123.4 record',  () => {
		return req()
			.send({ operation: 'delete', schema: '123', table: '4', hash_values: [987654321] })
			.expect((r) => assert.equal(r.body.message, '1 of 1 record successfully deleted', r.text))
			.expect(200);
	});

	it('search by conditions - equals',  () => {
		return req()
			.send({
				operation: 'search_by_conditions',
				schema: 'dev',
				table: 'dog_conditions',
				get_attributes: ['*'],
				conditions: [{ search_attribute: 'age', search_type: 'equals', search_value: 5 }],
			})
			.expect((r) => assert.equal(r.body.length, 2, r.text))
			.expect((r) => {
				r.body.forEach((row) => {
					assert.ok([1, 2].includes(row.id), r.text);
				});
			})
			.expect(200);
	});

	it('search by conditions - contains',  () => {
		return req()
			.send({
				operation: 'search_by_conditions',
				schema: 'dev',
				table: 'dog_conditions',
				get_attributes: ['*'],
				conditions: [{ search_attribute: 'location', search_type: 'contains', search_value: 'Denver' }],
			})
			.expect((r) => assert.equal(r.body.length, 6, r.text))
			.expect((r) => {
				r.body.forEach((row) => {
					assert.ok(row.location.includes('Denver'), r.text);
				});
			})
			.expect(200);
	});

	it('search by conditions - starts_with',  () => {
		return req()
			.send({
				operation: 'search_by_conditions',
				schema: 'dev',
				table: 'dog_conditions',
				get_attributes: ['*'],
				conditions: [{ search_attribute: 'location', search_type: 'starts_with', search_value: 'Denver' }],
			})
			.expect((r) => assert.equal(r.body.length, 6, r.text))
			.expect((r) => {
				r.body.forEach((row) => {
					assert.ok(row.location.startsWith('Denver'), r.text);
				});
			})
			.expect(200);
	});

	it('search by conditions - ends_with',  () => {
		return req()
			.send({
				operation: 'search_by_conditions',
				schema: 'dev',
				table: 'dog_conditions',
				get_attributes: ['*'],
				conditions: [{ search_attribute: 'dog_name', search_type: 'ends_with', search_value: 'y' }],
			})
			.expect((r) => assert.equal(r.body.length, 4, r.text))
			.expect((r) => {
				r.body.forEach((row) => {
					assert.equal([...row.dog_name].pop(), 'y', r.text);
				});
			})
			.expect(200);
	});

	it('search by conditions - greater_than',  () => {
		return req()
			.send({
				operation: 'search_by_conditions',
				schema: 'dev',
				table: 'dog_conditions',
				get_attributes: ['*'],
				conditions: [{ search_attribute: 'age', search_type: 'greater_than', search_value: 4 }],
			})
			.expect((r) => assert.equal(r.body.length, 6, r.text))
			.expect((r) => {
				r.body.forEach((row) => {
					assert.ok(row.age > 4, r.text);
				});
			})
			.expect(200);
	});

	it('search by conditions - greater_than_equal',  () => {
		return req()
			.send({
				operation: 'search_by_conditions',
				schema: 'dev',
				table: 'dog_conditions',
				get_attributes: ['*'],
				conditions: [{ search_attribute: 'age', search_type: 'greater_than_equal', search_value: 4 }],
			})
			.expect((r) => assert.equal(r.body.length, 8, r.text))
			.expect((r) => {
				r.body.forEach((row) => {
					assert.ok(row.age >= 4, r.text);
				});
			})
			.expect(200);
	});

	it('search by conditions - less_than',  () => {
		return req()
			.send({
				operation: 'search_by_conditions',
				schema: 'dev',
				table: 'dog_conditions',
				get_attributes: ['*'],
				conditions: [{ search_attribute: 'age', search_type: 'less_than', search_value: 4 }],
			})
			.expect((r) => assert.equal(r.body.length, 2, r.text))
			.expect((r) => {
				r.body.forEach((row) => {
					assert.ok(row.age < 4, r.text);
				});
			})
			.expect(200);
	});

	it('search by conditions - less_than_equal',  () => {
		return req()
			.send({
				operation: 'search_by_conditions',
				schema: 'dev',
				table: 'dog_conditions',
				get_attributes: ['*'],
				conditions: [{ search_attribute: 'age', search_type: 'less_than_equal', search_value: 4 }],
			})
			.expect((r) => assert.equal(r.body.length, 4, r.text))
			.expect((r) => {
				r.body.forEach((row) => {
					assert.ok(row.age <= 4, r.text);
				});
			})
			.expect(200);
	});

	it('search by conditions - between',  () => {
		return req()
			.send({
				operation: 'search_by_conditions',
				schema: 'dev',
				table: 'dog_conditions',
				get_attributes: ['*'],
				conditions: [{ search_attribute: 'age', search_type: 'between', search_value: [2, 5] }],
			})
			.expect((r) => assert.equal(r.body.length, 5, r.text))
			.expect((r) => {
				r.body.forEach((row) => {
					assert.ok(row.age <= 5 && row.age >= 2, r.text);
				});
			})
			.expect(200);
	});

	it('search by conditions - between using same value',  () => {
		return req()
			.send({
				operation: 'search_by_conditions',
				schema: 'dev',
				table: 'dog_conditions',
				get_attributes: ['*'],
				conditions: [{ search_attribute: 'age', search_type: 'between', search_value: [5, 5] }],
			})
			.expect((r) => assert.equal(r.body.length, 2, r.text))
			.expect((r) => {
				r.body.forEach((row) => {
					assert.equal(row.age, 5, r.text);
				});
			})
			.expect(200);
	});

	it('search by conditions - between w/ alpha',  () => {
		return req()
			.send({
				operation: 'search_by_conditions',
				schema: 'dev',
				table: 'dog_conditions',
				get_attributes: ['*'],
				conditions: [{ search_attribute: 'group', search_type: 'between', search_value: ['A', 'B'] }],
			})
			.expect((r) => assert.equal(r.body.length, 7, r.text))
			.expect((r) => {
				r.body.forEach((row) => {
					assert.ok(['A', 'B'].includes(row.group), r.text);
				});
			})
			.expect(200);
	});

	it('search by conditions - equals & equals',  () => {
		return req()
			.send({
				operation: 'search_by_conditions',
				schema: 'dev',
				table: 'dog_conditions',
				get_attributes: ['*'],
				conditions: [
					{
						search_attribute: 'group',
						search_type: 'equals',
						search_value: 'A',
					},
					{ search_attribute: 'age', search_type: 'equals', search_value: 5 },
				],
			})
			.expect((r) => assert.equal(r.body.length, 2, r.text))
			.expect((r) => {
				r.body.forEach((row) => {
					assert.ok(row.age === 5 && row.group === 'A', r.text);
				});
			})
			.expect(200);
	});

	it('search by conditions - equals || equals',  () => {
		return req()
			.send({
				operation: 'search_by_conditions',
				schema: 'dev',
				table: 'dog_conditions',
				get_attributes: ['*'],
				operator: 'OR',
				conditions: [
					{
						search_attribute: 'group',
						search_type: 'equals',
						search_value: 'A',
					},
					{
						search_attribute: 'group',
						search_type: 'equals',
						search_value: 'B',
					},
				],
			})
			.expect((r) => assert.equal(r.body.length, 7, r.text))
			.expect((r) => {
				r.body.forEach((row) => {
					assert.ok(['A', 'B'].includes(row.group), r.text);
				});
			})
			.expect(200);
	});

	it('search by conditions - equals & contains',  () => {
		return req()
			.send({
				operation: 'search_by_conditions',
				schema: 'dev',
				table: 'dog_conditions',
				get_attributes: ['*'],
				conditions: [
					{
						search_attribute: 'location',
						search_type: 'contains',
						search_value: 'CO',
					},
					{ search_attribute: 'group', search_type: 'equals', search_value: 'B' },
				],
			})
			.expect((r) => assert.equal(r.body.length, 2, r.text))
			.expect((r) => {
				r.body.forEach((row) => {
					assert.equal(row.group, 'B', r.text);
					assert.ok(row.location.includes('CO'), r.text);
				});
			})
			.expect(200);
	});

	it('search by conditions - equals & ends_with',  () => {
		return req()
			.send({
				operation: 'search_by_conditions',
				schema: 'dev',
				table: 'dog_conditions',
				get_attributes: ['*'],
				conditions: [
					{
						search_attribute: 'location',
						search_type: 'ends_with',
						search_value: 'CO',
					},
					{ search_attribute: 'group', search_type: 'equals', search_value: 'B' },
				],
			})
			.expect((r) => {
				assert.equal(r.body.length, 2, r.text);
				r.body.forEach((row) => {
					assert.equal(row.group, 'B', r.text);
					assert.equal(row.location.split(', ')[1], 'CO', r.text);
				});
			})
			.expect(200);
	});

	it('search by conditions - greater_than_equal & starts_with',  () => {
		return req()
			.send({
				operation: 'search_by_conditions',
				schema: 'dev',
				table: 'dog_conditions',
				get_attributes: ['*'],
				conditions: [
					{
						search_attribute: 'location',
						search_type: 'starts_with',
						search_value: 'Denver',
					},
					{ search_attribute: 'age', search_type: 'greater_than_equal', search_value: 5 },
				],
			})
			.expect((r) => {
				assert.equal(r.body.length, 3, r.text);
				r.body.forEach((row) => {
					assert.ok(row.age >= 5, r.text);
					assert.equal(row.location.split(',')[0], 'Denver', r.text);
				});
			})
			.expect(200);
	});

	it('search by conditions - less_than_equal ||  greater_than',  () => {
		return req()
			.send({
				operation: 'search_by_conditions',
				schema: 'dev',
				table: 'dog_conditions',
				get_attributes: ['*'],
				operator: 'OR',
				conditions: [
					{
						search_attribute: 'age',
						search_type: 'less_than_equal',
						search_value: 4,
					},
					{ search_attribute: 'age', search_type: 'greater_than', search_value: 5 },
				],
			})
			.expect((r) => assert.equal(r.body.length, 8, r.text))
			.expect((r) => {
				r.body.forEach((row) => {
					assert.ok(row.age <= 4 || row.age > 5, r.text);
				});
			})
			.expect(200);
	});

	it('search by conditions - contains || contains',  () => {
		return req()
			.send({
				operation: 'search_by_conditions',
				schema: 'dev',
				table: 'dog_conditions',
				get_attributes: ['*'],
				operator: 'OR',
				conditions: [
					{
						search_attribute: 'location',
						search_type: 'contains',
						search_value: 'NC',
					},
					{ search_attribute: 'location', search_type: 'contains', search_value: 'CO' },
				],
			})
			.expect((r) => assert.equal(r.body.length, 10, r.text))
			.expect((r) => {
				r.body.forEach((row) => {
					assert.ok(row.location.includes('CO') || row.location.includes('NC'), r.text);
				});
			})
			.expect(200);
	});

	it('search by conditions - contains & between',  () => {
		return req()
			.send({
				operation: 'search_by_conditions',
				schema: 'dev',
				table: 'dog_conditions',
				get_attributes: ['id', 'age', 'group', 'location'],
				conditions: [
					{
						search_attribute: 'group',
						search_type: 'between',
						search_value: ['A', 'C'],
					},
					{ search_attribute: 'location', search_type: 'contains', search_value: 'Denver' },
				],
			})
			.expect((r) => {
				const expected_hash_order = [1, 2, 8, 5, 7, 11];
				assert.equal(r.body.length, 6, r.text);
				r.body.forEach((row, i) => {
					assert.ok(['A', 'B', 'C'].includes(row.group), r.text);
					assert.equal(row.location.split(',')[0], 'Denver', r.text);
					assert.equal(row.id, expected_hash_order[i], r.text);
				});
			})
			.expect(200);
	});

	it('search by conditions - starts_with "AND" between',  () => {
		return req()
			.send({
				operation: 'search_by_conditions',
				schema: 'dev',
				table: 'dog_conditions',
				sort: { attribute: 'id' },
				get_attributes: ['id', 'age', 'location', 'group'],
				operator: 'AND',
				conditions: [
					{
						search_attribute: 'group',
						search_type: 'between',
						search_value: ['A', 'C'],
					},
					{ search_attribute: 'location', search_type: 'starts_with', search_value: 'Denver' },
				],
			})
			.expect((r) => {
				const expected_hash_order = [1, 2, 5, 7, 8, 11];
				assert.equal(r.body.length, 6, r.text);
				r.body.forEach((row, i) => {
					assert.ok(['A', 'B', 'C'].includes(row.group), r.text);
					assert.equal(row.location.split(',')[0], 'Denver', r.text);
					assert.equal(row.id, expected_hash_order[i], r.text);
				});
			})
			.expect(200);
	});

	it('search by conditions - starts_with & between w/ offset',  () => {
		return req()
			.send({
				operation: 'search_by_conditions',
				schema: 'dev',
				table: 'dog_conditions',
				sort: { attribute: 'id' },
				get_attributes: ['id', 'age', 'location', 'group'],
				offset: 1,
				conditions: [
					{
						search_attribute: 'group',
						search_type: 'between',
						search_value: ['A', 'C'],
					},
					{ search_attribute: 'location', search_type: 'starts_with', search_value: 'Denver' },
				],
			})
			.expect((r) => {
				const expected_hash_order = [2, 5, 7, 8, 11];
				assert.equal(r.body.length, 5, r.text);
				r.body.forEach((row, i) => {
					assert.ok(['A', 'B', 'C'].includes(row.group), r.text);
					assert.equal(row.location.split(',')[0], 'Denver', r.text);
					assert.equal(row.id, expected_hash_order[i], r.text);
				});
			})
			.expect(200);
	});

	it('search by conditions - starts_with & between limit',  () => {
		return req()
			.send({
				operation: 'search_by_conditions',
				schema: 'dev',
				table: 'dog_conditions',
				sort: { attribute: 'id' },
				get_attributes: ['id', 'age', 'location', 'group'],
				limit: 4,
				conditions: [
					{
						search_attribute: 'group',
						search_type: 'between',
						search_value: ['A', 'C'],
					},
					{ search_attribute: 'location', search_type: 'starts_with', search_value: 'Denver' },
				],
			})
			.expect((r) => {
				const expected_hash_order = [1, 2, 5, 7];
				assert.equal(r.body.length, 4, r.text);
				r.body.forEach((row, i) => {
					assert.ok(['A', 'B', 'C'].includes(row.group), r.text);
					assert.equal(row.location.split(',')[0], 'Denver', r.text);
					assert.equal(row.id, expected_hash_order[i], r.text);
				});
			})
			.expect(200);
	});

	it('search by conditions - starts_with & between offset, limit',  () => {
		return req()
			.send({
				operation: 'search_by_conditions',
				schema: 'dev',
				table: 'dog_conditions',
				sort: { attribute: 'id' },
				get_attributes: ['id', 'age', 'location', 'group'],
				offset: 1,
				limit: 3,
				conditions: [
					{
						search_attribute: 'group',
						search_type: 'between',
						search_value: ['A', 'C'],
					},
					{ search_attribute: 'location', search_type: 'starts_with', search_value: 'Denver' },
				],
			})
			.expect((r) => {
				const expected_hash_order = [2, 5, 7];
				assert.equal(r.body.length, expected_hash_order.length, r.text);
				r.body.forEach((row, i) => {
					assert.ok(['A', 'B', 'C'].includes(row.group), r.text);
					assert.equal(row.location.split(',')[0], 'Denver', r.text);
					assert.equal(row.id, expected_hash_order[i], r.text);
				});
			})
			.expect(200);
	});

	it('search by conditions - starts_with condition, offset, limit of 2',  () => {
		return req()
			.send({
				operation: 'search_by_conditions',
				schema: 'dev',
				table: 'dog_conditions',
				get_attributes: ['id', 'age', 'location', 'group'],
				offset: 3,
				limit: 2,
				conditions: [{ search_attribute: 'location', search_type: 'starts_with', search_value: 'Denver' }],
			})
			.expect((r) => {
				const expected_hash_order = [11, 1];
				assert.equal(r.body.length, expected_hash_order.length, r.text);
				r.body.forEach((row, i) => {
					assert.equal(row.location.split(',')[0], 'Denver', r.text);
					assert.equal(row.id, expected_hash_order[i], r.text);
				});
			})
			.expect(200);
	});

	it('search by conditions - starts_with condition, offset, limit of 10',  () => {
		return req()
			.send({
				operation: 'search_by_conditions',
				schema: 'dev',
				table: 'dog_conditions',
				get_attributes: ['id', 'age', 'location', 'group'],
				offset: 3,
				limit: 10,
				conditions: [{ search_attribute: 'location', search_type: 'starts_with', search_value: 'Denver' }],
			})
			.expect((r) => {
				const expected_hash_order = [11, 1, 8];
				assert.equal(r.body.length, expected_hash_order.length, r.text);
				r.body.forEach((row, i) => {
					assert.equal(row.location.split(',')[0], 'Denver', r.text);
					assert.equal(row.id, expected_hash_order[i], r.text);
				});
			})
			.expect(200);
	});

	it('search by conditions - ends_with condition, offset, limit of 3',  () => {
		return req()
			.send({
				operation: 'search_by_conditions',
				schema: 'dev',
				table: 'dog_conditions',
				get_attributes: ['id', 'age', 'location', 'group'],
				offset: 3,
				limit: 3,
				conditions: [{ search_attribute: 'location', search_type: 'ends_with', search_value: 'CO' }],
				sort: { attribute: 'id' },
			})
			.expect((r) => {
				const expected_hash_order = [7, 9, 10];
				assert.equal(r.body.length, expected_hash_order.length, r.text);
				r.body.forEach((row, i) => {
					assert.equal(row.location.toString().split(', ')[1], 'CO', r.text);
					assert.equal(row.id, expected_hash_order[i], r.text);
				});
			})
			.expect(200);
	});
});