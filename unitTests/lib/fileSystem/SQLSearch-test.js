'use strict';

const test_utils = require('../../test_utils');
// try to move to /bin directory so our properties reader doesn't explode.
test_utils.preTestPrep();
const {
    createMockFS,
    deepClone,
    getMockFSPath,
    mochaAsyncWrapper,
    tearDownMockFS,
    generateMockAST,
    getFormattedIntegrationTestCsvData
} = test_utils;

const chai = require('chai');
const { expect } = chai;
const sinon = require('sinon');

const fs = require('fs-extra');
const path = require('path');
const rewire = require('rewire');
const FileSearch = rewire('../../../lib/fileSystem/SQLSearch');
const log = require('../../../utility/logging/harper_logger');
const terms = require('../../../utility/hdbTerms');
const { HASH_FOLDER_NAME } = terms;

const RAW_FILE_READ_LIMIT = FileSearch.__get__('RAW_FILE_READ_LIMIT');
const TEST_FS_DIR = getMockFSPath();
const TEST_SCHEMA = 'dev';
const HASH_ATTRIBUTE = 'id';
const TEST_TABLE_CAT = 'cat';
const TEST_TABLE_DOG = 'dog';
const TEST_TABLE_LONGTEXT = 'longtext';
const dog_schema_table_id = `${TEST_SCHEMA}_${TEST_TABLE_DOG}`;
const cat_schema_table_id = `${TEST_SCHEMA}_${TEST_TABLE_CAT}`;
const longtext_scheam_table_id = `${TEST_SCHEMA}_${TEST_TABLE_LONGTEXT}`;
const TEST_DATA_DOG = [
    {
        "age": 5,
        "breed": "Mutt",
        "id": 1,
        "name": "Sam"
    },
    {
        "age": 4,
        "breed": "Golden Retriever",
        "id": 2,
        "name": "David"
    },
    {
        "age": 10,
        "breed": "Pit Bull",
        "id": 3,
        "name": "Kyle"
    },
    {
        "age": 10,
        "breed": "Pit",
        "id": 4,
        "name": "Sam"
    },
    {
        "age": 15,
        "breed": "Poodle",
        "id": 5,
        "name": "Eli"
    },
    {
        "age": 8,
        "breed": "Poodle",
        "id": 6,
        "name": "Sarah"
    }
];

const TEST_DATA_CAT = [
    {
        "age": 5,
        "id": 1,
        "name": "Sam"
    },
    {
        "age": 4,
        "id": 2,
        "name": "David"
    }
];

const TEST_DATA_AGGR = [
    {
        "all" : 1,
        "dog_name" : "Penny",
        "owner_name": "Kyle",
        "breed_id":154,
        "age":5,
        "weight_lbs":35,
        "adorable":true
    },
    {
        "all" : 2,
        "dog_name" : "Harper",
        "owner_name": "Stephen",
        "breed_id":346,
        "age":5,
        "weight_lbs":55,
        "adorable":true
    },
    {
        "all" : 3,
        "dog_name" : "Alby",
        "owner_name": "Kaylan",
        "breed_id":348,
        "age":5,
        "weight_lbs":84,
        "adorable":true
    },
    {
        "all" : 4,
        "dog_name" : "Billy",
        "owner_name": "Zach",
        "breed_id":347,
        "age":4,
        "weight_lbs":60,
        "adorable":true
    },
    {
        "all" : 5,
        "dog_name" : "Rose Merry",
        "owner_name": "Zach",
        "breed_id":348,
        "age":6,
        "weight_lbs":15,
        "adorable":true
    },
    {
        "all" : 6,
        "dog_name" : "Kato",
        "owner_name": "Kyle",
        "breed_id":351,
        "age":4,
        "weight_lbs":28,
        "adorable":true
    },
    {
        "all" : 7,
        "dog_name" : "Simon",
        "owner_name": "Fred",
        "breed_id":349,
        "age":1,
        "weight_lbs":35,
        "adorable":true
    },
    {
        "all" : 8,
        "dog_name" : "Gemma",
        "owner_name": "Stephen",
        "breed_id":350,
        "age":3,
        "weight_lbs":55,
        "adorable":true
    },
    {
        "all" : 9,
        "dog_name" : "Gertrude",
        "owner_name": "Eli",
        "breed_id":158,
        "age":5,
        "weight_lbs":70,
        "adorable":true
    },
    {
        "all" : 10,
        "dog_name" : "Big Louie",
        "owner_name": "Eli",
        "breed_id":241,
        "age":11,
        "weight_lbs":20,
        "adorable":true
    },
    {
        "all" : 11,
        "dog_name" : ".",
        "owner_name": ".."
    }
];

const TEST_DATA_LONGTEXT = [
    {
        "id": 1,
        "remarks": "RIVERFRONT LIFESTYLE! New dock, new roof and new appliances. For sale fully furnished. Beautiful custom-built 2-story home with pool. Panoramic river views and open floor plan -- great for entertaining. Hardwood floors flow throughout. Enjoy sunsets over the St. Johns from covered lanai or family room with wood-burning fireplace. Large back yard, dock, boat lift, kayak area...endless lifestyle options for fishing, boating or just chilling. Spacious master suite includes seating area with gas fireplace. Additional bedroom or office, pool bath, and laundry room on 1st floor. Upstairs loft area, perfect for a game room, plus two bedrooms with upgraded baths in each. Kitchen features stainless steel appliances, granite countertops, cooking island, and walk-in pantry. 3-car garage with abundant"
    },
    {
        "id": 2,
        "remarks": "Come see the kitchen remodel and new wood flooring.  Custom built by Howard White in 2007, this immaculate Deerwood home enjoys a view of the 18th fairway. From the moment you step into the foyer, you will be impressed with the bright, open floor plan. The Master suite features a large en suite bath with his and hers custom closets. The kitchen features high-end appliances,cabinetry and granite countertops. Retreat upstairs to an expansive library with cherry bookshelves. Additional bedrooms are spacious with large walk-in closets for extra storage. Plantation shutters throughout. Relax in the large hot tub/small pool with lounge chair shelf and fountain. Side entry 3 car garage is connected by a breezeway to home. Portion of back yard fenced for small dog."
    },
    {
        "id": 3,
        "remarks": "This custom built dream home is stunningly gorgeous!  It is a 5+ acres luxury equestrian property with access to Jennings State Forest from your backyard, no need to trailer your horses anywhere for a beautifully scenic peaceful ride.  This amazing home includes impressive Brazilian hardwood floors, plantation shutters throughout, granite countertops, triple tray and wood beam ceilings and so much more.  Builder's touches include 24'' tiles, rounded corner walls, 5'' baseboards, 10 ft. ceilings, in-wall vacuum system and many more unique upgrades.  There are extensive custom touches on this property from the mailbox to the unique 3000 sq. ft. two level 3-stall barn with tons of storage space."
    },
    {
        "id": 4,
        "remarks": "Make this stunning traditional two story red brick house your forever home. Custom built in 2004, this home is spacious enough for large gatherings and cozy enough for small get togethers. Located on a large corner lot with side entry four car garage and fenced backyard, this home has it all inside and out. Inviting foyer is flanked by formal living room and dining room with wood floors, crown molding, and large windows. Large eat-in kitchen with custom made Pine Cottage cabinets, granite countertops, and stainless steel appliances is conveniently located next to family room. Separate downstairs flex space with attached full bath currently used as a playroom could be used as a 5th bedroom/guest or mother-in-law suite (no closet, but one could be easily added.)"
    },
    {
        "id": 5,
        "remarks": "A beautiful waterfront home located on a deep water canal providing quick access to the St. Johns River and ocean. Spacious and open, the downstairs is perfect for both family activities and entertaining. Central to this is a large kitchen with extensive granite countertops, upgraded appliances, separate island and an adjacent laundry room. A great room with fireplace flows into Florida & game rooms which overlook the canal. From the leaded glass front door, the extensive crown molding, to the hardwood, marble and tile flooring, there are numerous upgrades throughout the house. Outside, a large backyard includes three separate patios surrounded by tropical landscaping maintained by automatic sprinklers. Along the concrete bulkhead, there are docks, davits and a 9,000lb. boat lift w Remote."
    },
    {
        "id": 6,
        "remarks": "Walk inside this Perfect Family Home and make it your own. Spacious Foyer opens to formal living room. Family room features brick fireplace, wet bar, and sliding glass doors to beautiful patio and lushly landscapped backyard. Recently updated Kitchen boasts granite countertops, abundance of cabinets with pull out drawers and breakfast nook. Large Master Suite offers multiple closets, separate vanities,walk-in shower and garden tub. Spacious room sizes and storage throughout.Bedroom and Bath arrangements were built for today's living and convenience.  Walk to neighborhood parks. A rated Hendricks Elementary also a walk or bike ride away. Pretty median treed street filled with homes of the era dead ending to riverfront homes."
    },
    {
        "id": 7,
        "remarks": "Wow! Pow! This one will knock you over! Like New! Meticulously cared for David Weekley home with all the bells and whistles! Telescoping sliders Open onto huge screened brick paver lanai with massive fireplace at end. Open concept floor plan has hardwood floors in all common areas, 3 way split bedroom plan, also has a study, formal dining room, sunroom, breakfast room - plenty of storage space, and room to spread out. Kitchen features a gorgeous large island, granite countertops, walk in pantry and upgraded stainless appliances lanai overlooks the park like, almost 1/2 acre fully fenced backyard with creek and preserve behind. Gated community no through traffic. Front view is a lake with fountain Heart of Mandarin.  If I could, I would buy this one myself!"
    },
    {
        "id": 8,
        "remarks": "Rare opportunity to own a home on fabulous Heaven Trees road! OPEN HOUSE Saturday 4/28 from 2 - 5! This beautiful brick home is move in ready! This home offers abundant living space with light filled rooms and hardwood floors. The kitchen features a gas range, double ovens, and granite countertops. Enjoy the expansive backyard with complete privacy. Owners have made several improvements including: New A/C 6/16, New Electric Box and Circuit Breakers 11/16, Front Septic Tank and Drainage Field Replaced 8/16, Back Septic Tank Improvements 4/18, New Hot Water Heater 5/14, New Soft Water Treatment System 7/12, Wet Bar installed in Family Room with beverage cooler, ice maker; and more. Please note: Fogged window in Sunroom is being replaced!"
    },
    {
        "id": 9,
        "remarks": "Wow! Spectacular opportunity to live in a charming, yet spacious, brick home in one the most highly desirable communities, Ortega Forest. This beautifully updated, one-story, pool home will be a beautiful place to make memories. The home features a large eat-in kitchen that has been fully renovated with custom cabinetry, granite countertops and upgraded, stainless appliances. A formal living and huge dining room are located at the front of the home. The family room/den features a gorgeous wood burning fireplace and overlooks the sparkling pool and backyard. The living and sleeping areas are separated. The large master bedroom features sizable his/her closets. The master and guest baths are renovated with custom cabinetry and marble countertops."
    },
    {
        "id": 10,
        "remarks": "Lovely updated home in desired gated community.  Large corner lot with new paver circular driveway. Great first impression entryway to open floor plan with warm wood floors. Separate Dining room, huge Family room with gas fireplace and custom mantel, and sitting or casual eating area. Spacious Kitchen with quartz countertops, stainless steel appliances, gas range, and breakfast bar. Large laundry room between garage and kitchen. Split bedrooms with private Master Bedroom overlooking fenced, landscaped backyard and screened lanai. Master Bath has granite countertops, double sinks, wood grain tile floors, tub and separate shower. Two guest Bedrooms and Bath opposite the master along with a 4th Bedroom or Bonus room upstairs with another full Bath. Close to Beaches and Shopping!"
    },
    {
        "id": 11,
        "remarks": "Historic Avondale home designed in the Prairie School style -- an architectural design made famous by Frank Lloyd Wright and Jacksonville resident Henry John Klutho. This 3 bedroom, two bath, 2,202 sq ft home has maintained its vintage appeal while combining modern updates, such as renovated kitchen with beverage fridge and wine storage. Granite countertops and 2-yr-old SS appliances. Updates meld beautifully with original Prairie School window casings with grids, glass knobs, hardwood inlay floors, 10'' baseboards, picture rail molding and all original doors. Beautifully glassed sun room at the front of the house is a perfect office or reading room. Gorgeous French doors open to private backyard built for entertaining. Two-car garage includes back entry, extra storage and partial bathroom"
    },
    {
        "id": 12,
        "remarks": "MUCH bigger than it looks! This remodeled 4bed/2.5bath Avondale home has a separate studio apartment which rents for $750 a month. Relax on the front porch or walk to Boone Park, numerous restaurants, and shops. The living room w/ the original fireplace has French doors which lead to a sun room/office. The hardwood floors have been refinished beautifully. The spacious kitchen has finely crafted cabinets, gorgeous granite countertops, and a  walk-in pantry. The laundry room includes a washer and dryer. A unique rock and metal design surrounds the jetted tub. A large linen closet is near by. 2 beds and 2 baths are on the main floor. Two bedrooms and a half bath are on the second floor.  A screened porch overlooks the fully fenced back yard."
    },
    {
        "id": 13,
        "remarks": "*DON'T MISS THIS BEAUTIFUL DAVID WEEKLEY BELMONTE MODEL*ONE OF THE LARGEST LOTS IN CROSSWATER*GREAT FOR OUTDOOR FUN!*LUXURIOUS LIVING!*HIGH TECH HOME*CROWN MOLDING, CUSTOM PLANTATION SHUTTERS, 18'' TILE & CUSTOM WHITE OAK HARDWOOD FLOORING THRUOUT THE HOME*LARGE OFFICE W/GLASS FRENCH DOORS*FORMAL DINING ROOM W/PICTURE FRAME MOLDING*GOURMET KITCHEN W/42''CUSTOM CABINETRY & GRANITE COUNTERTOPS, STAINLESS STEEL APPLIANCES, & HUGE ISLAND OPEN TO THE GREAT ROOM W/TRAY CEILING & SURROUND SOUND SPEAKERS*MASTER BEDROOM SUITE W/TRAY CEILING W/BEADBOARD INSET AND SHOWER W/OVERHEAD RAINFOREST HEAD*2 MORE BEDROOMS & OPEN ''FLEX'' AREA*COVERED LANAI OVERLOOKING THE HUGE FENCED BACKYARD*3-CAR GARAGE*''NEST'' THERMOSTAT & AT&T HOME SECURITY W/WIFI ACCESS*WATER SOFTENER*LOTS MORE!!!"
    },
    {
        "id": 14,
        "remarks": "This is a 4 bedroom, 3 bath, with additional tiled sunroom single family home located in the Pablo Bay community. Upgrades galore! This home offers gorgeous marble flooring throughout the living areas, high ceilings, an upgraded kitchen with granite countertops, a tile backsplash, and stainless steel appliances! Relax and enjoy the lake view from the tiled sunroom or the expansive fenced backyard! Will have a 1 year home warranty! Also listed for rent under MLS 903970"
    },
    {
        "id": 15,
        "remarks": "Spacious & updated 2-story home on large preserve lot nearly 1/2 acre! Concrete block constr. & desirable ICW location near JTB, shopping, dining & the beach! Great split BD flrpln w/soaring ceilings features 4BD + office, upstairs loft & 3 full BA. Beautiful tiled kitchen has granite countertops, island, newer refrigerator, cooktop, oven & convection microwave (2 yrs), breakfast bar & nook. Separate DR, LR & Fam Rm all w/crown molding & wood laminate flrs; FP in Fam Rm. Remodeled BA w/granite countertops & gorgeous travertine tiled showers & flrs. New Roof 6/2014 & New upgraded AC system 10/2015. Huge owner suite w/Jacuzzi tub, sep. shower, 2 walk-in closets & bonus rm w/French doors. Relaxing back porch w/phantom retractable screen overlooks the charming patio & huge stunning backyard!**"
    },
    {
        "id": 16,
        "remarks": "Location ... Location ...GOURGEOUS HOME in a Heart of MANDARIN,Next to Loretto Magnet schoolClose to I-295, shopping & entertainment. Gated community! Loaded with upgrades: GRANITE countertops,upgraded kitchen cabs w/crown molding, st steel appl, New carpets,New exterior and interior paint,Rain soft water softner, tile floors, bay windows, addtl loft + sep. Internet center, fireplace, lots of arches& niches, 2 story family room, huge covered porch overlooking, Planing to put the new sod in the front and sides, landscaped backyard and much more! MUST SEE!"
    },
    {
        "id": 17,
        "remarks": "WELCOME HOME! MOVE-IN-READY! Spacious & Beautifully updated home with over 3500 sq ft of comfort. Great for everyday living or entertaining. 5 Bedrooms and 3.5 baths. Spacious 1st floor owner suite with a huge walking closet, sitting area, updated master bath with double vanities, separate shower & garden tub. Updated kitchen with granite countertops, food prep island, all appliances, plenty of cabinets and breakfast nook. Inviting family room with fireplace and large picture windows that bring in natural light throughout. Formal dining & living rooms. 2nd floor offers spacious bonus room, 4 large bedrooms and 2 full baths. Hard wood floors, new roof 2016, many updates throughout. Inviting screened in porch, large back yard backs up to wooded preserve. Great Community amenities. A must see"
    },
    {
        "id": 18,
        "remarks": "Welcome to the very desirable community of ST. JOHNS LANDING. This 4 bedroom 2 bathroom home is located in a riverfront community. It has been totally upgraded, boasting detailed crown molding, new kitchen cabinets, Travertine Stone Floors & granite countertops throughout.  6 foot Jacuzzi tub in master bath and separate shower. Prewired alarm system. Central Heat & A/C replaced a year ago, fireplace and an energy saving on demand water heater are just some of the features this beautiful home has to offer.(BRAND NEW ROOF is Included).  This home sits on a corner lot with a fenced backyard, and a tiled heated and cooled lanai overlooking the plush lawn and playset. Walking distance to the community clubhouse, playground, fishing dock, boat ramp & pool. Buyer to verify square footage."
    },
    {
        "id": 19,
        "remarks": "Location ... Location ...GOURGEOUS HOME in a Heart of MANDARIN,Next to Loretto Magnet schoolClose to I-295, shopping & entertainment. Gated community! Loaded with upgrades: GRANITE countertops,upgraded kitchen cabs w/crown molding, st steel appl, New carpets,New exterior and interior paint,Rain soft water softner, tile floors, bay windows, addtl loft + sep. Internet center, fireplace, lots of arches& niches, 2 story family room, huge covered porch overlooking, Planing to put the new sod in the front and sides, landscaped backyard and much more! MUST SEE!"
    },
    {
        "id": 20,
        "remarks": "This house is ready for you to call it home! No stone was left unturned when it came to upgrades in this gorgeous home! As you walk through the front door, you'll be immediately impressed by the 20ft ceiling in the Grand Foyer. Beautiful hardwood floors throughout the first floor, Gourmet Kitchen, Double Ovens, Granite Countertops, Stainless Steel appliances. Need space? How about this: 5 bedrooms, 4 full bath (1 full bath and bedroom downstairs), plenty of room for a growing family. Need a place to escape to relax? Look no further, enjoy the peace and serenity that your large backyard offers, as you enjoy the evenings in your screened-in lanai, all behind the privacy of the preserve."
    },
    {
        "id": 21,
        "remarks": "BACK ON MARKET!!MOTIVATED SELLER, OFFERING A $3000 CONCESSION TOWARDS NEW FLOORING. CONCESSION PAID AT CLOSING! Come see this gorgeous 4 bedroom 4 bath home in beautiful Hampton Glen. This home has two large master bedrooms with ensuites with sitting area. The loft bedroom upstairs also has a full bath. All baths have been updated with granite countertops and tile. If you love to cook you will love this kitchen. This large kitchen has beautiful granite countertops and tile. Everything has been updated. The roof is brand new!!! It was replaced January 2017. The house has been completely painted inside and out. Come and enjoy the serenity of the backyard in your large screened in patio and view the tall pines of the preserve swaying in the breeze."
    },
    {
        "id": 22,
        "remarks": "Beautiful pool home that has all the upgrades you're looking for.  4 Bedroom/2 bath with updated kitchen with granite countertops, stainless steel appliances including a Bosch dishwasher and double ovens.  Formal Living room, dining room & separate family room with vauled ceilings. Family room is wired for speakers. Tile floors in kitchen & b'fast area.  Hardwood floors are found in the family room and 2 bedrooms.  The master bedroom has french doors out to the screened pool area.  The bath has separate vanities with granite tops, remodeled shower with a seat & his and hers closets.  There is a pool and spa.  Both are heated using solar panels, no gas heater.  There is a Soothing waterfall feature that makes this outdoor area perfect for entertaining.  Fenced back yard as well."
    },
    {
        "id": 23,
        "remarks": "What a gem !!!! Located within walking distance to Bolles on a quiet cul de sac street, this brick home, with a circular drive,has it all! New roof in 2017, re-plumbed in 2016 and 2 HVAC systems ( inside and out -2008 and 2017). The kitchen has beenbeautifully updated with granite countertops and cream cabinets.  The kitchen opens to a large family room. The master suite has 2 walk-in closets and a large updated bath with jacuzzi and separate shower, separate dining room and formal living room with wood burning fireplace. Freshly painted and new tile throughout. There is a large shed in the backyard for additional storage in addition to the 2 car garage.This home was renovated in 2008 and 1,400 sq. ft. was added to the original plan. OPEN HOUSE SUNDAY 3/12/17 1:00-3:00"
    },
    {
        "id": 24,
        "remarks": "Designed for Generous Space and Flexibility for Family or Lifestyle! This Midcentury Modern Pool Home offers over 3000 sf of upgrades & classic design on almost 1/2 acre. Original Hardwood Floors, Lots of Natural Light, Freshly Painted Interior, Custom Kitchen, Granite countertops, Newer AC & New Carpet upstairs. Spacious rooms throughout include Living room w/Fireplace, Formal Dining and even larger Casual Dining, Breakfast room or Office. Family room with built-ins & pool bath could also be Mother-in-Law Suite with private bath or 4th Bedroom. Perfect Home for Entertaining with Private Backyard, Majestic Oaks, Expansive multi-level patio & Sparkling Pool. Plenty of room for RV/Boat Parking. All this in Desirable Beauclerc location convenient to I-295, Downtown, nearby Shops & Restaurants"
    },
    {
        "id": 25,
        "remarks": "Welcome to your new home in James Island. Easy commuting around the City, close to Town Center and JTB takes you to the beaches. You have it all with this home - Owner Suite is on the first floor, large bonus room upstairs with full bath, office, formal dining room, living room, and family room with fireplace. Amazing owner bath and large owner suite with beautiful ceilings. Split floor plan for the other two bedrooms which share a Jack and Jill bathroom. High ceilings, crown molding and so much more. Tile and wood flooring downstairs, gas range, granite countertops, fenced backyard, welcoming front entrance and large covered patio. Seller will consider reasonable offers. With accepted offer seller will provide credits for the fogged windows and a replacement stainless steel oven."
    }
];

const sql_basic_dog_select = "SELECT * FROM dev.dog";
const sql_basic_cat_select = "SELECT * FROM dev.cat";
const test_basic_calc = "2 * 4";
const test_basic_calc_result = eval(test_basic_calc);
const sql_basic_op = `SELECT ${test_basic_calc}`;
const sql_integration_data = {};

let test_instance;

let sandbox;
let search_spy;
let _getColumns_spy;
let _getTables_spy;
let _conditionsToFetchAttributeValues_spy;
let _backtickAllSchemaItems_spy;
let _checkEmptySQL_spy;
let _findColumn_spy;
let _addFetchColumns_spy;
let _getFetchAttributeValues_spy;
let _checkHashValueExists_spy;
let _retrieveIds_spy;
let _readBlobFilesForSetup_spy;
let _consolidateData_spy;
let _processJoins_spy;
let _decideReadPattern_spy;
let _readRawFiles_spy;
let _readAttributeFilesByIds_spy;
let _readAttributeValues_spy;
let _readBlobFiles_spy;
let _finalSQL_spy;
let _buildSQL_spy;
let _stripFileExtension_spy;
let readdir_spy;
let readFile_spy;
let error_logger_spy;

function setClassMethodSpies() {
    sandbox = sinon.createSandbox();
    const getHdbBasePath_stub = function() {
        return `${TEST_FS_DIR}`;
    };
    FileSearch.__set__('base_path', getHdbBasePath_stub)
    search_spy = sandbox.spy(FileSearch.prototype, 'search');
    _getColumns_spy = sandbox.spy(FileSearch.prototype, '_getColumns');
    _getTables_spy = sandbox.spy(FileSearch.prototype, '_getTables');
    _conditionsToFetchAttributeValues_spy = sandbox.spy(FileSearch.prototype, '_conditionsToFetchAttributeValues');
    _backtickAllSchemaItems_spy = sandbox.spy(FileSearch.prototype, '_backtickAllSchemaItems');
    _checkEmptySQL_spy = sandbox.spy(FileSearch.prototype, '_checkEmptySQL');
    _findColumn_spy = sandbox.spy(FileSearch.prototype, '_findColumn');
    _addFetchColumns_spy = sandbox.spy(FileSearch.prototype, '_addFetchColumns');
    _getFetchAttributeValues_spy = sandbox.spy(FileSearch.prototype, '_getFetchAttributeValues');
    _checkHashValueExists_spy = sandbox.spy(FileSearch.prototype, '_checkHashValueExists');
    _retrieveIds_spy = sandbox.spy(FileSearch.prototype, '_retrieveIds');
    _readBlobFilesForSetup_spy = sandbox.spy(FileSearch.prototype, '_readBlobFilesForSetup');
    _consolidateData_spy = sandbox.spy(FileSearch.prototype, '_consolidateData');
    _processJoins_spy = sandbox.spy(FileSearch.prototype, '_processJoins');
    _decideReadPattern_spy = sandbox.spy(FileSearch.prototype, '_decideReadPattern');
    _readRawFiles_spy = sandbox.spy(FileSearch.prototype, '_readRawFiles');
    _readAttributeFilesByIds_spy = sandbox.spy(FileSearch.prototype, '_readAttributeFilesByIds');
    _readAttributeValues_spy = sandbox.spy(FileSearch.prototype, '_readAttributeValues');
    _readBlobFiles_spy = sandbox.stub(FileSearch.prototype, '_readBlobFiles').callThrough();
    _finalSQL_spy = sandbox.spy(FileSearch.prototype, '_finalSQL');
    _buildSQL_spy = sandbox.spy(FileSearch.prototype, '_buildSQL');
    _stripFileExtension_spy = sandbox.spy(FileSearch.prototype, '_stripFileExtension');
    readdir_spy = sandbox.spy(fs, 'readdir');
    readFile_spy = sandbox.spy(fs, 'readFile');
    error_logger_spy = sandbox.spy(log, 'error');
}

function setupBasicTestData() {
    const test_data_dog = deepClone(TEST_DATA_DOG);
    const test_data_cat = deepClone(TEST_DATA_CAT);

    createMockFS(HASH_ATTRIBUTE, TEST_SCHEMA, TEST_TABLE_DOG, test_data_dog);
    createMockFS(HASH_ATTRIBUTE, TEST_SCHEMA, TEST_TABLE_CAT, test_data_cat);
    createMockFS("all", "call", "aggr", deepClone(TEST_DATA_AGGR));
    createMockFS(HASH_ATTRIBUTE, TEST_SCHEMA, "longtext", deepClone(TEST_DATA_LONGTEXT));
}

async function setupSqlData() {
    const sql_csv_data = await getFormattedIntegrationTestCsvData();

    sql_csv_data.forEach(({ hash, schema, table, data }) => {
        const csv_data = deepClone(data);
        const attrs = Object.keys(data[0]);
        const test_attr = attrs[0] === hash ? attrs[1] : attrs[0];
        sql_integration_data[table] = { hash, schema, table, attrs, test_attr, data: csv_data };
        createMockFS(hash, schema, table, data);
    });
}

function sortDesc(data, sort_by) {
    if (sort_by) {
        return data.sort((a, b) => b[sort_by] - a[sort_by]);
    }

    return data.sort((a, b) => b - a);
}

function sortAsc(data, sort_by) {
    if (sort_by) {
        return data.sort((a, b) => a[sort_by] - b[sort_by]);
    }

    return data.sort((a, b) => a - b);
}

function setupTestInstance(sql_statement, set_null_attr) {
    const statement = sql_statement ? sql_statement : sql_basic_dog_select;
    const test_sql = generateMockAST(statement);
    const test_statement = test_sql.statement;
    const test_attributes = set_null_attr === true ? null : test_sql.attributes;
    test_instance = new FileSearch(test_statement, test_attributes);
}

function sortTestResults(test_results) {
    const sorted_arr = sortAsc(test_results, HASH_ATTRIBUTE);
    const sorted_results = [];
    sorted_arr.forEach(result => {
        const sorted_result = {}
        const sort_keys = Object.keys(result).sort();
        sort_keys.forEach(key => {
            sorted_result[key] = result[key];
        });
        sorted_results.push(sorted_result);
    });
    return sorted_results;
}

describe('Test FileSystem Class', () => {
    before(() => {
        tearDownMockFS();
        setupBasicTestData();
        setClassMethodSpies();
    });

    afterEach(() => {
        test_instance = null;
        sandbox.resetHistory();
    })

    after(() => {
        // TODO: this hook is timing out without this timeout - review to figure out why this is needed
        setTimeout(() => {
            tearDownMockFS();
        }, 200);
        sandbox.restore();
        rewire('../../../lib/fileSystem/SQLSearch');
    });

    describe('constructor()', () => {
        it('should call four class methods when instantiated', () => {
            setupTestInstance();
            expect(_getColumns_spy.calledOnce).to.equal(true);
            expect(_getTables_spy.calledOnce).to.equal(true);
            expect(_conditionsToFetchAttributeValues_spy.calledOnce).to.equal(true);
            expect(_backtickAllSchemaItems_spy.calledOnce).to.equal(true);
        });

        it('should throw an exception if no statement argument is provided', () => {
            let err;
            try {
                new FileSearch(null);
            } catch(e) {
                err = e;
            }
            expect(err).to.equal('statement cannot be null');
        });
    });

    describe('search()', () => {
        it('should return all rows when there is no WHERE clause', mochaAsyncWrapper(async () => {
            let search_results;
            setupTestInstance();

            try {
                search_results = await test_instance.search();
            } catch(e) {
                console.log(e);
            }

            const sorted_results = sortTestResults(search_results);
            expect(sorted_results).to.deep.equal(TEST_DATA_DOG);
        }));

        it('should return matching row based on WHERE clause', mochaAsyncWrapper(async() => {
            let search_results;
            const test_row = TEST_DATA_DOG[2];
            const test_sql_statement = `SELECT * FROM dev.dog WHERE id = ${test_row.id}`;

            setupTestInstance(test_sql_statement);

            try {
                search_results = await test_instance.search();
            } catch(e) {
                console.log(e);
            }

            const sorted_results = sortTestResults(search_results);
            expect(sorted_results[0]).to.deep.equal(test_row);
        }));

        it('should return matching rows based on WHERE clause', mochaAsyncWrapper(async() => {
            let search_results;
            const test_rows = [TEST_DATA_DOG[0], TEST_DATA_DOG[1], TEST_DATA_DOG[2]];
            const test_sql_statement = `SELECT * FROM dev.dog WHERE id <= ${TEST_DATA_DOG[2].id}`;

            setupTestInstance(test_sql_statement);
            try {
                search_results = await test_instance.search();
            } catch(e) {
                console.log(e);
            }

            const sorted_results = sortTestResults(search_results);
            expect(sorted_results).to.deep.equal(test_rows);
        }));

        it('should return [] if no rows meet WHERE clause', mochaAsyncWrapper(async() => {
            let search_results;
            const test_incorrect_id = TEST_DATA_DOG.length + 1;
            const test_sql_statement = `SELECT * FROM dev.dog WHERE id = ${test_incorrect_id}`;

            setupTestInstance(test_sql_statement);
            try {
                search_results = await test_instance.search();
            } catch(e) {
                console.log(e);
            }

            expect(search_results).to.be.an('array').that.has.lengthOf(0);
        }));

        it('should return the result of a operation with only a calculation', mochaAsyncWrapper(async() => {
            let search_results;
            setupTestInstance(sql_basic_op, null);

            try {
                search_results = await test_instance.search();
            } catch(e) {
                console.log(e);
            }

            expect(search_results[0]).to.have.property(test_basic_calc);
            expect(search_results[0][test_basic_calc]).to.equal(test_basic_calc_result);
            // Validate that other methods in search() method were not called;
            expect(_getFetchAttributeValues_spy.called).to.equal(false);
            expect(_retrieveIds_spy.called).to.equal(false);
            expect(_readBlobFilesForSetup_spy.called).to.equal(false);
            expect(_consolidateData_spy.called).to.equal(false);
            expect(_decideReadPattern_spy.called).to.equal(false);
            expect(_finalSQL_spy.called).to.equal(false);
        }));
    });

    // Note: These SELECT statements scenarios were developed from the SQL integration tests scenarios
    describe('search() - testing variety of SQL statements', () => {
        before(() => {
            setupSqlData();
        });

        it('Basic select by hash returns requested attribute values for hash', mochaAsyncWrapper(async () => {
            let search_results;
            const { attrs, data, hash } = sql_integration_data.customers;
            const test_row = data[5];
            const test_sql_statement = `SELECT ${attrs.toString()} FROM northnwd.customers WHERE ${hash} = '${test_row[hash]}'`;
            setupTestInstance(test_sql_statement);

            try {
                search_results = await test_instance.search();
            } catch(e) {
                console.log(e);
            }

            Object.keys(search_results[0]).forEach(key => {
                expect(search_results[0][key]).to.equal(test_row[key]);
            });
        }));

        it('Basic select by hash with wildcard returns requested attribute values for matching hashes', mochaAsyncWrapper(async () => {
            let search_results;
            const { attrs, data, hash } = sql_integration_data.customers;
            const test_search_val = "A";
            const expected_search_results = data.filter(row => row[hash].startsWith(test_search_val));
            const sorted_attrs = attrs.sort();

            const test_sql_statement = `SELECT ${attrs.toString()} FROM northnwd.customers WHERE ${hash} LIKE '${test_search_val}%'`;
            setupTestInstance(test_sql_statement);

            try {
                search_results = await test_instance.search();
            } catch(e) {
                console.log(e);
            }

            expect(search_results.length).to.equal(expected_search_results.length);
            search_results.forEach(row => {
                expect(Object.keys(row).sort()).to.deep.equal(sorted_attrs);
            });
        }));

        it('Basic select by value returns requested attributes for matching rows', mochaAsyncWrapper(async () => {
            let search_result;
            const { data, attrs, test_attr } = sql_integration_data.customers;
            const test_row = data[5];
            const test_sql_statement = `SELECT ${attrs.toString()} FROM northnwd.customers WHERE ${test_attr} = '${test_row[test_attr]}'`;
            setupTestInstance(test_sql_statement);

            try {
                search_result = await test_instance.search();
            } catch(e) {
                console.log(e);
            }

            expect(search_result.length).to.equal(1);
            Object.keys(search_result[0]).forEach(key => {
                expect(search_result[0][key]).to.equal(test_row[key]);
            });
        }));

        it('Basic select by value with wildcard returns requested attributes for matching rows', mochaAsyncWrapper(async () => {
            let search_results;
            const { data } = sql_integration_data.customers;
            const test_search_val = "A";
            const attr_key = 'companyname';
            const expected_search_results = data.filter(row => row[attr_key].startsWith(test_search_val));

            const test_sql_statement = `SELECT customerid, postalcode, companyname FROM northnwd.customers WHERE ${attr_key} LIKE '${test_search_val}%'`;
            setupTestInstance(test_sql_statement);

            try {
                search_results = await test_instance.search();
            } catch(e) {
                console.log(e);
            }

            expect(search_results.length).to.equal(expected_search_results.length).and.above(0);
            expect(Object.keys(search_results[0]).length).to.equal(3);
        }));

        it('should sort employees by hash in asc order', mochaAsyncWrapper(async () => {
            let search_results;
            const { data, hash } = sql_integration_data.employees;
            const sorted_data = sortTestResults(data);
            const sorted_hashes = sortAsc(sorted_data, hash);

            const test_sql_statement = `SELECT ${hash}, * from northnwd.employees ORDER BY ${hash} ASC`;
            setupTestInstance(test_sql_statement);

            try {
                search_results = await test_instance.search();
            } catch(e) {
                console.log(e);
            }

            expect(sortTestResults(search_results)).to.deep.equal(sorted_hashes);
        }));

        it('should return results when reserved words are used for schema.table AND are backticked', mochaAsyncWrapper(async () => {
            let search_results;
            const expected_data = TEST_DATA_AGGR.filter(row => row.all > 3);
            const expected_results = sortDesc(expected_data, 'all');

            const test_sql_statement = "select age AS `alter`, * from `call`.`aggr` as `and` WHERE `all` > 3 ORDER BY `and`.`all` DESC";
            setupTestInstance(test_sql_statement);

            try {
                search_results = await test_instance.search();
            } catch(e) {
                console.log(e);
            }

            expect(search_results.length).to.equal(expected_results.length).and.above(0);
            search_results.forEach((row, i) => {
                expect(row.all).to.equal(expected_results[i].all);
            });
        }));

        it('should return dot & double dot attribute values', mochaAsyncWrapper(async () => {
            let search_result;
            const test_hash_val = 11;
            const expected_result = TEST_DATA_AGGR.filter(row => row.all === test_hash_val);

            const test_sql_statement = "select * from `call`.`aggr` where `all` = " + test_hash_val;
            setupTestInstance(test_sql_statement);

            try {
                search_result = await test_instance.search();
            } catch(e) {
                console.log(e);
            }

            expect(search_result.length).to.equal(1);
            Object.keys(search_result[0]).forEach(attr => {
                if (expected_result[0][attr] === undefined) {
                    expect(search_result[0][attr]).to.equal(null);
                } else {
                    expect(search_result[0][attr]).to.equal(expected_result[0][attr]);
                }
            });
        }));

        it('should return orders sorted by orderid in desc order', mochaAsyncWrapper(async () => {
            let search_results;
            const { data, hash } = sql_integration_data.orders;
            const sorted_hashes = sortDesc(data, hash).map(row => row[hash]);

            const test_sql_statement = `SELECT ${hash}, * from northnwd.orders ORDER BY ${hash} DESC`;
            setupTestInstance(test_sql_statement);

            try {
                search_results = await test_instance.search();
            } catch(e) {
                console.log(e);
            }

            search_results.forEach((row, i) => {
                expect(row[hash]).to.equal(sorted_hashes[i]);
            });
        }));

        it('should return count of records with attr value equal to null', mochaAsyncWrapper(async () => {
            let search_results;
            const { data } = sql_integration_data.orders;
            const expected_result = data.filter(row => row.shipregion === null).length;

            const test_sql_statement = "select count(*) as `count` from northnwd.orders where shipregion IS NULL";
            setupTestInstance(test_sql_statement);

            try {
                search_results = await test_instance.search();
            } catch(e) {
                console.log(e);
            }

            expect(search_results[0].count).to.equal(expected_result);
        }));

        it('should return count of records with attr value NOT equal to null', mochaAsyncWrapper(async () => {
            let search_results;
            const { data } = sql_integration_data.orders;
            const expected_result = data.filter(row => row.shipregion !== null).length;

            const test_sql_statement = "SELECT count(*) as `count` from northnwd.orders where shipregion IS NOT NULL";
            setupTestInstance(test_sql_statement);

            try {
                search_results = await test_instance.search();
            } catch(e) {
                console.log(e);
            }

            expect(search_results[0].count).to.equal(expected_result);
        }));

        it('should return complex join sorted by summed attribute value and joined company name in desc order', mochaAsyncWrapper(async () => {
            let search_results;
            const { data } = sql_integration_data.orderdetails;
            const expected_results_sorted = sortDesc(data, 'unitprice');

            const test_sql_statement = "SELECT a.orderid, a.productid, d.companyname, d.contactmame, b.productname, SUM(a.unitprice) AS unitprice, SUM(a.quantity), SUM(a.discount) FROM northnwd.orderdetails a JOIN northnwd.products b ON a.productid = b.productid JOIN northnwd.orders c ON a.orderid = c.orderid JOIN northnwd.customers d ON c.customerid = d.customerid GROUP BY a.orderid, a.productid, d.companyname, d.contactmame, b.productname ORDER BY unitprice DESC, d.companyname";
            setupTestInstance(test_sql_statement);

            try {
                search_results = await test_instance.search();
            } catch(e) {
                console.log(e);
            }

            expect(search_results.length).to.equal(expected_results_sorted.length);
            expect(search_results[0].unitprice).to.equal(expected_results_sorted[0].unitprice);
            expect(search_results[0].companyname).to.equal("Berglunds snabbk\ufffdp");
            expect(search_results[1].companyname).to.equal("Great Lakes Food Market");
        }));

        it('should return requested attributes from 5 table join statement for specified companyname', mochaAsyncWrapper(async () => {
            let search_results;
            const test_companyname = "Alfreds Futterkiste"
            const expected_customer_data = sql_integration_data.customers.data.filter(row => row.companyname === test_companyname)[0];

            const test_sql_statement = `SELECT a.customerid, a.companyname, a.contactmame, b.orderid, b.shipname, d.productid, d.productname, d.unitprice, c.quantity, c.discount, e.employeeid, e.firstname, e.lastname FROM northnwd.customers a JOIN northnwd.orders b ON a.customerid = b.customerid JOIN northnwd.orderdetails c ON b.orderid = c.orderid JOIN northnwd.products d ON c.productid = d.productid JOIN northnwd.employees e ON b.employeeid = e.employeeid WHERE a.companyname = '${test_companyname}'`;
            setupTestInstance(test_sql_statement);

            try {
                search_results = await test_instance.search();
            } catch(e) {
                console.log(e);
            }

            expect(search_results.length).to.equal(12);
            expect(search_results[0].companyname).to.equal(test_companyname);
            expect(search_results[0].customerid).to.equal(expected_customer_data.customerid);
            expect(search_results[0].contactname).to.equal(expected_customer_data.contactname);
        }));

        it('should count customers and group by country attribute', mochaAsyncWrapper(async () => {
            let search_results;
            const { data } = sql_integration_data.customers;
            const expected_results = data.reduce((acc, row) => {
                const { country } = row;
                if (!acc[country]) {
                    acc[country] = 1;
                } else {
                    acc[country] += 1;
                }
                return acc;
            }, {})

            const test_sql_statement = "SELECT COUNT(customerid) AS counter, country FROM northnwd.customers GROUP BY country ORDER BY counter DESC";
            setupTestInstance(test_sql_statement);

            try {
                search_results = await test_instance.search();
            } catch(e) {
                console.log(e);
            }

            expect(search_results.length).to.equal(Object.keys(expected_results).length);
            search_results.forEach(row => {
                const { counter, country } = row;
                expect(counter).to.equal(expected_results[country]);
            });
        }));

        it('should return the top 10 products by unitprice based on limit and order by', mochaAsyncWrapper(async () => {
            let search_results;
            const test_limit = 10;
            const test_data = [...sql_integration_data.products.data];
            const expected_results = sortDesc(test_data, 'unitprice');
            expected_results.splice(test_limit);

            const test_sql_statement = `SELECT categoryid, productname, quantityperunit, unitprice, * from northnwd.products ORDER BY unitprice DESC LIMIT ${test_limit}`;
            setupTestInstance(test_sql_statement);

            try {
                search_results = await test_instance.search();
            } catch(e) {
                console.log(e);
            }

            expect(search_results.length).to.equal(test_limit)
            expect(sortTestResults(search_results)).to.deep.equal(sortTestResults(expected_results));
        }));

        it('should return count min max avg sum price of products', mochaAsyncWrapper(async () => {
            let search_results;
            const { data } = sql_integration_data.products;
            const expected_results = data.reduce((acc, row) => {
                const { unitprice } = row;
                acc.allproducts += 1;
                acc.sumprice += unitprice;
                acc.avgprice = acc.sumprice / acc.allproducts;
                if (!acc.minprice || unitprice < acc.minprice) {
                    acc.minprice = unitprice;
                }
                if (!acc.maxprice || unitprice > acc.maxprice) {
                    acc.maxprice = unitprice;
                }
                return acc;
            }, { allproducts: 0, minprice: null, maxprice: null, avgprice: 0, sumprice: 0 });

            const test_sql_statement = "SELECT COUNT(unitprice) AS allproducts, MIN(unitprice) AS minprice, MAX(unitprice) AS maxprice, AVG(unitprice) AS avgprice, SUM(unitprice) AS sumprice FROM northnwd.products";
            setupTestInstance(test_sql_statement);

            try {
                search_results = await test_instance.search();
            } catch(e) {
                console.log(e);
            }

            expect(search_results.length).to.equal(1);
            Object.keys(search_results[0]).forEach(val => {
                expect(search_results[0][val]).to.equal(expected_results[val]);
            });
        }));

        it('should return rounded unit price and group by calculated value', mochaAsyncWrapper(async () => {
            let search_results;
            const test_alias = "Price";
            const { data } = sql_integration_data.products;
            const expected_result = data.reduce((acc, row) => {
                const { unitprice } = row;
                const rounded_val = Math.round(unitprice);
                if (!acc.includes(rounded_val)) {
                    acc.push(rounded_val);
                };
                return acc;
            }, []);

            const test_sql_statement = `SELECT ROUND(unitprice) AS ${test_alias} FROM northnwd.products GROUP BY ROUND(unitprice)`;
            setupTestInstance(test_sql_statement);

            try {
                search_results = await test_instance.search();
            } catch(e) {
                console.log(e);
            }

            expect(search_results.length).to.equal(expected_result.length);
            search_results.forEach(val => {
                const price_val = val[test_alias];
                expect(Object.keys(val).length).to.equal(1);
                expect(expected_result.includes(price_val)).to.equal(true);
            });
        }));

        it('should return results based on wildcard and min value parameters', mochaAsyncWrapper(async () => {
            let search_results;
            const test_search_string = "T";
            const test_search_min = 100;
            const { data } = sql_integration_data.products;
            const expected_results = data.filter(row => row.productname.startsWith(test_search_string) && row.unitprice > test_search_min);

            const test_sql_statement = `SELECT * FROM northnwd.products WHERE (productname LIKE '${test_search_string}%') AND (unitprice > ${test_search_min})`;
            setupTestInstance(test_sql_statement);

            try {
                search_results = await test_instance.search();
            } catch(e) {
                console.log(e);
            }

            expect(sortTestResults(search_results)).to.deep.equal(sortTestResults(expected_results));
        }));

        it('should return longtext values based on regex', mochaAsyncWrapper(async () => {
            let search_results;
            const test_regex = "dock"
            const expected_results = TEST_DATA_LONGTEXT.filter(row => row.remarks.includes(test_regex));

            const test_sql_statement = `SELECT * FROM dev.longtext where remarks regexp '${test_regex}'`;
            // const test_sql_statement = `SELECT * FROM dev.longtext`;
            setupTestInstance(test_sql_statement);

            try {
                search_results = await test_instance.search();
            } catch(e) {
                console.log(e);
            }

            expect(search_results.length).to.equal(expected_results.length);
            expect(sortTestResults(search_results)).to.deep.equal(sortTestResults(expected_results));
        }));
    });

    describe('_checkEmptySQL()', () => {
        it('should return undefined if attributes and columns are set in class instance', mochaAsyncWrapper(async () => {
            let method_results;
            setupTestInstance();

            try {
                method_results = await test_instance._checkEmptySQL();
            } catch(e) {
                console.log(e);
            }
            expect(method_results).to.equal(undefined);
        }));

        it('should return the result of a sql operation if sql is only calculation', mochaAsyncWrapper(async () => {
            let method_results;
            setupTestInstance(sql_basic_op, null);

            try {
                method_results = await test_instance._checkEmptySQL();
            } catch(e) {
                console.log(e);
            }
            expect(method_results[0]).to.have.property(test_basic_calc);
            expect(method_results[0][test_basic_calc]).to.equal(test_basic_calc_result);
        }));
    });

    describe('_getColumns()', () => {
        it('should collect column data from the statement and set it to column property on class', () => {
            const test_sql_statement = "SELECT * FROM dev.dog";
            setupTestInstance(test_sql_statement);

            test_instance.columns = {};
            const test_AST_statememt = generateMockAST(test_sql_statement).statement;
            test_instance.statement = test_AST_statememt;
            test_instance._getColumns();

            const { columns } = test_instance.columns;
            const expected_columns = Object.keys(TEST_DATA_DOG[0]);
            expected_columns.push("*");
            expect(columns.length).to.equal(expected_columns.length);
            columns.forEach(col => {
                expect(expected_columns.includes(col.columnid)).to.equal(true);
                if (col.columnid !== "*") {
                    expect(col.tableid).to.equal(TEST_TABLE_DOG);
                }
            });
        });

        it('should collect column data from statement columns, joins, and order by and set to columns property', () => {
            const test_sql_statement = "SELECT d.id, d.name, d.breed, c.age FROM dev.dog d JOIN dev.cat c ON d.id = c.id ORDER BY d.id";
            setupTestInstance(test_sql_statement);

            test_instance.columns = {};
            const test_AST_statememt = generateMockAST(test_sql_statement).statement;
            test_instance.statement = test_AST_statememt;
            test_instance._getColumns();

            const column_data = test_instance.columns;
            const { columns, joins, order } = column_data;
            const expected_columns = { id: "d", name: "d", breed: "d", age: "c" };

            expect(Object.keys(column_data).length).to.equal(3);
            expect(columns.length).to.equal(4);
            expect(joins.length).to.equal(2);
            expect(order.length).to.equal(1);
            columns.forEach(col => {
                expect(col.tableid).to.equal(expected_columns[col.columnid]);
            });
            expect(joins[0].columnid).to.equal("id");
            expect(joins[0].tableid).to.equal("d");
            expect(joins[1].columnid).to.equal("id");
            expect(joins[1].tableid).to.equal("c");
            expect(order[0].columnid).to.equal("id");
            expect(order[0].tableid).to.equal("d");
        });

        it('should search for ORDER BY element and replace the column alias with the expression from SELECT', () => {
            const test_sql_statement = "SELECT d.id AS id, d.name, d.breed, c.age FROM dev.dog d JOIN dev.cat c ON d.id = c.id ORDER BY id";
            setupTestInstance(test_sql_statement);

            test_instance.columns = {};
            const test_AST_statememt = generateMockAST(test_sql_statement).statement;
            test_instance.statement = test_AST_statememt;
            test_instance._getColumns();

            const { columns } = test_instance.columns;
            expect(columns[0].columnid).to.equal("id");
            expect(columns[0].tableid).to.equal("d");
            expect(columns[0].as).to.equal("id");

            const { columnid, tableid } = test_instance.statement.order[0].expression;
            expect(columnid).to.equal("id");
            expect(tableid).to.equal("d");
        });
    });

    describe('_getTables()', () => {

        function checkTestInstanceData(data, table_id, hash_name, has_hash, merged_data) {
            const test_table_obj = data[table_id];
            const { __hash_name, __has_hash, __merged_data } = test_table_obj;

            const exp_hash_name = hash_name ? hash_name : 'id';
            const exp_has_hash = has_hash ? has_hash : false;
            const exp_merged_data = merged_data ? merged_data : {};

            expect(test_table_obj).to.be.an('object');
            expect(__hash_name).to.equal(exp_hash_name);
            expect(__has_hash).to.equal(exp_has_hash);
            expect(__merged_data).to.deep.equal(exp_merged_data);
        }

        it('test multiple attributes from ONE table sets one table in this.data and gets hash_name from global.schema', () => {
            setupTestInstance();
            test_instance.data = {};
            test_instance.tables = [];

            test_instance._getTables();
            const { data, tables } = test_instance;

            checkTestInstanceData(data, dog_schema_table_id);
            expect(tables[0].databaseid).to.equal(TEST_SCHEMA);
            expect(tables[0].tableid).to.equal(TEST_TABLE_DOG);
        });

        it('test multiple attributes from multiple table sets multiple tables in this.data and gets hash_name from global.schema', () => {
            const test_sql_statement = "SELECT d.id, d.name, d.breed, c.age FROM dev.dog d JOIN dev.cat c ON d.id = c.id";

            setupTestInstance(test_sql_statement);
            test_instance.data = {};
            test_instance.tables = [];

            test_instance._getTables();
            const { data, tables } = test_instance;

            checkTestInstanceData(data, dog_schema_table_id);
            checkTestInstanceData(data, cat_schema_table_id);
            expect(tables[0].databaseid).to.equal(TEST_SCHEMA);
            expect(tables[0].tableid).to.equal(TEST_TABLE_DOG);
            expect(tables[1].databaseid).to.equal(TEST_SCHEMA);
            expect(tables[1].tableid).to.equal(TEST_TABLE_CAT);
        });
    });

    describe('_conditionsToFetchAttributeValues()', () => {
        it('should NOT set exact_search_values property when there is no WHERE clause', () => {
            const test_sql_statement = sql_basic_dog_select;
            setupTestInstance(test_sql_statement);

            test_instance.exact_search_values = {};
            const test_AST_statememt = generateMockAST(test_sql_statement).statement;
            test_instance.statement = test_AST_statememt;
            test_instance._conditionsToFetchAttributeValues();

            const test_result = test_instance.exact_search_values;
            expect(test_result).to.deep.equal({});
        });

        it('should set exact_search_values property with data from WHERE clause', () => {
            const test_hash_val = "1";
            const test_sql_statement = sql_basic_dog_select + ` WHERE ${HASH_ATTRIBUTE} = ${test_hash_val}`;
            setupTestInstance(test_sql_statement);

            test_instance.exact_search_values = {};
            const test_AST_statememt = generateMockAST(test_sql_statement).statement;
            test_instance.statement = test_AST_statememt;
            test_instance._conditionsToFetchAttributeValues();

            const test_attr_path = `${TEST_SCHEMA}/${TEST_TABLE_DOG}/${HASH_ATTRIBUTE}`;
            const test_result = test_instance.exact_search_values;

            expect(test_result[test_attr_path]).to.be.a('object');
            expect(test_result[test_attr_path].ignore).to.equal(false);
            test_result[test_attr_path].values.forEach(val => {
                expect(val).to.equal(test_hash_val);
            });
        });

        it('should set multiple values to exact_search_values property with data from WHERE IN clause', () => {
            const test_hash_vals = "1,2";
            const test_sql_statement = sql_basic_dog_select + ` WHERE ${HASH_ATTRIBUTE} IN (${test_hash_vals})`;
            setupTestInstance(test_sql_statement);

            test_instance.exact_search_values = {};
            const test_AST_statememt = generateMockAST(test_sql_statement).statement;
            test_instance.statement = test_AST_statememt;
            test_instance._conditionsToFetchAttributeValues();

            const test_attr_path = `${TEST_SCHEMA}/${TEST_TABLE_DOG}/${HASH_ATTRIBUTE}`;
            const test_result = test_instance.exact_search_values;

            expect(test_result[test_attr_path]).to.be.a('object');
            expect(test_result[test_attr_path].ignore).to.equal(false);
            test_result[test_attr_path].values.forEach(val => {
                expect(["1","2"].includes(val)).to.equal(true);
            });
        });
    });

    describe('_backtickAllSchemaItems()', () => {
        function backtickString(string_val) {
          return `\`${string_val}\``;
        };

        it('should add backticks to all schema elements in statement property', () => {
            const test_sql_statement = "SELECT d.id AS id, d.name, d.breed, c.age FROM dev.dog d JOIN dev.cat c ON d.id = c.id ORDER BY id";
            setupTestInstance(test_sql_statement);

            const test_AST_statememt = generateMockAST(test_sql_statement).statement;
            const expected_results = deepClone(test_AST_statememt);
            test_instance.statement = test_AST_statememt;
            test_instance._backtickAllSchemaItems();

            const test_statement_keys = Object.keys(test_AST_statememt);
            test_statement_keys.forEach(key => {
               test_instance.statement[key].forEach((item_vals, i) => {
                   const initial_val = expected_results[key][i];
                   switch (key) {
                       case 'columns':
                           expect(item_vals.columnid).to.equal(backtickString(initial_val.columnid));
                           expect(item_vals.tableid).to.equal(backtickString(initial_val.tableid));
                           expect(item_vals.columnid_orig).to.equal(initial_val.columnid);
                           expect(item_vals.tableid_orig).to.equal(initial_val.tableid);
                           break;
                       case 'from':
                           expect(item_vals.databaseid).to.equal(backtickString(initial_val.databaseid));
                           expect(item_vals.tableid).to.equal(backtickString(initial_val.tableid));
                           expect(item_vals.databaseid_orig).to.equal(initial_val.databaseid);
                           expect(item_vals.tableid_orig).to.equal(initial_val.tableid);
                           break;
                       case 'joins':
                           expect(item_vals.on.left.columnid).to.equal(backtickString(initial_val.on.left.columnid));
                           expect(item_vals.on.left.tableid).to.equal(backtickString(initial_val.on.left.tableid));
                           expect(item_vals.on.right.columnid).to.equal(backtickString(initial_val.on.right.columnid));
                           expect(item_vals.on.right.tableid).to.equal(backtickString(initial_val.on.right.tableid));
                           expect(item_vals.table.databaseid).to.equal(backtickString(initial_val.table.databaseid));
                           expect(item_vals.table.tableid).to.equal(backtickString(initial_val.table.tableid));
                           expect(item_vals.on.left.columnid_orig).to.equal(initial_val.on.left.columnid);
                           expect(item_vals.on.left.tableid_orig).to.equal(initial_val.on.left.tableid);
                           expect(item_vals.on.right.columnid_orig).to.equal(initial_val.on.right.columnid);
                           expect(item_vals.on.right.tableid_orig).to.equal(initial_val.on.right.tableid);
                           expect(item_vals.table.databaseid_orig).to.equal(initial_val.table.databaseid);
                           expect(item_vals.table.tableid_orig).to.equal(initial_val.table.tableid);
                           break;
                       case 'order':
                           expect(item_vals.expression.columnid).to.equal(backtickString(initial_val.expression.columnid));
                           expect(item_vals.expression.columnid_orig).to.equal(initial_val.expression.columnid);
                           break;
                       default:
                           break;
                   }
               });
            });
        });
    });

    describe('_findColumn()', () => {
        it('should return full column data for requested column', () => {
            setupTestInstance();

            const test_column = { columnid: HASH_ATTRIBUTE, tableid: TEST_TABLE_DOG };
            const test_result = test_instance._findColumn(test_column);

            expect(test_result.attribute).to.equal(test_column.columnid);
            expect(test_result.table.databaseid).to.equal(TEST_SCHEMA);
            expect(test_result.table.tableid).to.equal(test_column.tableid);
        });

        it('should return column data for alias', () => {
            const test_alias = 'dogname';
            const test_sql_statement = `SELECT d.id AS id, d.name AS ${test_alias}, d.breed, c.age FROM dev.dog d JOIN dev.cat c ON d.id = c.id ORDER BY id`;
            setupTestInstance(test_sql_statement);

            const test_column = {columnid: test_alias};
            const test_result = test_instance._findColumn(test_column);

            expect(test_result.as).to.equal(test_alias);
            expect(test_result.columnid).to.equal('name');
            expect(test_result.tableid).to.equal('d');
        });

        it('should NOT return data for column that does not exist', () => {
            const test_column = {columnid: 'snoopdog'};
            setupTestInstance();

            const test_result = test_instance._findColumn(test_column);

            expect(test_result).to.equal(undefined);
        });
    });

    describe('_addFetchColumns()', () => {
        it('should add columns from JOIN clause to fetch_attributes property', () => {
            const test_sql_statement = `SELECT d.id AS id, d.name, d.breed, c.age FROM dev.dog d JOIN dev.cat c ON d.id = c.id`;
            setupTestInstance(test_sql_statement);

            test_instance._addFetchColumns(test_instance.columns.joins);

            expect(test_instance.fetch_attributes.length).to.equal(2);
            expect(test_instance.fetch_attributes[0].attribute).to.equal(HASH_ATTRIBUTE);
            expect(test_instance.fetch_attributes[0].table.as).to.equal("d");
            expect(test_instance.fetch_attributes[0].table.databaseid).to.equal(TEST_SCHEMA);
            expect(test_instance.fetch_attributes[0].table.tableid).to.equal(TEST_TABLE_DOG);
            expect(test_instance.fetch_attributes[1].attribute).to.equal(HASH_ATTRIBUTE);
            expect(test_instance.fetch_attributes[1].table.as).to.equal("c");
            expect(test_instance.fetch_attributes[1].table.databaseid).to.equal(TEST_SCHEMA);
            expect(test_instance.fetch_attributes[1].table.tableid).to.equal(TEST_TABLE_CAT);
        });

        it('should add columns from ORDER BY clause to fetch_attributes property', () => {
            const test_sql_statement = `${sql_basic_dog_select} ORDER BY id`;
            setupTestInstance(test_sql_statement);

            test_instance._addFetchColumns(test_instance.columns.order);

            expect(test_instance.fetch_attributes.length).to.equal(1);
            expect(test_instance.fetch_attributes[0].attribute).to.equal(HASH_ATTRIBUTE);
            expect(test_instance.fetch_attributes[0].table.databaseid).to.equal(TEST_SCHEMA);
            expect(test_instance.fetch_attributes[0].table.tableid).to.equal(TEST_TABLE_DOG);
        });

        it('should add columns from WHERE clause to fetch_attributes property', () => {
            const test_sql_statement = `${sql_basic_dog_select} WHERE id IN(1,2,3)`;
            setupTestInstance(test_sql_statement);

            test_instance._addFetchColumns(test_instance.columns.where);

            expect(test_instance.fetch_attributes.length).to.equal(1);
            expect(test_instance.fetch_attributes[0].attribute).to.equal(HASH_ATTRIBUTE);
            expect(test_instance.fetch_attributes[0].table.databaseid).to.equal(TEST_SCHEMA);
            expect(test_instance.fetch_attributes[0].table.tableid).to.equal(TEST_TABLE_DOG);
        });

        it('should NOT add columns to fetch_attributes property if not found', () => {
            const test_sql_statement = `${sql_basic_dog_select}`;
            setupTestInstance(test_sql_statement);

            const test_column = {columnid: 'snoopdog'};
            test_instance._addFetchColumns(test_column);

            expect(test_instance.fetch_attributes.length).to.equal(0);
        });
    });

    describe('_getFetchAttributeValues()', () => {
        // const test_sql_basic = sql_basic_dog_select;
        // const test_sql_join = `SELECT d.id AS id, d.name, d.breed, c.age FROM dev.dog d JOIN dev.cat c ON d.id = c.id`;
        // const test_sql_orderby = `${sql_basic_dog_select} ORDER BY id`;
        // const test_sql_where = `${sql_basic_dog_select} WHERE id IN(1,2,3)`;

        it('should set hash values to the fetched_attr property for basic full table select', mochaAsyncWrapper(async () => {
            const test_sql_basic = sql_basic_dog_select;
            setupTestInstance(test_sql_basic);

            const expected_result = TEST_DATA_DOG.map(col => `${col.id}`);
            await test_instance._getFetchAttributeValues();

            expect(test_instance.fetch_attributes[0].values).to.deep.equal(expected_result);
            expect(readdir_spy.calledOnce).to.equal(true);
        }));

        it('should set values to the fetched_attr property for specified hash attributes from WHERE clause', mochaAsyncWrapper(async () => {
            const test_sql_where = `${sql_basic_dog_select} WHERE id IN(1,2,3)`;
            setupTestInstance(test_sql_where);

            const expected_result = TEST_DATA_DOG.reduce((acc, col) => {
                if (col.id < 4) {
                    acc.push(`${col.id}`);
                }
                return acc;
            }, []);
            await test_instance._getFetchAttributeValues();

            expect(test_instance.fetch_attributes.length).to.equal(1);
            expect(test_instance.fetch_attributes[0].values.length).to.equal(expected_result.length);
            test_instance.fetch_attributes[0].values.forEach(col => {
                expect(expected_result.includes(col)).to.equal(true);
            });
            expect(_checkHashValueExists_spy.calledOnce).to.equal(true);
            expect(readdir_spy.calledOnce).to.equal(false);
        }));

        it('should set values to the fetched_attr property for specified attribute value from WHERE clause', mochaAsyncWrapper(async () => {
            const name_attr_val = "Sam";
            const test_sql_where = `${sql_basic_dog_select} WHERE name = '${name_attr_val}'`;
            setupTestInstance(test_sql_where);

            const expected_result = [name_attr_val]
            await test_instance._getFetchAttributeValues();

            expect(test_instance.fetch_attributes.length).to.equal(1);
            expect(test_instance.fetch_attributes[0].values).to.deep.equal(expected_result);
            expect(_checkHashValueExists_spy.called).to.equal(false);
            expect(readdir_spy.calledOnce).to.equal(false);
        }));

        it('should set values to the fetched_attr property for specified attributes from JOIN clause', mochaAsyncWrapper(async () => {
            const test_sql_join = `SELECT d.id AS id, d.name, d.breed, c.age FROM dev.dog d JOIN dev.cat c ON d.id = c.id`;
            setupTestInstance(test_sql_join);

            const expected_result_dog = TEST_DATA_DOG.map(col => `${col.id}`);
            const expected_result_cat = TEST_DATA_CAT.map(col => `${col.id}`);
            await test_instance._getFetchAttributeValues();

            expect(test_instance.fetch_attributes.length).to.equal(2);
            expect(test_instance.fetch_attributes[0].values).to.deep.equal(expected_result_dog);
            expect(test_instance.fetch_attributes[1].values).to.deep.equal(expected_result_cat);
            expect(_stripFileExtension_spy.callCount).to.equal(expected_result_dog.length + expected_result_cat.length);
            expect(readdir_spy.calledTwice).to.equal(true);
        }));

        it('should set values to the fetched_attr property for specified hash from ORDER BY clause', mochaAsyncWrapper(async () => {
            const test_sql_orderby = `${sql_basic_dog_select} ORDER BY id`;
            setupTestInstance(test_sql_orderby);

            const expected_result = TEST_DATA_DOG.map(col => `${col.id}`);
            await test_instance._getFetchAttributeValues();

            expect(test_instance.fetch_attributes.length).to.equal(1);
            expect(test_instance.fetch_attributes[0].values).to.deep.equal(expected_result);
            expect(readdir_spy.calledOnce).to.equal(true);
        }));

        it('should set values to the fetched_attr property for specified attribute value from ORDER BY clause', mochaAsyncWrapper(async () => {
            const name_attr_key = "name";
            const test_sql_orderby = `${sql_basic_dog_select} ORDER BY ${name_attr_key}`;
            setupTestInstance(test_sql_orderby);

            const expected_result_id = TEST_DATA_DOG.map(col => `${col.id}`);
            const expected_result_name = TEST_DATA_DOG.reduce((acc, col) => {
                if (!acc.includes(`${col.name}`)) {
                    acc.push(`${col.name}`);
                }
                return acc;
            },[]);
            await test_instance._getFetchAttributeValues();

            expect(test_instance.fetch_attributes.length).to.equal(2);
            expect(test_instance.fetch_attributes[0].values).to.deep.equal(expected_result_id);
            expect(test_instance.fetch_attributes[1].values.length).to.equal(expected_result_name.length);
            test_instance.fetch_attributes[1].values.forEach(col => {
                expect(expected_result_name.includes(col)).to.equal(true);
            })
            expect(readdir_spy.calledTwice).to.equal(true);
            expect(_stripFileExtension_spy.callCount).to.equal(expected_result_id.length);
        }));
    });

    describe('_checkHashValueExists()', () => {
        it('should return valid hash values', mochaAsyncWrapper(async () => {
            const test_hash_ids = TEST_DATA_DOG.reduce((acc, col) => {
                if (col.id < 4) {
                    acc.push(`${col.id}`);
                }
                return acc;
            }, []).sort((a, b) => a - b);

            const test_attr_path = path.join(getMockFSPath(), TEST_SCHEMA, TEST_TABLE_DOG, HASH_FOLDER_NAME, HASH_ATTRIBUTE);

            setupTestInstance();
            const test_result = await test_instance._checkHashValueExists(test_attr_path, test_hash_ids);
            const test_result_sorted = test_result.sort((a, b) => a - b);

            expect(test_result_sorted).to.deep.equal(test_hash_ids);
        }));

        it('should not return invalid hash values and log them as errors', mochaAsyncWrapper(async () => {
            const test_hash_ids = TEST_DATA_DOG.reduce((acc, col) => {
                if (col.id < 4) {
                    acc.push(`${col.id}`);
                }
                return acc;
            }, []);
            const test_attr_path = path.join(getMockFSPath(), TEST_SCHEMA, TEST_TABLE_DOG, HASH_FOLDER_NAME, HASH_ATTRIBUTE);
            const expected_results = deepClone(test_hash_ids);
            test_hash_ids.push("444");
            test_hash_ids.push("445");

            setupTestInstance();
            const test_result = await test_instance._checkHashValueExists(test_attr_path, test_hash_ids);

            expect(test_result.length).to.equal(expected_results.length);
            test_result.forEach(val => {
                expect(expected_results.includes(val)).to.equal(true);
            })
            expect(error_logger_spy.callCount).to.equal(2);
        }));

        it('should return [] and log errors if an incorrect attribute path is passed in', mochaAsyncWrapper(async () => {
            const test_hash_ids = TEST_DATA_DOG.reduce((acc, col) => {
                if (col.id < 4) {
                    acc.push(`${col.id}`);
                }
                return acc;
            }, []);
            const test_attr_path = path.join(getMockFSPath(), TEST_SCHEMA, TEST_TABLE_DOG, HASH_FOLDER_NAME, "snoopdog");

            setupTestInstance();
            const test_result = await test_instance._checkHashValueExists(test_attr_path, test_hash_ids);

            expect(test_result.length).to.equal(0);
            expect(error_logger_spy.callCount).to.equal(test_hash_ids.length);
        }));
    });

    describe('_retrieveIds()', () => {
        const where_in_hash_ids = TEST_DATA_DOG.reduce((acc, col) => {
            if (col.id < 4) {
                acc.push(col.id);
            }
            return acc;
        }, []);

        const uniq_shortened_longtext = TEST_DATA_LONGTEXT.reduce((acc, row) => {
            const clone = deepClone(row.remarks);
            clone.slice(0, 254);
            if (!acc.includes(clone)) {
                acc.push(clone);
            }
            return acc;
        },[]);

        it('should set data property with hash attributes values', mochaAsyncWrapper(async () => {
            const expected_hash_ids = TEST_DATA_DOG.map(col => col.id);
            setupTestInstance();

            await test_instance._getFetchAttributeValues();
            const test_result = await test_instance._retrieveIds();
            const test_instance_data = test_instance.data[dog_schema_table_id];

            expect(test_result).to.deep.equal({});
            expect(test_instance_data.__has_hash).to.equal(true);
            expect(Object.keys(test_instance_data.__merged_data).length).to.equal(TEST_DATA_DOG.length);
            expect(Object.keys(test_instance_data.id).length).to.equal(expected_hash_ids.length);
            Object.keys(test_instance_data.id).forEach(val => {
                expect(expected_hash_ids.includes(test_instance_data.id[val])).to.equal(true);
            });
        }));

        it('should set data property for dog and cat table attributes', mochaAsyncWrapper(async () => {
            const expected_hash_ids_d = TEST_DATA_DOG.map(col => col.id);
            const expected_names_d = TEST_DATA_DOG.reduce((acc, col) => {
                acc[col.id] = col.name;
                return acc;
            }, {});
            const expected_hash_ids_c = TEST_DATA_CAT.map(col => col.id);
            const test_sql_statement = `SELECT d.id, d.name AS name, d.breed, c.age FROM dev.dog d JOIN dev.cat c ON d.id = c.id ORDER BY name`;
            setupTestInstance(test_sql_statement);
            await test_instance._getFetchAttributeValues();

            const test_result = await test_instance._retrieveIds();
            const test_instance_data_d = test_instance.data[dog_schema_table_id];
            const test_instance_data_c = test_instance.data[cat_schema_table_id];

            expect(test_result).to.deep.equal({});
            //check this.data for dog table
            expect(test_instance_data_d.__has_hash).to.equal(true);
            expect(Object.keys(test_instance_data_d.__merged_data).length).to.equal(TEST_DATA_DOG.length);
            expect(Object.keys(test_instance_data_d.id).length).to.equal(expected_hash_ids_d.length);
            expect(Object.keys(test_instance_data_d.name).length).to.equal(TEST_DATA_DOG.length);
            Object.keys(test_instance_data_d.id).forEach(val => {
                expect(expected_hash_ids_d.includes(test_instance_data_d.id[val])).to.equal(true);
            });
            Object.keys(test_instance_data_d.name).forEach(val => {
                expect(test_instance_data_d.name[val]).to.equal(expected_names_d[val]);
            });
            //check this.data for cat table
            expect(test_instance_data_c.__has_hash).to.equal(true);
            expect(Object.keys(test_instance_data_c.__merged_data).length).to.equal(TEST_DATA_CAT.length);
            expect(Object.keys(test_instance_data_c.id).length).to.equal(expected_hash_ids_c.length);
            Object.keys(test_instance_data_c.id).forEach(val => {
                expect(expected_hash_ids_c.includes(test_instance_data_c.id[val])).to.equal(true);
            });
        }));

        it('should set data property hash values in WHERE clause', mochaAsyncWrapper(async () => {
            const test_sql_statement = `${sql_basic_dog_select} WHERE id IN(${where_in_hash_ids.toString()})`;
            setupTestInstance(test_sql_statement);
            await test_instance._getFetchAttributeValues();

            const test_results = await test_instance._retrieveIds();
            const test_instance_data = test_instance.data[dog_schema_table_id];

            expect(test_results).to.deep.equal({});
            expect(test_instance_data.__has_hash).to.equal(true);
            expect(Object.keys(test_instance_data.__merged_data).length).to.equal(where_in_hash_ids.length);
            expect(Object.keys(test_instance_data.id).length).to.equal(where_in_hash_ids.length);
            Object.keys(test_instance_data.id).forEach(val => {
                expect(where_in_hash_ids.includes(test_instance_data.id[val])).to.equal(true);
            });
        }));

        it('should return blob dir paths for unique char-limited long text values and set ids in data property', mochaAsyncWrapper(async () => {
            const test_sql_statement = `SELECT * FROM dev.longtext ORDER BY remarks`;
            setupTestInstance(test_sql_statement);
            await test_instance._getFetchAttributeValues();

            const test_results = await test_instance._retrieveIds();
            const test_instance_data = test_instance.data[longtext_scheam_table_id];

            expect(test_instance_data.__has_hash).to.equal(true);
            expect(test_instance_data.__hash_name).to.equal(HASH_ATTRIBUTE);
            expect(Object.keys(test_instance_data.__merged_data).length).to.equal(TEST_DATA_LONGTEXT.length);
            expect(Object.keys(test_results).length).to.equal(uniq_shortened_longtext.length);
        }));

        it('should return blob data for hash values in WHERE clause', mochaAsyncWrapper(async () => {
            const test_sql_statement = `SELECT * FROM dev.longtext WHERE id IN(${where_in_hash_ids.toString()}) ORDER BY remarks`;
            setupTestInstance(test_sql_statement);
            await test_instance._getFetchAttributeValues();

            const test_results = await test_instance._retrieveIds();
            const test_results_keys = Object.keys(test_results);
            const test_instance_data = test_instance.data[longtext_scheam_table_id];

            expect(test_instance_data.__has_hash).to.equal(true);
            expect(test_instance_data.__hash_name).to.equal(HASH_ATTRIBUTE);
            expect(Object.keys(test_instance_data.__merged_data).length).to.equal(where_in_hash_ids.length);
            expect(test_results_keys.length).to.equal(uniq_shortened_longtext.length);
        }));

        it('should set a remarks property on this.data and return all unique file paths for remarks blob dirs', mochaAsyncWrapper(async () => {
            const test_regex = "dock";
            const test_sql_statement = `SELECT * FROM dev.longtext WHERE remarks regexp '${test_regex}'`;
            setupTestInstance(test_sql_statement);
            await test_instance._getFetchAttributeValues();

            const test_results = await test_instance._retrieveIds();
            const test_results_keys = Object.keys(test_results);
            const test_instance_data = test_instance.data[longtext_scheam_table_id];

            expect(test_instance_data.__has_hash).to.equal(false);
            expect(test_instance_data.__hash_name).to.equal(HASH_ATTRIBUTE);
            expect(test_instance_data.__merged_data).to.deep.equal({});
            expect(test_instance_data.remarks).to.deep.equal({});
            expect(test_results_keys.length).to.equal(uniq_shortened_longtext.length);
        }));
    });

    describe('_readBlobFilesForSetup()', () => {
        it('should break if blob_paths argument is an empty object', mochaAsyncWrapper(async () => {
            setupTestInstance();
            const initial_data_val = deepClone(test_instance.data);

            await test_instance._readBlobFilesForSetup({});

            expect(test_instance.data).to.deep.equal(initial_data_val);
            expect(readdir_spy.called).to.equal(false);
        }));

        it('should collect full blob value and assign it to hash value', mochaAsyncWrapper(async () => {
            const test_regex = "dock";
            const test_sql_statement = `SELECT * FROM dev.longtext WHERE remarks regexp '${test_regex}'`;

            setupTestInstance(test_sql_statement);
            await test_instance._getFetchAttributeValues();
            const blob_paths = await test_instance._retrieveIds();
            const test_instance_data = test_instance.data[longtext_scheam_table_id];

            //validate that remarks property has not been set w/ values
            expect(Object.keys(test_instance_data.remarks).length).to.equal(0);
            await test_instance._readBlobFilesForSetup(blob_paths);

            //validate that remarks data has been set w/ full values
            expect(Object.keys(test_instance_data.remarks).length).to.equal(TEST_DATA_LONGTEXT.length);
            TEST_DATA_LONGTEXT.forEach(row => {
                expect(row.remarks).to.equal(test_instance_data.remarks[row.id]);
            })
            expect(test_instance_data.__has_hash).to.equal(false);
            expect(test_instance_data.__hash_name).to.equal(HASH_ATTRIBUTE);
            expect(Object.keys(test_instance_data.__merged_data).length).to.equal(TEST_DATA_LONGTEXT.length);
        }));
    });

    describe('_consolidateData()', () => {
        const where_in_hash_ids = TEST_DATA_DOG.reduce((acc, col) => {
            if (col.id < 4) {
                acc.push(col.id);
            }
            return acc;
        }, []);

        it('should collect all id and name attribute values for table into __merged_data', mochaAsyncWrapper(async () => {
            const expected_values = TEST_DATA_DOG.reduce((acc, col) => {
                acc[col.id] = {
                    age: col.age,
                    breed: col.breed,
                    name: col.name
                };
                return acc;
            }, {});
            const test_sql_statement = `SELECT * FROM dev.dog WHERE id IN(${where_in_hash_ids}) ORDER BY id, name, breed, age`;

            setupTestInstance(test_sql_statement);
            await test_instance._getFetchAttributeValues();
            await test_instance._retrieveIds();
            await test_instance._consolidateData();
            const test_instance_data = test_instance.data[dog_schema_table_id];

            expect(test_instance_data.__has_hash).to.equal(true);
            const merged_data_keys = Object.keys(test_instance_data.__merged_data);
            expect(merged_data_keys.length).to.equal(TEST_DATA_DOG.length);
            merged_data_keys.forEach(hash_val => {
                expect(test_instance_data.__merged_data[hash_val].age).to.equal(expected_values[hash_val].age);
                expect(test_instance_data.__merged_data[hash_val].breed).to.equal(expected_values[hash_val].breed);
                expect(test_instance_data.__merged_data[hash_val].name).to.equal(expected_values[hash_val].name);
            })
            const id_attr_keys = Object.keys(test_instance_data.id);
            expect(id_attr_keys.length).to.equal(where_in_hash_ids.length);
            id_attr_keys.forEach(val => {
                expect(where_in_hash_ids.includes(test_instance_data.id[val])).to.equal(true);
            });
        }));

        it('should nullify non-hash attribute properties in this.data after adding values to __merged_data (to free up memory)', mochaAsyncWrapper(async () => {
            const test_sql_statement = `SELECT * FROM dev.dog WHERE id IN(${where_in_hash_ids}) ORDER BY id, name, breed, age`;

            setupTestInstance(test_sql_statement);
            await test_instance._getFetchAttributeValues();
            await test_instance._retrieveIds();
            await test_instance._consolidateData();

            const test_instance_data = test_instance.data[dog_schema_table_id];
            expect(test_instance_data.name).to.equal(null);
            expect(test_instance_data.breed).to.equal(null);
            expect(test_instance_data.age).to.equal(null);
            expect(Object.keys(test_instance_data.id).length).to.equal(where_in_hash_ids.length);
        }));
    });

    describe('_processJoins()', () => {
        //TODO: update this to be global for all other tests using it
        const where_in_hash_ids = TEST_DATA_DOG.reduce((acc, col) => {
            if (col.id < 4) {
                acc.push(col.id);
            }
            return acc;
        }, []);

        it('should remove rows from `__merged_data` that do not meet WHERE clause', mochaAsyncWrapper(async () => {
            const expected_attr_keys = ['id', 'name', 'breed'];
            const test_sql_statement = `SELECT * FROM dev.dog WHERE id IN(${where_in_hash_ids}) ORDER BY ${expected_attr_keys.toString()}`;

            setupTestInstance(test_sql_statement);
            await test_instance._getFetchAttributeValues();
            await test_instance._retrieveIds();
            await test_instance._consolidateData();

            const merged_data = test_instance.data[dog_schema_table_id].__merged_data;
            const expected_merged_data = Object.keys(merged_data).reduce((acc, key) => {
                if (where_in_hash_ids.includes(parseInt(key))) {
                    acc[key] = merged_data[key];
                }
                return acc;
            }, {})
            const test_results = await test_instance._processJoins();

            expect(test_results.joined_length).to.equal(where_in_hash_ids.length);
            const test_result_table_attrs = test_results.existing_attributes[TEST_TABLE_DOG];
            expect(test_result_table_attrs.length).to.equal(expected_attr_keys.length);
            test_result_table_attrs.forEach(attr => {
                expect(expected_attr_keys.includes(attr)).to.equal(true);
            });
            expect(merged_data).to.deep.equal(expected_merged_data);
        }));

        it('should update merged_data for each table based on overlap of JOIN clause', mochaAsyncWrapper(async () => {
            const test_sql_statement = "SELECT d.id, d.name, d.breed, c.age FROM dev.dog d JOIN dev.cat c ON d.id = c.id ORDER BY d.id, d.name, d.breed";
            const expected_attr_keys_d = ['id', 'name', 'breed'];

            setupTestInstance(test_sql_statement);
            await test_instance._getFetchAttributeValues();
            await test_instance._retrieveIds();
            await test_instance._consolidateData();

            const merged_data_d = test_instance.data[dog_schema_table_id].__merged_data;
            const merged_data_c = test_instance.data[cat_schema_table_id].__merged_data;
            const expected_merged_data_d = Object.keys(merged_data_d).reduce((acc, key) => {
                if (Object.keys(merged_data_c).includes(key)) {
                    acc[key] = merged_data_d[key];
                }
                return acc;
            }, {});
            const expected_merged_data_c = deepClone(merged_data_c);

            const test_results = await test_instance._processJoins();

            expect(test_results.joined_length).to.equal(2);
            const test_result_table_attrs_d = test_results.existing_attributes[TEST_TABLE_DOG];
            expect(test_result_table_attrs_d.length).to.equal(3);
            test_result_table_attrs_d.forEach(attr => {
                expect(expected_attr_keys_d.includes(attr)).to.equal(true);
            });
            const test_result_table_attrs_c = test_results.existing_attributes[TEST_TABLE_CAT];
            expect(test_result_table_attrs_c.length).to.equal(1);
            expect(test_result_table_attrs_c[0]).to.equal(HASH_ATTRIBUTE);
            expect(merged_data_d).to.deep.equal(expected_merged_data_d);
            expect(merged_data_c).to.deep.equal(expected_merged_data_c);
        }));

        it('should update __merged_data for longtext blobs based on WHERE statement', mochaAsyncWrapper(async () => {
            const test_regex = "dock";
            const test_sql_statement = `SELECT * FROM dev.longtext WHERE remarks regexp '${test_regex}'`;
            const expected_attr_keys = Object.keys(TEST_DATA_LONGTEXT[0]);

            setupTestInstance(test_sql_statement);
            await test_instance._getFetchAttributeValues();
            const blob_paths = await test_instance._retrieveIds();
            await test_instance._readBlobFilesForSetup(blob_paths);
            await test_instance._consolidateData();

            const test_results = await test_instance._processJoins();

            const merged_data = test_instance.data[longtext_scheam_table_id].__merged_data;
            const merged_data_keys = Object.keys(merged_data);
            expect(test_results.joined_length).to.equal(merged_data_keys.length);
            merged_data_keys.forEach(key => {
                expect(merged_data[key].remarks.includes(test_regex)).to.equal(true);
            });
            const test_result_table_attrs = test_results.existing_attributes[TEST_TABLE_LONGTEXT];
            expect(test_result_table_attrs.length).to.equal(expected_attr_keys.length);
            test_result_table_attrs.forEach(attr => {
                expect(expected_attr_keys.includes(attr)).to.equal(true);
            });
        }));
    });

    describe('_decideReadPattern()', () => {
        const where_in_hash_ids = TEST_DATA_DOG.reduce((acc, col) => {
            if (col.id < 4) {
                acc.push(col.id);
            }
            return acc;
        }, []);

        it('should consolidate additional attr columns to pull for 2nd/final sql query', mochaAsyncWrapper(async () => {
            const sql_attr_keys = ['id', 'name'];
            const test_sql_statement = `SELECT * FROM dev.dog WHERE id IN(${where_in_hash_ids}) ORDER BY ${sql_attr_keys.toString()}`;
            const expected_attr_keys = Object.keys(TEST_DATA_DOG[0]).filter(key => !sql_attr_keys.includes(key));

            setupTestInstance(test_sql_statement);
            await test_instance._getFetchAttributeValues();
            await test_instance._retrieveIds();
            await test_instance._consolidateData();
            const join_results = await test_instance._processJoins();

            await test_instance._decideReadPattern(join_results.existing_attributes, join_results.joined_length);

            expect(_readRawFiles_spy.called).to.equal(true);
            const spy_args = _readRawFiles_spy.args[0][0];
            expect(spy_args.length).to.equal(expected_attr_keys.length);
            spy_args.forEach(arg => {
                expect(expected_attr_keys.includes(arg.attribute)).to.equal(true);
            });
        }));

        it('should call _readRawFiles if row count is <= 1000', mochaAsyncWrapper(async () => {
            setupTestInstance();
            await test_instance._getFetchAttributeValues();
            await test_instance._retrieveIds();
            await test_instance._consolidateData();
            const join_results = await test_instance._processJoins();

            await test_instance._decideReadPattern(join_results.existing_attributes, 500);

            expect(_readRawFiles_spy.called).to.equal(true);
        }));

        it('should call _readAttributeValues if row count is > 1000', mochaAsyncWrapper(async () => {
            setupTestInstance();
            await test_instance._getFetchAttributeValues();
            await test_instance._retrieveIds();
            await test_instance._consolidateData();
            const join_results = await test_instance._processJoins();

            await test_instance._decideReadPattern(join_results.existing_attributes, 1005);

            expect(_readAttributeValues_spy.called).to.equal(true);
        }));
    });

    describe('_readRawFiles()', () => {
        it('should collect ids for each column and call _readAttributeFilesByIds for each column', mochaAsyncWrapper(async () => {
            setupTestInstance();
            await test_instance._getFetchAttributeValues();
            await test_instance._retrieveIds();
            await test_instance._consolidateData();
            const test_columns_data = test_instance.all_table_attributes.filter(data => data.attribute !== HASH_ATTRIBUTE);
            const test_merged_data = test_instance.data[dog_schema_table_id].__merged_data;

            await test_instance._readRawFiles(test_columns_data);

            expect(_readAttributeFilesByIds_spy.callCount).to.equal(test_columns_data.length);
            _readAttributeFilesByIds_spy.args.forEach((data, i) => {
                expect(data[0].attribute).to.deep.equal(test_columns_data[i].attribute);
                expect(data[0].table).to.deep.equal(test_columns_data[i].table);
                expect(data[1].length).to.equal(Object.keys(test_merged_data).length);
            });
        }));

        it('should log an error if column data is not found', mochaAsyncWrapper(async () => {
            setupTestInstance();
            await test_instance._getFetchAttributeValues();
            await test_instance._retrieveIds();
            await test_instance._consolidateData();
            const test_columns_data = test_instance.all_table_attributes.filter(data => data.attribute !== HASH_ATTRIBUTE);
            test_columns_data[0].table.databaseid = "dogzz";

            await test_instance._readRawFiles(test_columns_data);

            expect(error_logger_spy.calledOnce).to.equal(true);
            expect(error_logger_spy.args[0][0].message).to.equal(`Cannot read property '__merged_data' of undefined`);
            expect(_readAttributeFilesByIds_spy.callCount).to.equal(test_columns_data.length - 1);
        }));
    });

    describe('_readAttributeFilesByIds()', () => {
        it('should query and set attr value for ids provided', mochaAsyncWrapper(async () => {
            setupTestInstance();
            await test_instance._getFetchAttributeValues();
            await test_instance._retrieveIds();
            await test_instance._consolidateData();
            const test_columns_data = test_instance.all_table_attributes.filter(data => data.attribute !== HASH_ATTRIBUTE);
            const test_column = test_columns_data[0];
            const { attribute } = test_column;
            const test_ids = TEST_DATA_DOG.map(row => `${row.id}`);

            await test_instance._readAttributeFilesByIds(test_column, test_ids);

            expect(readFile_spy.callCount).to.equal(test_ids.length);
            const test_merged_data = test_instance.data[dog_schema_table_id].__merged_data;
            Object.keys(test_merged_data).forEach(key => {
                const row_data = TEST_DATA_DOG.filter(row => key === `${row.id}`)[0];
                expect(test_merged_data[key][attribute]).to.equal(row_data[attribute]);
            });
        }));
    });

    describe('_readAttributeValues()', () => {
        const where_in_hash_ids = TEST_DATA_DOG.reduce((acc, col) => {
            if (col.id < 4) {
                acc.push(col.id);
            }
            return acc;
        }, []);

        before(() => {
            _readBlobFiles_spy.resolves();
        });

        after(() => {
            _readBlobFiles_spy.reset();
            _readBlobFiles_spy.callThrough();
        });

        it('should set values for all non-hash attrs in data property', mochaAsyncWrapper(async () => {
            setupTestInstance();
            await test_instance._getFetchAttributeValues();
            await test_instance._retrieveIds();
            await test_instance._consolidateData();
            const test_columns_data = test_instance.all_table_attributes.filter(data => data.attribute !== HASH_ATTRIBUTE);
            const test_merged_data = test_instance.data[dog_schema_table_id].__merged_data;

            Object.keys(test_merged_data).forEach(row => {
               expect(Object.keys(test_merged_data[row]).length).to.equal(1);
            });

            await test_instance._readAttributeValues(test_columns_data);

            TEST_DATA_DOG.forEach(row => {
                const hash_id = row.id;
                const attr_keys = Object.keys(row);
                expect(Object.keys(test_merged_data[hash_id]).length).to.equal(attr_keys.length);
                attr_keys.forEach(attr => {
                    expect(test_merged_data[hash_id][attr]).to.equal(row[attr]);
                });
            });
        }));

        it('should set values for all non-hash attrs not processed in initial pass', mochaAsyncWrapper(async () => {
            const sql_attr_keys = ['id', 'name'];
            const test_sql_statement = `SELECT * FROM dev.dog WHERE id IN(${where_in_hash_ids}) ORDER BY ${sql_attr_keys.toString()}`;

            setupTestInstance(test_sql_statement);
            await test_instance._getFetchAttributeValues();
            await test_instance._retrieveIds();
            await test_instance._consolidateData();
            const test_columns_data = test_instance.all_table_attributes.filter(data => data.attribute !== HASH_ATTRIBUTE);
            const test_merged_data = test_instance.data[dog_schema_table_id].__merged_data;

            Object.keys(test_merged_data).forEach(row => {
               expect(Object.keys(test_merged_data[row]).length).to.equal(sql_attr_keys.length);
            });

            await test_instance._readAttributeValues(test_columns_data);

            expect(_readBlobFiles_spy.called).to.equal(false);
            TEST_DATA_DOG.forEach(row => {
                const hash_id = row.id;
                const attr_keys = Object.keys(row);
                expect(Object.keys(test_merged_data[hash_id]).length).to.equal(attr_keys.length);
                attr_keys.forEach(attr => {
                    expect(test_merged_data[hash_id][attr]).to.equal(row[attr]);
                });
            });
        }));

        it('should call readBlobFiles to set values for all non-hash longtext attrs not processed in initial pass', mochaAsyncWrapper(async () => {
            const test_sql_statement = `SELECT * FROM dev.longtext`;

            setupTestInstance(test_sql_statement);
            await test_instance._getFetchAttributeValues();
            const blob_paths = await test_instance._retrieveIds();
            await test_instance._readBlobFilesForSetup(blob_paths);
            await test_instance._consolidateData();
            const test_columns_data = test_instance.all_table_attributes.filter(data => data.attribute !== HASH_ATTRIBUTE);
            const test_merged_data = test_instance.data[longtext_scheam_table_id].__merged_data;

            Object.keys(test_merged_data).forEach(row => {
               expect(Object.keys(test_merged_data[row]).length).to.equal(1);
            });

            await test_instance._readAttributeValues(test_columns_data);

            expect(_readBlobFiles_spy.calledOnce).to.equal(true);
            expect(Object.keys(_readBlobFiles_spy.args[0][0]).length).to.equal(24);
            Object.keys(test_merged_data).forEach(row => {
                expect(Object.keys(test_merged_data[row]).length).to.equal(1);
            });
        }));
    });

    describe('_readBlobFiles()', () => {
        const where_in_hash_ids = TEST_DATA_LONGTEXT.reduce((acc, col) => {
            if (col.id < 4) {
                acc.push(col.id);
            }
            return acc;
        }, []);

        const expected_results = TEST_DATA_LONGTEXT.filter(row => row.id < 4);

        //blob paths that should be passed to the method for the test rows with ids 1, 2, or 3
        const test_blob_paths = {
            "dev/longtext/remarks/RIVERFRONT LIFESTYLE! New dock, new roof and new appliances. For sale fully furnished. Beautiful custom-built 2-story home with pool. Panoramic river views and open floor plan -- great for entertaining. Hardwood floors flow throughout. Enjoy sunsets over ": {
                attribute: "remarks",
                table: {
                    databaseid: "dev",
                    tableid: "longtext"
                }
            },
            "dev/longtext/remarks/Come see the kitchen remodel and new wood flooring.  Custom built by Howard White in 2007, this immaculate Deerwood home enjoys a view of the 18th fairway. From the moment you step into the foyer, you will be impressed with the bright, open floor plan. Th": {
                attribute: "remarks",
                table: {
                    databaseid: "dev",
                    tableid: "longtext"
                }
            },
            "dev/longtext/remarks/This custom built dream home is stunningly gorgeous!  It is a 5+ acres luxury equestrian property with access to Jennings State Forest from your backyard, no need to trailer your horses anywhere for a beautifully scenic peaceful ride.  This amazing home i": {
                attribute: "remarks",
                table: {
                    databaseid: "dev",
                    tableid: "longtext"
                }
            }
        };

        it('should set longtext/blob values in the data property', mochaAsyncWrapper(async () => {
            const test_sql_statement = `SELECT * FROM dev.longtext WHERE id IN(${where_in_hash_ids.toString()})`;

            setupTestInstance(test_sql_statement);
            await test_instance._getFetchAttributeValues();
            const blob_paths = await test_instance._retrieveIds();
            await test_instance._readBlobFilesForSetup(blob_paths);
            await test_instance._consolidateData();
            const test_merged_data = test_instance.data[longtext_scheam_table_id].__merged_data;

            Object.keys(test_merged_data).forEach(key => {
                expect(Object.keys(test_merged_data[key]).length).to.equal(1);
            });

            await test_instance._readBlobFiles(test_blob_paths);

            expected_results.forEach(row => {
                const hash_id = row.id;
                const attr_keys = Object.keys(row);
                expect(Object.keys(test_merged_data[hash_id]).length).to.equal(attr_keys.length);
                attr_keys.forEach(attr => {
                    expect(test_merged_data[hash_id][attr]).to.equal(row[attr]);
                });
            });
        }));
    });

    describe('_finalSQL()', () => {
        it('should return final sql results sorted by id in DESC order', mochaAsyncWrapper(async () => {
            const expected_hashes = TEST_DATA_DOG.reduce((acc, row) => {
                acc.push(row.id);
                return acc;
            }, []);
            const expected_hashes_desc_sort = sortDesc(expected_hashes);
            const test_sql_statement = `SELECT * FROM dev.dog ORDER BY id DESC`;

            setupTestInstance(test_sql_statement);
            await test_instance._getFetchAttributeValues();
            await test_instance._retrieveIds();
            await test_instance._consolidateData();
            const test_columns_data = test_instance.all_table_attributes.filter(data => data.attribute !== HASH_ATTRIBUTE);
            await test_instance._readRawFiles(test_columns_data);

            const test_results = await test_instance._finalSQL();

            expected_hashes_desc_sort.forEach((hash, i) => {
                expect(test_results[i][HASH_ATTRIBUTE]).to.equal(hash);
            });
        }));
    });

    describe('_buildSQL()', () => {
        it('should parse columns to remove extra alias in UPPER function clause', mochaAsyncWrapper( async () => {
            const test_sql_statement = `SELECT id AS hash, UPPER(name) AS first_name, AVG(age) as ave_age FROM dev.dog`;
            setupTestInstance(test_sql_statement);
            const initial_statement_string = test_instance.statement.toString();
            const expected_sql_string = initial_statement_string.replace(" AS `first_name`", "");

            const test_result = test_instance._buildSQL();

            expect(test_result).to.not.equal(initial_statement_string);
            expect(test_result).to.equal(expected_sql_string);
        }));

        it('should return initial statement string if there are not column functions clauses', mochaAsyncWrapper( async () => {
            const test_sql_statement = `SELECT id AS hash, name AS first_name, AVG(age) as ave_age FROM dev.dog`;
            setupTestInstance(test_sql_statement);
            const initial_statement_string = test_instance.statement.toString();

            const test_result = test_instance._buildSQL();

            expect(test_result).to.equal(initial_statement_string);
        }));
    });

    describe('_stripFileExtension()', () => {
        it('should remove `.hdb` from the argument passed', () => {
            const file_name = "very_important_file";
            const file_ext_name = ".hdb";
            const test_file_name = file_name + file_ext_name;
            setupTestInstance();

            const test_result = test_instance._stripFileExtension(test_file_name);

            expect(test_result).to.equal(file_name);
        });

        it('should return undefined if no argument is passed', () => {
            setupTestInstance();

            const test_result = test_instance._stripFileExtension();

            expect(test_result).to.equal(undefined);
        });
    });
});