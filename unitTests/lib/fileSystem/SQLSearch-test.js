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

// const alasql = require('alasql');
// const sql = require('../../../sqlTranslator/index');
const rewire = require('rewire');
const FileSearch = rewire('../../../lib/fileSystem/SQLSearch');

const TEST_FS_DIR = getMockFSPath();
const TEST_SCHEMA = 'dev';
const HASH_ATTRIBUTE = 'id';
const TEST_TABLE_CAT = 'cat';
const TEST_TABLE_DOG = 'dog';
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
    _readBlobFiles_spy = sandbox.spy(FileSearch.prototype, '_readBlobFiles');
    _finalSQL_spy = sandbox.spy(FileSearch.prototype, '_finalSQL');
    _buildSQL_spy = sandbox.spy(FileSearch.prototype, '_buildSQL');
    _stripFileExtension_spy = sandbox.spy(FileSearch.prototype, '_stripFileExtension');
}

function setupDefaultData() {
    const test_data_dog = deepClone(TEST_DATA_DOG);
    const test_data_cat = deepClone(TEST_DATA_CAT);

    createMockFS(HASH_ATTRIBUTE, TEST_SCHEMA, TEST_TABLE_DOG, test_data_dog);
    createMockFS(HASH_ATTRIBUTE, TEST_SCHEMA, TEST_TABLE_CAT, test_data_cat);
}

async function setupSqlData() {
    const sql_csv_data = await getFormattedIntegrationTestCsvData();

    createMockFS("all", "call", "aggr", deepClone(TEST_DATA_AGGR));
    createMockFS(HASH_ATTRIBUTE, TEST_SCHEMA, "longtext", deepClone(TEST_DATA_LONGTEXT));

    sql_csv_data.forEach(({ hash, schema, table, data }) => {
        const csv_data = deepClone(data);
        const attrs = Object.keys(data[0]);
        const test_attr = attrs[0] === hash ? attrs[1] : attrs[0];
        sql_integration_data[table] = { hash, schema, table, attrs, test_attr, data: csv_data };
        createMockFS(hash, schema, table, data);
    });
}

function sortDesc(data, sort_by) {
    return data.sort((a, b) => b[sort_by] - a[sort_by]);
}

function sortAsc(data, sort_by) {
    return data.sort((a, b) => a[sort_by] - b[sort_by]);
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
        setupDefaultData();
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

    describe('search() - SELECT', () => {
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

            expect(search_results).to.be.an('array').that.is.empty;;
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

    describe('search() - Integration Test Scripts', () => {
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
            const test_data = deepClone(sql_integration_data.products.data);
            const expected_results = sortDesc(test_data, 'unitprice');
            expected_results.splice(test_limit);

            const test_sql_statement = `SELECT categoryid, productname, quantityperunit, unitprice, * from northnwd.products ORDER BY unitprice DESC LIMIT ${test_limit}`;
            setupTestInstance(test_sql_statement);

            try {
                search_results = await test_instance.search();
            } catch(e) {
                console.log(e);
            }

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
            // "name": "select round unit price using alias",
            // "SELECT ROUND(unitprice) AS Price FROM dev.products GROUP BY ROUND(unitprice)"
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

    describe('_getTables()', () => {
        it('test multiple attributes from ONE table sets one table in this.data and gets hash_name from global.schema', () => {
            //TODO: write test
        });

        it('test multiple attributes from multiple table sets multiple tables in this.data and gets hash_name from global.schema', () => {
            //TODO: write test
        });
    });

    describe('_getColumns()', () => {
        it('', () => {

        });
    });

    describe('_findColumn()', () => {
        it('', () => {

        });
    });

    describe('_addFetchColumns()', () => {
        it('', () => {

        });
    });

    describe('_conditionsToFetchAttributeValues()', () => {
        it('', () => {

        });
    });

    describe('_backtickAllSchemaItems()', () => {
        it('', () => {

        });
    });

    describe('_getFetchAttributeValues()', () => {
        it('', () => {

        });
    });

    describe('_checkHashValueExists()', () => {
        it('', () => {

        });
    });

    describe('_retrieveIds()', () => {
        it('', () => {

        });
    });

    describe('_readBlobFilesForSetup()', () => {
        it('', () => {

        });
    });

    describe('_consolidateData()', () => {
        it('', () => {

        });
    });

    describe('_processJoins()', () => {
        it('', () => {

        });
    });

    describe('_decideReadPattern()', () => {
        it('', () => {

        });
    });

    describe('_readRawFiles()', () => {
        it('', () => {

        });
    });

    describe('_readAttributeFilesByIds()', () => {
        it('', () => {

        });
    });

    describe('_readAttributeValues()', () => {
        it('', () => {

        });
    });

    describe('_readBlobFiles()', () => {
        it('', () => {

        });
    });

    describe('_finalSQL()', () => {
        it('', () => {

        });
    });

    describe('_buildSQL()', () => {
        it('', () => {

        });
    });

    describe('_stripFileExtension()', () => {
        it('', () => {

        });
    });
});