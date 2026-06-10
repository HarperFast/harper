/**
 * Northwind integration tests.
 *
 * Ported from legacy apiTests/tests/ files:
 *   2_dataLoad.mjs, 3_sqlTests.mjs, 4_noSqlTests.mjs,
 *   5_noSqlRoleTesting.mjs, 6_sqlRoleTesting.mjs,
 *   7_jobsAndJobRoleTesting.mjs, 10_otherRoleTests.mjs
 *
 * All seven sub-suites share a single Harper instance to avoid repeating the
 * expensive CSV load. Northwind schemas, tables, and large CSV fixtures are
 * set up once in before(). JSON data and the url_csv_* tables are inserted by
 * the 2_dataLoad sub-suite tests so that the insert/upsert tests remain valid.
 *
 * Skipped on Windows: csv_file_load uses Linux-style absolute paths.
 */
import { suite, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout } from 'node:timers/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startHarper, teardownHarper } from '@harperfast/integration-testing';
import { createApiClient, createHeaders } from './utils/client.mjs';
import { awaitJob, awaitJobCompleted, getJobId, waitFor } from './utils/operations.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const csvPath = join(__dirname, 'data') + '/';

// JSON fixture record sets (parsed once at module load; used by 2_dataLoad tests)
const LONG_TEXT_RECORDS = [
	{
		id: 1,
		remarks:
			'RIVERFRONT LIFESTYLE! New dock, new roof and new appliances. For sale fully furnished. Beautiful custom-built 2-story home with pool. Panoramic river views and open floor plan -- great for entertaining. Hardwood floors flow throughout. Enjoy sunsets over the St. Johns from covered lanai or family room with wood-burning fireplace. Large back yard, dock, boat lift, kayak area...endless lifestyle options for fishing, boating or just chilling. Spacious master suite includes seating area with gas fireplace. Additional bedroom or office, pool bath, and laundry room on 1st floor. Upstairs loft area, perfect for a game room, plus two bedrooms with upgraded baths in each. Kitchen features stainless steel appliances, granite countertops, cooking island, and walk-in pantry. 3-car garage with abundant',
	},
	{
		id: 2,
		remarks:
			'Come see the kitchen remodel and new wood flooring.  Custom built by Howard White in 2007, this immaculate Deerwood home enjoys a view of the 18th fairway. From the moment you step into the foyer, you will be impressed with the bright, open floor plan. The Master suite features a large en suite bath with his and hers custom closets. The kitchen features high-end appliances,cabinetry and granite countertops. Retreat upstairs to an expansive library with cherry bookshelves. Additional bedrooms are spacious with large walk-in closets for extra storage. Plantation shutters throughout. Relax in the large hot tub/small pool with lounge chair shelf and fountain. Side entry 3 car garage is connected by a breezeway to home. Portion of back yard fenced for small dog.',
	},
	{
		id: 3,
		remarks:
			"This custom built dream home is stunningly gorgeous!  It is a 5+ acres luxury equestrian property with access to Jennings State Forest from your backyard, no need to trailer your horses anywhere for a beautifully scenic peaceful ride.  This amazing home includes impressive Brazilian hardwood floors, plantation shutters throughout, granite countertops, triple tray and wood beam ceilings and so much more.  Builder's touches include 24'' tiles, rounded corner walls, 5'' baseboards, 10 ft. ceilings, in-wall vacuum system and many more unique upgrades.  There are extensive custom touches on this property from the mailbox to the unique 3000 sq. ft. two level 3-stall barn with tons of storage space.",
	},
	{
		id: 4,
		remarks:
			'Make this stunning traditional two story red brick house your forever home. Custom built in 2004, this home is spacious enough for large gatherings and cozy enough for small get togethers. Located on a large corner lot with side entry four car garage and fenced backyard, this home has it all inside and out. Inviting foyer is flanked by formal living room and dining room with wood floors, crown molding, and large windows. Large eat-in kitchen with custom made Pine Cottage cabinets, granite countertops, and stainless steel appliances is conveniently located next to family room. Separate downstairs flex space with attached full bath currently used as a playroom could be used as a 5th bedroom/guest or mother-in-law suite (no closet, but one could be easily added.)',
	},
	{
		id: 5,
		remarks:
			'A beautiful waterfront home located on a deep water canal providing quick access to the St. Johns River and ocean. Spacious and open, the downstairs is perfect for both family activities and entertaining. Central to this is a large kitchen with extensive granite countertops, upgraded appliances, separate island and an adjacent laundry room. A great room with fireplace flows into Florida & game rooms which overlook the canal. From the leaded glass front door, the extensive crown molding, to the hardwood, marble and tile flooring, there are numerous upgrades throughout the house. Outside, a large backyard includes three separate patios surrounded by tropical landscaping maintained by automatic sprinklers. Along the concrete bulkhead, there are docks, davits and a 9,000lb. boat lift w Remote.',
	},
	{
		id: 6,
		remarks:
			"Walk inside this Perfect Family Home and make it your own. Spacious Foyer opens to formal living room. Family room features brick fireplace, wet bar, and sliding glass doors to beautiful patio and lushly landscapped backyard. Recently updated Kitchen boasts granite countertops, abundance of cabinets with pull out drawers and breakfast nook. Large Master Suite offers multiple closets, separate vanities,walk-in shower and garden tub. Spacious room sizes and storage throughout.Bedroom and Bath arrangements were built for today's living and convenience.  Walk to neighborhood parks. A rated Hendricks Elementary also a walk or bike ride away. Pretty median treed street filled with homes of the era dead ending to riverfront homes.",
	},
	{
		id: 7,
		remarks:
			'Wow! Pow! This one will knock you over! Like New! Meticulously cared for David Weekley home with all the bells and whistles! Telescoping sliders Open onto huge screened brick paver lanai with massive fireplace at end. Open concept floor plan has hardwood floors in all common areas, 3 way split bedroom plan, also has a study, formal dining room, sunroom, breakfast room - plenty of storage space, and room to spread out. Kitchen features a gorgeous large island, granite countertops, walk in pantry and upgraded stainless appliances lanai overlooks the park like, almost 1/2 acre fully fenced backyard with creek and preserve behind. Gated community no through traffic. Front view is a lake with fountain Heart of Mandarin.  If I could, I would buy this one myself!',
	},
	{
		id: 8,
		remarks:
			'Rare opportunity to own a home on fabulous Heaven Trees road! OPEN HOUSE Saturday 4/28 from 2 - 5! This beautiful brick home is move in ready! This home offers abundant living space with light filled rooms and hardwood floors. The kitchen features a gas range, double ovens, and granite countertops. Enjoy the expansive backyard with complete privacy. Owners have made several improvements including: New A/C 6/16, New Electric Box and Circuit Breakers 11/16, Front Septic Tank and Drainage Field Replaced 8/16, Back Septic Tank Improvements 4/18, New Hot Water Heater 5/14, New Soft Water Treatment System 7/12, Wet Bar installed in Family Room with beverage cooler, ice maker; and more. Please note: Fogged window in Sunroom is being replaced!',
	},
	{
		id: 9,
		remarks:
			'Wow! Spectacular opportunity to live in a charming, yet spacious, brick home in one the most highly desirable communities, Ortega Forest. This beautifully updated, one-story, pool home will be a beautiful place to make memories. The home features a large eat-in kitchen that has been fully renovated with custom cabinetry, granite countertops and upgraded, stainless appliances. A formal living and huge dining room are located at the front of the home. The family room/den features a gorgeous wood burning fireplace and overlooks the sparkling pool and backyard. The living and sleeping areas are separated. The large master bedroom features sizable his/her closets. The master and guest baths are renovated with custom cabinetry and marble countertops.',
	},
	{
		id: 10,
		remarks:
			'Lovely updated home in desired gated community.  Large corner lot with new paver circular driveway. Great first impression entryway to open floor plan with warm wood floors. Separate Dining room, huge Family room with gas fireplace and custom mantel, and sitting or casual eating area. Spacious Kitchen with quartz countertops, stainless steel appliances, gas range, and breakfast bar. Large laundry room between garage and kitchen. Split bedrooms with private Master Bedroom overlooking fenced, landscaped backyard and screened lanai. Master Bath has granite countertops, double sinks, wood grain tile floors, tub and separate shower. Two guest Bedrooms and Bath opposite the master along with a 4th Bedroom or Bonus room upstairs with another full Bath. Close to Beaches and Shopping!',
	},
	{
		id: 11,
		remarks:
			"Historic Avondale home designed in the Prairie School style -- an architectural design made famous by Frank Lloyd Wright and Jacksonville resident Henry John Klutho. This 3 bedroom, two bath, 2,202 sq ft home has maintained its vintage appeal while combining modern updates, such as renovated kitchen with beverage fridge and wine storage. Granite countertops and 2-yr-old SS appliances. Updates meld beautifully with original Prairie School window casings with grids, glass knobs, hardwood inlay floors, 10'' baseboards, picture rail molding and all original doors. Beautifully glassed sun room at the front of the house is a perfect office or reading room. Gorgeous French doors open to private backyard built for entertaining. Two-car garage includes back entry, extra storage and partial bathroom",
	},
	{
		id: 12,
		remarks:
			'MUCH bigger than it looks! This remodeled 4bed/2.5bath Avondale home has a separate studio apartment which rents for $750 a month. Relax on the front porch or walk to Boone Park, numerous restaurants, and shops. The living room w/ the original fireplace has French doors which lead to a sun room/office. The hardwood floors have been refinished beautifully. The spacious kitchen has finely crafted cabinets, gorgeous granite countertops, and a  walk-in pantry. The laundry room includes a washer and dryer. A unique rock and metal design surrounds the jetted tub. A large linen closet is near by. 2 beds and 2 baths are on the main floor. Two bedrooms and a half bath are on the second floor.  A screened porch overlooks the fully fenced back yard.',
	},
	{
		id: 13,
		remarks:
			"*DON'T MISS THIS BEAUTIFUL DAVID WEEKLEY BELMONTE MODEL*ONE OF THE LARGEST LOTS IN CROSSWATER*GREAT FOR OUTDOOR FUN!*LUXURIOUS LIVING!*HIGH TECH HOME*CROWN MOLDING, CUSTOM PLANTATION SHUTTERS, 18'' TILE & CUSTOM WHITE OAK HARDWOOD FLOORING THRUOUT THE HOME*LARGE OFFICE W/GLASS FRENCH DOORS*FORMAL DINING ROOM W/PICTURE FRAME MOLDING*GOURMET KITCHEN W/42''CUSTOM CABINETRY & GRANITE COUNTERTOPS, STAINLESS STEEL APPLIANCES, & HUGE ISLAND OPEN TO THE GREAT ROOM W/TRAY CEILING & SURROUND SOUND SPEAKERS*MASTER BEDROOM SUITE W/TRAY CEILING W/BEADBOARD INSET AND SHOWER W/OVERHEAD RAINFOREST HEAD*2 MORE BEDROOMS & OPEN ''FLEX'' AREA*COVERED LANAI OVERLOOKING THE HUGE FENCED BACKYARD*3-CAR GARAGE*''NEST'' THERMOSTAT & AT&T HOME SECURITY W/WIFI ACCESS*WATER SOFTENER*LOTS MORE!!!",
	},
	{
		id: 14,
		remarks:
			'This is a 4 bedroom, 3 bath, with additional tiled sunroom single family home located in the Pablo Bay community. Upgrades galore! This home offers gorgeous marble flooring throughout the living areas, high ceilings, an upgraded kitchen with granite countertops, a tile backsplash, and stainless steel appliances! Relax and enjoy the lake view from the tiled sunroom or the expansive fenced backyard! Will have a 1 year home warranty! Also listed for rent under MLS 903970',
	},
	{
		id: 15,
		remarks:
			'Spacious & updated 2-story home on large preserve lot nearly 1/2 acre! Concrete block constr. & desirable ICW location near JTB, shopping, dining & the beach! Great split BD flrpln w/soaring ceilings features 4BD + office, upstairs loft & 3 full BA. Beautiful tiled kitchen has granite countertops, island, newer refrigerator, cooktop, oven & convection microwave (2 yrs), breakfast bar & nook. Separate DR, LR & Fam Rm all w/crown molding & wood laminate flrs; FP in Fam Rm. Remodeled BA w/granite countertops & gorgeous travertine tiled showers & flrs. New Roof 6/2014 & New upgraded AC system 10/2015. Huge owner suite w/Jacuzzi tub, sep. shower, 2 walk-in closets & bonus rm w/French doors. Relaxing back porch w/phantom retractable screen overlooks the charming patio & huge stunning backyard!**',
	},
	{
		id: 16,
		remarks:
			'Location ... Location ...GOURGEOUS HOME in a Heart of MANDARIN,Next to Loretto Magnet schoolClose to I-295, shopping & entertainment. Gated community! Loaded with upgrades: GRANITE countertops,upgraded kitchen cabs w/crown molding, st steel appl, New carpets,New exterior and interior paint,Rain soft water softner, tile floors, bay windows, addtl loft + sep. Internet center, fireplace, lots of arches& niches, 2 story family room, huge covered porch overlooking, Planing to put the new sod in the front and sides, landscaped backyard and much more! MUST SEE!',
	},
	{
		id: 17,
		remarks:
			'WELCOME HOME! MOVE-IN-READY! Spacious & Beautifully updated home with over 3500 sq ft of comfort. Great for everyday living or entertaining. 5 Bedrooms and 3.5 baths. Spacious 1st floor owner suite with a huge walking closet, sitting area, updated master bath with double vanities, separate shower & garden tub. Updated kitchen with granite countertops, food prep island, all appliances, plenty of cabinets and breakfast nook. Inviting family room with fireplace and large picture windows that bring in natural light throughout. Formal dining & living rooms. 2nd floor offers spacious bonus room, 4 large bedrooms and 2 full baths. Hard wood floors, new roof 2016, many updates throughout. Inviting screened in porch, large back yard backs up to wooded preserve. Great Community amenities. A must see',
	},
	{
		id: 18,
		remarks:
			'Welcome to the very desirable community of ST. JOHNS LANDING. This 4 bedroom 2 bathroom home is located in a riverfront community. It has been totally upgraded, boasting detailed crown molding, new kitchen cabinets, Travertine Stone Floors & granite countertops throughout.  6 foot Jacuzzi tub in master bath and separate shower. Prewired alarm system. Central Heat & A/C replaced a year ago, fireplace and an energy saving on demand water heater are just some of the features this beautiful home has to offer.(BRAND NEW ROOF is Included).  This home sits on a corner lot with a fenced backyard, and a tiled heated and cooled lanai overlooking the plush lawn and playset. Walking distance to the community clubhouse, playground, fishing dock, boat ramp & pool. Buyer to verify square footage.',
	},
	{
		id: 19,
		remarks:
			'Location ... Location ...GOURGEOUS HOME in a Heart of MANDARIN,Next to Loretto Magnet schoolClose to I-295, shopping & entertainment. Gated community! Loaded with upgrades: GRANITE countertops,upgraded kitchen cabs w/crown molding, st steel appl, New carpets,New exterior and interior paint,Rain soft water softner, tile floors, bay windows, addtl loft + sep. Internet center, fireplace, lots of arches& niches, 2 story family room, huge covered porch overlooking, Planing to put the new sod in the front and sides, landscaped backyard and much more! MUST SEE!',
	},
	{
		id: 20,
		remarks:
			"This house is ready for you to call it home! No stone was left unturned when it came to upgrades in this gorgeous home! As you walk through the front door, you'll be immediately impressed by the 20ft ceiling in the Grand Foyer. Beautiful hardwood floors throughout the first floor, Gourmet Kitchen, Double Ovens, Granite Countertops, Stainless Steel appliances. Need space? How about this: 5 bedrooms, 4 full bath (1 full bath and bedroom downstairs), plenty of room for a growing family. Need a place to escape to relax? Look no further, enjoy the peace and serenity that your large backyard offers, as you enjoy the evenings in your screened-in lanai, all behind the privacy of the preserve.",
	},
	{
		id: 21,
		remarks:
			'BACK ON MARKET!!MOTIVATED SELLER, OFFERING A $3000 CONCESSION TOWARDS NEW FLOORING. CONCESSION PAID AT CLOSING! Come see this gorgeous 4 bedroom 4 bath home in beautiful Hampton Glen. This home has two large master bedrooms with ensuites with sitting area. The loft bedroom upstairs also has a full bath. All baths have been updated with granite countertops and tile. If you love to cook you will love this kitchen. This large kitchen has beautiful granite countertops and tile. Everything has been updated. The roof is brand new!!! It was replaced January 2017. The house has been completely painted inside and out. Come and enjoy the serenity of the backyard in your large screened in patio and view the tall pines of the preserve swaying in the breeze.',
	},
	{
		id: 22,
		remarks:
			"Beautiful pool home that has all the upgrades you're looking for.  4 Bedroom/2 bath with updated kitchen with granite countertops, stainless steel appliances including a Bosch dishwasher and double ovens.  Formal Living room, dining room & separate family room with vauled ceilings. Family room is wired for speakers. Tile floors in kitchen & b'fast area.  Hardwood floors are found in the family room and 2 bedrooms.  The master bedroom has french doors out to the screened pool area.  The bath has separate vanities with granite tops, remodeled shower with a seat & his and hers closets.  There is a pool and spa.  Both are heated using solar panels, no gas heater.  There is a Soothing waterfall feature that makes this outdoor area perfect for entertaining.  Fenced back yard as well.",
	},
	{
		id: 23,
		remarks:
			'What a gem !!!! Located within walking distance to Bolles on a quiet cul de sac street, this brick home, with a circular drive,has it all! New roof in 2017, re-plumbed in 2016 and 2 HVAC systems ( inside and out -2008 and 2017). The kitchen has beenbeautifully updated with granite countertops and cream cabinets.  The kitchen opens to a large family room. The master suite has 2 walk-in closets and a large updated bath with jacuzzi and separate shower, separate dining room and formal living room with wood burning fireplace. Freshly painted and new tile throughout. There is a large shed in the backyard for additional storage in addition to the 2 car garage.This home was renovated in 2008 and 1,400 sq. ft. was added to the original plan. OPEN HOUSE SUNDAY 3/12/17 1:00-3:00',
	},
	{
		id: 24,
		remarks:
			'Designed for Generous Space and Flexibility for Family or Lifestyle! This Midcentury Modern Pool Home offers over 3000 sf of upgrades & classic design on almost 1/2 acre. Original Hardwood Floors, Lots of Natural Light, Freshly Painted Interior, Custom Kitchen, Granite countertops, Newer AC & New Carpet upstairs. Spacious rooms throughout include Living room w/Fireplace, Formal Dining and even larger Casual Dining, Breakfast room or Office. Family room with built-ins & pool bath could also be Mother-in-Law Suite with private bath or 4th Bedroom. Perfect Home for Entertaining with Private Backyard, Majestic Oaks, Expansive multi-level patio & Sparkling Pool. Plenty of room for RV/Boat Parking. All this in Desirable Beauclerc location convenient to I-295, Downtown, nearby Shops & Restaurants',
	},
	{
		id: 25,
		remarks:
			'Welcome to your new home in James Island. Easy commuting around the City, close to Town Center and JTB takes you to the beaches. You have it all with this home - Owner Suite is on the first floor, large bonus room upstairs with full bath, office, formal dining room, living room, and family room with fireplace. Amazing owner bath and large owner suite with beautiful ceilings. Split floor plan for the other two bedrooms which share a Jack and Jill bathroom. High ceilings, crown molding and so much more. Tile and wood flooring downstairs, gas range, granite countertops, fenced backyard, welcoming front entrance and large covered patio. Seller will consider reasonable offers. With accepted offer seller will provide credits for the fogged windows and a replacement stainless steel oven.',
	},
];
const REMARKS_RECORDS = [
	{
		id: 1,
		length: 238,
		remarks:
			"Beautiful pool home that has all the upgrades you're looking for. 4 Bedroom/2.5+ bath with updated kitchen with granite countertops, stainless steel appliances including a Bosch dishwasher and double ovens. Formal Living room, dining room.",
	},
	{
		id: 2,
		length: 248,
		remarks:
			"Beautiful pool home that has all the upgrades you're looking for.  4 Bedroom/2.5+ bath with updated kitchen with granite countertops, stainless steel appliances including a Bosch dishwasher and double ovens.  Formal Living room, dining room and stuff.",
	},
	{
		id: 3,
		length: 788,
		remarks:
			"Beautiful pool home that has all the upgrades you're looking for.  4 Bedroom/2.5+ bath with updated kitchen with granite countertops, stainless steel appliances including a Bosch dishwasher and double ovens.  Formal Living room, dining room & separate family room with vauled ceilings. Family room is wired for speakers. Tile floors in kitchen & b'fast area.  Hardwood floors are found in the family room and 2 bedrooms.  The master bedroom has french doors out to the screened pool area.  The bath has separate vanities with granite tops, remodeled shower with a seat & his and hers closets.  There is a pool and spa.  Both are heated using solar panels, no gas heater.  There is a Soothing waterfall feature that makes this outdoor area perfect for entertaining.  Fenced back yard as well.",
	},
	{
		id: 4,
		length: 701,
		remarks:
			"This custom built dream home is stunningly gorgeous!  It is a 5+ acres luxury equestrian property with access to Jennings State Forest from your backyard, no need to trailer your horses anywhere for a beautifully scenic peaceful ride.  This amazing home includes impressive Brazilian hardwood floors, plantation shutters throughout, granite countertops, triple tray and wood beam ceilings and so much more.  Builder's touches include 24'' tiles, rounded corner walls, 5'' baseboards, 10 ft. ceilings, in-wall vacuum system and many more unique upgrades.  There are extensive custom touches on this property from the mailbox to the unique 3000 sq. ft. two level 3-stall barn with tons of storage space.",
	},
	{
		id: 5,
		length: 234,
		remarks:
			'This custom built dream home is stunningly gorgeous!  It is a 5+ acres luxury equestrian property with access to Jennings State Forest from your backyard, no need to trailer your horses anywhere for a beautifully scenic peaceful ride.',
	},
	{
		id: 6,
		length: 779,
		remarks:
			"*DON'T MISS THIS BEAUTIFUL DAVID WEEKLEY BELMONTE MODEL*ONE OF THE LARGEST LOTS IN CROSSWATER*GREAT FOR OUTDOOR FUN!*LUXURIOUS LIVING!*HIGH TECH HOME*CROWN MOLDING, CUSTOM PLANTATION SHUTTERS, 18'' TILE & CUSTOM WHITE OAK HARDWOOD FLOORING...THRUOUT THE HOME*LARGE OFFICE W/GLASS FRENCH DOORS*FORMAL DINING ROOM W/PICTURE FRAME MOLDING*GOURMET KITCHEN W/42''CUSTOM CABINETRY & GRANITE COUNTERTOPS, STAINLESS STEEL APPLIANCES, & HUGE ISLAND OPEN TO THE GREAT ROOM W/TRAY CEILING & SURROUND SOUND SPEAKERS*MASTER BEDROOM SUITE W/TRAY CEILING W/BEADBOARD INSET AND SHOWER W/OVERHEAD RAINFOREST HEAD*2 MORE BEDROOMS & OPEN ''FLEX'' AREA*COVERED LANAI OVERLOOKING THE HUGE FENCED BACKYARD*3-CAR GARAGE*''NEST'' THERMOSTAT & AT&T HOME SECURITY W/WIFI ACCESS*WATER SOFTENER*LOTS MORE!!!",
	},
	{
		id: 7,
		length: 243,
		remarks:
			"*DON'T MISS THIS BEAUTIFUL DAVID WEEKLEY BELMONTE MODEL*ONE OF THE LARGEST LOTS IN CROSSWATER*GREAT FOR OUTDOOR FUN!*LUXURIOUS LIVING!*HIGH TECH HOME*CROWN MOLDING, CUSTOM PLANTATION SHUTTERS, 18'' TILE & CUSTOM WHITE OAK HARDWOOD FLOORING...",
	},
	{
		id: 8,
		length: 802,
		remarks:
			'**Spacious & updated 2-story home on large preserve lot nearly 1/2 acre! Concrete block constr. & desirable ICW location near JTB, shopping, dining & the beach! Great split BD flrpln w/soaring ceilings features 4BD + office, upstairs loft & 3 full BA. Beautiful tiled kitchen has granite countertops, island, newer refrigerator, cooktop, oven & convection microwave (2 yrs), breakfast bar & nook. Separate DR, LR & Fam Rm all w/crown molding & wood laminate flrs; FP in Fam Rm. Remodeled BA w/granite countertops & gorgeous travertine tiled showers & flrs. New Roof 6/2014 & New upgraded AC system 10/2015. Huge owner suite w/Jacuzzi tub, sep. shower, 2 walk-in closets & bonus rm w/French doors. Relaxing back porch w/phantom retractable screen overlooks the charming patio & huge stunning backyard!**',
	},
	{
		id: 9,
		length: 251,
		remarks:
			'**Spacious & updated 2-story home on large preserve lot nearly 1/2 acre! Concrete block constr. & desirable ICW location near JTB, shopping, dining & the beach! Great split BD flrpln w/soaring ceilings features 4BD + office, upstairs loft & 3 full BA.',
	},
	{
		id: 10,
		length: 560,
		remarks:
			'Location ... Location ...GOURGEOUS HOME in a Heart of MANDARIN,Next to Loretto Magnet schoolClose to I-295, shopping & entertainment. Gated community! Loaded with upgrades: GRANITE countertops,upgraded kitchen cabs w/crown molding, st steel appl, New carpets,New exterior and interior paint,Rain soft water softner, tile floors, bay windows, addtl loft + sep. Internet center, fireplace, lots of arches& niches, 2 story family room, huge covered porch overlooking, Planing to put the new sod in the front and sides, landscaped backyard and much more! MUST SEE!',
	},
	{
		id: 11,
		length: 172,
		remarks:
			'Location ... Location ...GOURGEOUS HOME in a Heart of MANDARIN,Next to Loretto Magnet schoolClose to I-295, shopping & entertainment. Gated community! Loaded with upgrades:',
	},
];
const DOG_RECORDS = [
	{ id: 1, breed_id: 154, weight_lbs: 35, dog_name: 'Penny', age: 5, adorable: true, owner_id: 2 },
	{ id: 2, breed_id: 346, weight_lbs: 55, dog_name: 'Harper', age: 5, adorable: true, owner_id: 3 },
	{ id: 3, breed_id: 348, weight_lbs: 84, dog_name: 'Alby', age: 5, adorable: true, owner_id: 4 },
	{ id: 4, breed_id: 347, weight_lbs: 60, dog_name: 'Billy', age: 4, adorable: true, owner_id: 1 },
	{ id: 5, breed_id: 348, weight_lbs: 15, dog_name: 'Rose Merry', age: 6, adorable: true, owner_id: 2 },
	{ id: 6, breed_id: 351, weight_lbs: 28, dog_name: 'Kato', age: 4, adorable: true, owner_id: 3 },
	{ id: 7, breed_id: 349, weight_lbs: 35, dog_name: 'Simon', age: 1, adorable: true, owner_id: 4 },
	{ id: 8, breed_id: 250, weight_lbs: 55, dog_name: 'Gemma', age: 3, adorable: true, owner_id: 1 },
	{ id: 9, breed_id: 104, weight_lbs: 75, dog_name: 'Bode', age: 8, adorable: true },
];
const BREED_RECORDS = [
	{
		id: 1,
		name: 'ENGLISH POINTER',
		image: 'http://www.fci.be/Nomenclature/Illustrations/001g07.jpg',
		country: 'GREAT BRITAIN',
		section: 'British and Irish Pointers and Setters',
	},
	{
		id: 2,
		name: 'ENGLISH SETTER',
		image: 'http://www.fci.be/Nomenclature/Illustrations/002g07.jpg',
		country: 'GREAT BRITAIN',
		section: 'British and Irish Pointers and Setters',
	},
	{ id: 3, name: 'KERRY BLUE TERRIER', image: null, country: 'IRELAND', section: 'Large and medium sized Terriers' },
	{
		id: 4,
		name: 'CAIRN TERRIER',
		image: 'http://www.fci.be/Nomenclature/Illustrations/004g03.jpg',
		country: 'GREAT BRITAIN',
		section: 'Small sized Terriers',
	},
	{
		id: 5,
		name: 'ENGLISH COCKER SPANIEL',
		image: 'http://www.fci.be/Nomenclature/Illustrations/005g08.jpg',
		country: 'GREAT BRITAIN',
		section: 'Flushing Dogs',
	},
	{
		id: 6,
		name: 'GORDON SETTER',
		image: 'http://www.fci.be/Nomenclature/Illustrations/006g07.jpg',
		country: 'GREAT BRITAIN',
		section: 'British and Irish Pointers and Setters',
	},
	{
		id: 7,
		name: 'AIREDALE TERRIER',
		image: 'http://www.fci.be/Nomenclature/Illustrations/007g03.jpg',
		country: 'GREAT BRITAIN',
		section: 'Large and medium sized Terriers',
	},
	{
		id: 8,
		name: 'AUSTRALIAN TERRIER',
		image: 'http://www.fci.be/Nomenclature/Illustrations/008g03.jpg',
		country: 'AUSTRALIA',
		section: 'Small sized Terriers',
	},
	{
		id: 9,
		name: 'BEDLINGTON TERRIER',
		image: 'http://www.fci.be/Nomenclature/Illustrations/009g03.jpg',
		country: 'GREAT BRITAIN',
		section: 'Large and medium sized Terriers',
	},
	{ id: 10, name: 'BORDER TERRIER', image: null, country: 'GREAT BRITAIN', section: 'Large and medium sized Terriers' },
	{
		id: 11,
		name: 'BULL TERRIER',
		image: 'http://www.fci.be/Nomenclature/Illustrations/011g03.jpg',
		country: 'GREAT BRITAIN',
		section: 'Bull type Terriers',
	},
	{
		id: 12,
		name: 'FOX TERRIER (SMOOTH)',
		image: 'http://www.fci.be/Nomenclature/Illustrations/012g03.jpg',
		country: 'GREAT BRITAIN',
		section: 'Large and medium sized Terriers',
	},
	{
		id: 13,
		name: 'ENGLISH TOY TERRIER (BLACK &TAN)',
		image: 'http://www.fci.be/Nomenclature/Illustrations/013g03.jpg',
		country: 'GREAT BRITAIN',
		section: 'Toy Terriers',
	},
	{
		id: 14,
		name: 'SWEDISH VALLHUND',
		image: 'http://www.fci.be/Nomenclature/Illustrations/014g05.jpg',
		country: 'SWEDEN',
		section: 'Nordic Watchdogs and Herders',
	},
	{ id: 15, name: 'BELGIAN SHEPHERD DOG', image: null, country: 'BELGIUM', section: 'Sheepdogs' },
	{
		id: 16,
		name: 'OLD ENGLISH SHEEPDOG',
		image: 'http://www.fci.be/Nomenclature/Illustrations/016g01.jpg',
		country: 'GREAT BRITAIN',
		section: 'Sheepdogs',
	},
	{
		id: 17,
		name: 'GRIFFON NIVERNAIS',
		image: 'http://www.fci.be/Nomenclature/Illustrations/017g06.jpg',
		country: 'FRANCE',
		section: 'Scent hounds',
	},
	{
		id: 18,
		name: 'BRIQUET GRIFFON VENDEEN',
		image: 'http://www.fci.be/Nomenclature/Illustrations/019g06.jpg',
		country: 'FRANCE',
		section: 'Scent hounds',
	},
	{
		id: 19,
		name: 'ARIEGEOIS',
		image: 'http://www.fci.be/Nomenclature/Illustrations/020g06.jpg',
		country: 'FRANCE',
		section: 'Scent hounds',
	},
	{ id: 20, name: 'GASCON SAINTONGEOIS', image: null, country: 'FRANCE', section: 'Scent hounds' },
	{
		id: 21,
		name: 'GREAT GASCONY BLUE',
		image: 'http://www.fci.be/Nomenclature/Illustrations/022g06.jpg',
		country: 'FRANCE',
		section: 'Scent hounds',
	},
	{
		id: 22,
		name: 'POITEVIN',
		image: 'http://www.fci.be/Nomenclature/Illustrations/024g06.jpg',
		country: 'FRANCE',
		section: 'Scent hounds',
	},
	{
		id: 23,
		name: 'BILLY',
		image: 'http://www.fci.be/Nomenclature/Illustrations/025g06.jpg',
		country: 'FRANCE',
		section: 'Scent hounds',
	},
	{
		id: 24,
		name: 'ARTOIS HOUND',
		image: 'http://www.fci.be/Nomenclature/Illustrations/028g06.jpg',
		country: 'FRANCE',
		section: 'Scent hounds',
	},
	{
		id: 25,
		name: 'PORCELAINE',
		image: 'http://www.fci.be/Nomenclature/Illustrations/030g06.jpg',
		country: 'FRANCE',
		section: 'Scent hounds',
	},
	{ id: 26, name: 'SMALL BLUE GASCONY BLUE', image: null, country: 'FRANCE', section: 'Scent hounds' },
	{ id: 27, name: 'BLUE GASCONY GRIFFON', image: null, country: 'FRANCE', section: 'Scent hounds' },
	{ id: 28, name: 'GRAND BASSET GRIFFON VENDEEN', image: null, country: 'FRANCE', section: 'Scent hounds' },
	{ id: 29, name: 'NORMAN ARTESIEN BASSET', image: null, country: 'FRANCE', section: 'Scent hounds' },
	{ id: 30, name: 'BLUE GASCONY BASSET', image: null, country: 'FRANCE', section: 'Scent hounds' },
	{ id: 31, name: 'BASSET FAUVE DE BRETAGNE', image: null, country: 'FRANCE', section: 'Scent hounds' },
	{
		id: 32,
		name: 'PORTUGUESE WATER DOG',
		image: 'http://www.fci.be/Nomenclature/Illustrations/037g08.jpg',
		country: 'PORTUGAL',
		section: 'Water Dogs',
	},
	{
		id: 33,
		name: 'WELSH CORGI CARDIGAN',
		image: 'http://www.fci.be/Nomenclature/Illustrations/038g01.jpg',
		country: 'GREAT BRITAIN',
		section: 'Sheepdogs',
	},
	{
		id: 34,
		name: 'WELSH CORGI PEMBROKE',
		image: 'http://www.fci.be/Nomenclature/Illustrations/039g01.jpg',
		country: 'GREAT BRITAIN',
		section: 'Sheepdogs',
	},
	{
		id: 35,
		name: 'IRISH SOFT COATED WHEATEN TERRIER',
		image: null,
		country: 'IRELAND',
		section: 'Large and medium sized Terriers',
	},
	{
		id: 36,
		name: 'YUGOSLAVIAN SHEPHERD DOG - SHARPLANINA',
		image: ' SERBIA',
		country: 'MACEDONIA',
		section: 'Molossian type',
	},
	{
		id: 37,
		name: 'J\u00c4MTHUND',
		image: 'http://www.fci.be/Nomenclature/Illustrations/042g05.jpg',
		country: 'SWEDEN',
		section: 'Nordic Hunting Dogs',
	},
	{ id: 38, name: 'BASENJI', image: null, country: 'CENTRAL AFRICA', section: 'Primitive type' },
	{ id: 39, name: 'BERGER DE BEAUCE', image: null, country: 'FRANCE', section: 'Sheepdogs' },
	{
		id: 40,
		name: 'BERNESE MOUNTAIN DOG',
		image: 'http://www.fci.be/Nomenclature/Illustrations/045g02.jpg',
		country: 'SWITZERLAND',
		section: 'Swiss Mountain- and Cattledogs',
	},
	{
		id: 41,
		name: 'APPENZELL CATTLE DOG',
		image: null,
		country: 'SWITZERLAND',
		section: 'Swiss Mountain- and Cattledogs',
	},
	{
		id: 42,
		name: 'ENTLEBUCH CATTLE DOG',
		image: 'http://www.fci.be/Nomenclature/Illustrations/047g02.jpg',
		country: 'SWITZERLAND',
		section: 'Swiss Mountain- and Cattledogs',
	},
	{
		id: 43,
		name: 'KARELIAN BEAR DOG',
		image: 'http://www.fci.be/Nomenclature/Illustrations/048g05-1.jpg',
		country: 'FINLAND',
		section: 'Nordic Hunting Dogs',
	},
	{
		id: 44,
		name: 'FINNISH SPITZ',
		image: 'http://www.fci.be/Nomenclature/Illustrations/049g05-1.jpg',
		country: 'FINLAND',
		section: 'Nordic Hunting Dogs',
	},
	{ id: 45, name: 'NEWFOUNDLAND', image: null, country: 'CANADA', section: 'Molossian type' },
	{ id: 46, name: 'FINNISH HOUND', image: null, country: 'FINLAND', section: 'Scent hounds' },
	{
		id: 47,
		name: 'POLISH HOUND',
		image: 'http://www.fci.be/Nomenclature/Illustrations/052g06.jpg',
		country: 'POLAND',
		section: 'Scent hounds',
	},
	{
		id: 48,
		name: 'KOMONDOR',
		image: 'http://www.fci.be/Nomenclature/Illustrations/053g01.jpg',
		country: 'HUNGARY',
		section: 'Sheepdogs',
	},
	{
		id: 49,
		name: 'KUVASZ',
		image: 'http://www.fci.be/Nomenclature/Illustrations/054g01.jpg',
		country: 'HUNGARY',
		section: 'Sheepdogs',
	},
	{
		id: 50,
		name: 'PULI',
		image: 'http://www.fci.be/Nomenclature/Illustrations/055g01.jpg',
		country: 'HUNGARY',
		section: 'Sheepdogs',
	},
	{
		id: 51,
		name: 'PUMI',
		image: 'http://www.fci.be/Nomenclature/Illustrations/056g01.jpg',
		country: 'HUNGARY',
		section: 'Sheepdogs',
	},
	{
		id: 52,
		name: 'HUNGARIAN SHORT-HAIRED POINTER (VIZSLA)',
		image: 'http://www.fci.be/Nomenclature/Illustrations/057g07.jpg',
		country: 'HUNGARY',
		section: 'Continental Pointing Dogs',
	},
	{
		id: 53,
		name: 'GREAT SWISS MOUNTAIN DOG',
		image: 'http://www.fci.be/Nomenclature/Illustrations/058g02.jpg',
		country: 'SWITZERLAND',
		section: 'Swiss Mountain- and Cattledogs',
	},
	{
		id: 54,
		name: 'SWISS HOUND',
		image: 'http://www.fci.be/Nomenclature/Illustrations/059g06-1.jpg',
		country: 'SWITZERLAND',
		section: 'Scent hounds',
	},
	{
		id: 55,
		name: 'SMALL SWISS HOUND',
		image: 'http://www.fci.be/Nomenclature/Illustrations/060g06-1.jpg',
		country: 'SWITZERLAND',
		section: 'Scent hounds',
	},
	{
		id: 56,
		name: 'ST. BERNARD',
		image: 'http://www.fci.be/Nomenclature/Illustrations/061g02-1.jpg',
		country: 'SWITZERLAND',
		section: 'Molossian type',
	},
	{
		id: 57,
		name: 'COARSE-HAIRED STYRIAN HOUND',
		image: 'http://www.fci.be/Nomenclature/Illustrations/062g06.jpg',
		country: 'AUSTRIA',
		section: 'Scent hounds',
	},
	{
		id: 58,
		name: 'AUSTRIAN BLACK AND TAN HOUND',
		image: 'http://www.fci.be/Nomenclature/Illustrations/063g06.jpg',
		country: 'AUSTRIA',
		section: 'Scent hounds',
	},
	{ id: 59, name: 'AUSTRIAN  PINSCHER', image: null, country: 'AUSTRIA', section: 'Pinscher and Schnauzer type' },
	{
		id: 60,
		name: 'MALTESE',
		image: null,
		country: 'CENTRAL MEDITERRANEAN BASIN',
		section: 'Bichons and related breeds',
	},
	{
		id: 61,
		name: 'FAWN BRITTANY GRIFFON',
		image: 'http://www.fci.be/Nomenclature/Illustrations/066g06.jpg',
		country: 'FRANCE',
		section: 'Scent hounds',
	},
	{ id: 62, name: 'PETIT BASSET GRIFFON VENDEEN', image: null, country: 'FRANCE', section: 'Scent hounds' },
	{ id: 63, name: 'TYROLEAN HOUND', image: null, country: 'AUSTRIA', section: 'Scent hounds' },
	{
		id: 64,
		name: 'LAKELAND TERRIER',
		image: 'http://www.fci.be/Nomenclature/Illustrations/070g03.jpg',
		country: 'GREAT BRITAIN',
		section: 'Large and medium sized Terriers',
	},
	{
		id: 65,
		name: 'MANCHESTER TERRIER',
		image: 'http://www.fci.be/Nomenclature/Illustrations/071g03.jpg',
		country: 'GREAT BRITAIN',
		section: 'Large and medium sized Terriers',
	},
	{
		id: 66,
		name: 'NORWICH TERRIER',
		image: 'http://www.fci.be/Nomenclature/Illustrations/072g03.jpg',
		country: 'GREAT BRITAIN',
		section: 'Small sized Terriers',
	},
	{
		id: 67,
		name: 'SCOTTISH TERRIER',
		image: 'http://www.fci.be/Nomenclature/Illustrations/073g03.jpg',
		country: 'GREAT BRITAIN',
		section: 'Small sized Terriers',
	},
	{
		id: 68,
		name: 'SEALYHAM TERRIER',
		image: 'http://www.fci.be/Nomenclature/Illustrations/074g03.jpg',
		country: 'GREAT BRITAIN',
		section: 'Small sized Terriers',
	},
	{
		id: 69,
		name: 'SKYE TERRIER',
		image: 'http://www.fci.be/Nomenclature/Illustrations/075g03.jpg',
		country: 'GREAT BRITAIN',
		section: 'Small sized Terriers',
	},
	{
		id: 70,
		name: 'STAFFORDSHIRE BULL TERRIER',
		image: 'http://www.fci.be/Nomenclature/Illustrations/076g03.jpg',
		country: 'GREAT BRITAIN',
		section: 'Bull type Terriers',
	},
	{
		id: 71,
		name: 'CONTINENTAL TOY SPANIEL',
		image: ' FRANCE',
		country: 'BELGIUM',
		section: 'Continental Toy Spaniel and Russian Toy',
	},
	{
		id: 72,
		name: 'WELSH TERRIER',
		image: 'http://www.fci.be/Nomenclature/Illustrations/078g03.jpg',
		country: 'GREAT BRITAIN',
		section: 'Large and medium sized Terriers',
	},
	{
		id: 73,
		name: 'GRIFFON BRUXELLOIS',
		image: 'http://www.fci.be/Nomenclature/Illustrations/080g09-1.jpg',
		country: 'BELGIUM',
		section: 'Small Belgian Dogs',
	},
	{ id: 74, name: 'GRIFFON BELGE', image: null, country: 'BELGIUM', section: 'Small Belgian Dogs' },
	{ id: 75, name: 'PETIT BRABAN\u00c7ON', image: null, country: 'BELGIUM', section: 'Small Belgian Dogs' },
	{ id: 76, name: 'SCHIPPERKE', image: null, country: 'BELGIUM', section: 'Sheepdogs' },
	{ id: 77, name: 'BLOODHOUND', image: null, country: 'BELGIUM', section: 'Scent hounds' },
	{
		id: 78,
		name: 'WEST HIGHLAND WHITE TERRIER',
		image: 'http://www.fci.be/Nomenclature/Illustrations/085g03.jpg',
		country: 'GREAT BRITAIN',
		section: 'Small sized Terriers',
	},
	{
		id: 79,
		name: 'YORKSHIRE TERRIER',
		image: 'http://www.fci.be/Nomenclature/Illustrations/086g03.jpg',
		country: 'GREAT BRITAIN',
		section: 'Toy Terriers',
	},
	{ id: 80, name: 'CATALAN SHEEPDOG', image: null, country: 'SPAIN', section: 'Sheepdogs' },
	{
		id: 81,
		name: 'SHETLAND SHEEPDOG',
		image: 'http://www.fci.be/Nomenclature/Illustrations/088g01.jpg',
		country: 'GREAT BRITAIN',
		section: 'Sheepdogs',
	},
	{ id: 82, name: 'IBIZAN PODENCO', image: null, country: 'SPAIN', section: 'Primitive type - Hunting Dogs' },
	{ id: 83, name: 'BURGOS POINTING DOG', image: null, country: 'SPAIN', section: 'Continental Pointing Dogs' },
	{ id: 84, name: 'SPANISH MASTIFF', image: null, country: 'SPAIN', section: 'Molossian type' },
	{ id: 85, name: 'PYRENEAN MASTIFF', image: null, country: 'SPAIN', section: 'Molossian type' },
	{
		id: 86,
		name: 'PORTUGUESE SHEEPDOG',
		image: 'http://www.fci.be/Nomenclature/Illustrations/093g01.jpg',
		country: 'PORTUGAL',
		section: 'Sheepdogs',
	},
	{
		id: 87,
		name: 'PORTUGUESE WARREN HOUND-PORTUGUESE PODENGO',
		image: 'http://www.fci.be/Nomenclature/Illustrations/094g05-1.jpg',
		country: 'PORTUGAL',
		section: 'Primitive type - Hunting Dogs',
	},
	{
		id: 88,
		name: 'BRITTANY SPANIEL',
		image: 'http://www.fci.be/Nomenclature/Illustrations/095g07.jpg',
		country: 'FRANCE',
		section: 'Continental Pointing Dogs',
	},
	{
		id: 89,
		name: 'RAFEIRO OF ALENTEJO',
		image: 'http://www.fci.be/Nomenclature/Illustrations/096g02.jpg',
		country: 'PORTUGAL',
		section: 'Molossian type',
	},
	{
		id: 90,
		name: 'GERMAN SPITZ',
		image: 'http://www.fci.be/Nomenclature/Illustrations/097g05-1.jpg',
		country: 'GERMANY',
		section: 'European Spitz',
	},
	{
		id: 91,
		name: 'GERMAN WIRE- HAIRED POINTING DOG',
		image: 'http://www.fci.be/Nomenclature/Illustrations/098g07.jpg',
		country: 'GERMANY',
		section: 'Continental Pointing Dogs',
	},
	{ id: 92, name: 'WEIMARANER', image: null, country: 'GERMANY', section: 'Continental Pointing Dogs' },
	{ id: 93, name: 'WESTPHALIAN DACHSBRACKE', image: null, country: 'GERMANY', section: 'Scent hounds' },
	{
		id: 94,
		name: 'FRENCH BULLDOG',
		image: 'http://www.fci.be/Nomenclature/Illustrations/101g09.jpg',
		country: 'FRANCE',
		section: 'Small Molossian type Dogs',
	},
	{
		id: 95,
		name: 'KLEINER M\u00dcNSTERL\u00c4NDER',
		image: null,
		country: 'GERMANY',
		section: 'Continental Pointing Dogs',
	},
	{
		id: 96,
		name: 'GERMAN HUNTING TERRIER',
		image: 'http://www.fci.be/Nomenclature/Illustrations/103g03-1.jpg',
		country: 'GERMANY',
		section: 'Large and medium sized Terriers',
	},
	{
		id: 97,
		name: 'GERMAN SPANIEL',
		image: 'http://www.fci.be/Nomenclature/Illustrations/104g08.jpg',
		country: 'GERMANY',
		section: 'Flushing Dogs',
	},
	{
		id: 98,
		name: 'FRENCH WATER DOG',
		image: 'http://www.fci.be/Nomenclature/Illustrations/105g08.jpg',
		country: 'FRANCE',
		section: 'Water Dogs',
	},
	{ id: 99, name: 'BLUE PICARDY SPANIEL', image: null, country: 'FRANCE', section: 'Continental Pointing Dogs' },
	{
		id: 100,
		name: 'WIRE-HAIRED POINTING GRIFFON KORTHALS',
		image: null,
		country: 'FRANCE',
		section: 'Continental Pointing Dogs',
	},
	{ id: 101, name: 'PICARDY SPANIEL', image: null, country: 'FRANCE', section: 'Continental Pointing Dogs' },
	{
		id: 102,
		name: 'CLUMBER SPANIEL',
		image: 'http://www.fci.be/Nomenclature/Illustrations/109g08.jpg',
		country: 'GREAT BRITAIN',
		section: 'Flushing Dogs',
	},
	{
		id: 103,
		name: 'CURLY COATED RETRIEVER',
		image: 'http://www.fci.be/Nomenclature/Illustrations/110g08.jpg',
		country: 'GREAT BRITAIN',
		section: 'Retrievers',
	},
	{ id: 104, name: 'GOLDEN RETRIEVER', image: null, country: 'GREAT BRITAIN', section: 'Retrievers' },
	{
		id: 105,
		name: 'BRIARD',
		image: 'http://www.fci.be/Nomenclature/Illustrations/113g01.jpg',
		country: 'FRANCE',
		section: 'Sheepdogs',
	},
	{ id: 106, name: 'PONT-AUDEMER SPANIEL', image: null, country: 'FRANCE', section: 'Continental Pointing Dogs' },
	{ id: 107, name: 'SAINT GERMAIN POINTER', image: null, country: 'FRANCE', section: 'Continental Pointing Dogs' },
	{
		id: 108,
		name: 'DOGUE DE BORDEAUX',
		image: 'http://www.fci.be/Nomenclature/Illustrations/116g02.jpg',
		country: 'FRANCE',
		section: 'Molossian type',
	},
	{
		id: 109,
		name: 'DEUTSCH LANGHAAR',
		image: 'http://www.fci.be/Nomenclature/Illustrations/117g07.jpg',
		country: 'GERMANY',
		section: 'Continental Pointing Dogs',
	},
	{
		id: 110,
		name: 'LARGE MUNSTERLANDER',
		image: 'http://www.fci.be/Nomenclature/Illustrations/118g07.jpg',
		country: 'GERMANY',
		section: 'Continental Pointing Dogs',
	},
	{
		id: 111,
		name: 'GERMAN SHORT- HAIRED POINTING DOG',
		image: 'http://www.fci.be/Nomenclature/Illustrations/119g07.jpg',
		country: 'GERMANY',
		section: 'Continental Pointing Dogs',
	},
	{
		id: 112,
		name: 'IRISH RED SETTER',
		image: null,
		country: 'IRELAND',
		section: 'British and Irish Pointers and Setters',
	},
	{
		id: 113,
		name: 'FLAT COATED RETRIEVER',
		image: 'http://www.fci.be/Nomenclature/Illustrations/121g08.jpg',
		country: 'GREAT BRITAIN',
		section: 'Retrievers',
	},
	{
		id: 114,
		name: 'LABRADOR RETRIEVER',
		image: 'http://www.fci.be/Nomenclature/Illustrations/122g08.jpg',
		country: 'GREAT BRITAIN',
		section: 'Retrievers',
	},
	{
		id: 115,
		name: 'FIELD SPANIEL',
		image: 'http://www.fci.be/Nomenclature/Illustrations/123g08.jpg',
		country: 'GREAT BRITAIN',
		section: 'Flushing Dogs',
	},
	{ id: 116, name: 'IRISH WATER SPANIEL', image: null, country: 'IRELAND', section: 'Water Dogs' },
	{
		id: 117,
		name: 'ENGLISH SPRINGER SPANIEL',
		image: 'http://www.fci.be/Nomenclature/Illustrations/125g08.jpg',
		country: 'GREAT BRITAIN',
		section: 'Flushing Dogs',
	},
	{
		id: 118,
		name: 'WELSH SPRINGER SPANIEL',
		image: 'http://www.fci.be/Nomenclature/Illustrations/126g08.jpg',
		country: 'GREAT BRITAIN',
		section: 'Flushing Dogs',
	},
	{
		id: 119,
		name: 'SUSSEX SPANIEL',
		image: 'http://www.fci.be/Nomenclature/Illustrations/127g08.jpg',
		country: 'GREAT BRITAIN',
		section: 'Flushing Dogs',
	},
	{
		id: 120,
		name: 'KING CHARLES SPANIEL',
		image: 'http://www.fci.be/Nomenclature/Illustrations/128g09.jpg',
		country: 'GREAT BRITAIN',
		section: 'English Toy Spaniels',
	},
	{
		id: 121,
		name: 'SM\u00c5LANDSST\u00d6VARE',
		image: 'http://www.fci.be/Nomenclature/Illustrations/129g06.jpg',
		country: 'SWEDEN',
		section: 'Scent hounds',
	},
	{
		id: 122,
		name: 'DREVER',
		image: 'http://www.fci.be/Nomenclature/Illustrations/130g06.jpg',
		country: 'SWEDEN',
		section: 'Scent hounds',
	},
	{
		id: 123,
		name: 'SCHILLERST\u00d6VARE',
		image: 'http://www.fci.be/Nomenclature/Illustrations/131g06.jpg',
		country: 'SWEDEN',
		section: 'Scent hounds',
	},
	{
		id: 124,
		name: 'HAMILTONST\u00d6VARE',
		image: 'http://www.fci.be/Nomenclature/Illustrations/132g06.jpg',
		country: 'SWEDEN',
		section: 'Scent hounds',
	},
	{
		id: 125,
		name: 'FRENCH POINTING DOG - GASCOGNE TYPE',
		image: null,
		country: 'FRANCE',
		section: 'Continental Pointing Dogs',
	},
	{
		id: 126,
		name: 'FRENCH POINTING DOG - PYRENEAN TYPE',
		image: null,
		country: 'FRANCE',
		section: 'Continental Pointing Dogs',
	},
	{ id: 127, name: 'SWEDISH LAPPHUND', image: null, country: 'SWEDEN', section: 'Nordic Watchdogs and Herders' },
	{
		id: 128,
		name: 'CAVALIER KING CHARLES SPANIEL',
		image: 'http://www.fci.be/Nomenclature/Illustrations/136g09.jpg',
		country: 'GREAT BRITAIN',
		section: 'English Toy Spaniels',
	},
	{
		id: 129,
		name: 'PYRENEAN MOUNTAIN DOG',
		image: 'http://www.fci.be/Nomenclature/Illustrations/137g02.jpg',
		country: 'FRANCE',
		section: 'Molossian type',
	},
	{
		id: 130,
		name: 'PYRENEAN SHEEPDOG - SMOOTH FACED',
		image: 'http://www.fci.be/Nomenclature/Illustrations/138g01.jpg',
		country: 'FRANCE',
		section: 'Sheepdogs',
	},
	{ id: 131, name: 'IRISH TERRIER', image: null, country: 'IRELAND', section: 'Large and medium sized Terriers' },
	{
		id: 132,
		name: 'BOSTON TERRIER',
		image: null,
		country: 'UNITED STATES OF AMERICA',
		section: 'Small Molossian type Dogs',
	},
	{
		id: 133,
		name: 'LONG-HAIRED PYRENEAN SHEEPDOG',
		image: 'http://www.fci.be/Nomenclature/Illustrations/141g01.jpg',
		country: 'FRANCE',
		section: 'Sheepdogs',
	},
	{ id: 134, name: 'SLOVAKIAN CHUVACH', image: null, country: 'SLOVAKIA', section: 'Sheepdogs' },
	{
		id: 135,
		name: 'DOBERMANN',
		image: 'http://www.fci.be/Nomenclature/Illustrations/143g02.jpg',
		country: 'GERMANY',
		section: 'Pinscher and Schnauzer type',
	},
	{
		id: 136,
		name: 'BOXER',
		image: 'http://www.fci.be/Nomenclature/Illustrations/144g02.jpg',
		country: 'GERMANY',
		section: 'Molossian type',
	},
	{ id: 137, name: 'LEONBERGER', image: null, country: 'GERMANY', section: 'Molossian type' },
	{ id: 138, name: 'RHODESIAN RIDGEBACK', image: null, country: 'SOUTH AFRICA', section: 'Related breeds' },
	{ id: 139, name: 'ROTTWEILER', image: null, country: 'GERMANY', section: 'Molossian type' },
	{
		id: 140,
		name: 'DACHSHUND',
		image: 'http://www.fci.be/Nomenclature/Illustrations/148g04-1.jpg',
		country: 'GERMANY',
		section: 'None',
	},
	{
		id: 141,
		name: 'BULLDOG',
		image: 'http://www.fci.be/Nomenclature/Illustrations/149g02.jpg',
		country: 'GREAT BRITAIN',
		section: 'Molossian type',
	},
	{
		id: 142,
		name: 'SERBIAN HOUND',
		image: 'http://www.fci.be/Nomenclature/Illustrations/150g06.jpg',
		country: 'SERBIA',
		section: 'Scent hounds',
	},
	{
		id: 143,
		name: 'ISTRIAN SHORT-HAIRED HOUND',
		image: 'http://www.fci.be/Nomenclature/Illustrations/151g06.jpg',
		country: 'CROATIA',
		section: 'Scent hounds',
	},
	{
		id: 144,
		name: 'ISTRIAN WIRE-HAIRED HOUND',
		image: 'http://www.fci.be/Nomenclature/Illustrations/152g06.jpg',
		country: 'CROATIA',
		section: 'Scent hounds',
	},
	{
		id: 145,
		name: 'DALMATIAN',
		image: 'http://www.fci.be/Nomenclature/Illustrations/153g06.jpg',
		country: 'CROATIA',
		section: 'Related breeds',
	},
	{
		id: 146,
		name: 'POSAVATZ HOUND',
		image: 'http://www.fci.be/Nomenclature/Illustrations/154g06.jpg',
		country: 'CROATIA',
		section: 'Scent hounds',
	},
	{
		id: 147,
		name: 'BOSNIAN BROKEN-HAIRED HOUND - CALLED BARAK',
		image: 'http://www.fci.be/Nomenclature/Illustrations/155g06.jpg',
		country: 'BOSNIA AND HERZEGOVINA',
		section: 'Scent hounds',
	},
	{
		id: 148,
		name: 'COLLIE ROUGH',
		image: 'http://www.fci.be/Nomenclature/Illustrations/156g01.jpg',
		country: 'GREAT BRITAIN',
		section: 'Sheepdogs',
	},
	{ id: 149, name: 'BULLMASTIFF', image: null, country: 'GREAT BRITAIN', section: 'Molossian type' },
	{
		id: 150,
		name: 'GREYHOUND',
		image: 'http://www.fci.be/Nomenclature/Illustrations/158g10.jpg',
		country: 'GREAT BRITAIN',
		section: 'Short-haired Sighthounds',
	},
	{ id: 151, name: 'ENGLISH FOXHOUND', image: null, country: 'GREAT BRITAIN', section: 'Scent hounds' },
	{ id: 152, name: 'IRISH WOLFHOUND', image: null, country: 'IRELAND', section: 'Rough-haired Sighthounds' },
	{
		id: 153,
		name: 'BEAGLE',
		image: 'http://www.fci.be/Nomenclature/Illustrations/161g06.jpg',
		country: 'GREAT BRITAIN',
		section: 'Scent hounds',
	},
	{
		id: 154,
		name: 'WHIPPET',
		image: 'http://www.fci.be/Nomenclature/Illustrations/162g10.jpg',
		country: 'GREAT BRITAIN',
		section: 'Short-haired Sighthounds',
	},
	{
		id: 155,
		name: 'BASSET HOUND',
		image: 'http://www.fci.be/Nomenclature/Illustrations/163g06.jpg',
		country: 'GREAT BRITAIN',
		section: 'Scent hounds',
	},
	{
		id: 156,
		name: 'DEERHOUND',
		image: 'http://www.fci.be/Nomenclature/Illustrations/164g10.jpg',
		country: 'GREAT BRITAIN',
		section: 'Rough-haired Sighthounds',
	},
	{ id: 157, name: 'ITALIAN SPINONE', image: null, country: 'ITALY', section: 'Continental Pointing Dogs' },
	{
		id: 158,
		name: 'GERMAN SHEPHERD DOG',
		image: 'http://www.fci.be/Nomenclature/Illustrations/166g01-1.jpg',
		country: 'GERMANY',
		section: 'Sheepdogs',
	},
	{
		id: 159,
		name: 'AMERICAN COCKER SPANIEL',
		image: null,
		country: 'UNITED STATES OF AMERICA',
		section: 'Flushing Dogs',
	},
	{
		id: 160,
		name: 'DANDIE DINMONT TERRIER',
		image: 'http://www.fci.be/Nomenclature/Illustrations/168g03.jpg',
		country: 'GREAT BRITAIN',
		section: 'Small sized Terriers',
	},
	{
		id: 161,
		name: 'FOX TERRIER (WIRE)',
		image: 'http://www.fci.be/Nomenclature/Illustrations/169g03.jpg',
		country: 'GREAT BRITAIN',
		section: 'Large and medium sized Terriers',
	},
	{
		id: 162,
		name: 'CASTRO LABOREIRO DOG',
		image: 'http://www.fci.be/Nomenclature/Illustrations/170g02.jpg',
		country: 'PORTUGAL',
		section: 'Molossian type',
	},
	{
		id: 163,
		name: 'BOUVIER DES ARDENNES',
		image: null,
		country: 'BELGIUM',
		section: 'Cattledogs (except Swiss Cattledogs)',
	},
	{
		id: 164,
		name: 'POODLE',
		image: 'http://www.fci.be/Nomenclature/Illustrations/172g09.jpg',
		country: 'FRANCE',
		section: 'Poodle',
	},
	{
		id: 165,
		name: 'ESTRELA MOUNTAIN DOG',
		image: 'http://www.fci.be/Nomenclature/Illustrations/173g02.jpg',
		country: 'PORTUGAL',
		section: 'Molossian type',
	},
	{
		id: 166,
		name: 'FRENCH SPANIEL',
		image: 'http://www.fci.be/Nomenclature/Illustrations/175g07.jpg',
		country: 'FRANCE',
		section: 'Continental Pointing Dogs',
	},
	{ id: 167, name: 'PICARDY SHEEPDOG', image: null, country: 'FRANCE', section: 'Sheepdogs' },
	{ id: 168, name: 'ARIEGE POINTING DOG', image: null, country: 'FRANCE', section: 'Continental Pointing Dogs' },
	{
		id: 169,
		name: 'BOURBONNAIS POINTING DOG',
		image: 'http://www.fci.be/Nomenclature/Illustrations/179g07.jpg',
		country: 'FRANCE',
		section: 'Continental Pointing Dogs',
	},
	{
		id: 170,
		name: 'AUVERGNE POINTER',
		image: 'http://www.fci.be/Nomenclature/Illustrations/180g07.jpg',
		country: 'FRANCE',
		section: 'Continental Pointing Dogs',
	},
	{
		id: 171,
		name: 'GIANT SCHNAUZER',
		image: 'http://www.fci.be/Nomenclature/Illustrations/181g02.jpg',
		country: 'GERMANY',
		section: 'Pinscher and Schnauzer type',
	},
	{
		id: 172,
		name: 'SCHNAUZER',
		image: 'http://www.fci.be/Nomenclature/Illustrations/182g02.jpg',
		country: 'GERMANY',
		section: 'Pinscher and Schnauzer type',
	},
	{
		id: 173,
		name: 'MINIATURE SCHNAUZER',
		image: 'http://www.fci.be/Nomenclature/Illustrations/183g02.jpg',
		country: 'GERMANY',
		section: 'Pinscher and Schnauzer type',
	},
	{
		id: 174,
		name: 'GERMAN PINSCHER',
		image: 'http://www.fci.be/Nomenclature/Illustrations/184g02.jpg',
		country: 'GERMANY',
		section: 'Pinscher and Schnauzer type',
	},
	{
		id: 175,
		name: 'MINIATURE PINSCHER',
		image: 'http://www.fci.be/Nomenclature/Illustrations/185g02.jpg',
		country: 'GERMANY',
		section: 'Pinscher and Schnauzer type',
	},
	{
		id: 176,
		name: 'AFFENPINSCHER',
		image: 'http://www.fci.be/Nomenclature/Illustrations/186g02.jpg',
		country: 'GERMANY',
		section: 'Pinscher and Schnauzer type',
	},
	{
		id: 177,
		name: 'PORTUGUESE POINTING DOG',
		image: 'http://www.fci.be/Nomenclature/Illustrations/187g07.jpg',
		country: 'PORTUGAL',
		section: 'Continental Pointing Dogs',
	},
	{ id: 178, name: 'SLOUGHI', image: null, country: 'MOROCCO', section: 'Short-haired Sighthounds' },
	{ id: 179, name: 'FINNISH LAPPHUND', image: null, country: 'FINLAND', section: 'Nordic Watchdogs and Herders' },
	{ id: 180, name: 'HOVAWART', image: null, country: 'GERMANY', section: 'Molossian type' },
	{
		id: 181,
		name: 'BOUVIER DES FLANDRES',
		image: ' FRANCE',
		country: 'BELGIUM',
		section: 'Cattledogs (except Swiss Cattledogs)',
	},
	{
		id: 182,
		name: 'KROMFOHRL\u00c4NDER',
		image: 'http://www.fci.be/Nomenclature/Illustrations/192g09.jpg',
		country: 'GERMANY',
		section: 'Kromfohrl\u00e4nder',
	},
	{
		id: 183,
		name: 'BORZOI - RUSSIAN HUNTING SIGHTHOUND',
		image: 'http://www.fci.be/Nomenclature/Illustrations/193g10.jpg',
		country: 'RUSSIA',
		section: 'Long-haired or fringed Sighthounds',
	},
	{
		id: 184,
		name: 'BERGAMASCO SHEPHERD DOG',
		image: 'http://www.fci.be/Nomenclature/Illustrations/194g01-1.jpg',
		country: 'ITALY',
		section: 'Sheepdogs',
	},
	{ id: 185, name: 'ITALIAN VOLPINO', image: null, country: 'ITALY', section: 'European Spitz' },
	{ id: 186, name: 'BOLOGNESE', image: null, country: 'ITALY', section: 'Bichons and related breeds' },
	{ id: 187, name: 'NEAPOLITAN MASTIFF', image: null, country: 'ITALY', section: 'Molossian type' },
	{
		id: 188,
		name: 'ITALIAN ROUGH-HAIRED SEGUGIO',
		image: 'http://www.fci.be/Nomenclature/Illustrations/198g06.jpg',
		country: 'ITALY',
		section: 'Scent hounds',
	},
	{ id: 189, name: "CIRNECO DELL'ETNA", image: null, country: 'ITALY', section: 'Primitive type - Hunting Dogs' },
	{ id: 190, name: 'ITALIAN GREYHOUND', image: null, country: 'ITALY', section: 'Short-haired Sighthounds' },
	{ id: 191, name: 'MAREMMA AND THE ABRUZZES SHEEPDOG', image: null, country: 'ITALY', section: 'Sheepdogs' },
	{ id: 192, name: 'ITALIAN POINTING DOG', image: null, country: 'ITALY', section: 'Continental Pointing Dogs' },
	{
		id: 193,
		name: 'NORWEGIAN HOUND',
		image: 'http://www.fci.be/Nomenclature/Illustrations/203g06.jpg',
		country: 'NORWAY',
		section: 'Scent hounds',
	},
	{ id: 194, name: 'SPANISH HOUND', image: null, country: 'SPAIN', section: 'Scent hounds' },
	{
		id: 195,
		name: 'CHOW CHOW',
		image: 'http://www.fci.be/Nomenclature/Illustrations/205g05.jpg',
		country: 'CHINA',
		section: 'Asian Spitz and related breeds',
	},
	{
		id: 196,
		name: 'JAPANESE CHIN',
		image: 'http://www.fci.be/Nomenclature/Illustrations/206g09.jpg',
		country: 'JAPAN',
		section: 'Japan Chin and Pekingese',
	},
	{
		id: 197,
		name: 'PEKINGESE',
		image: 'http://www.fci.be/Nomenclature/Illustrations/207g09.jpg',
		country: 'CHINA',
		section: 'Japan Chin and Pekingese',
	},
	{
		id: 198,
		name: 'SHIH TZU',
		image: 'http://www.fci.be/Nomenclature/Illustrations/208g09.jpg',
		country: 'Tibet (China)',
		section: 'Tibetan breeds',
	},
	{
		id: 199,
		name: 'TIBETAN TERRIER',
		image: 'http://www.fci.be/Nomenclature/Illustrations/209g09.jpg',
		country: 'Tibet (China)',
		section: 'Tibetan breeds',
	},
	{ id: 200, name: 'SAMOYED', image: ' SIBERIA', country: 'NORTHERN RUSSIA', section: 'Nordic Sledge Dogs' },
	{
		id: 201,
		name: 'HANOVERIAN SCENTHOUND',
		image: 'http://www.fci.be/Nomenclature/Illustrations/213g06-1.jpg',
		country: 'GERMANY',
		section: 'Leash (scent) Hounds',
	},
	{ id: 202, name: 'HELLENIC HOUND', image: null, country: 'GREECE', section: 'Scent hounds' },
	{ id: 203, name: 'BICHON FRISE', image: ' FRANCE', country: 'BELGIUM', section: 'Bichons and related breeds' },
	{ id: 204, name: 'PUDELPOINTER', image: null, country: 'GERMANY', section: 'Continental Pointing Dogs' },
	{
		id: 205,
		name: 'BAVARIAN MOUNTAIN SCENT HOUND',
		image: 'http://www.fci.be/Nomenclature/Illustrations/217g06.jpg',
		country: 'GERMANY',
		section: 'Leash (scent) Hounds',
	},
	{
		id: 206,
		name: 'CHIHUAHUA',
		image: 'http://www.fci.be/Nomenclature/Illustrations/218g09-1.jpg',
		country: 'MEXICO',
		section: 'Chihuahueno',
	},
	{ id: 207, name: 'FRENCH TRICOLOUR HOUND', image: null, country: 'FRANCE', section: 'Scent hounds' },
	{
		id: 208,
		name: 'FRENCH WHITE & BLACK HOUND',
		image: 'http://www.fci.be/Nomenclature/Illustrations/220g06.jpg',
		country: 'FRANCE',
		section: 'Scent hounds',
	},
	{ id: 209, name: 'FRISIAN WATER DOG', image: null, country: 'THE NETHERLANDS', section: 'Water Dogs' },
	{
		id: 210,
		name: 'STABIJHOUN',
		image: 'http://www.fci.be/Nomenclature/Illustrations/222g07-1.jpg',
		country: 'THE NETHERLANDS',
		section: 'Continental Pointing Dogs',
	},
	{
		id: 211,
		name: 'DUTCH SHEPHERD DOG',
		image: 'http://www.fci.be/Nomenclature/Illustrations/223g01-1.jpg',
		country: 'THE NETHERLANDS',
		section: 'Sheepdogs',
	},
	{
		id: 212,
		name: 'DRENTSCHE PARTRIDGE DOG',
		image: null,
		country: 'THE NETHERLANDS',
		section: 'Continental Pointing Dogs',
	},
	{
		id: 213,
		name: 'FILA BRASILEIRO',
		image: 'http://www.fci.be/Nomenclature/Illustrations/225g02.jpg',
		country: 'BRAZIL',
		section: 'Molossian type',
	},
	{
		id: 214,
		name: 'LANDSEER (EUROPEAN CONTINENTAL TYPE)',
		image: ' SWITZERLAND',
		country: 'GERMANY',
		section: 'Molossian type',
	},
	{
		id: 215,
		name: 'LHASA APSO',
		image: 'http://www.fci.be/Nomenclature/Illustrations/227g09.jpg',
		country: 'Tibet (China)',
		section: 'Tibetan breeds',
	},
	{
		id: 216,
		name: 'AFGHAN HOUND',
		image: 'http://www.fci.be/Nomenclature/Illustrations/228g10.jpg',
		country: 'AFGHANISTAN',
		section: 'Long-haired or fringed Sighthounds',
	},
	{
		id: 217,
		name: 'SERBIAN TRICOLOUR HOUND',
		image: 'http://www.fci.be/Nomenclature/Illustrations/229g06.jpg',
		country: 'SERBIA',
		section: 'Scent hounds',
	},
	{ id: 218, name: 'TIBETAN MASTIFF', image: null, country: 'Tibet (China)', section: 'Molossian type' },
	{
		id: 219,
		name: 'TIBETAN SPANIEL',
		image: 'http://www.fci.be/Nomenclature/Illustrations/231g09.jpg',
		country: 'Tibet (China)',
		section: 'Tibetan breeds',
	},
	{
		id: 220,
		name: 'DEUTSCH STICHELHAAR',
		image: 'http://www.fci.be/Nomenclature/Illustrations/232g07.jpg',
		country: 'GERMANY',
		section: 'Continental Pointing Dogs',
	},
	{
		id: 221,
		name: 'LITTLE LION DOG',
		image: 'http://www.fci.be/Nomenclature/Illustrations/233g09.jpg',
		country: 'FRANCE',
		section: 'Bichons and related breeds',
	},
	{
		id: 222,
		name: 'XOLOITZCUINTLE',
		image: 'http://www.fci.be/Nomenclature/Illustrations/234g05-1.jpg',
		country: 'MEXICO',
		section: 'Primitive type',
	},
	{
		id: 223,
		name: 'GREAT DANE',
		image: 'http://www.fci.be/Nomenclature/Illustrations/235g02.jpg',
		country: 'GERMANY',
		section: 'Molossian type',
	},
	{
		id: 224,
		name: 'AUSTRALIAN SILKY TERRIER',
		image: 'http://www.fci.be/Nomenclature/Illustrations/236g03.jpg',
		country: 'AUSTRALIA',
		section: 'Toy Terriers',
	},
	{
		id: 225,
		name: 'NORWEGIAN BUHUND',
		image: 'http://www.fci.be/Nomenclature/Illustrations/237g05.jpg',
		country: 'NORWAY',
		section: 'Nordic Watchdogs and Herders',
	},
	{
		id: 226,
		name: 'MUDI',
		image: 'http://www.fci.be/Nomenclature/Illustrations/238g01.jpg',
		country: 'HUNGARY',
		section: 'Sheepdogs',
	},
	{
		id: 227,
		name: 'HUNGARIAN WIRE-HAIRED POINTER',
		image: 'http://www.fci.be/Nomenclature/Illustrations/239g07.jpg',
		country: 'HUNGARY',
		section: 'Continental Pointing Dogs',
	},
	{
		id: 228,
		name: 'HUNGARIAN GREYHOUND',
		image: 'http://www.fci.be/Nomenclature/Illustrations/240g10.jpg',
		country: 'HUNGARY',
		section: 'Short-haired Sighthounds',
	},
	{
		id: 229,
		name: 'HUNGARIAN HOUND - TRANSYLVANIAN SCENT HOUND',
		image: 'http://www.fci.be/Nomenclature/Illustrations/241g06.jpg',
		country: 'HUNGARY',
		section: 'Scent hounds',
	},
	{
		id: 230,
		name: 'NORWEGIAN ELKHOUND GREY',
		image: 'http://www.fci.be/Nomenclature/Illustrations/242g05.jpg',
		country: 'NORWAY',
		section: 'Nordic Hunting Dogs',
	},
	{
		id: 231,
		name: 'ALASKAN MALAMUTE',
		image: null,
		country: 'UNITED STATES OF AMERICA',
		section: 'Nordic Sledge Dogs',
	},
	{ id: 232, name: 'SLOVAKIAN HOUND', image: null, country: 'SLOVAKIA', section: 'Scent hounds' },
	{
		id: 233,
		name: 'BOHEMIAN WIRE-HAIRED POINTING GRIFFON',
		image: null,
		country: 'CZECH REPUBLIC',
		section: 'Continental Pointing Dogs',
	},
	{
		id: 234,
		name: 'CESKY TERRIER',
		image: 'http://www.fci.be/Nomenclature/Illustrations/246g03.jpg',
		country: 'CZECH REPUBLIC',
		section: 'Small sized Terriers',
	},
	{ id: 235, name: 'ATLAS MOUNTAIN DOG (AIDI)', image: null, country: 'MOROCCO', section: 'Molossian type' },
	{ id: 236, name: 'PHARAOH HOUND', image: null, country: 'MALTA', section: 'Primitive type' },
	{ id: 237, name: 'MAJORCA MASTIFF', image: null, country: 'SPAIN', section: 'Molossian type' },
	{
		id: 238,
		name: 'HAVANESE',
		image: null,
		country: 'WESTERN MEDITERRANEAN BASIN',
		section: 'Bichons and related breeds',
	},
	{
		id: 239,
		name: 'POLISH LOWLAND SHEEPDOG',
		image: 'http://www.fci.be/Nomenclature/Illustrations/251g01.jpg',
		country: 'POLAND',
		section: 'Sheepdogs',
	},
	{
		id: 240,
		name: 'TATRA SHEPHERD DOG',
		image: 'http://www.fci.be/Nomenclature/Illustrations/252g01.jpg',
		country: 'POLAND',
		section: 'Sheepdogs',
	},
	{
		id: 241,
		name: 'PUG',
		image: 'http://www.fci.be/Nomenclature/Illustrations/253g09.jpg',
		country: 'CHINA',
		section: 'Small Molossian type Dogs',
	},
	{ id: 242, name: 'ALPINE DACHSBRACKE', image: null, country: 'AUSTRIA', section: 'Leash (scent) Hounds' },
	{
		id: 243,
		name: 'AKITA',
		image: 'http://www.fci.be/Nomenclature/Illustrations/255g05.jpg',
		country: 'JAPAN',
		section: 'Asian Spitz and related breeds',
	},
	{
		id: 244,
		name: 'SHIBA',
		image: 'http://www.fci.be/Nomenclature/Illustrations/257g05.jpg',
		country: 'JAPAN',
		section: 'Asian Spitz and related breeds',
	},
	{
		id: 245,
		name: 'JAPANESE TERRIER',
		image: 'http://www.fci.be/Nomenclature/Illustrations/259g03.jpg',
		country: 'JAPAN',
		section: 'Small sized Terriers',
	},
	{
		id: 246,
		name: 'TOSA',
		image: 'http://www.fci.be/Nomenclature/Illustrations/260g02.jpg',
		country: 'JAPAN',
		section: 'Molossian type',
	},
	{
		id: 247,
		name: 'HOKKAIDO',
		image: 'http://www.fci.be/Nomenclature/Illustrations/261g05.jpg',
		country: 'JAPAN',
		section: 'Asian Spitz and related breeds',
	},
	{
		id: 248,
		name: 'JAPANESE SPITZ',
		image: 'http://www.fci.be/Nomenclature/Illustrations/262g05.jpg',
		country: 'JAPAN',
		section: 'Asian Spitz and related breeds',
	},
	{
		id: 249,
		name: 'CHESAPEAKE BAY RETRIEVER',
		image: null,
		country: 'UNITED STATES OF AMERICA',
		section: 'Retrievers',
	},
	{ id: 250, name: 'MASTIFF', image: null, country: 'GREAT BRITAIN', section: 'Molossian type' },
	{
		id: 251,
		name: 'NORWEGIAN LUNDEHUND',
		image: 'http://www.fci.be/Nomenclature/Illustrations/265g05.jpg',
		country: 'NORWAY',
		section: 'Nordic Hunting Dogs',
	},
	{
		id: 252,
		name: 'HYGEN HOUND',
		image: 'http://www.fci.be/Nomenclature/Illustrations/266g06.jpg',
		country: 'NORWAY',
		section: 'Scent hounds',
	},
	{
		id: 253,
		name: 'HALDEN HOUND',
		image: 'http://www.fci.be/Nomenclature/Illustrations/267g06.jpg',
		country: 'NORWAY',
		section: 'Scent hounds',
	},
	{
		id: 254,
		name: 'NORWEGIAN ELKHOUND BLACK',
		image: 'http://www.fci.be/Nomenclature/Illustrations/268g05.jpg',
		country: 'NORWAY',
		section: 'Nordic Hunting Dogs',
	},
	{ id: 255, name: 'SALUKI', image: null, country: 'MIDDLE EAST', section: 'Long-haired or fringed Sighthounds' },
	{ id: 256, name: 'SIBERIAN HUSKY', image: null, country: 'UNITED STATES OF AMERICA', section: 'Nordic Sledge Dogs' },
	{
		id: 257,
		name: 'BEARDED COLLIE',
		image: 'http://www.fci.be/Nomenclature/Illustrations/271g01.jpg',
		country: 'GREAT BRITAIN',
		section: 'Sheepdogs',
	},
	{
		id: 258,
		name: 'NORFOLK TERRIER',
		image: 'http://www.fci.be/Nomenclature/Illustrations/272g03.jpg',
		country: 'GREAT BRITAIN',
		section: 'Small sized Terriers',
	},
	{ id: 259, name: 'CANAAN DOG', image: null, country: 'ISRAEL', section: 'Primitive type' },
	{
		id: 260,
		name: 'GREENLAND DOG',
		image: 'http://www.fci.be/Nomenclature/Illustrations/274g05.jpg',
		country: 'GREENLAND',
		section: 'Nordic Sledge Dogs',
	},
	{
		id: 261,
		name: 'NORRBOTTENSPITZ',
		image: 'http://www.fci.be/Nomenclature/Illustrations/276g05.jpg',
		country: 'SWEDEN',
		section: 'Nordic Hunting Dogs',
	},
	{
		id: 262,
		name: 'CROATIAN SHEPHERD DOG',
		image: 'http://www.fci.be/Nomenclature/Illustrations/277g01.jpg',
		country: 'CROATIA',
		section: 'Sheepdogs',
	},
	{
		id: 263,
		name: 'KARST SHEPHERD DOG',
		image: 'http://www.fci.be/Nomenclature/Illustrations/278g02.jpg',
		country: 'SLOVENIA',
		section: 'Molossian type',
	},
	{
		id: 264,
		name: 'MONTENEGRIN MOUNTAIN HOUND',
		image: 'http://www.fci.be/Nomenclature/Illustrations/279g06.jpg',
		country: 'MONTENEGRO',
		section: 'Scent hounds',
	},
	{ id: 265, name: 'OLD DANISH POINTING DOG', image: null, country: 'DENMARK', section: 'Continental Pointing Dogs' },
	{
		id: 266,
		name: 'GRAND GRIFFON VENDEEN',
		image: 'http://www.fci.be/Nomenclature/Illustrations/282g06.jpg',
		country: 'FRANCE',
		section: 'Scent hounds',
	},
	{ id: 267, name: 'COTON DE TULEAR', image: null, country: 'MADAGASCAR', section: 'Bichons and related breeds' },
	{ id: 268, name: 'LAPPONIAN HERDER', image: null, country: 'FINLAND', section: 'Nordic Watchdogs and Herders' },
	{ id: 269, name: 'SPANISH GREYHOUND', image: null, country: 'SPAIN', section: 'Short-haired Sighthounds' },
	{
		id: 270,
		name: 'AMERICAN STAFFORDSHIRE TERRIER',
		image: null,
		country: 'UNITED STATES OF AMERICA',
		section: 'Bull type Terriers',
	},
	{
		id: 271,
		name: 'AUSTRALIAN CATTLE DOG',
		image: 'http://www.fci.be/Nomenclature/Illustrations/287g01.jpg',
		country: 'AUSTRALIA',
		section: 'Cattledogs (except Swiss Cattledogs)',
	},
	{
		id: 272,
		name: 'CHINESE CRESTED DOG',
		image: 'http://www.fci.be/Nomenclature/Illustrations/288g09.jpg',
		country: 'CHINA',
		section: 'Hairless Dogs',
	},
	{
		id: 273,
		name: 'ICELANDIC SHEEPDOG',
		image: 'http://www.fci.be/Nomenclature/Illustrations/289g05.jpg',
		country: 'ICELAND',
		section: 'Nordic Watchdogs and Herders',
	},
	{ id: 274, name: 'BEAGLE HARRIER', image: null, country: 'FRANCE', section: 'Scent hounds' },
	{
		id: 275,
		name: 'EURASIAN',
		image: 'http://www.fci.be/Nomenclature/Illustrations/291g05.jpg',
		country: 'GERMANY',
		section: 'Asian Spitz and related breeds',
	},
	{
		id: 276,
		name: 'DOGO ARGENTINO',
		image: 'http://www.fci.be/Nomenclature/Illustrations/292g02.jpg',
		country: 'ARGENTINA',
		section: 'Molossian type',
	},
	{
		id: 277,
		name: 'AUSTRALIAN KELPIE',
		image: 'http://www.fci.be/Nomenclature/Illustrations/293g01.jpg',
		country: 'AUSTRALIA',
		section: 'Sheepdogs',
	},
	{
		id: 278,
		name: 'OTTERHOUND',
		image: 'http://www.fci.be/Nomenclature/Illustrations/294g06.jpg',
		country: 'GREAT BRITAIN',
		section: 'Scent hounds',
	},
	{ id: 279, name: 'HARRIER', image: null, country: 'GREAT BRITAIN', section: 'Scent hounds' },
	{
		id: 280,
		name: 'COLLIE SMOOTH',
		image: 'http://www.fci.be/Nomenclature/Illustrations/296g01.jpg',
		country: 'GREAT BRITAIN',
		section: 'Sheepdogs',
	},
	{
		id: 281,
		name: 'BORDER COLLIE',
		image: 'http://www.fci.be/Nomenclature/Illustrations/297g01.jpg',
		country: 'GREAT BRITAIN',
		section: 'Sheepdogs',
	},
	{
		id: 282,
		name: 'ROMAGNA WATER DOG',
		image: 'http://www.fci.be/Nomenclature/Illustrations/298g08-01.jpg',
		country: 'ITALY',
		section: 'Water Dogs',
	},
	{ id: 283, name: 'GERMAN HOUND', image: null, country: 'GERMANY', section: 'Scent hounds' },
	{
		id: 284,
		name: 'BLACK AND TAN COONHOUND',
		image: 'http://www.fci.be/Nomenclature/Illustrations/300g06.jpg',
		country: 'UNITED STATES OF AMERICA',
		section: 'Scent hounds',
	},
	{ id: 285, name: 'AMERICAN WATER SPANIEL', image: null, country: 'UNITED STATES OF AMERICA', section: 'Water Dogs' },
	{
		id: 286,
		name: 'IRISH GLEN OF IMAAL TERRIER',
		image: null,
		country: 'IRELAND',
		section: 'Large and medium sized Terriers',
	},
	{ id: 287, name: 'AMERICAN FOXHOUND', image: null, country: 'UNITED STATES OF AMERICA', section: 'Scent hounds' },
	{ id: 288, name: 'RUSSIAN-EUROPEAN LAIKA', image: null, country: 'RUSSIA', section: 'Nordic Hunting Dogs' },
	{
		id: 289,
		name: 'EAST SIBERIAN LAIKA',
		image: 'http://www.fci.be/Nomenclature/Illustrations/305g05-1.jpg',
		country: 'RUSSIA',
		section: 'Nordic Hunting Dogs',
	},
	{ id: 290, name: 'WEST SIBERIAN LAIKA', image: null, country: 'RUSSIA', section: 'Nordic Hunting Dogs' },
	{ id: 291, name: 'AZAWAKH', image: null, country: 'MALI', section: 'Short-haired Sighthounds' },
	{ id: 292, name: 'DUTCH SMOUSHOND', image: null, country: 'THE NETHERLANDS', section: 'Pinscher and Schnauzer type' },
	{ id: 293, name: 'SHAR PEI', image: null, country: 'CHINA', section: 'Molossian type' },
	{
		id: 294,
		name: 'PERUVIAN HAIRLESS DOG',
		image: 'http://www.fci.be/Nomenclature/Illustrations/310g05.jpg',
		country: 'PERU',
		section: 'Primitive type',
	},
	{ id: 295, name: 'SAARLOOS WOLFHOND', image: null, country: 'THE NETHERLANDS', section: 'Sheepdogs' },
	{ id: 296, name: 'NOVA SCOTIA DUCK TOLLING RETRIEVER', image: null, country: 'CANADA', section: 'Retrievers' },
	{
		id: 297,
		name: 'DUTCH SCHAPENDOES',
		image: 'http://www.fci.be/Nomenclature/Illustrations/313g01.jpg',
		country: 'THE NETHERLANDS',
		section: 'Sheepdogs',
	},
	{
		id: 298,
		name: 'NEDERLANDSE KOOIKERHONDJE',
		image: 'http://www.fci.be/Nomenclature/Illustrations/314g08-1.jpg',
		country: 'THE NETHERLANDS',
		section: 'Flushing Dogs',
	},
	{
		id: 299,
		name: 'BROHOLMER',
		image: 'http://www.fci.be/Nomenclature/Illustrations/315g02.jpg',
		country: 'DENMARK',
		section: 'Molossian type',
	},
	{ id: 300, name: 'FRENCH WHITE AND ORANGE HOUND', image: null, country: 'FRANCE', section: 'Scent hounds' },
	{
		id: 301,
		name: 'KAI',
		image: 'http://www.fci.be/Nomenclature/Illustrations/317g05.jpg',
		country: 'JAPAN',
		section: 'Asian Spitz and related breeds',
	},
	{
		id: 302,
		name: 'KISHU',
		image: 'http://www.fci.be/Nomenclature/Illustrations/318g05.jpg',
		country: 'JAPAN',
		section: 'Asian Spitz and related breeds',
	},
	{
		id: 303,
		name: 'SHIKOKU',
		image: 'http://www.fci.be/Nomenclature/Illustrations/319g05.jpg',
		country: 'JAPAN',
		section: 'Asian Spitz and related breeds',
	},
	{
		id: 304,
		name: 'WIREHAIRED SLOVAKIAN POINTER',
		image: null,
		country: 'SLOVAKIA',
		section: 'Continental Pointing Dogs',
	},
	{ id: 305, name: 'MAJORCA SHEPHERD DOG', image: null, country: 'SPAIN', section: 'Sheepdogs' },
	{ id: 306, name: 'GREAT ANGLO-FRENCH TRICOLOUR HOUND', image: null, country: 'FRANCE', section: 'Scent hounds' },
	{
		id: 307,
		name: 'GREAT ANGLO-FRENCH WHITE AND BLACK HOUND',
		image: 'http://www.fci.be/Nomenclature/Illustrations/323g06.jpg',
		country: 'FRANCE',
		section: 'Scent hounds',
	},
	{ id: 308, name: 'GREAT ANGLO-FRENCH WHITE & ORANGE HOUND', image: null, country: 'FRANCE', section: 'Scent hounds' },
	{ id: 309, name: 'MEDIUM-SIZED ANGLO-FRENCH HOUND', image: null, country: 'FRANCE', section: 'Scent hounds' },
	{ id: 310, name: 'SOUTH RUSSIAN SHEPHERD DOG', image: null, country: 'RUSSIA', section: 'Sheepdogs' },
	{ id: 311, name: 'RUSSIAN BLACK TERRIER', image: null, country: 'RUSSIA', section: 'Pinscher and Schnauzer type' },
	{
		id: 312,
		name: 'CAUCASIAN SHEPHERD DOG',
		image: 'http://www.fci.be/Nomenclature/Illustrations/328g02.jpg',
		country: 'RUSSIA',
		section: 'Molossian type',
	},
	{
		id: 313,
		name: 'CANARIAN WARREN HOUND',
		image: 'http://www.fci.be/Nomenclature/Illustrations/329g05.jpg',
		country: 'SPAIN',
		section: 'Primitive type - Hunting Dogs',
	},
	{
		id: 314,
		name: 'IRISH RED AND WHITE SETTER',
		image: null,
		country: 'IRELAND',
		section: 'British and Irish Pointers and Setters',
	},
	{
		id: 315,
		name: 'ANATOLIAN SHEPHERD DOG',
		image: 'http://www.fci.be/Nomenclature/Illustrations/331g02.jpg',
		country: 'ANATOLIA',
		section: 'Molossian type',
	},
	{ id: 316, name: 'CZECHOSLOVAKIAN WOLFDOG', image: null, country: 'SLOVAKIA', section: 'Sheepdogs' },
	{ id: 317, name: 'POLISH GREYHOUND', image: null, country: 'POLAND', section: 'Short-haired Sighthounds' },
	{
		id: 318,
		name: 'KOREA JINDO DOG',
		image: 'http://www.fci.be/Nomenclature/Illustrations/334g05.jpg',
		country: 'REPUBLIC OF KOREA',
		section: 'Asian Spitz and related breeds',
	},
	{
		id: 319,
		name: 'CENTRAL ASIA SHEPHERD DOG',
		image: 'http://www.fci.be/Nomenclature/Illustrations/335g02-1.jpg',
		country: 'RUSSIA',
		section: 'Molossian type',
	},
	{ id: 320, name: 'SPANISH WATER DOG', image: null, country: 'SPAIN', section: 'Water Dogs' },
	{
		id: 321,
		name: 'ITALIAN SHORT-HAIRED SEGUGIO',
		image: 'http://www.fci.be/Nomenclature/Illustrations/337g06.jpg',
		country: 'ITALY',
		section: 'Scent hounds',
	},
	{ id: 322, name: 'THAI RIDGEBACK DOG', image: null, country: 'THAILAND', section: 'Primitive type - Hunting Dogs' },
	{
		id: 323,
		name: 'PARSON RUSSELL TERRIER',
		image: 'http://www.fci.be/Nomenclature/Illustrations/339g03.jpg',
		country: 'GREAT BRITAIN',
		section: 'Large and medium sized Terriers',
	},
	{ id: 324, name: 'SAINT MIGUEL CATTLE DOG', image: null, country: 'PORTUGAL', section: 'Molossian type' },
	{
		id: 325,
		name: 'BRAZILIAN TERRIER',
		image: 'http://www.fci.be/Nomenclature/Illustrations/341g03.jpg',
		country: 'BRAZIL',
		section: 'Large and medium sized Terriers',
	},
	{ id: 326, name: 'AUSTRALIAN SHEPHERD', image: null, country: 'UNITED STATES OF AMERICA', section: 'Sheepdogs' },
	{
		id: 327,
		name: 'ITALIAN CORSO DOG',
		image: 'http://www.fci.be/Nomenclature/Illustrations/343g02.jpg',
		country: 'ITALY',
		section: 'Molossian type',
	},
	{ id: 328, name: 'AMERICAN AKITA', image: null, country: 'JAPAN', section: 'Asian Spitz and related breeds' },
	{
		id: 329,
		name: 'JACK RUSSELL TERRIER',
		image: 'http://www.fci.be/Nomenclature/Illustrations/345g03-2.jpg',
		country: 'GREAT BRITAIN',
		section: 'Small sized Terriers',
	},
	{ id: 330, name: 'DOGO CANARIO', image: null, country: 'SPAIN', section: 'Molossian type' },
	{
		id: 331,
		name: 'WHITE SWISS SHEPHERD DOG',
		image: 'http://www.fci.be/Nomenclature/Illustrations/347g01-1.jpg',
		country: 'SWITZERLAND',
		section: 'Sheepdogs',
	},
	{ id: 332, name: 'TAIWAN DOG', image: null, country: 'TAIWAN', section: 'Primitive type - Hunting Dogs' },
	{ id: 333, name: 'ROMANIAN MIORITIC SHEPHERD DOG', image: null, country: 'ROMANIA', section: 'Sheepdogs' },
	{
		id: 334,
		name: 'ROMANIAN CARPATHIAN SHEPHERD DOG',
		image: 'http://www.fci.be/Nomenclature/Illustrations/350g01.jpg',
		country: 'ROMANIA',
		section: 'Sheepdogs',
	},
	{
		id: 335,
		name: 'AUSTRALIAN STUMPY TAIL CATTLE DOG',
		image: null,
		country: 'AUSTRALIA',
		section: 'Cattledogs (except Swiss Cattledogs)',
	},
	{
		id: 336,
		name: 'RUSSIAN TOY',
		image: 'http://www.fci.be/Nomenclature/Illustrations/352g09-1.jpg',
		country: 'RUSSIA',
		section: 'Continental Toy Spaniel and Russian Toy',
	},
	{ id: 337, name: 'CIMARR\u00d3N URUGUAYO', image: null, country: 'URUGUAY', section: 'Molossian type' },
	{ id: 338, name: 'POLISH HUNTING DOG', image: null, country: 'POLAND', section: 'Scent hounds' },
	{
		id: 339,
		name: 'BOSNIAN AND HERZEGOVINIAN - CROATIAN SHEPHERD DOG',
		image: ' CROATIA',
		country: 'BOSNIA AND HERZEGOVINA',
		section: 'Molossian type',
	},
	{
		id: 340,
		name: 'DANISH-SWEDISH FARMDOG',
		image: ' SWEDEN',
		country: 'DENMARK',
		section: 'Pinscher and Schnauzer type',
	},
	{
		id: 341,
		name: 'SOUTHEASTERN EUROPEAN SHEPHERD',
		image: 'http://www.fci.be/Nomenclature/Illustrations/357g02.jpg',
		country: 'SOUTH-EASTERN EUROPE',
		section: 'Molossian type',
	},
	{
		id: 342,
		name: 'THAI BANGKAEW DOG',
		image: 'http://www.fci.be/Nomenclature/Illustrations/358g05.jpg',
		country: 'THAILAND',
		section: 'Asian Spitz and related breeds',
	},
	{
		id: 343,
		name: 'MINIATURE BULL TERRIER',
		image: 'http://www.fci.be/Nomenclature/Illustrations/359g03.jpg',
		country: 'GREAT BRITAIN',
		section: 'Bull type Terriers',
	},
	{
		id: 344,
		name: 'LANCASHIRE HEELER',
		image: 'http://www.fci.be/Nomenclature/Illustrations/360g01.jpg',
		country: 'ENGLAND',
		section: 'Sheepdogs',
	},
	{ id: 345, name: 'LABRADOR RETRIEVER MIX', image: null, country: 'NA', section: 'Mutt' },
	{ id: 346, name: 'HUSKY MIX', image: null, country: 'NA', section: 'Mutt' },
	{ id: 347, name: 'LABRADOR / GREAT DANE MIX', image: null, country: 'NA', section: 'Mutt' },
	{ id: 348, name: 'TERRIER MIX', image: null, country: 'NA', section: 'Mutt' },
	{ id: 349, name: 'BEAGLE MIX', image: null, country: 'NA', section: 'Mutt' },
	{ id: 350, name: 'SHORT HAIRED SETTER MIX', image: null, country: 'NA', section: 'Mutt' },
];
const OWNER_RECORDS = [
	{ id: 1, name: 'Sam', best_friend: 'Charlie' },
	{ id: 2, name: 'Kyle', best_friend: 'Stephen' },
	{ id: 3, name: 'David', best_friend: 'Sam' },
	{ id: 4, name: 'Kaylan', best_friend: 'Stephen' },
];
const OWNER_ONLY_RECORDS = [
	{ id: 1, name: 'Sam' },
	{ id: 2, name: 'Kyle' },
	{ id: 3, name: 'David' },
	{ id: 4, name: 'Kaylan' },
];
const DATA_BULK_RECORDS = [
	{ all: 1, dog_name: 'Penny', owner_name: 'Kyle', breed_id: 154, age: 5, weight_lbs: 35, adorable: true },
	{ all: 2, dog_name: 'Harper', owner_name: 'Stephen', breed_id: 346, age: 5, weight_lbs: 55, adorable: true },
	{ all: 3, dog_name: 'Alby', owner_name: 'Kaylan', breed_id: 348, age: 5, weight_lbs: 84, adorable: true },
	{ all: 4, dog_name: 'Billy', owner_name: 'Zach', breed_id: 347, age: 4, weight_lbs: 60, adorable: true },
	{ all: 5, dog_name: 'Rose Merry', owner_name: 'Zach', breed_id: 348, age: 6, weight_lbs: 15, adorable: true },
	{ all: 6, dog_name: 'Kato', owner_name: 'Kyle', breed_id: 351, age: 4, weight_lbs: 28, adorable: true },
	{ all: 7, dog_name: 'Simon', owner_name: 'Fred', breed_id: 349, age: 1, weight_lbs: 35, adorable: true },
	{ all: 8, dog_name: 'Gemma', owner_name: 'Stephen', breed_id: 350, age: 3, weight_lbs: 55, adorable: true },
	{ all: 9, dog_name: 'Gertrude', owner_name: 'Eli', breed_id: 158, age: 5, weight_lbs: 70, adorable: true },
	{ all: 10, dog_name: 'Big Louie', owner_name: 'Eli', breed_id: 241, age: 11, weight_lbs: 20, adorable: true },
];

const skipSuite = process.platform === 'win32';

suite('Northwind operations', { skip: skipSuite }, (ctx) => {
	let client;
	let adminPwd, adminUsername;
	let jobId; // shared job_id state used by 7_jobsAndJobRoleTesting tests
	// Per-user headers — built in before() from the Harper admin password.
	let headersTestUser, headersBulkLoadUser, headersNoPermsUser, headersOnePermUser, headersImportantUser;
	let dateYesterday, dateTomorrow;

	before(async () => {
		await startHarper(ctx, { config: {}, env: {} });
		client = createApiClient(ctx.harper);
		adminPwd = ctx.harper.admin.password;
		adminUsername = ctx.harper.admin.username;

		// Per-user headers — users are created inside tests with the admin password.
		headersTestUser = createHeaders('test_user', adminPwd);
		headersBulkLoadUser = createHeaders('bulk_load_user', adminPwd);
		headersNoPermsUser = createHeaders('no_perms_user', adminPwd);
		headersOnePermUser = createHeaders('one_perm_user', adminPwd);
		headersImportantUser = createHeaders('important-user', 'password');

		dateYesterday = new Date(Date.now() - 86400000).toISOString();
		dateTomorrow = new Date(Date.now() + 86400000).toISOString();

		// ── Schemas ──────────────────────────────────────────────────────────
		for (const schema of ['northnwd', 'dev', 'call', 'other', 'another']) {
			await client.req().send({ operation: 'create_schema', schema }).expect(200);
		}

		// ── Northwind tables (created empty; 2_dataLoad sub-suite loads the CSVs) ─
		// CSV loads are NOT done here to avoid duplicate-PK conflicts when the
		// 2_dataLoad tests run their csvFileUpload assertions against the same files.
		// Sequential sub-suite execution guarantees the data is present for 3–10.
		for (const [table, pk] of [
			['customers', 'customerid'],
			['suppliers', 'supplierid'],
			['region', 'regionid'],
			['employees', 'employeeid'],
			['territories', 'territoryid'],
			['employeeterritories', 'employeeid'],
			['shippers', 'shipperid'],
			['categories', 'categoryid'],
			['products', 'productid'],
			['order_details', 'orderdetailid'],
			['orders', 'orderid'],
		]) {
			await client.req().send({ operation: 'create_table', schema: 'northnwd', table, primary_key: pk }).expect(200);
		}

		// ── dev tables (created empty; JSON data + CSVs inserted by 2_dataLoad) ─
		const devTables = [
			['long_text', 'id'],
			['AttributeDropTest', 'hashid'],
			['invalid_attribute', 'id'],
			['remarks_blob', 'id'],
			['time_functions', 'id'],
			['dog', 'id'],
			['breed', 'id'],
			['owner', 'id'],
			['sql_function', 'id'],
			['leading_zero', 'id'],
			['dog_conditions', 'id'],
			['rando', 'id'],
			['books', 'id'],
			['ratings', 'id'],
			['movie', 'id'],
			['credits', 'movie_id'],
		];
		for (const [table, pk] of devTables) {
			await client.req().send({ operation: 'create_table', schema: 'dev', table, primary_key: pk }).expect(200);
		}

		// ── Numeric-string schemas (used by NoSQL tests) ────────────────────────
		await client.req().send({ operation: 'create_schema', schema: '123' }).expect(200);
		await client.req().send({ operation: 'create_table', schema: '123', table: '4', primary_key: 'id' }).expect(200);

		// ── call / other / another (created empty; data inserted by 2_dataLoad) ─
		await client
			.req()
			.send({ operation: 'create_table', schema: 'call', table: 'aggr', primary_key: 'all' })
			.expect(200);
		await client
			.req()
			.send({ operation: 'create_table', schema: 'other', table: 'owner', primary_key: 'id' })
			.expect(200);
		await client
			.req()
			.send({ operation: 'create_table', schema: 'another', table: 'breed', primary_key: 'id' })
			.expect(200);
	});

	after(async () => {
		await teardownHarper(ctx);
	});

	// ── Legacy utility shims — defined at suite scope so they close over client ──

	async function createTable(schema, table, pk) {
		return client.req().send({ operation: 'create_table', schema, table, primary_key: pk }).expect(200);
	}

	async function csvFileUpload(schema, table, filePath, _expectedError, _expectedMessage) {
		const r = await client
			.req()
			.send({
				operation: 'csv_file_load',
				action: 'insert',
				schema,
				table,
				file_path: filePath,
			})
			.expect(200);
		return awaitJobCompleted(client, getJobId(r.body), {
			expectedError: _expectedError || undefined,
			expectedMessage: _expectedMessage || undefined,
			timeoutSeconds: 30,
		});
	}

	async function csvDataLoad(customHeaders, action, schema, table, data, _expectedError, _expectedMessage) {
		const r = await client
			.reqAs(customHeaders)
			.send({
				operation: 'csv_data_load',
				action,
				schema,
				table,
				data,
			})
			.expect(200);
		// Use awaitJob + manual assertions so we can return job.message as a raw
		// object — awaitJobCompleted would stringify it, breaking callers that
		// access errorMsg.unauthorized_access / errorMsg.invalid_schema_items.
		// Bun under CI-runner contention can leave a small csv_data_load job
		// IN_PROGRESS well past a minute, so the wait is bounded but generous
		// (#1222).
		const jobResp = await awaitJob(client, getJobId(r.body), isBunRuntime ? 300 : 30);
		const job = jobResp.body[0];
		assert.ok(job, `No job found in response: ${jobResp.text}`);
		if (_expectedError) {
			assert.notEqual(job.status, 'COMPLETE', jobResp.text);
			const msgStr = typeof job.message === 'string' ? job.message : JSON.stringify(job.message);
			assert.ok(msgStr.includes(_expectedError), jobResp.text);
		} else {
			assert.equal(job.status, 'COMPLETE', jobResp.text);
			if (_expectedMessage) assert.ok(job.message.includes(_expectedMessage), jobResp.text);
		}
		return job.message;
	}

	async function csvUrlLoad(schema, table, url, _expectedError, _expectedMessage) {
		const r = await client
			.req()
			.send({
				operation: 'csv_url_load',
				action: 'insert',
				schema,
				table,
				csv_url: url,
			})
			.expect(200);
		return awaitJobCompleted(client, getJobId(r.body), {
			expectedError: _expectedError || undefined,
			expectedMessage: _expectedMessage || undefined,
			timeoutSeconds: 30,
		});
	}

	async function insert(schema, table, records, expectedMessage) {
		const r = await client.req().send({ operation: 'insert', schema, table, records }).expect(200);
		if (expectedMessage) assert.ok(r.body.message.includes(expectedMessage), r.text);
		return r;
	}

	async function searchByHash(schema, table, pk, hashValues, getAttrs, expectedContent) {
		const r = await client
			.req()
			.send({
				operation: 'search_by_hash',
				schema,
				table,
				primary_key: pk,
				hash_values: hashValues,
				get_attributes: getAttrs,
			})
			.expect(200);
		if (expectedContent) assert.ok(JSON.stringify(r.body).includes(expectedContent), r.text);
		return r;
	}

	// checkJob shim — mirrors legacy utils/jobs.mjs checkJob.
	async function checkJob(_jobId, timeoutSeconds) {
		return awaitJob(client, _jobId, timeoutSeconds);
	}

	// checkJobCompleted shim — handles both success and expected-error outcomes.
	// Returns the raw job message (may be string or object) for caller assertions.
	async function checkJobCompleted(jobId, expectedErrorMsg, expectedCompleteMsg) {
		const jobResp = await awaitJob(client, jobId, 60);
		const job = jobResp.body[0];
		assert.ok(job, `No job found in response: ${jobResp.text}`);
		if (expectedErrorMsg) {
			assert.notEqual(job.status, 'COMPLETE', jobResp.text);
			const msgStr = typeof job.message === 'string' ? job.message : JSON.stringify(job.message);
			assert.ok(msgStr.includes(expectedErrorMsg), jobResp.text);
		} else {
			assert.equal(job.status, 'COMPLETE', jobResp.text);
			if (expectedCompleteMsg) {
				assert.ok(job.message.includes(expectedCompleteMsg), jobResp.text);
			}
		}
		return job.message;
	}

	// Normalize floating-point values in a response body to 10 decimal places so
	// that sub-ULP precision differences across JS runtimes (Node.js vs Bun) do
	// not cause deepEqual failures in geo tests.
	function roundFloats(val) {
		if (typeof val === 'number') return Math.round(val * 1e10) / 1e10;
		if (Array.isArray(val)) return val.map(roundFloats);
		if (val !== null && typeof val === 'object')
			return Object.fromEntries(Object.entries(val).map(([k, v]) => [k, roundFloats(v)]));
		return val;
	}

	// Harper runs the test process in Node.js but sets HARPER_RUNTIME=bun when the
	// server itself uses Bun. process.versions.bun is therefore undefined; use the
	// env var to detect the Bun runtime.
	const isBunRuntime = process.env.HARPER_RUNTIME === 'bun';

	// Some HarperDB wildcard-string-search operations fail on Bun with
	// "finishUtf8 is not defined" — a V8-internal API Bun does not expose.
	// Skip those tests on Bun rather than failing CI.
	const bunSkip = isBunRuntime ? 'finishUtf8 is not available in Bun' : false;

	suite('2. Data Load', () => {
		//CSV Folder

		test('1 Upload Suppliers.csv', async () => {
			await csvFileUpload('northnwd', 'suppliers', csvPath + 'Suppliers.csv');
		});

		test('2 Upload Region.csv', async () => {
			await csvFileUpload('northnwd', 'region', csvPath + 'Region.csv');
		});

		test('3 Upload Territories.csv', async () => {
			await csvFileUpload('northnwd', 'territories', csvPath + 'Territories.csv');
		});

		test('4 Upload EmployeeTerritories.csv', async () => {
			await csvFileUpload('northnwd', 'employeeterritories', csvPath + 'EmployeeTerritories.csv');
		});

		test('5 Upload Shippers.csv', async () => {
			await csvFileUpload('northnwd', 'shippers', csvPath + 'Shippers.csv');
		});

		test('6 Upload Categories.csv', async () => {
			await csvFileUpload('northnwd', 'categories', csvPath + 'Categories.csv');
		});

		test('7 Upload Employees.csv', async () => {
			await csvFileUpload('northnwd', 'employees', csvPath + 'Employees.csv');
		});

		test('8 Upload Customers.csv', async () => {
			await csvFileUpload('northnwd', 'customers', csvPath + 'Customers.csv');
		});

		test('9 Upload Products.csv', async () => {
			await csvFileUpload('northnwd', 'products', csvPath + 'Products.csv');
		});

		test('10 Upload Orderdetails.csv', async () => {
			await csvFileUpload('northnwd', 'order_details', csvPath + 'Orderdetails.csv');
		});

		test('11 Upload Orders.csv', async () => {
			await csvFileUpload('northnwd', 'orders', csvPath + 'Orders.csv');
		});

		test('12 Upload Books.csv', async () => {
			await csvFileUpload('dev', 'books', csvPath + 'Books.csv');
		});

		test('13 Upload BooksRatings.csv', async () => {
			await csvFileUpload('dev', 'ratings', csvPath + 'BooksRatings.csv');
		});

		test('14 Upload movies.csv', async () => {
			await csvFileUpload('dev', 'movie', csvPath + 'movies.csv');
		});

		test('15 Upload credits.csv', async () => {
			await csvFileUpload('dev', 'credits', csvPath + 'credits.csv');
		});

		//CSV URL Load Folder

		test('Create CSV data table', async () => {
			await createTable('northnwd', 'url_csv_data', 'id');
		});

		test.skip('CSV url load', async () => {
			await csvUrlLoad(
				'northnwd',
				'url_csv_data',
				'', // TODO: Figure out how to safely include a public S3 URL
				'',
				'successfully loaded 350 of 350 records'
			);
		});

		test.skip('Confirm all CSV records loaded', async () => {
			await client
				.req()
				.send({
					operation: 'sql',
					sql: `select count(*)
		                      from northnwd.url_csv_data`,
				})
				.expect((r) => {
					assert.equal(r.body[0]['COUNT(*)'], 350, `url_csv_data count was not 350`);
				})
				.expect(200);
		});

		test('Create CSV data table empty', async () => {
			await createTable('northnwd', 'url_csv_no_data', 'id');
		});

		test.skip('CSV url load empty file', async () => {
			await csvUrlLoad(
				'northnwd',
				'url_csv_no_data',
				'' // TODO: Figure out how to safely include a public S3 URL
			);
		});

		test('Confirm 0 CSV records loaded', async () => {
			await client
				.req()
				.send({
					operation: 'sql',
					sql: `select count(*)
		                      from northnwd.url_csv_no_data`,
				})
				.expect((r) => {
					assert.equal(r.body[0]['COUNT(*)'], 0, `url_csv_no_data count was not 0`);
				})
				.expect(200);
		});

		test.skip('CSV file load bad attribute', async () => {
			await csvUrlLoad(
				'northnwd',
				'url_csv_no_data',
				'', // TODO: Figure out how to safely include a public S3 URL
				`Invalid column name 'id/', cancelling load operation`
			);
		});

		//JSON Folder

		test('Import data bulk insert into dev.long_text table', async () => {
			await insert('dev', 'long_text', LONG_TEXT_RECORDS, 'inserted 25');
		});

		test('Import data bulk confirm specific value exists', async () => {
			await searchByHash('dev', 'long_text', 'id', [10], ['id', 'remarks'], '"id":10,"remarks":"Lovely updated home');
		});

		test('Import data bulk insert into call.aggr', async () => {
			await insert('call', 'aggr', DATA_BULK_RECORDS, 'inserted 10');
		});

		test('Insert dot & double dot data', async () => {
			await insert(
				'call',
				'aggr',
				[
					{
						all: 11,
						dog_name: '.',
						owner_name: '..',
					},
				],
				'inserted 1'
			);
		});

		test('Insert confirm dot & double data', async () => {
			await searchByHash(
				'call',
				'aggr',
				'all',
				[11],
				['all', 'dog_name', 'owner_name'],
				'"all":11,"dog_name":".","owner_name":".."'
			);
		});

		test('Insert attributes into DropAttributeTest', async () => {
			await insert(
				'dev',
				'AttributeDropTest',
				[
					{
						hashid: 1,
						some_attribute: 'some_att1',
						another_attribute: '1',
					},
					{
						hashid: 2,
						some_attribute: 'some_att2',
						another_attribute: '1',
					},
				],
				'inserted 2'
			);
		});

		test('Insert confirm attributes added', async () => {
			await searchByHash(
				'dev',
				'AttributeDropTest',
				'hashid',
				[1, 2],
				['hashid', 'some_attribute', 'another_attribute'],
				'{"hashid":1,"some_attribute":"some_att1","another_attribute":"1"},' +
					'{"hashid":2,"some_attribute":"some_att2","another_attribute":"1"}'
			);
		});

		test('Import data bulk insert into dev.remarks_blob table', async () => {
			await insert('dev', 'remarks_blob', REMARKS_RECORDS, 'inserted 11');
		});

		test('Insert data into dev.dog', async () => {
			await insert('dev', 'dog', DOG_RECORDS, 'inserted 9');
		});

		test('Insert data into dev.breed', async () => {
			await insert('dev', 'breed', BREED_RECORDS, 'inserted 350');
		});

		test('Insert data into dev.owner', async () => {
			await insert('dev', 'owner', OWNER_RECORDS, 'inserted 4');
		});

		test('Insert data into other.owner', async () => {
			await insert('other', 'owner', OWNER_ONLY_RECORDS, 'inserted 4');
		});

		test('Insert data into another.breed', async () => {
			await insert('another', 'breed', BREED_RECORDS, 'inserted 350');
		});

		//CSV Bulk Load Tests Folder

		test('csv_data_load with invalid attribute', async () => {
			await csvDataLoad(
				client.headers,
				'insert',
				'dev',
				'invalid_attribute',
				'id,s/ome=attribute\n1,cheeseburger\n2,hamburger with cheese\n3,veggie burger\n',
				"Invalid column name 's/ome=attribute'"
			);
		});

		test('csv_file_load with invalid attributes', async () => {
			await csvFileUpload('dev', 'invalid_attribute', csvPath + 'InvalidAttributes.csv', 'Invalid column name');
		});

		test('search for specific value from CSV load', async () => {
			await client
				.req()
				.send({
					operation: 'search_by_hash',
					schema: `northnwd`,
					table: `suppliers`,
					primary_key: `supplierid`,
					hash_values: [10],
					get_attributes: ['supplierid', 'companyname', 'contactname'],
				})
				.expect((r) => {
					assert.equal(r.body[0].companyname, 'Refrescos Americanas LTDA', r.text);
					assert.equal(r.body[0].supplierid, 10, r.text);
					assert.equal(r.body[0].contactname, 'Carlos Diaz', r.text);
				})
				.expect(200);
		});

		test('search for random value from CSV load', async () => {
			await client
				.req()
				.send({
					operation: 'sql',
					sql: `SELECT *
		                              FROM northnwd.suppliers`,
				})
				.expect((r) => {
					let randomNumber = Math.floor(Math.random() * 29);
					assert.notEqual(r.body[randomNumber], null, r.text);
					assert.equal(r.body.length, 29, r.text);
					let keys = Object.keys(r.body[randomNumber]);
					if (keys.indexOf('__updatedtime__') > -1 && keys.indexOf('__createdtime__') > -1) {
						assert.equal(keys.length, 14, r.text);
					} else {
						assert.equal(keys.length, 12, r.text);
					}
				})
				.expect(200);
		});

		test('check error on invalid file', async () => {
			await client
				.req()
				.send({
					operation: 'csv_file_load',
					action: 'insert',
					schema: `northnwd`,
					table: `suppliers`,
					file_path: `${csvPath}Suppliers_wrong.csv`,
				})
				.expect((r) => assert.ok(r.body.error.includes('No such file or directory'), r.text))
				.expect(400);
		});

		test('csv bulk load update', async () => {
			const response = await client
				.req()
				.send({
					operation: 'csv_data_load',
					action: 'update',
					schema: `northnwd`,
					table: `suppliers`,
					data: 'supplierid,companyname\n19,The Chum Bucket\n',
				})
				.expect((r) =>
					assert.equal(r.body.message.indexOf('Starting job'), 0, 'Expected to find "Starting job" in the response')
				);

			const id = getJobId(response.body);
			await checkJobCompleted(id);
		});

		test('csv bulk load update confirm', async () => {
			await client
				.req()
				.send({
					operation: 'search_by_hash',
					schema: `northnwd`,
					table: `suppliers`,
					primary_key: `supplierid`,
					hash_values: [19],
					get_attributes: ['supplierid', 'companyname', 'contactname'],
				})
				.expect((r) => {
					assert.equal(r.body[0].supplierid, 19, r.text);
					assert.equal(r.body[0].contactname, 'Robb Merchant', r.text);
					assert.equal(r.body[0].companyname, 'The Chum Bucket', r.text);
				})
				.expect(200);
		});

		//Data Load Main Folder

		test('Insert object into table', async () => {
			await client
				.req()
				.send({
					operation: 'insert',
					schema: `northnwd`,
					table: `customers`,
					records: [{ postalcode: { house: 30, street: 'South St' }, customerid: 'TEST1' }],
				})
				.expect((r) => assert.equal(r.body.message, 'inserted 1 of 1 records', r.text))
				.expect((r) => assert.equal(r.body.inserted_hashes[0], 'TEST1', r.text))
				.expect(200);
		});

		test('Insert object confirm ', async () => {
			await client
				.req()
				.send({
					operation: 'search_by_hash',
					schema: `northnwd`,
					table: `customers`,
					primary_key: `supplierid`,
					hash_values: ['TEST1'],
					get_attributes: ['postalcode', 'customerid'],
				})
				.expect((r) => assert.deepEqual(r.body[0].postalcode, { house: 30, street: 'South St' }, r.text))
				.expect((r) => assert.equal(r.body[0].customerid, 'TEST1', r.text))
				.expect(200);
		});

		test('Insert array into table', async () => {
			await client
				.req()
				.send({
					operation: 'insert',
					schema: `northnwd`,
					table: `customers`,
					records: [{ postalcode: [1, 2, 3], customerid: 'TEST2' }],
				})
				.expect((r) => assert.equal(r.body.message, 'inserted 1 of 1 records', r.text))
				.expect((r) => assert.equal(r.body.inserted_hashes[0], 'TEST2', r.text))
				.expect(200);
		});

		test('Insert array confirm ', async () => {
			await client
				.req()
				.send({
					operation: 'search_by_hash',
					schema: `northnwd`,
					table: `customers`,
					primary_key: `supplierid`,
					hash_values: ['TEST2'],
					get_attributes: ['postalcode', 'customerid'],
				})
				.expect((r) => assert.deepEqual(r.body[0].postalcode, [1, 2, 3], r.text))
				.expect((r) => assert.equal(r.body[0].customerid, 'TEST2', r.text))
				.expect(200);
		});

		test('Insert value into schema that doesnt exist', async () => {
			await client
				.req()
				.send({
					operation: 'insert',
					schema: 'not_a_schema',
					table: `customers`,
					records: [{ name: 'Harper', customerid: 1 }],
				})
				.expect((r) => assert.equal(r.body.error, "database 'not_a_schema' does not exist", r.text))
				.expect(400);
		});

		test('Insert value into table that doesnt exist', async () => {
			await client
				.req()
				.send({
					operation: 'insert',
					schema: `northnwd`,
					table: 'not_a_table',
					records: [{ name: 'Harper', customerid: 1 }],
				})
				.expect((r) => assert.equal(r.body.error, "Table 'northnwd.not_a_table' does not exist", r.text))
				.expect(400);
		});

		test("Update value in schema that doesn't exist", async () => {
			await client
				.req()
				.send({
					operation: 'update',
					schema: 'not_a_schema',
					table: `customers`,
					records: [{ name: 'Harper', customerid: 1 }],
				})
				.expect((r) => assert.equal(r.body.error, "database 'not_a_schema' does not exist", r.text))
				.expect(400);
		});

		test("Update value in table that doesn't exist", async () => {
			await client
				.req()
				.send({
					operation: 'update',
					schema: `northnwd`,
					table: 'not_a_table',
					records: [{ name: 'Harper', customerid: 1 }],
				})
				.expect((r) => assert.equal(r.body.error, "Table 'northnwd.not_a_table' does not exist", r.text))
				.expect(400);
		});

		test('Set attribute to number', async () => {
			await client
				.req()
				.send({
					operation: 'insert',
					schema: `northnwd`,
					table: `employees`,
					records: [{ 4289: 'Mutt', firstname: 'Test for number attribute', employeeid: 25 }],
				})
				.expect((r) => assert.equal(r.body.message, 'inserted 1 of 1 records', r.text))
				.expect((r) => assert.equal(r.body.inserted_hashes[0], 25, r.text))
				.expect(200);
		});

		test('Set attribute to number confirm', async () => {
			await client
				.req()
				.send({ operation: 'describe_table', table: `employees`, schema: `northnwd` })
				.expect((r) => {
					let found = false;
					r.body.attributes.forEach((obj) => {
						if (Object.values(obj)[0] === '4289') found = true;
					});
					assert.ok(found, r.text);
				})
				.expect(200);
		});

		test('Set attribute name greater than 250 bytes', async () => {
			await client
				.req()
				.send({
					operation: 'insert',
					schema: `northnwd`,
					table: `employees`,
					records: [
						{
							4289: 'Mutt',
							firstname: 'Test for number attribute',
							employeeid: 31,
							IIetmyLabradorcomeoutsidewithmewhenIwastakingthebinsoutonemorningIlethimgoforawanderthinkinghewasjustgoingtopeeonthetelegraphpoleattheendofourdrivewaylikehealwaysdoesInsteadhesawhisopportunityandseizeditHekeptwalkingpastthetelegraphpolepasttheborderofour:
								'a story about a dog',
						},
					],
				})
				.expect((r) => {
					let longAttribute =
						'transaction aborted due to attribute name IIetmyLabradorcomeoutsidewithmewhenIwastakingthebinsoutonemorningIlethimgoforawanderthinkinghewasjustgoingtopeeonthetelegraphpoleattheendofourdrivewaylikehealwaysdoesInsteadhesawhisopportunityandseizeditHekeptwalkingpastthetelegraphpolepasttheborderofour being too long. Attribute names cannot be longer than 250 bytes.';
					assert.equal(r.body.error, longAttribute, r.text);
				})
				.expect(400);
		});

		test('insert valid records into dev.invalid_attributes', async () => {
			await client
				.req()
				.send({
					operation: 'insert',
					schema: 'dev',
					table: 'invalid_attribute',
					records: [
						{ id: 100, some_attribute: 'some_att1', another_attribute: 'another_1' },
						{
							id: 101,
							some_attribute: 'some_att2',
							another_attribute: 'another_2',
						},
					],
				})
				.expect((r) => assert.ok(r.body.message.includes('inserted 2'), r.text))
				.expect(200);
		});

		test('insert records into dev.leading_zero', async () => {
			await client
				.req()
				.send({
					operation: 'insert',
					schema: 'dev',
					table: 'leading_zero',
					records: [
						{ id: 0, some_attribute: 'some_att1', another_attribute: 'another_1' },
						{ id: '011', some_attribute: 'some_att2', another_attribute: 'another_2' },
						{ id: '00011', some_attribute: 'some_att3', another_attribute: 'another_3' },
					],
				})
				.expect((r) => assert.ok(r.body.message.includes('inserted 3'), r.text))
				.expect((r) => assert.deepEqual(r.body.inserted_hashes, [0, '011', '00011'], r.text))
				.expect(200);
		});

		test('insert test records into dev.rando', async () => {
			await client
				.req()
				.send({
					operation: 'insert',
					schema: 'dev',
					table: 'rando',
					records: [
						{ id: 987654321, name: 'Cool Dawg' },
						{
							id: 987654322,
							name: 'The Coolest Dawg',
						},
						{ id: 987654323, name: 'Sup Dawg' },
						{ id: 987654324, name: 'Snoop Dawg' },
					],
				})
				.expect((r) => assert.ok(r.body.message.includes('inserted 4'), r.text))
				.expect(200);
		});

		test('test SQL updating with numeric hash in single quotes', async () => {
			await client
				.req()
				.send({
					operation: 'sql',
					sql: "UPDATE dev.rando set active = true WHERE id IN ('987654321', '987654322')",
				})
				.expect((r) => assert.ok(r.body.message.includes('updated 2'), r.text))
				.expect((r) =>
					assert.ok(r.body.update_hashes.includes(987654321) && r.body.update_hashes.includes(987654322), r.text)
				)
				.expect(200);
		});

		test('Upsert dog data for conditions search tests', async () => {
			await client
				.req()
				.send({
					operation: 'upsert',
					schema: 'dev',
					table: 'dog_conditions',
					records: [
						{
							id: 1,
							breed_id: 154,
							weight_lbs: 35,
							dog_name: 'Penny',
							age: 5,
							adorable: true,
							owner_id: 2,
							group: 'A',
							location: 'Denver, NC',
						},
						{
							id: 2,
							breed_id: 346,
							weight_lbs: 55,
							dog_name: 'Harper',
							age: 5,
							adorable: true,
							owner_id: 3,
							group: 'A',
							location: 'Denver, CO',
						},
						{
							id: 3,
							breed_id: 348,
							weight_lbs: 84,
							dog_name: 'Alby',
							age: 8,
							adorable: true,
							owner_id: 4,
							group: 'A',
							location: 'Portland, OR',
						},
						{
							id: 4,
							breed_id: 347,
							weight_lbs: 60,
							dog_name: 'Billy',
							age: 4,
							adorable: true,
							owner_id: 1,
							group: 'B',
							location: 'Evergreen, CO',
						},
						{
							id: 5,
							breed_id: 348,
							weight_lbs: 15,
							dog_name: 'Rose Merry',
							age: 6,
							adorable: true,
							owner_id: 2,
							group: 'B',
							location: 'Denver, CO',
						},
						{
							id: 6,
							breed_id: 351,
							weight_lbs: 28,
							dog_name: 'Kato',
							age: 4,
							adorable: true,
							owner_id: 3,
							group: 'A',
							location: 'Charlotte, NC',
						},
						{
							id: 7,
							breed_id: 349,
							weight_lbs: 35,
							dog_name: 'Simon',
							age: 1,
							adorable: true,
							owner_id: 4,
							group: 'C',
							location: 'Denver, CO',
						},
						{
							id: 8,
							breed_id: 250,
							weight_lbs: 55,
							dog_name: 'Gemma',
							age: 3,
							adorable: true,
							owner_id: 1,
							group: 'A',
							location: 'Denver, NC',
						},
						{
							id: 9,
							breed_id: 104,
							weight_lbs: 75,
							dog_name: 'Bode',
							age: 9,
							adorable: true,
							owner_id: null,
							group: 'C',
							location: 'Boulder, CO',
						},
						{
							id: 10,
							breed_id: null,
							weight_lbs: null,
							dog_name: null,
							age: 7,
							adorable: null,
							owner_id: null,
							group: 'D',
							location: 'Boulder, CO',
						},
						{
							id: 11,
							breed_id: null,
							weight_lbs: null,
							dog_name: null,
							age: null,
							adorable: null,
							owner_id: null,
							group: 'C',
							location: 'Denver, CO',
						},
					],
				})
				.expect((r) => {
					assert.equal(r.body.upserted_hashes.length, 11, r.text);
					assert.ok(!r.body.skipped_hashes, r.text);
					assert.equal(r.body.message, 'upserted 11 of 11 records', r.text);
				})
				.expect(200);
		});

		test('Insert test records into 123.4', async () => {
			await client
				.req()
				.send({
					operation: 'insert',
					schema: '123',
					table: '4',
					records: [
						{ id: 987654321, name: 'Cool Dawg' },
						{
							id: 987654322,
							name: 'The Coolest Dawg',
						},
						{ id: 987654323, name: 'Sup Dawg' },
						{ id: 987654324, name: 'Snoop Dawg' },
					],
				})
				.expect((r) => assert.ok(r.body.message.includes('inserted 4'), r.text))
				.expect(200);
		});

		test('Insert records into 123.4 number schema table', async () => {
			await client
				.req()
				.send({ operation: 'insert', schema: 123, table: 4, records: [{ name: 'Hot Dawg' }] })
				.expect((r) => assert.ok(r.body.message.includes('inserted 1'), r.text))
				.expect(200);
		});

		test('Update test records in 123.4', async () => {
			await client
				.req()
				.send({
					operation: 'update',
					schema: '123',
					table: '4',
					records: [{ id: 987654321, name: 'Hot Dawg' }],
				})
				.expect((r) => assert.ok(r.body.message.includes('updated 1'), r.text))
				.expect(200);
		});

		test('Update records in 123.4 number schema table', async () => {
			await client
				.req()
				.send({
					operation: 'update',
					schema: 123,
					table: 4,
					records: [{ id: 987654321, name: 'Hot Diddy Dawg' }],
				})
				.expect((r) => assert.ok(r.body.message.includes('updated 1'), r.text))
				.expect(200);
		});

		test('Insert records missing table', async () => {
			await client
				.req()
				.send({
					operation: 'insert',
					schema: '123',
					records: [
						{ id: 987654321, name: 'Cool Dawg' },
						{
							id: 987654322,
							name: 'The Coolest Dawg',
						},
						{ id: 987654323, name: 'Sup Dawg' },
						{ id: 987654324, name: 'Snoop Dawg' },
					],
				})
				.expect((r) => assert.equal(r.body.error, "'table' is required", r.text))
				.expect(400);
		});

		test('Insert records missing records', async () => {
			await client
				.req()
				.send({ operation: 'insert', schema: '123', table: '4' })
				.expect((r) => assert.equal(r.body.error, "'records' is required", r.text))
				.expect(400);
		});

		test('Upsert records missing table', async () => {
			await client
				.req()
				.send({
					operation: 'upsert',
					schema: '123',
					records: [
						{ id: 987654321, name: 'Cool Dawg' },
						{
							id: 987654322,
							name: 'The Coolest Dawg',
						},
						{ id: 987654323, name: 'Sup Dawg' },
						{ id: 987654324, name: 'Snoop Dawg' },
					],
				})
				.expect((r) => assert.equal(r.body.error, "'table' is required", r.text))
				.expect(400);
		});

		test('Upsert records missing records', async () => {
			await client
				.req()
				.send({ operation: 'upsert', schema: '123', table: '4' })
				.expect((r) => assert.equal(r.body.error, "'records' is required", r.text))
				.expect(400);
		});

		test('Update records missing table', async () => {
			await client
				.req()
				.send({
					operation: 'update',
					schema: '123',
					records: [
						{ id: 987654321, name: 'Cool Dawg' },
						{
							id: 987654322,
							name: 'The Coolest Dawg',
						},
						{ id: 987654323, name: 'Sup Dawg' },
						{ id: 987654324, name: 'Snoop Dawg' },
					],
				})
				.expect((r) => assert.equal(r.body.error, "'table' is required", r.text))
				.expect(400);
		});

		test('Update records missing records', async () => {
			await client
				.req()
				.send({ operation: 'upsert', schema: '123', table: '4' })
				.expect((r) => assert.equal(r.body.error, "'records' is required", r.text))
				.expect(400);
		});
	});

	suite('3. SQL Tests', () => {
		//SQL Tests Folder

		//Invalid Attribute Check

		test('insert invalid attribute name - single row', async () => {
			await client
				.req()
				.send({
					operation: 'sql',
					sql: "INSERT INTO dev.invalid_attribute (id, `some/attribute`) VALUES ('1', 'some_attribute')",
				})
				.expect((r) =>
					assert.equal(r.body.error, 'Attribute names cannot include backticks or forward slashes', r.text)
				)
				.expect(400);
		});

		test('update single row w/ invalid attribute name', async () => {
			await client
				.req()
				.send({
					operation: 'sql',
					sql: "UPDATE dev.invalid_attribute SET `some/attribute` = 'some attribute' WHERE id = 100",
				})
				.expect((r) =>
					assert.equal(r.body.error, 'Attribute names cannot include backticks or forward slashes', r.text)
				)
				.expect(400);
		});

		test('insert all invalid attribute names - multiple rows', async () => {
			await client
				.req()
				.send({
					operation: 'sql',
					sql: "INSERT INTO dev.invalid_attribute (id, `some/attribute1`, `some_/attribute2`, `some_attribute/3`) VALUES ('1', 'some_attribute', 'another_attribute', 'some_other_attribute'), ('2', 'some_attribute', 'another_attribute', 'some_other_attribute'), ('3', 'some_attribute', 'another_attribute', 'some_other_attribute'), ('4', 'some_attribute', 'another_attribute', 'some_other_attribute'), ('5', 'some_attribute', 'another_attribute', 'some_other_attribute'), ('6', 'some_attribute', 'another_attribute', 'some_other_attribute')",
				})
				.expect((r) =>
					assert.equal(r.body.error, 'Attribute names cannot include backticks or forward slashes', r.text)
				)
				.expect(400);
		});

		test('update multiple rows with invalid attribute', async () => {
			await client
				.req()
				.send({
					operation: 'sql',
					sql: "UPDATE dev.invalid_attribute SET `/some_attribute` = 'new_value' WHERE id IN(100, 101)",
				})
				.expect((r) =>
					assert.equal(r.body.error, 'Attribute names cannot include backticks or forward slashes', r.text)
				)
				.expect(400);
		});

		test('insert some invalid attribute names - multiple rows', async () => {
			await client
				.req()
				.send({
					operation: 'sql',
					sql: "INSERT INTO dev.invalid_attribute (id, some_attribute, another_attribute, `some_/other_attribute`) VALUES ('1', 'some_attribute', 'another_attribute', 'some_other_attribute'), ('2', 'some_attribute', 'another_attribute', 'some_other_attribute'), ('3', 'some_attribute', 'another_attribute', 'some_other_attribute'), ('4', 'some_attribute', 'another_attribute', 'some_other_attribute'), ('5', 'some_attribute', 'another_attribute', 'some_other_attribute'), ('6', 'some_attribute', 'another_attribute', 'some_other_attribute')",
				})
				.expect((r) =>
					assert.equal(r.body.error, 'Attribute names cannot include backticks or forward slashes', r.text)
				)
				.expect(400);
		});

		//Search Response Data Type Check

		test('select by hash no result', async () => {
			await client
				.req()
				.send({
					operation: 'sql',
					sql: `SELECT *
		              FROM northnwd.employees
		              WHERE employeeid = 190`,
				})
				.expect((r) => assert.equal(r.body.length, 0, r.text))
				.expect(200);
		});

		test('select by hash one result', async () => {
			await client
				.req()
				.send({
					operation: 'sql',
					sql: `SELECT *
		              FROM northnwd.employees
		              WHERE employeeid = 3`,
				})
				.expect((r) => assert.equal(r.body.length, 1, r.text))
				.expect((r) => assert.equal(typeof r.body[0], 'object', r.text))
				.expect(200);
		});

		test('select by hash multiple results', async () => {
			await client
				.req()
				.send({
					operation: 'sql',
					sql: `SELECT *
		              FROM northnwd.employees
		              WHERE employeeid = 3
		                 OR employeeid = 5`,
				})
				.expect((r) => {
					assert.equal(r.body.length, 2, r.text);
					assert.equal(typeof r.body[0], 'object', r.text);
					assert.equal(typeof r.body[1], 'object', r.text);
				})
				.expect(200);
		});

		//Date Function Check

		test('insert initial date function data into table', async () => {
			await client
				.req()
				.send({
					operation: 'sql',
					sql: 'INSERT INTO dev.time_functions (id, c_date, c_time, c_timestamp, getdate, now) VALUES (1, CURRENT_DATE(), CURRENT_TIME(), CURRENT_TIMESTAMP, GETDATE(), NOW()), (2, CURRENT_DATE(), CURRENT_TIME(), CURRENT_TIMESTAMP, GETDATE(), NOW()), (3, CURRENT_DATE(), CURRENT_TIME(), CURRENT_TIMESTAMP, GETDATE(), NOW()), (4, CURRENT_DATE(), CURRENT_TIME(), CURRENT_TIMESTAMP, GETDATE(), NOW())',
				})
				.expect((r) => assert.equal(r.body.message, 'inserted 4 of 4 records', r.text))
				.expect((r) => assert.equal(r.body.inserted_hashes[0], 1, r.text))
				.expect(200);
		});

		test('check initial date function data in table', async () => {
			await client
				.req()
				.send({ operation: 'sql', sql: 'SELECT * FROM dev.time_functions' })
				.expect((r) => {
					assert.equal(r.body.length, 4, r.text);
					let current_date = new Date().getUTCDate();
					r.body.forEach((row) => {
						assert.ok([1, 2, 3, 4].includes(row.id), r.text);
						assert.equal(new Date(row.now).getUTCDate(), current_date, r.text);
						assert.equal(row.now.toString().length, 13, r.text);
						assert.equal(new Date(row.getdate).getUTCDate(), current_date, r.text);
						assert.equal(row.getdate.toString().length, 13, r.text);
						assert.equal(new Date(row.c_timestamp).getUTCDate(), current_date, r.text);
						assert.equal(row.c_timestamp.toString().length, 13, r.text);
						assert.ok(row.c_date.match(/\d{4}-[01]{1}\d{1}-[0-3]{1}\d{1}$/), r.text);
						assert.ok(row.c_time.match(/^[0-2]{1}\d{1}:[0-6]{1}\d{1}:[0-6]{1}\d{1}.\d{3}$/), r.text);
					});
				})
				.expect(200);
		});

		test('update w/ date function data to null in table', async () => {
			await client
				.req()
				.send({
					operation: 'sql',
					sql: 'UPDATE dev.time_functions SET c_date = null, c_time = null, c_timestamp = null, getdate = null, now = null',
				})
				.expect((r) => assert.equal(r.body.message, 'updated 4 of 4 records', r.text))
				.expect((r) => assert.equal(r.body.update_hashes[0], 1, r.text))
				.expect(200);
		});

		test('check data set to null in table', async () => {
			await client
				.req()
				.send({ operation: 'sql', sql: 'SELECT * FROM dev.time_functions' })
				.expect((r) => {
					assert.equal(r.body.length, 4, r.text);
					r.body.forEach((row) => {
						assert.ok([1, 2, 3, 4].includes(row.id), r.text);
						assert.ok(!row.now, r.text);
						assert.ok(!row.getdate, r.text);
						assert.ok(!row.c_timestamp, r.text);
						assert.ok(!row.c_date, r.text);
						assert.ok(!row.c_time, r.text);
					});
				})
				.expect(200);
		});

		test('update w/ new date function data in table', async () => {
			await client
				.req()
				.send({
					operation: 'sql',
					sql: 'UPDATE dev.time_functions SET c_date = CURRENT_DATE(), c_time = CURRENT_TIME(), c_timestamp = CURRENT_TIMESTAMP, getdate = GETDATE(), now = NOW()',
				})
				.expect((r) => assert.equal(r.body.message, 'updated 4 of 4 records', r.text))
				.expect((r) => assert.equal(r.body.update_hashes.length, 4, r.text))
				.expect(200);
		});

		test('check data updated to correct date values in table', async () => {
			await client
				.req()
				.send({ operation: 'sql', sql: 'SELECT * FROM dev.time_functions' })
				.expect((r) => {
					assert.equal(r.body.length, 4, r.text);
					let current_date = new Date().getUTCDate();
					r.body.forEach((row) => {
						assert.ok([1, 2, 3, 4].includes(row.id), r.text);
						assert.equal(new Date(row.now).getUTCDate(), current_date, r.text);
						assert.equal(row.now.toString().length, 13, r.text);
						assert.equal(new Date(row.getdate).getUTCDate(), current_date, r.text);
						assert.equal(row.getdate.toString().length, 13, r.text);
						assert.equal(new Date(row.c_timestamp).getUTCDate(), current_date, r.text);
						assert.equal(row.c_timestamp.toString().length, 13, r.text);
						assert.ok(row.c_date.match(/\d{4}-[01]{1}\d{1}-[0-3]{1}\d{1}$/), r.text);
						assert.ok(row.c_time.match(/^[0-2]{1}\d{1}:[0-6]{1}\d{1}:[0-6]{1}\d{1}.\d{3}$/), r.text);
					});
				})
				.expect(200);
		});

		test('update w/ other date functions', async () => {
			await client
				.req()
				.send({
					operation: 'sql',
					sql: "UPDATE dev.time_functions SET today = NOW(), add_day = DATE_ADD(CURRENT_TIMESTAMP, 1, 'days'), sub_3_years = DATE_SUB('2020-4-1', 3, 'years'), server_time = GET_SERVER_TIME(), offset_utc = OFFSET_UTC(NOW(), -6)",
				})
				.expect((r) => assert.equal(r.body.message, 'updated 4 of 4 records', r.text))
				.expect((r) => assert.equal(r.body.update_hashes.length, 4, r.text))
				.expect(200);
		});

		test('check other date function updates are correct in table', async () => {
			await client
				.req()
				.send({ operation: 'sql', sql: 'SELECT * FROM dev.time_functions' })
				.expect((r) => {
					assert.equal(r.body.length, 4, r.text);
					let current_date = new Date();
					let current_day = current_date.getUTCDate();
					let c_date_plus1 = current_date.setUTCDate(current_day + 1);
					let c_day_plus1 = new Date(c_date_plus1).getUTCDate();
					r.body.forEach((row) => {
						assert.ok(row.c_timestamp.toString().match(/\d{13}$/), r.text);
						assert.equal(new Date(row.add_day).getUTCDate(), c_day_plus1, r.text);
						assert.ok(row.add_day.toString().match(/\d{13}$/), r.text);
						assert.equal(new Date(row.sub_3_years).getFullYear(), 2017, r.text);
						assert.ok(row.sub_3_years.toString().match(/\d{13}$/), r.text);
						assert.equal(new Date(row.today).getUTCDate(), current_day, r.text);
						assert.ok(row.today.toString().match(/\d{13}$/), r.text);
					});
				})
				.expect(200);
		});

		test('update w/ other date functions', async () => {
			await client
				.req()
				.send({
					operation: 'sql',
					sql: "UPDATE dev.time_functions SET add_day = DATE_ADD(DATE(), 5, 'days'), tomorrow_epoch = DATE_FORMAT(DATE_ADD(NOW(), 1, 'days'), 'x') WHERE id > 2",
				})
				.expect((r) => assert.equal(r.body.message, 'updated 2 of 2 records', r.text))
				.expect((r) => assert.equal(r.body.update_hashes.length, 2, r.text))
				.expect(200);
		});

		test('select with date function in WHERE returns correct rows', async () => {
			await client
				.req()
				.send({
					operation: 'sql',
					sql: "SELECT * FROM dev.time_functions WHERE DATE_DIFF(add_day, c_timestamp, 'days') > 3 AND tomorrow_epoch > NOW()",
				})
				.expect((r) => {
					assert.equal(r.body.length, 2, r.text);
					let current_date = new Date().getDate();
					let date_plus_5 = new Date(new Date().setDate(current_date + 5));
					r.body.forEach((row) => {
						assert.ok([3, 4].includes(row.id), r.text);
						assert.equal(new Date(row.add_day).getDate(), date_plus_5.getDate(), r.text);
					});
				})
				.expect(200);
		});

		test('delete with date function in WHERE deletes correct rows', async () => {
			await client
				.req()
				.send({
					operation: 'sql',
					sql: "DELETE FROM dev.time_functions WHERE DATE_DIFF(add_day, c_timestamp, 'days') < 3",
				})
				.expect((r) => assert.equal(r.body.message, '2 of 2 records successfully deleted', r.text))
				.expect((r) => assert.equal(r.body.deleted_hashes.length, 2, r.text))
				.expect(200);
		});

		test('check that correct rows were deleted based on date function', async () => {
			await client
				.req()
				.send({ operation: 'sql', sql: 'SELECT * FROM dev.time_functions' })
				.expect((r) => {
					assert.equal(r.body.length, 2, r.text);
					let current_date = new Date().getDate();
					let date_plus_3 = new Date().setDate(current_date + 3);
					r.body.forEach((row) => {
						assert.ok([3, 4].includes(row.id), r.text);
						assert.ok(row.add_day > date_plus_3, r.text);
					});
				})
				.expect(200);
		});

		test('check that DATE(__createdtime__) returns correct value w/ correct alias', async () => {
			await client
				.req()
				.send({
					operation: 'sql',
					sql: 'SELECT id, DATE(__createdtime__), DATE(__updatedtime__) as updatedtime FROM dev.time_functions WHERE id = 3 OR id = 4',
				})
				.expect((r) => {
					assert.equal(r.body.length, 2, r.text);
					let current_date = new Date().getDate();
					r.body.forEach((row) => {
						assert.ok([3, 4].includes(row.id), r.text);
						assert.equal(new Date(row.updatedtime).getDate(), current_date, r.text);
						assert.equal(new Date(row['DATE(__createdtime__)']).getDate(), current_date, r.text);
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

		test('count movies where movie.keyword starts with super', async () => {
			await client
				.req()
				.send({
					operation: 'sql',
					sql: 'SELECT count(*) AS `count` from dev.movie where search_json(\'$[$substring(name,0, 5) = "super"].name\', keywords) is not null',
				})
				.expect((r) => assert.equal(r.body.length, 1, r.text))
				.expect((r) => assert.equal(r.body[0].count, 161, r.text))
				.expect(200);
		});

		test('return array of just movie keywords', async () => {
			await client
				.req()
				.send({
					operation: 'sql',
					sql: "SELECT title, search_json('name', keywords) as keywords from dev.movie where title Like '%Avengers%'",
				})
				.expect((r) => {
					assert.equal(r.body.length, 2, r.text);
					r.body.forEach((data) => {
						assert.ok(Array.isArray(data.keywords), r.text);
						assert.equal(typeof data.keywords[0], 'string', r.text);
					});
				})
				.expect(200);
		});

		test('filter on credits.cast with join to movie', async () => {
			await client
				.req()
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
						assert.ok(titles.indexOf(data.title) > -1, r.text);
					});
				})
				.expect(200);
		});

		//SQL INSERT/UPDATE with Expressions & Functions

		test('insert values into table dev.sql_function', async () => {
			await client
				.req()
				.send({
					operation: 'sql',
					sql: "INSERT INTO dev.sql_function (id, rando, week_day) VALUES (1, FLOOR(RANDOM() * (10 - 1)) + 1, date_format(NOW(), 'dddd')), (2, FLOOR(RANDOM() * (10 - 1)) + 1, date_format(NOW(), 'dddd'))",
				})
				.expect((r) => {
					assert.equal(r.body.message, 'inserted 2 of 2 records', r.text);
					assert.equal(r.body.inserted_hashes[0], 1, r.text);
					assert.equal(r.body.inserted_hashes[1], 2, r.text);
				})
				.expect(200);
		});

		test('SELECT inserted values FROM dev.sql_function', async () => {
			await client
				.req()
				.send({ operation: 'sql', sql: 'SELECT * FROM dev.sql_function' })
				.expect((r) => {
					assert.equal(r.body.length, 2, r.text);
					r.body.forEach((record) => {
						assert.equal(typeof record.week_day, 'string', r.text);
						assert.equal(typeof record.rando, 'number', r.text);
						assert.ok(record.rando >= 1 && record.rando <= 10, r.text);
					});
				})
				.expect(200);
		});

		test('update values into table dev.sql_function', async () => {
			await client
				.req()
				.send({
					operation: 'sql',
					sql: 'UPDATE dev.sql_function SET rando = rando * 10, upper_week_day = UPPER(week_day)',
				})
				.expect((r) => {
					assert.equal(r.body.message, 'updated 2 of 2 records', r.text);
					assert.equal(r.body.update_hashes[0], 1, r.text);
					assert.equal(r.body.update_hashes[1], 2, r.text);
				})
				.expect(200);
		});

		test('SELECT updated values FROM dev.sql_function', async () => {
			await client
				.req()
				.send({ operation: 'sql', sql: 'SELECT * FROM dev.sql_function' })
				.expect((r) => {
					assert.equal(r.body.length, 2, r.text);
					assert.ok(r.body[0].rando >= 10 && r.body[0].rando <= 100, r.text);
					assert.ok(r.body[1].rando >= 10 && r.body[1].rando <= 100, r.text);
					assert.equal(r.body[0].upper_week_day, r.body[0].week_day.toUpperCase(), r.text);
					assert.equal(r.body[1].upper_week_day, r.body[1].week_day.toUpperCase(), r.text);
				})
				.expect(200);
		});

		test('update value in table for non-existent row', async () => {
			await client
				.req()
				.send({
					operation: 'sql',
					sql: "UPDATE northnwd.customers SET companyname = 'Google' WHERE customerid = -100",
				})
				.expect((r) => {
					assert.equal(r.body.message, 'updated 0 of 0 records', r.text);
					assert.deepEqual(r.body.skipped_hashes, [], r.text);
					assert.deepEqual(r.body.update_hashes, [], r.text);
				})
				.expect(200);
		});

		//Restricted Keywords

		test('Create table keywords for SQL tests', async () => {
			await client
				.req()
				.send({ operation: 'create_table', schema: 'dev', table: 'keywords', primary_key: 'id' })
				.expect((r) => assert.ok(r.body.message.includes('successfully created'), r.text))
				.expect(200);
		});

		test('Upsert keywords data for SQL tests', async () => {
			await client
				.req()
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
				.expect((r) => assert.equal(r.body.upserted_hashes.length, 10, r.text))
				.expect(200);
		});

		test('Delete row from table with reserverd word in WHERE clause', async () => {
			await client
				.req()
				.send({ operation: 'sql', sql: "DELETE FROM dev.keywords WHERE `group` = 'D'" })
				.expect((r) => {
					assert.equal(r.body.message, '1 of 1 record successfully deleted', r.text);
					assert.equal(r.body.deleted_hashes[0], 10, r.text);
					assert.equal(r.body.deleted_hashes.length, 1, r.text);
					assert.equal(r.body.skipped_hashes.length, 0, r.text);
				})
				.expect(200);
		});

		test('Delete row from table with multiple reserverd words in WHERE clause', async () => {
			await client
				.req()
				.send({ operation: 'sql', sql: "DELETE FROM dev.keywords WHERE `group` = 'A' AND [Inserted] = true" })
				.expect((r) => {
					assert.equal(r.body.message, '2 of 2 records successfully deleted', r.text);
					assert.equal(r.body.deleted_hashes[0], 1, r.text);
					assert.equal(r.body.deleted_hashes[1], 7, r.text);
					assert.equal(r.body.deleted_hashes.length, 2, r.text);
					assert.equal(r.body.skipped_hashes.length, 0, r.text);
				})
				.expect(200);
		});

		test('UPDATE rows from table with reserved word in SET and WHERE clause', async () => {
			await client
				.req()
				.send({ operation: 'sql', sql: "UPDATE dev.keywords SET `group` = 'D' WHERE [ALL] = 'no'" })
				.expect((r) => {
					assert.equal(r.body.message, 'updated 4 of 4 records', r.text);
					assert.equal(r.body.update_hashes.length, 4, r.text);
					assert.equal(r.body.skipped_hashes.length, 0, r.text);
				})
				.expect(200);
		});

		test('Drop table keywords', async () => {
			await client
				.req()
				.send({ operation: 'drop_table', schema: 'dev', table: 'keywords' })
				.expect((r) => assert.ok(r.body.message.includes("successfully deleted table 'dev.keywords'"), r.text))
				.expect(200);
		});

		//SQL Update dev.cat

		test('Create table dev.cat for Update', async () => {
			await client
				.req()
				.send({ operation: 'create_table', schema: 'dev', table: 'cat', primary_key: 'id' })
				.expect((r) => assert.equal(r.body.message, "table 'dev.cat' successfully created.", r.text))
				.expect(200);
			await setTimeout(200);
		});

		test('Insert data into dev.cat', async () => {
			await client
				.req()
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
				.expect((r) => assert.equal(r.body.message, 'inserted 9 of 9 records', r.text))
				.expect(200);
		});

		test('Update record basic where dev.cat', async () => {
			await client
				.req()
				.send({ operation: 'sql', sql: "UPDATE dev.cat SET cat_name = 'Bobby' WHERE id = 9" })
				.expect((r) =>
					assert.equal(
						r.body.message,
						'updated 1 of 1 records',
						'Expected response message to eql "updated 1 of 1 records"'
					)
				)
				.expect((r) => assert.equal(r.body.update_hashes[0], 9, r.text))
				.expect(200);
		});

		test('Confirm update record basic where dev.cat', async () => {
			await client
				.req()
				.send({ operation: 'sql', sql: 'SELECT cat_name, weight_lbs, age, id FROM dev.cat WHERE id = 9' })
				.expect((r) => {
					assert.equal(r.body[0].id, 9, r.text);
					assert.equal(r.body[0].weight_lbs, 10, r.text);
					assert.equal(r.body[0].cat_name, 'Bobby', r.text);
					assert.equal(r.body[0].age, 8, r.text);
				})
				.expect(200);
		});

		test('Update record "where x != y" dev.cat', async () => {
			await client
				.req()
				.send({ operation: 'sql', sql: 'UPDATE dev.cat SET adorable = false WHERE owner_id != 2' })
				.expect((r) => assert.equal(r.body.message, 'updated 5 of 5 records', r.text))
				.expect((r) =>
					assert.ok(
						[3, 4, 6, 7, 8].every((el) => r.body.update_hashes.includes(el)),
						r.text
					)
				)
				.expect(200);
		});

		test('Confirm update record "where x != y" dev.cat', async () => {
			const cats = ['Biggie Paws', 'Willow', 'Murph', 'Simba', 'Gemma'];
			const ids = [3, 4, 6, 7, 8];

			await client
				.req()
				.send({ operation: 'sql', sql: 'SELECT cat_name, adorable, id FROM dev.cat WHERE owner_id != 2' })
				.expect((r) => assert.equal(r.body.length, 5, r.text))
				.expect((r) => {
					let cats_found = [];
					let ids_found = [];
					r.body.forEach((obj) => {
						assert.equal(Object.keys(obj).length, 3, r.text);
						assert.equal(obj.adorable, false, r.text);

						let cat_found = cats.filter((el) => obj.cat_name == el);
						if (cat_found.length > 0) cats_found.push(cat_found);
						let id_found = ids.filter((el) => obj.id == el);
						if (id_found.length > 0) ids_found.push(id_found);
					});
					assert.ok(cats_found.length > 0, r.text);
					assert.ok(ids_found.length > 0, r.text);
				})
				.expect(200);
		});

		test('Update record No where dev.cat', async () => {
			await client
				.req()
				.send({ operation: 'sql', sql: 'UPDATE dev.cat SET adorable = true' })
				.expect((r) => {
					assert.equal(r.body.message, 'updated 9 of 9 records', r.text);
					assert.ok(
						[1, 2, 3, 4, 5, 6, 7, 8, 9].every((el) => r.body.update_hashes.includes(el)),
						r.text
					);
					assert.deepEqual(r.body.skipped_hashes, [], r.text);
				})
				.expect(200);
		});

		test('Confirm update record No where dev.cat', async () => {
			const cats = ['Sophie', 'George', 'Biggie Paws', 'Willow', 'Bird', 'Murph', 'Simba', 'Gemma', 'Bobby'];
			const ids = [1, 2, 3, 4, 5, 6, 7, 8, 9];
			await client
				.req()
				.send({ operation: 'sql', sql: 'SELECT cat_name, adorable, id FROM dev.cat' })
				.expect((r) => assert.equal(r.body.length, 9, r.text))
				.expect((r) => {
					let cats_found = [];
					let ids_found = [];
					r.body.forEach((obj) => {
						assert.equal(Object.keys(obj).length, 3, r.text);
						assert.ok(obj.adorable, r.text);
						let cat_found = cats.filter((el) => obj.cat_name == el);
						if (cat_found.length > 0) cats_found.push(cat_found);
						let id_found = ids.filter((el) => obj.id == el);
						if (id_found.length > 0) ids_found.push(id_found);
					});
					assert.ok(cats_found.length > 0, r.text);
					assert.ok(ids_found.length > 0, r.text);
				})
				.expect(200);
		});

		test('Update record multiple wheres, multiple columns dev.cat', async () => {
			await client
				.req()
				.send({
					operation: 'sql',
					sql: "UPDATE dev.cat SET outdoor_privilages = false, weight_lbs = 6 WHERE owner_id = 2 AND cat_name = 'Sophie'",
				})
				.expect((r) =>
					assert.equal(
						r.body.message,
						'updated 1 of 1 records',
						'Expected response message to eql "updated 1 of 1 records"'
					)
				)
				.expect((r) => assert.equal(r.body.update_hashes[0], 1, r.text))
				.expect(200);
		});

		test('Confirm update record multiple wheres, multiple columns dev.cat', async () => {
			await client
				.req()
				.send({
					operation: 'sql',
					sql: "SELECT cat_name, weight_lbs, owner_id, outdoor_privilages, id FROM dev.cat WHERE owner_id = 2 AND cat_name = 'Sophie'",
				})
				.expect((r) => {
					assert.equal(r.body[0].id, 1, r.text);
					assert.equal(r.body[0].weight_lbs, 6, r.text);
					assert.equal(r.body[0].weight_lbs, 6, r.text);
					assert.equal(r.body[0].cat_name, 'Sophie', r.text);
					assert.equal(r.body[0].owner_id, 2, r.text);
					assert.equal(r.body[0].outdoor_privilages, false, r.text);
				})
				.expect(200);
		});

		test('Update record "where x is NULL" dev.cat', async () => {
			await client
				.req()
				.send({
					operation: 'sql',
					sql: 'UPDATE dev.cat SET outdoor_privilages = true WHERE outdoor_privilages IS null',
				})
				.expect((r) => assert.equal(r.body.message, 'updated 8 of 8 records', r.text))
				.expect((r) =>
					assert.ok(
						[2, 3, 4, 5, 6, 7, 8, 9].every((el) => r.body.update_hashes.includes(el)),
						r.text
					)
				)
				.expect(200);
		});

		test('Confirm update record "where x is NULL" dev.cat', async () => {
			await client
				.req()
				.send({
					operation: 'sql',
					sql: 'SELECT cat_name, outdoor_privilages, id FROM dev.cat WHERE outdoor_privilages IS null',
				})
				.expect((r) => assert.equal(r.body.length, 0, r.text))
				.expect(200);
		});

		test('Update record with nonexistant id dev.cat', async () => {
			await client
				.req()
				.send({ operation: 'sql', sql: "UPDATE dev.cat SET cat_name = 'Garfield' WHERE id = 75" })
				.expect((r) => assert.equal(r.body.message, 'updated 0 of 0 records', r.text))
				.expect((r) => assert.deepEqual(r.body.update_hashes, [], r.text))
				.expect(200);
		});

		test('Confirm update record with nonexistant id dev.cat', async () => {
			await client
				.req()
				.send({ operation: 'sql', sql: 'SELECT cat_name, weight_lbs, age FROM dev.cat WHERE id = 75' })
				.expect((r) => assert.equal(r.body.length, 0, r.text))
				.expect(200);
		});

		test('Drop table cat from dev.cat', async () => {
			await client
				.req()
				.send({ operation: 'drop_table', schema: 'dev', table: 'cat' })
				.expect((r) => assert.equal(r.body.message, "successfully deleted table 'dev.cat'", r.text))
				.expect(200);
		});

		//Geospatial

		test('Create table "geo"', async () => {
			await client
				.req()
				.send({ operation: 'create_table', table: 'geo', primary_key: 'id' })
				.expect((r) => assert.equal(r.body.message, "table 'data.geo' successfully created.", r.text))
				.expect(200);
		});

		test('Insert values into "geo" table', async () => {
			await client
				.req()
				.send(
					'{\n   \n\t"operation":"insert",\n\t"table":"geo",\n\t"records": [\n        {\n            "id": 1,\n            "name": "Wellington",\n            "geo_point" : {\n                "type": "Point",\n                "coordinates": [174.776230, -41.286461]\n            },\n            "geo_poly": {\n                "type": "Polygon",\n                "coordinates": [[ [174.615474867904,-41.34148585702194],\n                    [174.8800567396483,-41.31574371071801],\n                    [174.6896944170223,-41.19759744824616],\n                    [174.615474867904,-41.34148585702194]\n                ]]\n            },\n            "geo_line": {\n                "type": "LineString",\n                "coordinates": [\n                    [174.615474867904,-41.34148585702194],\n                    [174.8800567396483,-41.31574371071801]\n                ]\n            }\n        },\n        {\n            "id": 2,\n            "name": "North Adams",\n            "geo_point" : {\n                "type": "Point",\n                "coordinates": [-73.108704, 42.700539]\n            },\n            "geo_poly": {\n                "type": "Polygon",\n                "coordinates": [[                  [-73.12391499193579,42.70656096680374],\n                    [-73.12255557219314,42.69646774251972],\n                    [-73.09908993001123,42.6984753377431],\n                    [-73.10369107948782,42.70876034407737],\n                    [-73.12391499193579,42.70656096680374]\n                ]]\n            }\n        },\n        {\n            "id": 3,\n            "name": "Denver",\n            "geo_point" : {\n                "type": "Point",\n                "coordinates": [-104.990250, 39.739235]\n            },\n            "geo_poly": {\n                "type": "Polygon",\n                "coordinates": [[          [-105.0487835030464,39.77676227285275],\n                    [-105.0175466672944,39.68744341857906],\n                    [-104.9113967289065,39.74637288224356],\n                    [-105.0487835030464,39.77676227285275]\n                ]]\n            }\n        },\n        {\n            "id": 4,\n            "name": "New York City",\n            "geo_point" : {\n                "type": "Point",\n                "coordinates": [-74.005974, 40.712776]\n            },\n            "geo_poly": {\n                "type": "Polygon",\n                "coordinates": [[             [-74.00852603549784,40.73107908806126],\n                    [-74.03702059033735,40.70472625054263],\n                    [-73.98786450714653,40.70419899758365],\n                    [-74.00852603549784,40.73107908806126]\n                ]]\n            }\n        },\n        {\n            "id": 5,\n            "name": "Salt Lake City",\n            "geo_point" : {\n                "type": "Point",\n                "coordinates": [-111.920485, 40.7766079]\n            },\n            "geo_poly": {\n                "type": "Polygon",\n                "coordinates": [[           [-112.8291507578281,40.88206673094385],\n                    [-112.8956858211181,40.30332102898777],\n                    [-111.6032172200158,40.02757615254776],\n                    [-111.1456265349256,40.95908300700454],\n                    [-111.9047878338339,41.3291504973315],\n                    [-112.8291507578281,40.88206673094385]\n                ]]\n            },\n            "geo_line": {\n                "type": "LineString",\n                "coordinates": [        [-112.8291507578281,40.88206673094385],\n                    [-112.8956858211181,40.30332102898777],\n                    [-111.6032172200158,40.02757615254776],\n                    [-111.1456265349256,40.95908300700454],\n                    [-111.9047878338339,41.3291504973315],\n                    [-112.8291507578281,40.88206673094385]\n                ]\n            }\n        },\n        {\n            "id": 6,\n            "name": "Null Island",\n            "geo_point" : {\n                "type": "Point",\n                "coordinates": [null, null]\n            },\n            "geo_poly": null,\n            "geo_line": {\n                "type": "LineString",\n                "coordinates": [\n                    [-112.8291507578281,40.88206673094385],\n                    [null, null]\n                ]\n            }\n        },\n        {\n            "id": 7\n        },\n        {\n            "id": 8,\n            "name": "Hobbiton",\n            "geo_point" : [174.776230, -41.286461],\n            "geo_poly": "Somewhere in the shire",\n            "geo_line": {\n                "type": "LineString"\n            }\n        }\n    ]\n}\n'
				)
				.expect((r) => assert.equal(r.body.message, 'inserted 8 of 8 records', r.text))
				.expect(200);
		});

		test('geoArea test 1', async () => {
			await client
				.req()
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

		test('geoArea test 2', async () => {
			await client
				.req()
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

		test('geoArea test 3', async () => {
			await client
				.req()
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

		test('geoLength test 1', async () => {
			await client
				.req()
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

		test('geoLength test 2', async () => {
			await client
				.req()
				.send({ operation: 'sql', sql: "SELECT id, name, geoLength(geo_line, 'miles') FROM data.geo" })
				.expect((r) =>
					assert.deepEqual(
						roundFloats(r.body),
						roundFloats([
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
				)
				.expect(200);
		});

		test('geoLength test 3', async () => {
			await client
				.req()
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

		test('geoDifference test 1', async () => {
			await client
				.req()
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

		test('geoDifference test 2', async () => {
			await client
				.req()
				.send({
					operation: 'sql',
					sql: 'SELECT geoDifference(\'{"type": "Feature","properties": {"name":"Colorado"},"geometry": {"type": "Polygon","coordinates": [[[-109.072265625,37.00255267215955],[-102.01904296874999,37.00255267215955],[-102.01904296874999,41.0130657870063],[-109.072265625,41.0130657870063],[-109.072265625,37.00255267215955]]]}}\', null)',
				})
				.expect((r) => assert.deepEqual(r.body, [{}], r.text))
				.expect(200);
		});

		test('geoDistance test 1', async () => {
			await client
				.req()
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

		test('geoDistance test 2', async () => {
			await client
				.req()
				.send({
					operation: 'sql',
					sql: "SELECT id, name, geoDistance('[-104.979127,39.761563]', geo_point, 'miles') as distance FROM data.geo WHERE geoDistance('[-104.979127,39.761563]', geo_point, 'kilometers') < 40 ORDER BY distance ASC",
				})
				.expect((r) =>
					assert.deepEqual(
						roundFloats(r.body),
						roundFloats([
							{
								id: 3,
								name: 'Denver',
								distance: 1.6520011088478226,
							},
						])
					)
				)
				.expect(200);
		});

		test('geoDistance test 3', async () => {
			await client
				.req()
				.send({
					operation: 'sql',
					sql: "SELECT id, name, geoDistance('[-104.979127,39.761563]', geo_point, 'miles') as distance FROM data.geo",
				})
				.expect((r) =>
					assert.deepEqual(
						roundFloats(r.body),
						roundFloats([
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
				)
				.expect(200);
		});

		test('geoNear test 1', async () => {
			await client
				.req()
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

		test('geoNear test 2', async () => {
			await client
				.req()
				.send({
					operation: 'sql',
					sql: "SELECT id, name, geoDistance('[-104.979127,39.761563]', geo_point, 'miles') as distance FROM data.geo WHERE geoNear('[-104.979127,39.761563]', geo_point, 20, 'degrees') ORDER BY distance ASC",
				})
				.expect((r) =>
					assert.deepEqual(
						roundFloats(r.body),
						roundFloats([
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
				)
				.expect(200);
		});

		test('geoContains test 1', async () => {
			await client
				.req()
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

		test('geoContains test 2', async () => {
			await client
				.req()
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

		test('geoEqual test 1', async () => {
			await client
				.req()
				.send({
					operation: 'sql',
					sql: 'SELECT * FROM data.geo WHERE geoEqual(geo_poly, \'{"type": "Feature","properties": {"name": "HarperDB Headquarters"},"geometry": {"type": "Polygon","coordinates": [[[-104.98060941696167,39.760704817357905],[-104.98053967952728,39.76065120861263],[-104.98055577278137,39.760642961109674],[-104.98037070035934,39.76049450588716],[-104.9802714586258,39.76056254790385],[-104.9805235862732,39.76076461167841],[-104.98060941696167,39.760704817357905]]]}}\')',
				})
				.expect((r) => assert.equal(r.body.length, 0, r.text))
				.expect(200);
		});

		test('geoCrosses test 1', async () => {
			await client
				.req()
				.send({
					operation: 'sql',
					sql: 'SELECT id, name FROM data.geo WHERE geoCrosses(geo_poly,\'{"type": "Feature","properties": {"name": "Highway I-25"},"geometry": {"type": "LineString","coordinates": [[-104.9139404296875,41.00477542222947],[-105.0238037109375,39.715638134796336],[-104.853515625,39.53370327008705],[-104.853515625,38.81403111409755],[-104.61181640625,38.39764411353178],[-104.8974609375,37.68382032669382],[-104.501953125,37.00255267215955]]}}\')',
				})
				.expect((r) => assert.deepEqual(r.body, [{ id: 3, name: 'Denver' }], r.text))
				.expect(200);
		});

		test('geoConvert test 1', async () => {
			await client
				.req()
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

		test('Drop table "geo"', async () => {
			await client
				.req()
				.send({ operation: 'drop_table', schema: 'data', table: 'geo' })
				.expect((r) => assert.equal(r.body.message, "successfully deleted table 'data.geo'", r.text))
				.expect(200);
		});

		//SQL Tests Main Folder

		test('insert value into table', async () => {
			await client
				.req()
				.send({
					operation: 'sql',
					sql: "INSERT INTO northnwd.customers (customerid, postalcode, companyname) VALUES ('TEST3', 11385, 'Microsoft')",
				})
				.expect((r) => assert.equal(r.body.message, 'inserted 1 of 1 records', r.text))
				.expect((r) => assert.equal(r.body.inserted_hashes[0], 'TEST3', r.text))
				.expect(200);
		});

		test('insert value into table confirm', async () => {
			await client
				.req()
				.send({
					operation: 'sql',
					sql: "SELECT customerid, postalcode, companyname FROM northnwd.customers WHERE customerid = 'TEST3'",
				})
				.expect((r) => {
					assert.equal(r.body[0].customerid, 'TEST3', r.text);
					assert.equal(r.body[0].postalcode, 11385, r.text);
					assert.equal(r.body[0].companyname, 'Microsoft', r.text);
				})
				.expect(200);
		});

		test('update value in table', async () => {
			await client
				.req()
				.send({
					operation: 'sql',
					sql: "UPDATE northnwd.customers SET companyname = 'Google' WHERE customerid = 'TEST3'",
				})
				.expect((r) =>
					assert.equal(
						r.body.message,
						'updated 1 of 1 records',
						'Expected response message to eql "updated 1 of 1 records"'
					)
				)
				.expect((r) => assert.equal(r.body.update_hashes[0], 'TEST3', r.text))
				.expect(200);
		});

		test('update value in table confirm', async () => {
			await client
				.req()
				.send({
					operation: 'sql',
					sql: "SELECT customerid, postalcode, companyname FROM northnwd.customers WHERE customerid = 'TEST3'",
				})
				.expect((r) => {
					assert.equal(r.body[0].customerid, 'TEST3', r.text);
					assert.equal(r.body[0].postalcode, 11385, r.text);
					assert.equal(r.body[0].companyname, 'Google', r.text);
				})
				.expect(200);
		});

		test('attempt to update __createdtime__ in table', async () => {
			await client
				.req()
				.send({
					operation: 'sql',
					sql: "UPDATE northnwd.customers SET __createdtime__ = 'bad value' WHERE customerid = 'TEST3'",
				})
				.expect((r) =>
					assert.equal(
						r.body.message,
						'updated 1 of 1 records',
						'Expected response message to eql "updated 1 of 1 records"'
					)
				)
				.expect((r) => assert.equal(r.body.update_hashes[0], 'TEST3', r.text))
				.expect(200);
		});

		test('Confirm __createdtime__ did not get changed', async () => {
			await client
				.req()
				.send({ operation: 'sql', sql: "SELECT __createdtime__ FROM northnwd.customers WHERE customerid = 'TEST3'" })
				.expect((r) => assert.notEqual(r.body[0].__createdtime__, 'bad value', r.text))
				.expect(200);
		});

		test('delete value from table', async () => {
			await client
				.req()
				.send({ operation: 'sql', sql: "DELETE FROM northnwd.customers WHERE customerid = 'TEST3'" })
				.expect((r) => assert.ok(r.body.message.includes('successfully deleted'), r.text))
				.expect(200);
		});

		test('delete value from table confirm', async () => {
			await client
				.req()
				.send({
					operation: 'sql',
					sql: "SELECT customerid, postalcode, companyname FROM northnwd.customers WHERE companyname = 'Microsoft'",
				})
				.expect((r) => assert.equal(r.body.length, 0, r.text))
				.expect(200);
		});

		test('select w/ where in numeric values as strings', async () => {
			await client
				.req()
				.send({ operation: 'sql', sql: "select * from dev.books WHERE id IN('1','2','3') ORDER BY id" })
				.expect((r) => assert.equal(r.body.length, 3, r.text))
				.expect((r) => {
					r.body.forEach((row, i) => {
						assert.equal(row.id, i + 1, r.text);
					});
				})
				.expect(200);
		});

		test('select w/ where between', async () => {
			await client
				.req()
				.send({ operation: 'sql', sql: 'select * from dev.books WHERE id BETWEEN 1 AND 3 ORDER BY id' })
				.expect((r) => assert.equal(r.body.length, 3, r.text))
				.expect((r) => {
					r.body.forEach((row, i) => {
						assert.equal(row.id, i + 1, r.text);
					});
				})
				.expect(200);
		});

		test('select w/ where not between', async () => {
			await client
				.req()
				.send({ operation: 'sql', sql: 'select * from dev.books WHERE id NOT BETWEEN 1 AND 3 ORDER BY id' })
				.expect((r) => {
					assert.equal(r.body.length, 47, r.text);
					r.body.forEach((row) => {
						assert.ok(row.id > 3, r.text);
					});
				})
				.expect(200);
		});

		test('select w/ where value equals 0', async () => {
			await client
				.req()
				.send({ operation: 'sql', sql: 'select * from dev.books WHERE books_count = 0 ' })
				.expect((r) => assert.equal(r.body.length, 4, r.text))
				.expect((r) => {
					r.body.forEach((row) => {
						assert.equal(row.books_count, 0, r.text);
					});
				})
				.expect(200);
		});

		test('select w/ where value equals "false"', async () => {
			await client
				.req()
				.send({ operation: 'sql', sql: "select * from dev.books WHERE nytimes_best_seller = 'false' " })
				.expect((r) => assert.equal(r.body.length, 25, r.text))
				.expect((r) => {
					r.body.forEach((row) => {
						assert.equal(row.nytimes_best_seller, false, r.text);
					});
				})
				.expect(200);
		});

		test('select employees orderby id asc', async () => {
			await client
				.req()
				.send({
					operation: 'sql',
					sql: `select employeeid, *
		              from northnwd.employees
		              order by employeeid asc`,
				})
				.expect((r) => {
					assert.equal(r.body.length, 10, r.text);
					assert.equal(r.body[0].employeeid, 1, r.text);
					assert.equal(r.body[1].employeeid, 2, r.text);
					assert.equal(r.body[8].employeeid, 9, r.text);
					assert.equal(r.body[9].employeeid, 25, r.text);
				})
				.expect(200);
		});

		test('select 2 + 2', async () => {
			await client
				.req()
				.send({ operation: 'sql', sql: 'select 2 + 2 ' })
				.expect((r) => assert.equal(r.body[0]['2 + 2'], 4, r.text))
				.expect(200);
		});

		test('select * FROM orders - test no schema', async () => {
			await client
				.req()
				.send({ operation: 'sql', sql: 'select * FROM orders' })
				.expect((r) => assert.equal(r.body.error, 'schema not defined for table orders', r.text))
				.expect(500);
		});

		test('select * from call.aggr - reserved words', async () => {
			await client.req().send({ operation: 'sql', sql: 'select * from call.aggr' }).expect(400);
		});

		test('select * from `call`.`aggr` - reserved words', async () => {
			await client
				.req()
				.send({
					operation: 'sql',
					sql: 'select age AS `alter`, * from `call`.`aggr` as `and` WHERE `all` > 3 ORDER BY `and`.`all` desc',
				})
				.expect((r) => assert.equal(r.body[0].all, 11, r.text))
				.expect(200);
		});

		test('select * from call.aggr where id = 11 - select dot & double dot', async () => {
			await client
				.req()
				.send({ operation: 'sql', sql: 'select * from `call`.`aggr` where `all` = 11' })
				.expect((r) => {
					assert.equal(r.body.length, 1, r.text);
					assert.equal(r.body[0].owner_name, '..', r.text);
					assert.equal(r.body[0].dog_name, '.', r.text);
				})
				.expect(200);
		});

		test('select * from invalid schema - expect fail', async () => {
			await client
				.req()
				.send({ operation: 'sql', sql: 'select * from `braaah`.`aggr`' })
				.expect((r) => assert.equal(r.body.error, "database 'braaah' does not exist", r.text))
				.expect(404);
		});

		test('select * from invalid table - expect fail', async () => {
			await client
				.req()
				.send({ operation: 'sql', sql: 'select * from `call`.`braaaah`' })
				.expect((r) => assert.equal(r.body.error, "Table 'call.braaaah' does not exist", r.text))
				.expect(404);
		});

		test('select orders orderby id desc', async () => {
			await client
				.req()
				.send({
					operation: 'sql',
					sql: `select orderid, *
		              from northnwd.orders
		              order by orderid desc`,
				})
				.expect((r) => assert.equal(r.body[0].orderid, 11077, r.text))
				.expect(200);
		});

		test('select count(*) orders where shipregion is null', async () => {
			await client
				.req()
				.send({
					operation: 'sql',
					sql: `select count(*) as \`count\`
		              from northnwd.orders
		              where shipregion IS NULL`,
				})
				.expect((r) => assert.equal(r.body[0].count, 414, r.text))
				.expect(200);
		});

		test('select count(*) orders where shipregion is not null', async () => {
			await client
				.req()
				.send({
					operation: 'sql',
					sql: `select count(*) AS \`count\`
		              from northnwd.orders
		              where shipregion is not null`,
				})
				.expect((r) => assert.equal(r.body[0].count, 416, r.text))
				.expect(200);
		});

		test('select most buyer orderby price asc', async () => {
			await client
				.req()
				.send({
					operation: 'sql',
					sql: `select a.orderid,
		                     a.productid,
		                     d.companyname,
		                     d.contactmame,
		                     b.productname,
		                     sum(a.unitprice) as unitprice,
		                     sum(a.quantity),
		                     sum(a.discount)
		              from northnwd.order_details a
		                       join northnwd.products b on a.productid = b.productid
		                       join northnwd.orders c on a.orderid = c.orderid
		                       join northnwd.customers d on c.customerid = d.customerid
		              group by a.orderid, a.productid, d.companyname, d.contactmame, b.productname
		              order by unitprice desc, d.companyname`,
				})
				.expect((r) => assert.equal(r.body[0].companyname, 'Berglunds snabbk\ufffdp', r.text))
				.expect((r) => assert.equal(r.body[1].companyname, 'Great Lakes Food Market', r.text))
				.expect(200);
		});

		test('select most buyer orderby price asc & companyname alias', async () => {
			await client
				.req()
				.send({
					operation: 'sql',
					sql: `select a.orderid,
		                     a.productid,
		                     d.companyname    as compname,
		                     d.contactmame,
		                     b.productname,
		                     sum(a.unitprice) as unitprice,
		                     sum(a.quantity),
		                     sum(a.discount)
		              from northnwd.order_details a
		                       join northnwd.products b on a.productid = b.productid
		                       join northnwd.orders c on a.orderid = c.orderid
		                       join northnwd.customers d on c.customerid = d.customerid
		              group by a.orderid, a.productid, d.companyname, d.contactmame, b.productname
		              order by unitprice desc, compname`,
				})
				.expect((r) => assert.equal(r.body[0].compname, 'Berglunds snabbk\ufffdp', r.text))
				.expect((r) => assert.equal(r.body[1].compname, 'Great Lakes Food Market', r.text))
				.expect(200);
		});

		test('select most buyer orderby order_id asc & product_id desc', async () => {
			await client
				.req()
				.send({
					operation: 'sql',
					sql: `select a.orderid as ords_id,
		                     a.productid,
		                     d.companyname         as companyname,
		                     d.contactmame,
		                     b.productname,
		                     sum(a.unitprice)      as unitprice,
		                     sum(a.quantity),
		                     sum(a.discount)
		              from northnwd.order_details a
		                       join northnwd.products b on a.productid = b.productid
		                       join northnwd.orders c on a.orderid = c.orderid
		                       join northnwd.customers d on c.customerid = d.customerid
		              group by a.orderid, a.productid, d.companyname, d.contactmame, b.productname
		              order by ords_id, a.productid desc`,
				})
				.expect((r) => {
					assert.equal(r.body[0].ords_id, 10248, r.text);
					assert.equal(r.body[1].ords_id, 10248, r.text);
					assert.equal(r.body[19].ords_id, 10254, r.text);
					assert.equal(r.body[0].companyname, 'Vins et alcools Chevalier', r.text);
					assert.equal(r.body[19].companyname, 'Chop-suey Chinese', r.text);
					assert.equal(r.body[0].productid, 72, r.text);
					assert.equal(r.body[1].productid, 42, r.text);
					assert.equal(r.body[19].productid, 24, r.text);
				})
				.expect(200);
		});

		test('select product orderby id asc', async () => {
			await client
				.req()
				.send({
					operation: 'sql',
					sql: `select productid, *
		              from northnwd.products
		              order by productid asc`,
				})
				.expect((r) => assert.equal(r.body[0].productid, 1, r.text))
				.expect(200);
		});

		test('select customers orderby id asc', async () => {
			await client
				.req()
				.send({
					operation: 'sql',
					sql: `select customerid, *
		              from northnwd.customers
		              order by customerid asc`,
				})
				.expect((r) => assert.equal(r.body[0].customerid, 'ALFKI', r.text))
				.expect(200);
		});

		test('select all details join 5 table where customername', async () => {
			await client
				.req()
				.send({
					operation: 'sql',
					sql: `select a.customerid,
		                     a.companyname,
		                     a.contactmame,
		                     b.orderid,
		                     b.shipname,
		                     d.productid,
		                     d.productname,
		                     d.unitprice,
		                     c.quantity,
		                     c.discount,
		                     e.employeeid,
		                     e.firstname,
		                     e.lastname
		              from northnwd.customers a
		                       join northnwd.orders b on a.customerid = b.customerid
		                       join northnwd.order_details c on b.orderid = c.orderid
		                       join northnwd.products d on c.productid = d.productid
		                       join northnwd.employees e on b.employeeid = e.employeeid
		              where a.companyname = 'Alfreds Futterkiste'`,
				})
				.expect((r) => assert.equal(r.body[0].customerid, 'ALFKI', r.text))
				.expect(200);
		});

		test('select * with LEFT OUTER JOIN', async () => {
			await client
				.req()
				.send({ operation: 'sql', sql: 'SELECT * FROM dev.breed b LEFT JOIN dev.dog d ON b.id = d.breed_id' })
				.expect((r) => assert.equal(r.body.length, 351, r.text))
				.expect((r) => {
					r.body.forEach((row) => {
						const keys = Object.keys(row);
						assert.equal(keys.length, 16, r.text);
						Object.keys(row).forEach((key) => {
							assert.notEqual(row[key], undefined, r.text);
						});
					});
				})
				.expect(200);
		});

		test('select specific columns with LEFT OUTER JOIN Copy', async () => {
			await client
				.req()
				.send({
					operation: 'sql',
					sql: 'SELECT b.name, b.id, d.* FROM dev.breed b LEFT JOIN dev.dog d ON b.id = d.breed_id',
				})
				.expect((r) => assert.equal(r.body.length, 351, r.text))
				.expect((r) => {
					r.body.forEach((row) => {
						const keys = Object.keys(row);
						assert.equal(keys.length, 11, r.text);
						Object.keys(row).forEach((key) => {
							assert.notEqual(row[key], undefined, r.text);
						});
					});
				})
				.expect(200);
		});

		test('select order details', async () => {
			await client
				.req()
				.send({
					operation: 'sql',
					sql: `select orderid, productid, unitprice, quantity, discount
		              from northnwd.order_details
		              order by orderid asc`,
				})
				.expect((r) => assert.equal(r.body[0].orderid, 10248, r.text))
				.expect(200);
		});

		test('select count groupby country', async () => {
			await client
				.req()
				.send({
					operation: 'sql',
					sql: `select count(customerid) as counter, country
		              from northnwd.customers
		              group by country
		              order by counter desc`,
				})
				.expect((r) => assert.equal(r.body[0].country, 'USA', r.text))
				.expect(200);
		});

		test('select most have the extension employees', async () => {
			await client
				.req()
				.send({
					operation: 'sql',
					sql: `select extension, *
		              from northnwd.employees
		              order by extension desc`,
				})
				.expect((r) => assert.equal(r.body[0].firstname, 'Nancy', r.text))
				.expect(200);
		});

		test('select top 10 most price of product', async () => {
			await client
				.req()
				.send({
					operation: 'sql',
					sql: `select categoryid, productname, quantityperunit, unitprice, *
		              from northnwd.products
		              order by unitprice desc limit 10 `,
				})
				.expect((r) => assert.equal(r.body[0].productname, 'C\ufffdte de Blaye', r.text))
				.expect(200);
		});

		test('select count min max avg sum price of products', async () => {
			await client
				.req()
				.send({
					operation: 'sql',
					sql: `select count(unitprice) as allproducts,
		                     min(unitprice)   as minprice,
		                     max(unitprice)   as maxprice,
		                     avg(unitprice)   as avgprice,
		                     sum(unitprice)   as sumprice
		              from northnwd.products `,
				})
				.expect((r) => assert.equal(r.body[0].allproducts, 77, r.text))
				.expect(200);
		});

		test('select round unit price using alias', async () => {
			await client
				.req()
				.send({
					operation: 'sql',
					sql: `SELECT ROUND(unitprice) AS Price
		              FROM northnwd.products
		              GROUP BY ROUND(unitprice)`,
				})
				.expect((r) => {
					let objKeysData = Object.keys(r.body[0]);
					assert.equal(objKeysData[0], 'Price', r.text);
				})
				.expect(200);
		});

		test('select where (like)and(<=>)', async () => {
			await client
				.req()
				.send({
					operation: 'sql',
					sql: `select *
		              from northnwd.products
		              where (productname like 'T%')
		                and (unitprice > 100) `,
				})
				.expect((r) => assert.ok(r.body[0].unitprice > 100, r.text))
				.expect(200);
		});

		test('select - where attr < comparator', async () => {
			await client
				.req()
				.send({
					operation: 'sql',
					sql: `select *
		              from northnwd.products
		              where unitprice < 81`,
				})
				.expect((r) => {
					r.body.forEach((record) => {
						assert.ok(record.unitprice < 81, r.text);
					});
				})
				.expect(200);
		});

		test('select - where attr <= comparator', async () => {
			await client
				.req()
				.send({
					operation: 'sql',
					sql: `select *
		              from northnwd.products
		              where unitprice <= 81`,
				})
				.expect((r) => {
					r.body.forEach((record) => {
						assert.ok(record.unitprice <= 81, r.text);
					});
				})
				.expect(200);
		});

		test('select - where attr > comparator', async () => {
			await client
				.req()
				.send({
					operation: 'sql',
					sql: `select *
		              from northnwd.products
		              where unitprice > 81`,
				})
				.expect((r) => {
					r.body.forEach((record) => {
						assert.ok(record.unitprice > 81, r.text);
					});
				})
				.expect(200);
		});

		test('select - where attr >= comparator', async () => {
			await client
				.req()
				.send({
					operation: 'sql',
					sql: `select *
		              from northnwd.products
		              where unitprice >= 81`,
				})
				.expect((r) => {
					r.body.forEach((record) => {
						assert.ok(record.unitprice >= 81, r.text);
					});
				})
				.expect(200);
		});

		test('select - where attr w/ multiple comparators', async () => {
			await client
				.req()
				.send({
					operation: 'sql',
					sql: `select *
		              from northnwd.products
		              where unitprice > 20
		                AND unitprice <= 81`,
				})
				.expect((r) => {
					r.body.forEach((record) => {
						assert.ok(record.unitprice > 20, r.text);
						assert.ok(record.unitprice <= 81, r.text);
					});
				})
				.expect(200);
		});

		test('select - where w/ multiple attr comparators', async () => {
			await client
				.req()
				.send({
					operation: 'sql',
					sql: `select *
		              from northnwd.products
		              where unitprice > 10
		                AND unitprice <= 81
		                AND unitsinstock = 0`,
				})
				.expect((r) => {
					r.body.forEach((record) => {
						assert.ok(record.unitprice > 10, r.text);
						assert.ok(record.unitprice <= 81, r.text);
						assert.equal(record.unitsinstock, 0, r.text);
					});
				})
				.expect(200);
		});

		test('select - where w/ multiple comparators for multiple attrs', async () => {
			await client
				.req()
				.send({
					operation: 'sql',
					sql: `select *
		              from northnwd.products
		              where unitprice > 10
		                AND unitprice <= 81
		                AND unitsinstock > 10`,
				})
				.expect((r) => {
					r.body.forEach((record) => {
						assert.ok(record.unitprice > 10, r.text);
						assert.ok(record.unitprice <= 81, r.text);
						assert.ok(record.unitsinstock > 10, r.text);
					});
				})
				.expect(200);
		});

		test('select - where w/ IN() and multiple of comparators for multiple attrs', async () => {
			await client
				.req()
				.send({
					operation: 'sql',
					sql: `select *
		              from northnwd.products
		              where unitprice > 10
		                AND unitprice <= 81
		                AND unitsinstock > 10
		                AND supplierid IN (1, 2, 3, 4)`,
				})
				.expect((r) => {
					r.body.forEach((record) => {
						assert.ok(record.unitprice > 10, r.text);
						assert.ok(record.unitprice <= 81, r.text);
						assert.ok(record.unitsinstock > 10, r.text);
						assert.ok([1, 2, 3, 4].includes(record.supplierid), r.text);
					});
				})
				.expect(200);
		});

		test('update SQL employee', async () => {
			await client
				.req()
				.send({
					operation: 'sql',
					sql: `update northnwd.employees
		              set address = 'abc1234'
		              where employeeid = 1`,
				})
				.expect((r) => assert.equal(r.body.update_hashes[0], 1, r.text))
				.expect(200);
		});

		test('select verify SQL update', async () => {
			await client
				.req()
				.send({
					operation: 'sql',
					sql: `select address
		              from northnwd.employees
		              where employeeid = 1`,
				})
				.expect((r) => assert.equal(r.body[0].address, 'abc1234', r.text))
				.expect(200);
		});

		test('select * dev.long_text', async () => {
			await client
				.req()
				.send({ operation: 'sql', sql: 'select * FROM dev.long_text' })
				.expect((r) => assert.equal(r.body.length, 25, r.text))
				.expect((r) => {
					r.body.forEach((record) => {
						assert.ok(record.remarks.length > 255, r.text);
					});
				})
				.expect(200);
		});

		test('select * dev.long_text regexp', async () => {
			await client
				.req()
				.send({ operation: 'sql', sql: "select * FROM dev.long_text where remarks regexp 'dock'" })
				.expect((r) => assert.equal(r.body.length, 3, r.text))
				.expect((r) => {
					r.body.forEach((record) => {
						assert.ok(record.remarks.indexOf('dock') >= 0, r.text);
					});
				})
				.expect(200);
		});

		test('update employee with falsey data', async () => {
			await client
				.req()
				.send({
					operation: 'sql',
					sql: `UPDATE northnwd.employees
		              SET address   = false,
		                  hireDate  = 0,
		                  notes     = null,
		                  birthdate = undefined
		              WHERE employeeid = 1`,
				})
				.expect((r) => assert.equal(r.body.update_hashes[0], 1, r.text))
				.expect(200);
		});

		test('select employee to confirm falsey update', async () => {
			await client
				.req()
				.send({
					operation: 'sql',
					sql: `SELECT *
		              FROM northnwd.employees
		              WHERE employeeid = 1`,
				})
				.expect((r) => {
					assert.ok(!r.body[0].address, r.text);
					assert.equal(r.body[0].hireDate, 0, r.text);
					assert.ok(!r.body.hasOwnProperty('notes'), r.text);
					assert.ok(!r.body.hasOwnProperty('birthdate'), r.text);
				})
				.expect(200);
		});

		test('setup for next test - insert array', async () => {
			await client
				.req()
				.send({
					operation: 'insert',
					schema: `northnwd`,
					table: `customers`,
					records: [{ array: ['arr1', 'arr2', 'arr3'], customerid: 'arrayTest' }],
				})
				.expect((r) => assert.equal(r.body.message, 'inserted 1 of 1 records', r.text))
				.expect((r) => assert.equal(r.body.inserted_hashes[0], 'arrayTest', r.text))
				.expect(200);
		});

		test('select array from table', async () => {
			await client
				.req()
				.send({
					operation: 'sql',
					sql: `select *
		              from northnwd.customers
		              where customerid = 'arrayTest'`,
				})
				.expect((r) => assert.deepEqual(r.body[0].array, ['arr1', 'arr2', 'arr3'], r.text))
				.expect((r) => assert.equal(r.body[0].customerid, 'arrayTest', r.text))
				.expect(200);
		});

		test('setup for next test - insert object', async () => {
			await client
				.req()
				.send({
					operation: 'insert',
					schema: `northnwd`,
					table: `customers`,
					records: [{ object: { red: '1', white: '2', blue: '3' }, customerid: 'objTest' }],
				})
				.expect((r) => assert.equal(r.body.message, 'inserted 1 of 1 records', r.text))
				.expect((r) => assert.equal(r.body.inserted_hashes[0], 'objTest', r.text))
				.expect(200);
		});

		test('select object from table', async () => {
			await client
				.req()
				.send({
					operation: 'sql',
					sql: `select *
		              from northnwd.customers
		              where customerid = 'objTest'`,
				})
				.expect((r) => assert.deepEqual(r.body[0].object, { red: '1', white: '2', blue: '3' }, r.text))
				.expect((r) => assert.equal(r.body[0].customerid, 'objTest', r.text))
				.expect(200);
		});

		test('select without sql parameter', async () => {
			await client
				.req()
				.send({
					operation: 'sql',
					slq: `select *
		              from northnwd.customers`,
				})
				.expect((r) => assert.equal(r.body.error, "The 'sql' parameter is missing from the request body", r.text))
				.expect(400);
		});

		test('select * dev.remarks_blob like w/ special chars pt1', async () => {
			await client
				.req()
				.send({ operation: 'sql', sql: "select * FROM dev.remarks_blob where remarks like '%4 Bedroom/2.5+ bath%'" })
				.expect((r) => assert.equal(r.body.length, 3, r.text))
				.expect((r) => {
					r.body.forEach((record) => {
						let keys = Object.keys(record);
						if (keys.indexOf('__updatedtime__') > -1 && keys.indexOf('__createdtime__') > -1) {
							assert.equal(keys.length, 5, r.text);
						} else {
							assert.equal(keys.length, 3, r.text);
						}
						assert.ok(record.remarks.includes('4 Bedroom/2.5+ bath'), r.text);
					});
				})
				.expect(200);
		});

		test('select * dev.remarks_blob like w/ special chars pt2', async () => {
			await client
				.req()
				.send({
					operation: 'sql',
					sql: "select * FROM dev.remarks_blob where remarks like 'This custom built dream home is stunningly gorgeous!  It is a 5+ acres luxury equestrian property with access to Jennings State Forest from your backyard, no need to trailer your horses anywhere for a beautifully scenic peaceful ride.%'",
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
								'This custom built dream home is stunningly gorgeous!  It is a 5+ acres luxury equestrian property with access to' +
									' Jennings State Forest from your backyard, no need to trailer your horses anywhere for a beautifully scenic peaceful ride.'
							)
						);
					});
				})
				.expect(200);
		});

		test('select * dev.remarks_blob like w/ special chars pt3', async () => {
			await client
				.req()
				.send({
					operation: 'sql',
					sql: "select * FROM dev.remarks_blob where remarks like '%...GOURGEOUS HOME in a Heart of MANDARIN,Next to Loretto Magnet schoolClose to I-295, shopping & entertainment. Gated community! Loaded with upgrades:%'",
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
								'...GOURGEOUS HOME in a Heart of MANDARIN,Next to Loretto Magnet schoolClose to I-295, ' +
									'shopping & entertainment. Gated community! Loaded with upgrades:'
							)
						);
					});
				})
				.expect(200);
		});

		test('select * dev.remarks_blob like w/ special chars pt4', async () => {
			await client
				.req()
				.send({
					operation: 'sql',
					sql: "select * FROM dev.remarks_blob where remarks like '**Spacious & updated 2-story home on large preserve lot nearly 1/2 acre! Concrete block constr. & desirable ICW location near JTB, shopping, dining & the beach! Great split BD flrpln w/soaring ceilings features 4BD + office, upstairs loft & 3 full BA.'",
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
								'**Spacious & updated 2-story home on large preserve ' +
									'lot nearly 1/2 acre! Concrete block constr. & desirable ICW location near JTB, shopping, ' +
									'dining & the beach! Great split BD flrpln w/soaring ceilings features 4BD + office, upstairs loft & 3 full BA.'
							)
						);
					});
				})
				.expect(200);
		});

		test('select * dev.remarks_blob like w/ special chars pt5', async () => {
			await client
				.req()
				.send({ operation: 'sql', sql: "select * FROM dev.remarks_blob where remarks like '%'" })
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

		test('select * FROM schema.ords_tb LIMIT 100 OFFSET 0', async () => {
			await client
				.req()
				.send({
					operation: 'sql',
					sql: `select *
		              FROM northnwd.orders LIMIT 100
		              OFFSET 0`,
				})
				.expect((r) => {
					assert.equal(r.body.length, 100, r.text);
					assert.equal(r.body[0].orderid, 10248, r.text);
					assert.equal(r.body[99].orderid, 10347, r.text);
				})
				.expect(200);
		});

		test('select * FROM schema.ords_tb LIMIT 100 OFFSET 0 Copy', async () => {
			await client
				.req()
				.send({
					operation: 'sql',
					sql: `select *
		              FROM northnwd.orders LIMIT 100
		              OFFSET 100`,
				})
				.expect((r) => {
					assert.equal(r.body.length, 100, r.text);
					assert.equal(r.body[0].orderid, 10348, r.text);
					assert.equal(r.body[99].orderid, 10447, r.text);
				})
				.expect(200);
		});

		test('select AVE(rating) w/ join, group by and order by (1 of 2)', async () => {
			await client
				.req()
				.send({
					operation: 'sql',
					sql: 'select b.authors as authors, AVG(r.rating) as rating from dev.ratings as r join dev.books as b on r.book_id = b.id group by b.authors order by rating desc',
				})
				.expect((r) => {
					assert.equal(r.body.length, 26, r.text);
					assert.equal(r.body[0].rating, 4.46, r.text);
					assert.equal(r.body[1].rating, 4.42, r.text);
					assert.equal(r.body[25].rating, 2.77, r.text);
					assert.equal(r.body[0].authors, 'J.K. Rowling, Mary GrandPré, Rufus Beck', r.text);
					assert.equal(r.body[1].authors, 'Gabriel García Márquez, Gregory Rabassa', r.text);
					assert.equal(r.body[25].authors, 'Henry James, Patricia Crick', r.text);
				})
				.expect(200);
		});

		test('select AVE(rating) w/ join, group by and order by (2 of 2)', async () => {
			await client
				.req()
				.send({
					operation: 'sql',
					sql: 'select b.id, b.authors as authors, AVG(r.rating) from dev.ratings as r join dev.books as b on r.book_id = b.id group by b.authors, b.id order by b.id',
				})
				.expect((r) => {
					assert.equal(r.body.length, 50, r.text);
					assert.equal(r.body[0].id, 1, r.text);
					assert.equal(r.body[49].id, 50, r.text);
					assert.equal(r.body[5].id, 6, r.text);
					assert.equal(r.body[5].authors, 'J.K. Rowling, Mary GrandPré', r.text);
					assert.equal(r.body[5][`AVG(r.rating)`], 4.09, r.text);
					assert.equal(r.body[21].id, 22, r.text);
					assert.equal(r.body[21].authors, 'Edward P. Jones', r.text);
					assert.equal(r.body[21][`AVG(r.rating)`], 3.73, r.text);
				})
				.expect(200);
		});

		test('select AVE(rating) w/ join and group by (1 of 2)', async () => {
			await client
				.req()
				.send({
					operation: 'sql',
					sql: 'select b.id, b.authors as authors, AVG(r.rating) from dev.ratings as r join dev.books as b on r.book_id = b.id group by b.authors, b.id',
				})
				.expect((r) => {
					assert.equal(r.body.length, 50, r.text);
					assert.equal(Object.keys(r.body[0]).length, 3, r.text);
					assert.equal(Object.keys(r.body[49]).length, 3, r.text);
				})
				.expect(200);
		});

		test('select AVE(rating) w/ join, gb, ob, and LIMIT', async () => {
			await client
				.req()
				.send({
					operation: 'sql',
					sql: 'select b.id as id, b.authors as authors, AVG(r.rating) as rating from dev.ratings as r join dev.books as b on r.book_id = b.id group by b.id, b.authors order by id limit 10',
				})
				.expect((r) => {
					assert.equal(r.body.length, 10, r.text);
					assert.equal(r.body[0].id, 1, r.text);
					assert.equal(r.body[9].id, 10, r.text);
					assert.equal(Object.keys(r.body[0]).length, 3, r.text);
					assert.equal(Object.keys(r.body[8]).length, 3, r.text);
				})
				.expect(200);
		});

		test('select COUNT(rating) w/ join, gb, ob, limit, and OFFSET', async () => {
			await client
				.req()
				.send({
					operation: 'sql',
					sql: 'select b.authors as authors, COUNT(r.rating) as rating_count from dev.ratings as r join dev.books as b on r.book_id = b.id group by b.authors order by b.authors limit 15 offset 5',
				})
				.expect((r) => {
					assert.equal(r.body.length, 15, r.text);
					assert.equal(r.body[0].authors, 'Frank Herbert', r.text);
					assert.equal(r.body[14].authors, 'Marguerite Duras, Barbara Bray, Maxine Hong Kingston', r.text);
					assert.equal(r.body[9].authors, 'J.K. Rowling, Mary GrandPré', r.text);
					assert.equal(r.body[0].rating_count, 400, r.text);
					assert.equal(r.body[11].rating_count, 300, r.text);
				})
				.expect(200);
		});

		test('select w/ function alias in ORDER BY and LIMIT', async () => {
			await client
				.req()
				.send({
					operation: 'sql',
					sql: `select a.orderid as ords_id,
		                     a.productid,
		                     d.companyname         as companyname,
		                     d.contactmame,
		                     b.productname,
		                     ROUND(a.unitprice)    as unitprice
		              from northnwd.order_details a
		                       join northnwd.products b on a.productid = b.productid
		                       join northnwd.orders c on a.orderid = c.orderid
		                       join northnwd.customers d on c.customerid = d.customerid
		              order by unitprice DESC LIMIT 25`,
				})
				.expect((r) => {
					assert.equal(r.body.length, 25, r.text);
					assert.equal(r.body[0].ords_id, 10518, r.text);
					assert.equal(r.body[0].unitprice, 264, r.text);
					assert.equal(r.body[24].ords_id, 10510, r.text);
					assert.equal(r.body[24].unitprice, 124, r.text);
					assert.equal(r.body[15].unitprice, 264, r.text);
					assert.equal(r.body[16].unitprice, 211, r.text);
					assert.equal(r.body[20].unitprice, 211, r.text);
				})
				.expect(200);
		});

		test('select w/ inconsistent table refs & ORDER BY column not in SELECT', async () => {
			await client
				.req()
				.send({
					operation: 'sql',
					sql: `SELECT a.productid, a.unitprice as unitprice
		              FROM northnwd.order_details a
		              ORDER BY a.orderid DESC`,
				})
				.expect((r) => {
					assert.equal(r.body.length, 2155, r.text);
					assert.equal(r.body[0].productid, 2, r.text);
					assert.equal(r.body[0].unitprice, 19, r.text);
					assert.equal(r.body[1].productid, 3, r.text);
					assert.equal(r.body[1].unitprice, 10, r.text);
					assert.equal(r.body[3].productid, 6, r.text);
					assert.equal(r.body[3].unitprice, 25, r.text);
					assert.equal(r.body[15].unitprice, 9.65, r.text);
					assert.equal(r.body[996].unitprice, 18, r.text);
					assert.equal(r.body[1255].unitprice, 9.5, r.text);
				})
				.expect(200);
		});

		test('select w/ inconsistent table refs, ORDER BY column not in SELECT & LIMIT/OFFSET', async () => {
			await client
				.req()
				.send({
					operation: 'sql',
					sql: `SELECT productid, a.unitprice as unitprice
		              FROM northnwd.order_details a
		              ORDER BY orderid DESC LIMIT 250
		              OFFSET 5`,
				})
				.expect((r) => {
					assert.equal(r.body.length, 250, r.text);
					assert.equal(r.body[0].productid, 8, r.text);
					assert.equal(r.body[0].unitprice, 40, r.text);
					assert.equal(r.body[1].productid, 10, r.text);
					assert.equal(r.body[1].unitprice, 31, r.text);
					assert.equal(r.body[5].productid, 16, r.text);
					assert.equal(r.body[5].unitprice, 17.45, r.text);
					assert.equal(r.body[10].unitprice, 9.65, r.text);
					assert.equal(r.body[216].unitprice, 7.75, r.text);
					assert.equal(r.body[249].unitprice, 17.45, r.text);
				})
				.expect(200);
		});

		test('select w/ inconsistent table refs & second ORDER BY column not included in SELECT', async () => {
			await client
				.req()
				.send({
					operation: 'sql',
					sql: `SELECT a.orderid as ords_id, a.unitprice as unitprice
		              FROM northnwd.order_details a
		              ORDER BY productid DESC, a.orderid DESC`,
				})
				.expect((r) => {
					assert.equal(r.body.length, 2155, r.text);
					assert.equal(r.body[0].ords_id, 11077, r.text);
					assert.equal(r.body[0].unitprice, 13, r.text);
					assert.equal(r.body[1].ords_id, 11068, r.text);
					assert.equal(r.body[1].unitprice, 13, r.text);
					assert.equal(r.body[3].ords_id, 11015, r.text);
					assert.equal(r.body[3].unitprice, 13, r.text);
					assert.equal(r.body[15].unitprice, 13, r.text);
					assert.equal(r.body[996].unitprice, 46, r.text);
					assert.equal(r.body[1255].unitprice, 14.4, r.text);
				})
				.expect(200);
		});

		test('select w/ inconsistent table refs, second ORDER BY column not included in SELECT & LIMIT/OFFSETS', async () => {
			await client
				.req()
				.send({
					operation: 'sql',
					sql: `SELECT a.orderid as ords_id, a.unitprice as unitprice
		              FROM northnwd.order_details a
		              ORDER BY productid DESC, a.orderid DESC LIMIT 205
		              OFFSET 50`,
				})
				.expect((r) => {
					assert.equal(r.body.length, 205, r.text);
					assert.equal(r.body[0].ords_id, 10808, r.text);
					assert.equal(r.body[0].unitprice, 18, r.text);
					assert.equal(r.body[1].ords_id, 10749, r.text);
					assert.equal(r.body[1].unitprice, 18, r.text);
					assert.equal(r.body[3].ords_id, 10732, r.text);
					assert.equal(r.body[3].unitprice, 18, r.text);
					assert.equal(r.body[16].unitprice, 14.4, r.text);
					assert.equal(r.body[66].unitprice, 6.2, r.text);
					assert.equal(r.body[204].unitprice, 15, r.text);
				})
				.expect(200);
		});

		test('Select * on 3 table INNER JOIN', async () => {
			await client
				.req()
				.send({
					operation: 'sql',
					sql: 'SELECT `d`.*, `b`.*, `o`.* FROM `dev`.`dog` AS `d` INNER JOIN `dev`.`breed` AS `b` ON `d`.`breed_id` = `b`.`id` INNER JOIN `dev`.`owner` AS `o` ON `d`.`owner_id` = `o`.`id` ORDER BY `dog_name`',
				})
				.expect((r) => {
					assert.equal(r.body.length, 7, r.text);
					r.body.forEach((row) => {
						assert.ok(row.id, r.text);
						assert.ok(row.id1, r.text);
						assert.ok(row.id2, r.text);
						assert.ok(row.name, r.text);
						assert.ok(row.name1, r.text);
					});
				})
				.expect((r) => {
					assert.equal(r.body[1].name1, 'Sam', r.text);
					assert.equal(r.body[1].id2, 1, r.text);
					assert.equal(r.body[4].id1, 154, r.text);
				})
				.expect(200);
		});

		test('Select with basic CROSS SCHEMA JOIN', async () => {
			await client
				.req()
				.send({
					operation: 'sql',
					sql: 'SELECT d.id, d.dog_name, d.age, d.adorable, o.id, o.name FROM dev.dog AS d INNER JOIN other.owner AS o ON d.owner_id = o.id',
				})
				.expect((r) => assert.equal(r.body.length, 8, r.text))
				.expect((r) => {
					r.body.forEach((row) => {
						assert.ok(row.id, r.text);
						assert.ok(row.id1, r.text);
						assert.ok(row.dog_name, r.text);
						assert.ok(row.age, r.text);
						assert.ok(row.name, r.text);
					});
				})
				.expect((r) => {
					assert.equal(r.body[1].name, 'David', r.text);
					assert.equal(r.body[1].id1, 3, r.text);
					assert.equal(r.body[4].id1, 2, r.text);
				})
				.expect(200);
		});

		test('Select with complex CROSS SCHEMA JOIN', async () => {
			await client
				.req()
				.send({
					operation: 'sql',
					sql: 'SELECT d.id, d.dog_name, d.age, d.adorable, o.* FROM dev.dog AS d INNER JOIN other.owner AS o ON d.owner_id = o.id ORDER BY o.name, o.id LIMIT 5 OFFSET 1',
				})
				.expect((r) => {
					assert.equal(r.body.length, 5, r.text);
					r.body.forEach((row) => {
						assert.ok(row.id, r.text);
						assert.ok(row.id1, r.text);
						assert.ok(row.dog_name, r.text);
						assert.ok(row.age, r.text);
						assert.ok(row.name, r.text);
					});
				})
				.expect((r) => {
					assert.equal(r.body[0].name, 'David', r.text);
					assert.equal(r.body[0].id, 6, r.text);
					assert.equal(r.body[0].id1, 3, r.text);
					assert.equal(r.body[4].name, 'Kyle', r.text);
					assert.equal(r.body[4].id, 5, r.text);
					assert.equal(r.body[4].id1, 2, r.text);
				})
				.expect(200);
		});

		test('Select with basic CROSS 3 SCHEMA JOINS', async () => {
			await client
				.req()
				.send({
					operation: 'sql',
					sql: 'SELECT d.id, d.dog_name, d.age, d.adorable, o.id, o.name, b.id, b.name FROM dev.dog AS d INNER JOIN other.owner AS o ON d.owner_id = o.id INNER JOIN another.breed AS b ON d.breed_id = b.id',
				})
				.expect((r) => {
					assert.equal(r.body.length, 7, r.text);
					r.body.forEach((row) => {
						assert.ok(row.id, r.text);
						assert.ok(row.id1, r.text);
						assert.ok(row.id2, r.text);
						assert.ok(row.dog_name, r.text);
						assert.ok(row.age, r.text);
						assert.ok(row.name, r.text);
						assert.ok(row.name1, r.text);
					});
				})
				.expect((r) => {
					assert.equal(r.body[1].name, 'David', r.text);
					assert.equal(r.body[1].id1, 3, r.text);
					assert.equal(r.body[4].id1, 2, r.text);
					assert.equal(r.body[6].id1, 1, r.text);
					assert.equal(r.body[6].name1, 'MASTIFF', r.text);
				})
				.expect(200);
		});

		test('Select with complex CROSS 3 SCHEMA JOINS', async () => {
			await client
				.req()
				.send({
					operation: 'sql',
					sql: 'SELECT d.age AS dog_age, AVG(d.weight_lbs) AS dog_weight, o.name AS owner_name, b.name FROM dev.dog AS d INNER JOIN other.owner AS o ON d.owner_id = o.id INNER JOIN another.breed AS b ON d.breed_id = b.id GROUP BY o.name, b.name, d.age ORDER BY b.name',
				})
				.expect((r) => {
					assert.equal(r.body.length, 7, r.text);
					r.body.forEach((row) => {
						assert.ok(row.dog_age, r.text);
						assert.ok(row.dog_weight, r.text);
						assert.ok(row.owner_name, r.text);
						assert.ok(row.name, r.text);
					});
				})
				.expect((r) => {
					assert.equal(r.body[0].dog_age, 1, r.text);
					assert.equal(r.body[0].dog_weight, 35, r.text);
					assert.equal(r.body[0].owner_name, 'Kaylan', r.text);
					assert.equal(r.body[0].name, 'BEAGLE MIX', r.text);
					assert.equal(r.body[6].dog_age, 5, r.text);
					assert.equal(r.body[6].dog_weight, 35, r.text);
					assert.equal(r.body[6].owner_name, 'Kyle', r.text);
					assert.equal(r.body[6].name, 'WHIPPET', r.text);
				})
				.expect(200);
		});

		test('Select - simple full table query', async () => {
			await client
				.req()
				.send({ operation: 'sql', sql: 'SELECT * FROM dev.dog' })
				.expect((r) => assert.equal(r.body.length, 9, r.text))
				.expect((r) => {
					r.body.forEach((row) => {
						assert.equal(Object.keys(row).length, 9, r.text);
					});
				})
				.expect(200);
		});

		test('Select - simple full table query w/ * and alias', async () => {
			await client
				.req()
				.send({ operation: 'sql', sql: 'SELECT *, dog_name as dname FROM dev.dog' })
				.expect((r) => assert.equal(r.body.length, 9, r.text))
				.expect((r) => {
					r.body.forEach((row) => {
						assert.equal(Object.keys(row).length, 9, r.text);
						assert.ok(row.dname, r.text);
						assert.ok(!row.dog_name, r.text);
					});
				})
				.expect(200);
		});

		test('Select - simple full table query w/ single alias', async () => {
			await client
				.req()
				.send({ operation: 'sql', sql: 'SELECT dog_name as dname FROM dev.dog' })
				.expect((r) => assert.equal(r.body.length, 9, r.text))
				.expect((r) => {
					r.body.forEach((row) => {
						assert.equal(Object.keys(row).length, 1, r.text);
						assert.ok(row.dname, r.text);
						assert.ok(!row.dog_name, r.text);
					});
				})
				.expect(200);
		});

		test('Select - simple full table query w/ multiple aliases', async () => {
			await client
				.req()
				.send({ operation: 'sql', sql: 'SELECT id as dog_id, dog_name as dname, age as dog_age FROM dev.dog' })
				.expect((r) => assert.equal(r.body.length, 9, r.text))
				.expect((r) => {
					r.body.forEach((row) => {
						assert.equal(Object.keys(row).length, 3, r.text);
						assert.ok(row.dname, r.text);
						assert.ok(!row.dog_name, r.text);
						assert.ok(row.dog_id, r.text);
						assert.ok(!row.id, r.text);
						assert.ok(row.dog_age, r.text);
						assert.ok(!row.age, r.text);
					});
				})
				.expect(200);
		});

		test('Select - simple full table query from leading_zero', async () => {
			await client
				.req()
				.send({ operation: 'sql', sql: 'SELECT * FROM dev.leading_zero' })
				.expect((r) => assert.equal(r.body.length, 3, r.text))
				.expect((r) => {
					let ids = [];
					let expected_ids = [0, '00011', '011'];
					r.body.forEach((row) => {
						ids.push(row.id);
					});
					assert.deepEqual(ids, expected_ids, r.text);
				})
				.expect(200);
		});

		test('Select - basic self JOIN', async () => {
			await client
				.req()
				.send({
					operation: 'sql',
					sql: 'SELECT a.* FROM dev.owner as a INNER JOIN dev.owner as b ON a.name = b.best_friend',
				})
				.expect((r) => assert.equal(r.body.length, 1, r.text))
				.expect((r) => assert.equal(r.body[0].id, 1, r.text))
				.expect(200);
		});

		test('Select - basic self JOIN - reverse scenario', async () => {
			await client
				.req()
				.send({
					operation: 'sql',
					sql: 'SELECT b.* FROM dev.owner as a INNER JOIN dev.owner as b ON a.name = b.best_friend',
				})
				.expect((r) => assert.equal(r.body.length, 1, r.text))
				.expect((r) => assert.equal(r.body[0].id, 3, r.text))
				.expect(200);
		});

		test('query from leading_zero where id = 0', async () => {
			await client
				.req()
				.send({ operation: 'sql', sql: 'SELECT * FROM dev.leading_zero where id = 0' })
				.expect((r) => {
					assert.equal(r.body.length, 1, r.text);
					assert.equal(r.body[0].id, 0, r.text);
					assert.equal(r.body[0].another_attribute, 'another_1', r.text);
					assert.equal(r.body[0].some_attribute, 'some_att1', r.text);
				})
				.expect(200);
		});

		test("query from leading_zero where id = '011'", async () => {
			await client
				.req()
				.send({ operation: 'sql', sql: "SELECT * FROM dev.leading_zero where id = '011'" })
				.expect((r) => {
					assert.equal(r.body.length, 1, r.text);
					assert.equal(r.body[0].id, '011', r.text);
					assert.equal(r.body[0].another_attribute, 'another_2', r.text);
					assert.equal(r.body[0].some_attribute, 'some_att2', r.text);
				})
				.expect(200);
		});

		test('query from leading_zero where id = 011', async () => {
			await client
				.req()
				.send({ operation: 'sql', sql: 'SELECT * FROM dev.leading_zero where id = 011' })
				.expect((r) => assert.equal(r.body.length, 0, r.text))
				.expect(200);
		});

		test('insert record with dog_name =  single space value & empty string', async () => {
			await client
				.req()
				.send({ operation: 'sql', sql: "INSERT INTO dev.dog (id, dog_name) VALUES (1111, ' '), (2222, '')" })
				.expect((r) => assert.equal(r.body.message, 'inserted 2 of 2 records', r.text))
				.expect((r) => assert.deepEqual(r.body.inserted_hashes, [1111, 2222], r.text))
				.expect(200);
		});

		test('SELECT record with dog_name = single space and validate value', async () => {
			await client
				.req()
				.send({ operation: 'sql', sql: "SELECT id, dog_name FROM dev.dog  WHERE dog_name = ' '" })
				.expect((r) => assert.deepEqual(r.body, [{ id: 1111, dog_name: ' ' }], r.text))
				.expect(200);
		});

		test('SELECT record with dog_name = empty string and validate value', async () => {
			await client
				.req()
				.send({ operation: 'sql', sql: "SELECT id, dog_name FROM dev.dog  WHERE dog_name = ''" })
				.expect((r) => assert.deepEqual(r.body, [{ id: 2222, dog_name: '' }], r.text))
				.expect(200);
		});

		test('Delete dev.dog records previously created', async () => {
			await client
				.req()
				.send({ operation: 'sql', sql: 'DELETE FROM dev.dog WHERE id IN (1111, 2222)' })
				.expect((r) => assert.deepEqual(r.body.deleted_hashes, [1111, 2222], r.text))
				.expect(200);
		});
	});

	suite('4. NoSQL Tests', () => {
		//NoSQL Tests Folder

		//Invalid Attribute Check

		test('insert invalid attribute name - single row', async () => {
			await client
				.req()
				.send({
					operation: 'insert',
					schema: 'dev',
					table: 'invalid_attribute',
					records: [{ 'id': 1, 'some`$`attribute': 'some_attribute' }],
				})
				.expect((r) =>
					assert.equal(r.body.error, 'Attribute names cannot include backticks or forward slashes', r.text)
				)
				.expect(400);
		});

		test('update single row w/ invalid attribute name', async () => {
			await client
				.req()
				.send({
					operation: 'update',
					schema: 'dev',
					table: 'invalid_attribute',
					records: [{ 'id': 100, 'some/attribute': 'some_attribute' }],
				})
				.expect((r) =>
					assert.equal(r.body.error, 'Attribute names cannot include backticks or forward slashes', r.text)
				)
				.expect(400);
		});

		test('insert all invalid attribute names - multiple rows', async () => {
			await client
				.req()
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
				.expect((r) =>
					assert.equal(r.body.error, 'Attribute names cannot include backticks or forward slashes', r.text)
				)
				.expect(400);
		});

		test('update multiple rows with invalid attribute', async () => {
			await client
				.req()
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
				.expect((r) =>
					assert.equal(r.body.error, 'Attribute names cannot include backticks or forward slashes', r.text)
				)
				.expect(400);
		});

		test('upsert multiple rows with invalid attribute key', async () => {
			await client
				.req()
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
				.expect((r) =>
					assert.equal(r.body.error, 'Attribute names cannot include backticks or forward slashes', r.text)
				)
				.expect(400);
		});

		test('insert some invalid attribute names - multiple rows', async () => {
			await client
				.req()
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
				.expect((r) =>
					assert.equal(r.body.error, 'Attribute names cannot include backticks or forward slashes', r.text)
				)
				.expect(400);
		});

		//Search Response Data Type Check

		test('NoSQL search by hash no result', async () => {
			await client
				.req()
				.send({
					operation: 'search_by_hash',
					schema: `northnwd`,
					table: `employees`,
					primary_key: `employeeid`,
					hash_values: [100],
					get_attributes: ['firstname', 'lastname'],
				})
				.expect((r) => assert.equal(r.body.length, 0, r.text))
				.expect(200);
		});

		test('NoSQL search by hash one result', async () => {
			await client
				.req()
				.send({
					operation: 'search_by_hash',
					schema: `northnwd`,
					table: `employees`,
					primary_key: `employeeid`,
					hash_values: [1],
					get_attributes: ['firstname', 'lastname'],
				})
				.expect((r) => assert.equal(r.body.length, 1, r.text))
				.expect((r) => assert.equal(typeof r.body[0], 'object', r.text))
				.expect(200);
		});

		test('NoSQL search by hash multiple results', async () => {
			await client
				.req()
				.send({
					operation: 'search_by_hash',
					schema: `northnwd`,
					table: `employees`,
					primary_key: `employeeid`,
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

		test('NoSQL search by value no result', async () => {
			await client
				.req()
				.send({
					operation: 'search_by_value',
					schema: `northnwd`,
					table: `employees`,
					primary_key: `employeeid`,
					search_attribute: 'lastname',
					search_value: 'Xyz',
					get_attributes: ['firstname', 'lastname'],
				})
				.expect((r) => assert.equal(r.body.length, 0, r.text))
				.expect(200);
		});

		test('NoSQL search by value one result', async () => {
			await client
				.req()
				.send({
					operation: 'search_by_value',
					schema: `northnwd`,
					table: `employees`,
					primary_key: `employeeid`,
					search_attribute: 'lastname',
					search_value: 'King',
					get_attributes: ['firstname', 'lastname'],
				})
				.expect((r) => assert.equal(r.body.length, 1, r.text))
				.expect((r) => assert.equal(typeof r.body[0], 'object', r.text))
				.expect(200);
		});

		test('NoSQL search by value multiple results', async () => {
			await client
				.req()
				.send({
					operation: 'search_by_value',
					schema: `northnwd`,
					table: `employees`,
					primary_key: `employeeid`,
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

		test('NoSQL search by value limit 20', async () => {
			await client
				.req()
				.send({
					operation: 'search_by_value',
					schema: `northnwd`,
					table: `orders`,
					search_attribute: `orderid`,
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

		test('NoSQL search by value offset 20', async () => {
			await client
				.req()
				.send({
					operation: 'search_by_value',
					schema: `northnwd`,
					table: `orders`,
					search_attribute: `orderid`,
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

		test('NoSQL search by value limit 20 offset 20', async () => {
			await client
				.req()
				.send({
					operation: 'search_by_value',
					schema: `northnwd`,
					table: `orders`,
					search_attribute: `orderid`,
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

		test('NoSQL search by value reverse', async () => {
			await client
				.req()
				.send({
					operation: 'search_by_value',
					schema: `northnwd`,
					table: `orders`,
					search_attribute: `orderid`,
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

		test('NoSQL search by value reverse offset 20', async () => {
			await client
				.req()
				.send({
					operation: 'search_by_value',
					schema: `northnwd`,
					table: `orders`,
					search_attribute: `orderid`,
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

		test('NoSQL search by value reverse limit 20', async () => {
			await client
				.req()
				.send({
					operation: 'search_by_value',
					schema: `northnwd`,
					table: `orders`,
					search_attribute: `orderid`,
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

		test('NoSQL search by value reverse offset 20 limit 20', async () => {
			await client
				.req()
				.send({
					operation: 'search_by_value',
					schema: `northnwd`,
					table: `orders`,
					search_attribute: `orderid`,
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

		test('update NoSQL employee', async () => {
			await client
				.req()
				.send({
					operation: 'update',
					schema: `northnwd`,
					table: `employees`,
					records: [{ ['employeeid']: 1, address: 'def1234' }],
				})
				.expect((r) => assert.equal(r.body.update_hashes[0], 1, r.text))
				.expect(200);
		});

		test('update NoSQL employee confirm', async () => {
			await client
				.req()
				.send({
					operation: 'search_by_hash',
					schema: `northnwd`,
					table: `employees`,
					primary_key: `employeeid`,
					hash_values: [1],
					get_attributes: [`employeeid`, 'address'],
				})
				.expect((r) => assert.equal(r.body[0].employeeid, 1, r.text))
				.expect((r) => assert.equal(r.body[0].address, 'def1234', r.text))
				.expect(200);
		});

		test('update NoSQL call.aggr set data to dot & double dot', async () => {
			await client
				.req()
				.send({
					operation: 'update',
					schema: 'call',
					table: 'aggr',
					records: [{ all: 4, dog_name: '.', owner_name: '..' }],
				})
				.expect((r) => assert.equal(r.body.update_hashes[0], 4, r.text))
				.expect(200);
		});

		test('update NoSQL employee add new attribute', async () => {
			await client
				.req()
				.send({
					operation: 'update',
					schema: `northnwd`,
					table: `employees`,
					records: [{ ['employeeid']: 1, address: 'def1234', test_record: "I'mATest" }],
				})
				.expect((r) => assert.equal(r.body.update_hashes[0], 1, r.text))
				.expect(200);
			await setTimeout(200);
		});

		test('Insert with duplicate records to make sure both are not added', async () => {
			await client
				.req()
				.send({
					operation: 'insert',
					schema: `northnwd`,
					table: `employees`,
					records: [
						{
							['employeeid']: 212,
							address: 'def1234',
							lastname: 'dobolina',
							firstname: 'bob',
						},
						{
							['employeeid']: 212,
							address: 'def1234',
							lastname: 'dobolina2',
							firstname: 'bob',
						},
					],
				})
				.expect((r) => assert.equal(r.body.skipped_hashes[0], 212, r.text))
				.expect(200);
		});

		test('Insert with no hash', async () => {
			await client
				.req()
				.send({
					operation: 'insert',
					schema: `northnwd`,
					table: `employees`,
					records: [{ address: '1 North Street', lastname: 'Dog', firstname: 'Harper' }],
				})
				.expect((r) => assert.equal(r.body.inserted_hashes.length, 1, r.text))
				.expect((r) => assert.equal(r.body.message, 'inserted 1 of 1 records', r.text))
				.expect(200);
		});

		test('Insert with empty hash', async () => {
			await client
				.req()
				.send({
					operation: 'insert',
					schema: `northnwd`,
					table: `employees`,
					records: [{ ['employeeid']: '', address: '23 North Street', lastname: 'Cat', firstname: 'Brian' }],
				})
				.expect((r) => assert.equal(r.body.inserted_hashes.length, 1, r.text))
				.expect((r) => assert.equal(r.body.message, 'inserted 1 of 1 records', r.text))
				.expect(200);
		});

		test('NoSQL search by hash', async () => {
			await client
				.req()
				.send({
					operation: 'search_by_hash',
					schema: `northnwd`,
					table: `employees`,
					primary_key: `employeeid`,
					hash_values: [1],
					get_attributes: ['address', 'test_record'],
				})
				.expect((r) => assert.equal(r.body[0].address, 'def1234', r.text))
				.expect((r) => assert.equal(r.body[0].test_record, "I'mATest", r.text))
				.expect(200);
		});

		test('NoSQL search by hash - check dot & double dot', async () => {
			await client
				.req()
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

		test('NoSQL search by hash no schema', async () => {
			await client
				.req()
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

		test('NoSQL search by hash no table', async () => {
			await client
				.req()
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

		test('NoSQL search by hash hash_value bad data type', async () => {
			await client
				.req()
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

		test('NoSQL search by hash get_attributes bad data type', async () => {
			await client
				.req()
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

		test('update NoSQL employee with falsey attributes', async () => {
			await client
				.req()
				.send({
					operation: 'update',
					schema: `northnwd`,
					table: `employees`,
					records: [{ ['employeeid']: 2, address: 0, hireDate: null, notes: false }],
				})
				.expect((r) =>
					assert.equal(
						r.body.message,
						'updated 1 of 1 records',
						'Expected response message to eql "updated 1 of 1 records"'
					)
				)
				.expect((r) => assert.equal(r.body.update_hashes[0], 2, r.text))
				.expect(200);
		});

		test('NoSQL search by hash to confirm falsey update', async () => {
			await client
				.req()
				.send({
					operation: 'search_by_hash',
					schema: `northnwd`,
					table: `employees`,
					primary_key: `employeeid`,
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

		test('update NoSQL one employee record with no hash attribute', async () => {
			await client
				.req()
				.send({
					operation: 'update',
					schema: `northnwd`,
					table: `employees`,
					records: [{ address: '3000 Dog Place' }],
				})
				.expect((r) =>
					assert.equal(
						r.body.error,
						'a valid hash attribute must be provided with update record, check log for more info',
						r.text
					)
				)
				.expect(400);
		});

		test('update NoSQL one employee record with empty hash attribute', async () => {
			await client
				.req()
				.send({
					operation: 'update',
					schema: `northnwd`,
					table: `employees`,
					records: [{ ['employeeid']: '', address: '123 North Blvd', notes: 'This guy is the real deal' }],
				})
				.expect((r) =>
					assert.equal(
						r.body.error,
						'a valid hash attribute must be provided with update record, check log for more info',
						r.text
					)
				)
				.expect(400);
		});

		test('update NoSQL multiple employee records with no hash attribute', async () => {
			await client
				.req()
				.send({
					operation: 'update',
					schema: `northnwd`,
					table: `employees`,
					records: [
						{
							['employeeid']: 2,
							address: '123 North Blvd',
							notes: 'This guy is the real deal',
						},
						{ address: '45 Lost St', notes: "This person doesn't even have an id!" },
						{
							['employeeid']: 3,
							address: '1 Main St',
							notes: 'This guy okay',
						},
					],
				})
				.expect((r) =>
					assert.equal(
						r.body.error,
						'a valid hash attribute must be provided with update record, check log for more info',
						r.text
					)
				)
				.expect(400);
		});

		test('update NoSQL employee with valid nonexistent hash', async () => {
			await client
				.req()
				.send({
					operation: 'update',
					schema: `northnwd`,
					table: `employees`,
					records: [{ ['employeeid']: 'There is no way this exists', notes: 'who is this fella?' }],
				})
				.expect((r) => {
					if (r.body.message === 'updated 0 of 1 records') {
						assert.equal(r.body.message, 'updated 0 of 1 records', r.text);
						assert.deepEqual(r.body.update_hashes, [], r.text);
						assert.equal(r.body.skipped_hashes[0], 'There is no way this exists', r.text);
					} else if (r.body.message === 'updated 1 of 1 records') {
						assert.equal(
							r.body.message,
							'updated 1 of 1 records',
							'Expected response message to eql "updated 1 of 1 records"'
						);
						assert.equal(r.body.update_hashes[0], 'There is no way this exists', r.text);
						assert.deepEqual(r.body.skipped_hashes, [], r.text);
					}
				})
				.expect(200);
		});

		test('NoSQL search by value - * at end', { skip: bunSkip }, async () => {
			await client
				.req()
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

		test('NoSQL search by value - * at start', { skip: bunSkip }, async () => {
			await client
				.req()
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

		test('NoSQL search by value - * at start and end', { skip: bunSkip }, async () => {
			await client
				.req()
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

		test('NoSQL search by value - * as search_value', async () => {
			await client
				.req()
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

		test('NoSQL search by value - *** at start', { skip: bunSkip }, async () => {
			await client
				.req()
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

		test('NoSQL search by hash on leading_zero, value = 0', async () => {
			await client
				.req()
				.send({
					operation: 'search_by_hash',
					schema: 'dev',
					table: 'leading_zero',
					primary_key: 'id',
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

		test('NoSQL search by hash on leading_zero, values "011","00011"', async () => {
			await client
				.req()
				.send({
					operation: 'search_by_hash',
					schema: 'dev',
					table: 'leading_zero',
					primary_key: 'id',
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

		test('NoSQL search by value leading_zero - value = 0', async () => {
			await client
				.req()
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

		test('NoSQL search by value leading_zero - value = "011"', async () => {
			await client
				.req()
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

		test('NoSQL search by value leading_zero - value = "0*"', async () => {
			await client
				.req()
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

		test('Upsert into products 1 new record & 2 that exist', async () => {
			await client
				.req()
				.send({
					operation: 'upsert',
					schema: `northnwd`,
					table: `products`,
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

		test('Confirm upserted records exist and are updated', async () => {
			await client
				.req()
				.send({
					operation: 'search_by_value',
					schema: `northnwd`,
					table: `products`,
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

		test('Upsert into products 3 new records w/o hash vals', async () => {
			await client
				.req()
				.send({
					operation: 'upsert',
					schema: `northnwd`,
					table: `products`,
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

		test('Remove added record from products', async () => {
			await client
				.req()
				.send({ operation: 'delete', schema: `northnwd`, table: `products`, hash_values: [100] })
				.expect((r) => {
					assert.equal(r.body.deleted_hashes.length, 1, r.text);
					assert.deepEqual(r.body.deleted_hashes, [100], r.text);
					assert.equal(r.body.skipped_hashes.length, 0, r.text);
					assert.deepEqual(r.body.skipped_hashes, [], r.text);
					assert.equal(r.body.message, '1 of 1 record successfully deleted', r.text);
				})
				.expect(200);
		});

		test('Update products 1 existing record & one that does not exist', async () => {
			await client
				.req()
				.send({
					operation: 'update',
					schema: `northnwd`,
					table: `products`,
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

		test('Restore Product record', async () => {
			await client
				.req()
				.send({
					operation: 'update',
					schema: `northnwd`,
					table: `products`,
					records: [{ productid: 1, discontinued: 'False' }],
				})
				.expect((r) =>
					assert.equal(
						r.body.message,
						'updated 1 of 1 records',
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

		test('attempt to update __createdtime__', async () => {
			await client
				.req()
				.send({
					operation: 'update',
					schema: `northnwd`,
					table: `employees`,
					records: [{ ['employeeid']: 1, __createdtime__: 'bad value' }],
				})
				.expect((r) => assert.equal(r.body.update_hashes[0], 1, r.text))
				.expect(200);
		});

		test('confirm __createdtime__ did not change', async () => {
			await client
				.req()
				.send({
					operation: 'search_by_hash',
					schema: `northnwd`,
					table: `employees`,
					primary_key: `employeeid`,
					hash_values: [1],
					get_attributes: [`employeeid`, '__createdtime__'],
				})
				.expect((r) => assert.equal(r.body[0].employeeid, 1, r.text))
				.expect((r) => assert.notEqual(r.body[0].__createdtime__, 'bad value', r.text))
				.expect(200);
		});

		test('insert record with dog_name =  single space value & empty string', async () => {
			await client
				.req()
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

		test('search by value dog_name = single space string', async () => {
			await client
				.req()
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

		test('search by value dog_name = empty string', async () => {
			await client
				.req()
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

		test('Delete dev.dog records previously created', async () => {
			await client
				.req()
				.send({ operation: 'delete', schema: 'dev', table: 'dog', hash_values: [1111, 2222] })
				.expect((r) => assert.deepEqual(r.body.deleted_hashes, [1111, 2222], r.text))
				.expect(200);
		});

		test('Search by value 123.4', async () => {
			await client
				.req()
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

		test('Search by hash 123.4', async () => {
			await client
				.req()
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

		test('Delete 123.4 record', async () => {
			await client
				.req()
				.send({ operation: 'delete', schema: '123', table: '4', hash_values: [987654321] })
				.expect((r) => assert.equal(r.body.message, '1 of 1 record successfully deleted', r.text))
				.expect(200);
		});

		test('search by conditions - equals', async () => {
			await client
				.req()
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

		test('search by conditions - contains', async () => {
			await client
				.req()
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

		test('search by conditions - starts_with', async () => {
			await client
				.req()
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

		test('search by conditions - ends_with', async () => {
			await client
				.req()
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

		test('search by conditions - greater_than', async () => {
			await client
				.req()
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

		test('search by conditions - greater_than_equal', async () => {
			await client
				.req()
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

		test('search by conditions - less_than', async () => {
			await client
				.req()
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

		test('search by conditions - less_than_equal', async () => {
			await client
				.req()
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

		test('search by conditions - between', async () => {
			await client
				.req()
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

		test('search by conditions - between using same value', async () => {
			await client
				.req()
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

		test('search by conditions - between w/ alpha', async () => {
			await client
				.req()
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

		test('search by conditions - equals & equals', async () => {
			await client
				.req()
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

		test('search by conditions - equals || equals', async () => {
			await client
				.req()
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

		test('search by conditions - equals & contains', async () => {
			await client
				.req()
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

		test('search by conditions - equals & ends_with', async () => {
			await client
				.req()
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

		test('search by conditions - greater_than_equal & starts_with', async () => {
			await client
				.req()
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

		test('search by conditions - less_than_equal ||  greater_than', async () => {
			await client
				.req()
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

		test('search by conditions - contains || contains', async () => {
			await client
				.req()
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

		test('search by conditions - contains & between', async () => {
			await client
				.req()
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

		test('search by conditions - starts_with "AND" between', async () => {
			await client
				.req()
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

		test('search by conditions - starts_with & between w/ offset', async () => {
			await client
				.req()
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

		test('search by conditions - starts_with & between limit', async () => {
			await client
				.req()
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

		test('search by conditions - starts_with & between offset, limit', async () => {
			await client
				.req()
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

		test('search by conditions - starts_with condition, offset, limit of 2', async () => {
			await client
				.req()
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

		test('search by conditions - starts_with condition, offset, limit of 10', async () => {
			await client
				.req()
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

		test('search by conditions - ends_with condition, offset, limit of 3', async () => {
			await client
				.req()
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

	suite('5. NoSQL Role Testing', () => {
		//NoSQL Role Testing Folder

		//Bulk Load Perms Tests

		test('Add non-SU bulk_load_role', async () => {
			await client
				.req()
				.send({
					operation: 'add_role',
					role: 'bulk_load_role',
					permission: {
						super_user: false,
						northnwd: {
							tables: {
								suppliers: {
									read: true,
									insert: true,
									update: true,
									delete: true,
									attribute_permissions: [
										{
											attribute_name: 'companyname',
											read: true,
											insert: true,
											update: true,
										},
									],
								},
								// Table no longer exists due to S3 removal in 2_dataLoad.mjs
								// url_csv_data: {
								// 	read: true,
								// 	insert: true,
								// 	update: true,
								// 	delete: false,
								// 	attribute_permissions: [
								// 		{
								// 			attribute_name: 'name',
								// 			read: false,
								// 			insert: true,
								// 			update: false,
								// 		},
								// 		{
								// 			attribute_name: 'section',
								// 			read: true,
								// 			insert: false,
								// 			update: true,
								// 		},
								// 		{ attribute_name: 'image', read: true, insert: true, update: true },
								// 	],
								// },
							},
						},
						dev: {
							tables: {
								books: {
									read: true,
									insert: true,
									update: true,
									delete: true,
									attribute_permissions: [
										{
											attribute_name: 'books_count',
											read: true,
											insert: false,
											update: true,
										},
									],
								},
								dog: {
									read: true,
									insert: true,
									update: true,
									delete: false,
									attribute_permissions: [
										{
											attribute_name: 'dog_name',
											read: false,
											insert: true,
											update: true,
										},
										{
											attribute_name: 'age',
											read: true,
											insert: false,
											update: true,
										},
										{
											attribute_name: 'adorable',
											read: true,
											insert: true,
											update: false,
										},
										{ attribute_name: 'owner_id', read: true, insert: false, update: false },
									],
								},
								owner: {
									read: true,
									insert: true,
									update: true,
									delete: false,
									attribute_permissions: [
										{
											attribute_name: 'name',
											read: true,
											insert: false,
											update: false,
										},
									],
								},
							},
						},
					},
				})
				.expect((r) => assert.ok(r.body.id, r.text))
				.expect(200);
		});

		test('Add user with new bulk_load_role', async () => {
			await client
				.req()
				.send({
					operation: 'add_user',
					role: 'bulk_load_role',
					username: 'bulk_load_user',
					password: `${adminPwd}`,
					active: true,
				})
				.expect(200);
		});

		test('CSV Data Load  update to table w/ new attr & restricted attrs', async () => {
			const errorMsg = await csvDataLoad(
				headersBulkLoadUser,
				'update',
				'northnwd',
				'suppliers',
				'supplierid,companyname, rando\n19,The Chum Bucket, Another attr value\n',
				'This operation is not authorized due to role restrictions and/or invalid database items'
			);
			const resText = JSON.stringify(errorMsg);
			assert.equal(errorMsg.unauthorized_access.length, 0, resText);
			assert.equal(errorMsg.invalid_schema_items.length, 1, resText);
			assert.equal(
				errorMsg.invalid_schema_items[0],
				"Attribute ' rando' does not exist on 'northnwd.suppliers'",
				resText
			);
		});

		test('CSV Data Load - upsert - to table w/ some restricted attrs & new attr', async () => {
			const errorMsg = await csvDataLoad(
				headersBulkLoadUser,
				'upsert',
				'dev',
				'dog',
				'id,dog_name,adorable,age,rando\n19,doggy,true,22,Another attr value\n',
				'This operation is not authorized due to role restrictions and/or invalid database items'
			);
			const resText = JSON.stringify(errorMsg);
			assert.equal(errorMsg.unauthorized_access.length, 1, resText);
			const unauth_obj = errorMsg.unauthorized_access[0];
			assert.equal(unauth_obj.schema, 'dev', resText);
			assert.equal(unauth_obj.table, 'dog', resText);
			assert.equal(unauth_obj.required_table_permissions.length, 0, resText);
			assert.equal(unauth_obj.required_attribute_permissions.length, 2, resText);
			assert.equal(unauth_obj.required_attribute_permissions[0].attribute_name, 'adorable', resText);
			assert.equal(unauth_obj.required_attribute_permissions[0].required_permissions.length, 1, resText);
			assert.equal(unauth_obj.required_attribute_permissions[0].required_permissions[0], 'update', resText);
			assert.equal(unauth_obj.required_attribute_permissions[1].attribute_name, 'age', resText);
			assert.equal(unauth_obj.required_attribute_permissions[1].required_permissions.length, 1, resText);
			assert.equal(unauth_obj.required_attribute_permissions[1].required_permissions[0], 'insert', resText);
			assert.equal(errorMsg.invalid_schema_items.length, 1, resText);
			assert.equal(errorMsg.invalid_schema_items[0], "Attribute 'rando' does not exist on 'dev.dog'", resText);
		});

		test.skip('CSV URL Load - upsert - to table w/ restricted attrs', async () => {
			const response = await client
				.reqAs(headersBulkLoadUser)
				.send({
					operation: 'csv_url_load',
					action: 'upsert',
					schema: `northnwd`,
					table: `url_csv_data`,
					csv_url: '', // TODO: Figure out how to safely include a public S3 URL
				})
				.expect((r) => assert.equal(r.body.message.indexOf('Starting job'), 0, r.text));

			const id = getJobId(response.body);
			const errorMsg = await checkJobCompleted(
				id,
				'This operation is not authorized due to role restrictions and/or invalid database items'
			);

			const resText = JSON.stringify(errorMsg);
			assert.equal(errorMsg.unauthorized_access.length, 1, resText);
			const unauth_obj = errorMsg.unauthorized_access[0];

			assert.equal(unauth_obj.schema, 'northnwd', resText);
			assert.equal(unauth_obj.table, 'url_csv_data', resText);
			assert.equal(unauth_obj.required_table_permissions.length, 0, resText);
			assert.equal(unauth_obj.required_attribute_permissions.length, 2, resText);
			assert.equal(unauth_obj.required_attribute_permissions[0].attribute_name, 'name', resText);
			assert.equal(unauth_obj.required_attribute_permissions[0].required_permissions.length, 1, resText);
			assert.equal(unauth_obj.required_attribute_permissions[0].required_permissions[0], 'update', resText);
			assert.equal(unauth_obj.required_attribute_permissions[1].attribute_name, 'section', resText);
			assert.equal(unauth_obj.required_attribute_permissions[1].required_permissions.length, 1, resText);
			assert.equal(unauth_obj.required_attribute_permissions[1].required_permissions[0], 'insert', resText);
			assert.equal(errorMsg.invalid_schema_items.length, 1, resText);
			assert.equal(
				errorMsg.invalid_schema_items[0],
				"Attribute 'country' does not exist on 'northnwd.url_csv_data'",
				resText
			);
		});

		test.skip('CSV URL Load - update - to table w/ restricted attrs', async () => {
			const response = await client
				.reqAs(headersBulkLoadUser)
				.send({
					operation: 'csv_url_load',
					action: 'update',
					schema: `northnwd`,
					table: `url_csv_data`,
					csv_url: '', // TODO: Figure out how to safely include a public S3 URL
				})
				.expect((r) => assert.equal(r.body.message.indexOf('Starting job'), 0, r.text));

			const id = getJobId(response.body);
			const errorMsg = await checkJobCompleted(
				id,
				'This operation is not authorized due to role restrictions and/or invalid database items'
			);
			const resText = JSON.stringify(errorMsg);
			assert.equal(errorMsg.unauthorized_access.length, 1, resText);
			const unauth_obj = errorMsg.unauthorized_access[0];

			assert.equal(unauth_obj.schema, 'northnwd', resText);
			assert.equal(unauth_obj.table, 'url_csv_data', resText);
			assert.equal(unauth_obj.required_table_permissions.length, 0, resText);
			assert.equal(unauth_obj.required_attribute_permissions.length, 1, resText);
			assert.equal(unauth_obj.required_attribute_permissions[0].attribute_name, 'name', resText);
			assert.equal(unauth_obj.required_attribute_permissions[0].required_permissions.length, 1, resText);
			assert.equal(unauth_obj.required_attribute_permissions[0].required_permissions[0], 'update', resText);
			assert.equal(errorMsg.invalid_schema_items.length, 1, resText);
			assert.equal(
				errorMsg.invalid_schema_items[0],
				"Attribute 'country' does not exist on 'northnwd.url_csv_data'",
				resText
			);
		});

		test('CSV File Load to table w/ restricted attrs', async () => {
			const response = await client
				.reqAs(headersBulkLoadUser)
				.send({
					operation: 'csv_file_load',
					action: 'insert',
					schema: 'dev',
					table: 'books',
					file_path: `${csvPath}` + 'Books.csv',
				})
				.expect((r) => assert.equal(r.body.message.indexOf('Starting job'), 0, r.text))
				.expect(200);

			const id = getJobId(response.body);
			const errorMsg = await checkJobCompleted(
				id,
				'This operation is not authorized due to role restrictions and/or invalid database items'
			);
			const resText = JSON.stringify(errorMsg);
			assert.equal(errorMsg.unauthorized_access.length, 1, resText);
			const unauth_obj = errorMsg.unauthorized_access[0];

			assert.equal(unauth_obj.schema, 'dev', resText);
			assert.equal(unauth_obj.table, 'books', resText);
			assert.equal(unauth_obj.required_table_permissions.length, 0, resText);
			assert.equal(unauth_obj.required_attribute_permissions.length, 2, resText);
			assert.equal(unauth_obj.required_attribute_permissions[0].attribute_name, 'id', resText);
			assert.equal(unauth_obj.required_attribute_permissions[0].required_permissions.length, 1, resText);
			assert.equal(unauth_obj.required_attribute_permissions[0].required_permissions[0], 'insert', resText);
			assert.equal(unauth_obj.required_attribute_permissions[1].attribute_name, 'books_count', resText);
			assert.equal(unauth_obj.required_attribute_permissions[1].required_permissions.length, 1, resText);
			assert.equal(unauth_obj.required_attribute_permissions[1].required_permissions[0], 'insert', resText);
			assert.equal(errorMsg.invalid_schema_items.length, 17, resText);

			const expected_invalid_items = [
				"Attribute 'authors' does not exist on 'dev.books'",
				"Attribute 'original_publication_year' does not exist on 'dev.books'",
				"Attribute 'original_title' does not exist on 'dev.books'",
				"Attribute 'title' does not exist on 'dev.books'",
				"Attribute 'language_code' does not exist on 'dev.books'",
				"Attribute 'average_rating' does not exist on 'dev.books'",
				"Attribute 'ratings_count' does not exist on 'dev.books'",
				"Attribute 'work_ratings_count' does not exist on 'dev.books'",
				"Attribute 'work_text_reviews_count' does not exist on 'dev.books'",
				"Attribute 'ratings_1' does not exist on 'dev.books'",
				"Attribute 'ratings_2' does not exist on 'dev.books'",
				"Attribute 'ratings_3' does not exist on 'dev.books'",
				"Attribute 'ratings_4' does not exist on 'dev.books'",
				"Attribute 'ratings_5' does not exist on 'dev.books'",
				"Attribute 'nytimes_best_seller' does not exist on 'dev.books'",
				"Attribute 'image_url' does not exist on 'dev.books'",
				"Attribute 'small_image_url' does not exist on 'dev.books'",
			];

			errorMsg.invalid_schema_items.forEach((item) => {
				assert.ok(expected_invalid_items.includes(item), resText);
			});
		});

		test.skip('Import CSV from S3 to table w/ restricted attrs', async () => {
			const response = await client
				.reqAs(headersBulkLoadUser)
				.send({
					operation: 'import_from_s3',
					action: 'insert',
					schema: 'dev',
					table: 'dog',
					s3: {}, // TODO: Figure out how to safely include S3 keys for testing and local contributor usage
				})
				.expect((r) => assert.equal(r.body.message.indexOf('Starting job'), 0, r.text));

			const id = getJobId(response.body);
			const errorMsg = await checkJobCompleted(
				id,
				'This operation is not authorized due to role restrictions and/or invalid database items'
			);
			const resText = JSON.stringify(errorMsg);
			assert.equal(errorMsg.unauthorized_access.length, 1, resText);
			const unauth_obj = errorMsg.unauthorized_access[0];

			assert.equal(unauth_obj.schema, 'dev', resText);
			assert.equal(unauth_obj.table, 'dog', resText);
			assert.equal(unauth_obj.required_table_permissions.length, 0, resText);
			assert.equal(unauth_obj.required_attribute_permissions.length, 2, resText);
			assert.equal(unauth_obj.required_attribute_permissions[0].attribute_name, 'owner_id', resText);
			assert.equal(unauth_obj.required_attribute_permissions[0].required_permissions.length, 1, resText);
			assert.equal(unauth_obj.required_attribute_permissions[0].required_permissions[0], 'insert', resText);
			assert.equal(unauth_obj.required_attribute_permissions[1].attribute_name, 'age', resText);
			assert.equal(unauth_obj.required_attribute_permissions[1].required_permissions.length, 1, resText);
			assert.equal(unauth_obj.required_attribute_permissions[1].required_permissions[0], 'insert', resText);

			assert.equal(errorMsg.invalid_schema_items.length, 2, resText);
			const expected_invalid_items = [
				"Attribute 'breed_id' does not exist on 'dev.dog'",
				"Attribute 'weight_lbs' does not exist on 'dev.dog'",
			];
			errorMsg.invalid_schema_items.forEach((item) => {
				assert.ok(expected_invalid_items.includes(item), resText);
			});
		});

		test.skip('Import JSON from S3 - upsert - to table w/ restricted attrs', async () => {
			const response = await client
				.reqAs(headersBulkLoadUser)
				.send({
					operation: 'import_from_s3',
					action: 'upsert',
					schema: 'dev',
					table: 'owner',
					s3: {}, // TODO: Figure out how to safely include S3 keys for testing and local contributor usage
				})
				.expect((r) => assert.equal(r.body.message.indexOf('Starting job'), 0, r.text));

			const id = getJobId(response.body);
			const errorMsg = await checkJobCompleted(
				id,
				'This operation is not authorized due to role restrictions and/or invalid database items'
			);
			const resText = JSON.stringify(errorMsg);
			assert.equal(errorMsg.unauthorized_access.length, 1, resText);
			const unauth_obj = errorMsg.unauthorized_access[0];

			assert.equal(unauth_obj.schema, 'dev', resText);
			assert.equal(unauth_obj.table, 'owner', resText);
			assert.equal(unauth_obj.required_table_permissions.length, 0, resText);
			assert.equal(unauth_obj.required_attribute_permissions.length, 2, resText);
			assert.equal(unauth_obj.required_attribute_permissions[0].attribute_name, 'id', resText);
			assert.equal(unauth_obj.required_attribute_permissions[0].required_permissions.length, 2, resText);
			assert.equal(unauth_obj.required_attribute_permissions[0].required_permissions[0], 'insert', resText);
			assert.equal(unauth_obj.required_attribute_permissions[0].required_permissions[1], 'update', resText);
			assert.equal(unauth_obj.required_attribute_permissions[1].attribute_name, 'name', resText);
			assert.equal(unauth_obj.required_attribute_permissions[1].required_permissions.length, 2, resText);
			assert.equal(unauth_obj.required_attribute_permissions[1].required_permissions[0], 'insert', resText);
			assert.equal(unauth_obj.required_attribute_permissions[1].required_permissions[1], 'update', resText);
			assert.equal(errorMsg.invalid_schema_items.length, 0, resText);
		});

		test.skip('Import JSON from S3 - insert - to table w/ restricted attrs', async () => {
			const response = await client
				.reqAs(headersBulkLoadUser)
				.send({
					operation: 'import_from_s3',
					action: 'insert',
					schema: 'dev',
					table: 'owner',
					s3: {}, // TODO: Figure out how to safely include S3 keys for testing and local contributor usage
				})
				.expect((r) => assert.equal(r.body.message.indexOf('Starting job'), 0, r.text));

			const id = getJobId(response.body);
			const errorMsg = await checkJobCompleted(
				id,
				'This operation is not authorized due to role restrictions and/or invalid database items'
			);
			const resText = JSON.stringify(errorMsg);
			assert.equal(errorMsg.unauthorized_access.length, 1, resText);
			const unauth_obj = errorMsg.unauthorized_access[0];

			assert.equal(unauth_obj.schema, 'dev', resText);
			assert.equal(unauth_obj.table, 'owner', resText);
			assert.equal(unauth_obj.required_table_permissions.length, 0, resText);
			assert.equal(unauth_obj.required_attribute_permissions.length, 2, resText);
			assert.equal(unauth_obj.required_attribute_permissions[0].attribute_name, 'id', resText);
			assert.equal(unauth_obj.required_attribute_permissions[0].required_permissions.length, 1, resText);
			assert.equal(unauth_obj.required_attribute_permissions[0].required_permissions[0], 'insert', resText);
			assert.equal(unauth_obj.required_attribute_permissions[1].attribute_name, 'name', resText);
			assert.equal(unauth_obj.required_attribute_permissions[1].required_permissions.length, 1, resText);
			assert.equal(unauth_obj.required_attribute_permissions[1].required_permissions[0], 'insert', resText);
			assert.equal(errorMsg.invalid_schema_items.length, 0, resText);
		});

		test('Alter non-SU bulk_load_role', async () => {
			await client
				.req()
				.send({
					operation: 'alter_role',
					id: 'bulk_load_role',
					role: 'bulk_load_role',
					permission: {
						super_user: false,
						northnwd: {
							tables: {
								suppliers: {
									read: true,
									insert: true,
									update: true,
									delete: true,
									attribute_permissions: [],
								},
							},
						},
						dev: {
							tables: {
								dog: {
									read: true,
									insert: true,
									update: true,
									delete: false,
									attribute_permissions: [
										{
											attribute_name: 'dog_name',
											read: false,
											insert: true,
											update: true,
										},
										{
											attribute_name: 'age',
											read: true,
											insert: true,
											update: true,
										},
										{
											attribute_name: 'adorable',
											read: true,
											insert: true,
											update: true,
										},
										{
											attribute_name: 'owner_id',
											read: true,
											insert: true,
											update: true,
										},
										{
											attribute_name: 'weight_lbs',
											read: true,
											insert: true,
											update: true,
										},
										{
											attribute_name: 'breed_id',
											read: true,
											insert: true,
											update: true,
										},
										{ attribute_name: '__updatedtime__', read: true, insert: true, update: false },
									],
								},
							},
						},
					},
				})
				.expect((r) => assert.equal(r.body.id, 'bulk_load_role', r.text))
				.expect(200);
		});

		test('CSV Data Load  upsert to table w/ full perms', async () => {
			await csvDataLoad(
				headersBulkLoadUser,
				'upsert',
				'northnwd',
				'suppliers',
				'companyname, new_attr\nThe Chum Bucket, Another attr value\n',
				'',
				'successfully loaded 1 of 1 records'
			);
		});

		test('Check row from Data CSV job was upserted', async () => {
			// The upsert load above is asynchronous; poll the count until the new
			// row is visible rather than asserting once (it can still be flushing
			// under Bun/CI-runner contention — #1222).
			const r = await waitFor(
				() =>
					client
						.req()
						.send({
							operation: 'sql',
							sql: `SELECT count(*) AS row_count
		                                  FROM northnwd.suppliers`,
						})
						.expect(200),
				{ until: (res) => res.body?.[0]?.row_count === 30, timeoutSeconds: isBunRuntime ? 60 : 15 }
			);
			assert.equal(r.body?.[0]?.row_count, 30, r.text);
		});

		test.skip('Import CSV from S3 to table w/ full attr perms - update', async () => {
			const response = await client
				.reqAs(headersBulkLoadUser)
				.send({
					operation: 'import_from_s3',
					action: 'update',
					schema: 'dev',
					table: 'dog',
					s3: {}, // TODO: Figure out how to safely include S3 keys for testing and local contributor usage
				})
				.expect((r) => assert.equal(r.body.message.indexOf('Starting job'), 0, r.text));

			const id = getJobId(response.body);
			await checkJobCompleted(id, '', 'successfully loaded 9 of 12 records');
		});

		test.skip('Check rows from S3 update were updated', async () => {
			await client
				.req()
				.send({ operation: 'sql', sql: 'SELECT * FROM dev.dog' })
				.expect((r) => {
					r.body.forEach((row) => {
						assert.ok(row.__updatedtime__ > row.__createdtime__, r.text);
					});
				})
				.expect(200);
		});

		// Skip related to S3 usage
		test.skip('Drop bulk_load_user', async () => {
			await client
				.req()
				.send({ operation: 'drop_user', username: 'bulk_load_user' })
				.expect((r) => assert.ok(r.body.message, r.text))
				.expect((r) => assert.ok(r.body.message.includes('successfully deleted'), r.text))
				.expect(200);
		});

		// Skip related to S3 usage
		test.skip('Drop bulk_load_user role', async () => {
			await client
				.req()
				.send({ operation: 'drop_role', id: 'bulk_load_role' })
				.expect((r) => assert.ok(r.body.message, r.text))
				.expect((r) => assert.ok(r.body.message.includes('successfully deleted'), r.text))
				.expect(200);
		});

		//NoSQL Role Testing Main Folder

		test('Authentication - bad username', async () => {
			const myHeaders = createHeaders('bad_username', adminPwd);
			await client
				.reqAs(myHeaders)
				.send({ operation: 'create_schema', schema: 'auth' })
				.expect((r) => assert.ok(r.text.includes('Login failed')))
				.expect(401);
		});

		test('Authentication - bad password', async () => {
			const myHeaders = createHeaders(adminUsername, 'bad_password');
			await client
				.reqAs(myHeaders)
				.send({ operation: 'create_schema', schema: 'auth' })
				.expect((r) => assert.ok(r.text.includes('Login failed')))
				.expect(401);
		});

		test('NoSQL Add non SU role', async () => {
			await client
				.req()
				.send({
					operation: 'add_role',
					role: 'developer_test_5',
					permission: {
						super_user: false,
						northnwd: {
							tables: {
								customers: {
									read: true,
									insert: true,
									update: true,
									delete: true,
									attribute_permissions: [],
								},
								suppliers: {
									read: false,
									insert: false,
									update: false,
									delete: false,
									attribute_permissions: [],
								},
								region: {
									read: true,
									insert: false,
									update: false,
									delete: false,
									attribute_permissions: [
										{
											attribute_name: 'regiondescription',
											read: true,
											insert: false,
											update: false,
											delete: false,
										},
									],
								},
								territories: {
									read: true,
									insert: true,
									update: false,
									delete: false,
									attribute_permissions: [
										{
											attribute_name: 'territorydescription',
											read: true,
											insert: true,
											update: false,
											delete: false,
										},
									],
								},
								categories: {
									read: true,
									insert: true,
									update: true,
									delete: false,
									attribute_permissions: [
										{
											attribute_name: 'description',
											read: true,
											insert: true,
											update: true,
											delete: false,
										},
									],
								},
								shippers: {
									read: true,
									insert: true,
									update: true,
									delete: true,
									attribute_permissions: [
										{
											attribute_name: 'companyname',
											read: false,
											insert: false,
											update: false,
											delete: false,
										},
									],
								},
							},
						},
						dev: {
							tables: {
								dog: {
									read: true,
									insert: true,
									update: true,
									delete: true,
									attribute_permissions: [
										{
											attribute_name: '__createdtime__',
											read: true,
											insert: true,
											update: true,
										},
										{
											attribute_name: '__updatedtime__',
											read: true,
											insert: true,
											update: true,
										},
										{
											attribute_name: 'age',
											read: true,
											insert: true,
											update: false,
										},
										{
											attribute_name: 'dog_name',
											read: true,
											insert: false,
											update: true,
										},
										{
											attribute_name: 'adorable',
											read: true,
											insert: true,
											update: true,
										},
										{ attribute_name: 'owner_id', read: false, insert: true, update: true },
									],
								},
								breed: {
									read: true,
									insert: true,
									update: true,
									delete: true,
									attribute_permissions: [
										{
											attribute_name: '__createdtime__',
											read: false,
											insert: false,
											update: true,
										},
										{ attribute_name: '__updatedtime__', read: false, insert: true, update: true },
									],
								},
								dog_conditions: {
									read: true,
									insert: true,
									update: false,
									delete: false,
									attribute_permissions: [
										{
											attribute_name: 'age',
											read: true,
											insert: false,
											update: false,
										},
										{
											attribute_name: 'group',
											read: true,
											insert: false,
											update: false,
										},
										{
											attribute_name: 'breed_id',
											read: false,
											insert: true,
											update: false,
										},
										{
											attribute_name: 'dog_name',
											read: true,
											insert: false,
											update: false,
										},
										{
											attribute_name: 'id',
											read: true,
											insert: true,
											update: false,
										},
										{ attribute_name: 'location', read: false, insert: false, update: false },
									],
								},
							},
						},
					},
				})
				.expect((r) => assert.equal(r.body.id, 'developer_test_5', r.text))
				.expect(200);
		});

		test('NoSQL Add User with new Role', async () => {
			await client
				.req()
				.send({
					operation: 'add_user',
					role: 'developer_test_5',
					username: 'test_user',
					password: `${adminPwd}`,
					active: true,
				})
				.expect(200);
		});

		test('NoSQL try to get user info as test_user', async () => {
			await client
				.reqAs(headersTestUser)
				.send({ operation: 'list_users' })
				.expect((r) => {
					assert.equal(
						r.body.error,
						'This operation is not authorized due to role restrictions and/or invalid database items',
						r.text
					);
					assert.equal(r.body.unauthorized_access.length, 1, r.text);
					assert.equal(
						r.body.unauthorized_access[0],
						"Operation 'listUsersExternal' is restricted to 'super_user' roles",
						r.text
					);
					assert.equal(r.body.invalid_schema_items.length, 0, r.text);
				})
				.expect(403);
		});

		test('NoSQL Try to read suppliers table as SU', async () => {
			await client
				.req()
				.send({
					operation: 'search_by_value',
					table: `suppliers`,
					schema: `northnwd`,
					primary_key: 'id',
					search_attribute: `supplierid`,
					search_value: '*',
					get_attributes: [`supplierid`],
				})
				.expect(200);
		});

		test('NoSQL Try to read FULLY restricted suppliers table as test_user', async () => {
			await client
				.reqAs(headersTestUser)
				.send({
					operation: 'search_by_value',
					table: `suppliers`,
					schema: `northnwd`,
					primary_key: 'id',
					search_attribute: `supplierid`,
					search_value: '*',
					get_attributes: [`supplierid`],
				})
				.expect((r) => {
					assert.equal(
						r.body.error,
						'This operation is not authorized due to role restrictions and/or invalid database items',
						r.text
					);
					assert.equal(r.body.invalid_schema_items.length, 1, r.text);
					assert.equal(r.body.invalid_schema_items[0], "Table 'northnwd.suppliers' does not exist", r.text);
					assert.equal(r.body.unauthorized_access.length, 0, r.text);
				})
				.expect(403);
		});

		test('NoSQL Try to read region table as SU', async () => {
			await client
				.req()
				.send({
					operation: 'search_by_value',
					table: `region`,
					schema: `northnwd`,
					primary_key: 'id',
					search_attribute: 'regionid',
					search_value: '*',
					get_attributes: ['*'],
				})
				.expect(200);
		});

		test('NoSQL Try to read region table as test_user', async () => {
			await client
				.reqAs(headersTestUser)
				.send({
					operation: 'search_by_value',
					table: `region`,
					schema: `northnwd`,
					primary_key: 'id',
					search_attribute: 'regionid',
					search_value: '*',
					get_attributes: ['*'],
				})
				.expect(200);
		});

		test('NoSQL Try to insert into region table as SU', async () => {
			await client
				.req()
				.send({
					operation: 'insert',
					schema: `northnwd`,
					table: `region`,
					records: [{ regionid: 16, regiondescription: 'test description' }],
				})
				.expect(200);
		});

		test('NoSQL Try to insert into insert restricted region table as test_user', async () => {
			await client
				.reqAs(headersTestUser)
				.send({
					operation: 'insert',
					schema: `northnwd`,
					table: `region`,
					records: [{ regionid: 17, regiondescription: 'test description' }],
				})
				.expect((r) => {
					assert.equal(
						r.body.error,
						'This operation is not authorized due to role restrictions and/or invalid database items',
						r.text
					);
					assert.equal(r.body.unauthorized_access.length, 1, r.text);
					assert.equal(r.body.unauthorized_access[0].required_table_permissions.length, 1, r.text);
					assert.equal(r.body.unauthorized_access[0].required_table_permissions[0], 'insert', r.text);
					assert.equal(r.body.unauthorized_access[0].schema, 'northnwd', r.text);
					assert.equal(r.body.unauthorized_access[0].table, 'region', r.text);
					assert.equal(r.body.invalid_schema_items.length, 0, r.text);
				})
				.expect(403);
		});

		test('NoSQL Try to insert FULLY restricted attribute in categories table as test_user', async () => {
			await client
				.reqAs(headersTestUser)
				.send({
					operation: 'insert',
					schema: `northnwd`,
					table: `categories`,
					records: [{ ['categoryid']: 9, categoryname: 'test name', description: 'test description' }],
				})
				.expect((r) => {
					assert.equal(
						r.body.error,
						'This operation is not authorized due to role restrictions and/or invalid database items',
						r.text
					);
					assert.equal(r.body.invalid_schema_items.length, 1, r.text);
					assert.equal(
						r.body.invalid_schema_items[0],
						"Attribute 'categoryname' does not exist on 'northnwd.categories'",
						r.text
					);
					assert.equal(r.body.unauthorized_access.length, 0, r.text);
				})
				.expect(403);
		});

		test('NoSQL Try to insert into territories table as SU', async () => {
			await client
				.req()
				.send({
					operation: 'insert',
					schema: `northnwd`,
					table: `territories`,
					records: [{ ['territoryid']: 123456, territorydescription: 'test description' }],
				})
				.expect(200);
		});

		test('NoSQL Try to insert into territories table as test_user', async () => {
			await client
				.reqAs(headersTestUser)
				.send({
					operation: 'insert',
					schema: `northnwd`,
					table: `territories`,
					records: [{ ['territoryid']: 1234567, territorydescription: 'test description' }],
				})
				.expect(200);
		});

		test('NoSQL Try to update territories table as SU', async () => {
			await client
				.req()
				.send({
					operation: 'update',
					schema: `northnwd`,
					table: `territories`,
					records: [{ ['territoryid']: 123456, territorydescription: 'test description updated' }],
				})
				.expect(200);
		});

		test('NoSQL Try to update restricted territories table as test_user', async () => {
			await client
				.reqAs(headersTestUser)
				.send({
					operation: 'update',
					schema: `northnwd`,
					table: `territories`,
					records: [{ ['territoryid']: 1234567, territorydescription: 'test description updated' }],
				})
				.expect((r) => {
					assert.equal(
						r.body.error,
						'This operation is not authorized due to role restrictions and/or invalid database items',
						r.text
					);
					assert.equal(r.body.unauthorized_access.length, 1, r.text);
					assert.equal(r.body.unauthorized_access[0].required_table_permissions.length, 1, r.text);
					assert.equal(r.body.unauthorized_access[0].required_table_permissions[0], 'update', r.text);
					assert.equal(r.body.unauthorized_access[0].schema, 'northnwd', r.text);
					assert.equal(r.body.unauthorized_access[0].table, 'territories', r.text);
					assert.equal(r.body.invalid_schema_items.length, 0, r.text);
				})
				.expect(403);
		});

		test('NoSQL Try to update categories table as test_user', async () => {
			await client
				.reqAs(headersTestUser)
				.send({
					operation: 'update',
					schema: `northnwd`,
					table: `categories`,
					records: [{ ['categoryid']: 1, description: 'test description updated' }],
				})
				.expect(200);
		});

		test('NoSQL Try to update categories table with new attr as test_user - expect error', async () => {
			await client
				.reqAs(headersTestUser)
				.send({
					operation: 'update',
					schema: `northnwd`,
					table: `categories`,
					records: [{ ['categoryid']: 1, description: 'test description updated', active: true }],
				})
				.expect((r) => {
					assert.equal(
						r.body.error,
						'This operation is not authorized due to role restrictions and/or invalid database items',
						r.text
					);
					assert.equal(r.body.unauthorized_access.length, 0, r.text);
					assert.equal(r.body.invalid_schema_items.length, 1, r.text);
					assert.equal(
						r.body.invalid_schema_items[0],
						"Attribute 'active' does not exist on 'northnwd.categories'",
						r.text
					);
				})
				.expect(403);
		});

		test('NoSQL Try to update FULLY restricted attrs in categories table as test_user', async () => {
			await client
				.reqAs(headersTestUser)
				.send({
					operation: 'update',
					schema: `northnwd`,
					table: `categories`,
					records: [
						{
							['categoryid']: 1,
							categoryname: 'test name',
							description: 'test description updated',
							picture: 'test picture',
						},
					],
				})
				.expect((r) => {
					assert.equal(
						r.body.error,
						'This operation is not authorized due to role restrictions and/or invalid database items',
						r.text
					);
					assert.equal(r.body.invalid_schema_items.length, 2, r.text);
					assert.ok(
						r.body.invalid_schema_items.includes("Attribute 'categoryname' does not exist on 'northnwd.categories'"),
						r.text
					);
					assert.ok(
						r.body.invalid_schema_items.includes("Attribute 'picture' does not exist on 'northnwd.categories'"),
						r.text
					);
					assert.equal(r.body.unauthorized_access.length, 0, r.text);
				})
				.expect(403);
		});

		test('NoSQL Try to delete from categories table as SU', async () => {
			await client
				.req()
				.send({ operation: 'delete', table: `categories`, schema: `northnwd`, hash_values: [1] })
				.expect(200);
		});

		test('NoSQL Try to delete from restricted categories table as test_user', async () => {
			await client
				.reqAs(headersTestUser)
				.send({ operation: 'delete', table: `categories`, schema: `northnwd`, hash_values: [2] })
				.expect((r) => {
					assert.equal(
						r.body.error,
						'This operation is not authorized due to role restrictions and/or invalid database items',
						r.text
					);
					assert.equal(r.body.unauthorized_access.length, 1, r.text);
					assert.equal(r.body.unauthorized_access[0].required_table_permissions.length, 1, r.text);
					assert.equal(r.body.unauthorized_access[0].required_table_permissions[0], 'delete', r.text);
					assert.equal(r.body.unauthorized_access[0].schema, 'northnwd', r.text);
					assert.equal(r.body.unauthorized_access[0].table, 'categories', r.text);
					assert.equal(r.body.invalid_schema_items.length, 0, r.text);
				})
				.expect(403);
		});

		test('NoSQL Try to read shippers table FULLY restricted attribute as test_user', async () => {
			await client
				.reqAs(headersTestUser)
				.send({
					operation: 'search_by_value',
					table: `shippers`,
					schema: `northnwd`,
					primary_key: 'id',
					search_attribute: `shipperid`,
					search_value: '*',
					get_attributes: ['companyname'],
				})
				.expect((r) => {
					assert.equal(
						r.body.error,
						'This operation is not authorized due to role restrictions and/or invalid database items',
						r.text
					);
					assert.equal(r.body.invalid_schema_items.length, 2, r.text);
					assert.ok(
						r.body.invalid_schema_items.includes("Attribute 'shipperid' does not exist on 'northnwd.shippers'"),
						r.text
					);
					assert.ok(
						r.body.invalid_schema_items.includes("Attribute 'companyname' does not exist on 'northnwd.shippers'"),
						r.text
					);
					assert.equal(r.body.unauthorized_access.length, 0, r.text);
				})
				.expect(403);
		});

		test('NoSQL Try to read ALL shippers table FULLY restricted attributes as test_user', async () => {
			await client
				.reqAs(headersTestUser)
				.send({
					operation: 'search_by_value',
					table: `shippers`,
					schema: `northnwd`,
					primary_key: 'id',
					search_attribute: `shipperid`,
					search_value: '*',
					get_attributes: ['*'],
				})
				.expect((r) => {
					assert.equal(
						r.body.error,
						'This operation is not authorized due to role restrictions and/or invalid database items',
						r.text
					);
					assert.equal(r.body.invalid_schema_items.length, 1, r.text);
					assert.equal(
						r.body.invalid_schema_items[0],
						"Attribute 'shipperid' does not exist on 'northnwd.shippers'",
						r.text
					);
					assert.equal(r.body.unauthorized_access.length, 0, r.text);
				})
				.expect(403);
		});

		test('NoSQL Try to update shippers table FULLY restricted attributes as test_user', async () => {
			await client
				.reqAs(headersTestUser)
				.send({
					operation: 'update',
					schema: `northnwd`,
					table: `shippers`,
					records: [{ ['shipperid']: 1, companyname: 'bad update name' }],
				})
				.expect((r) => {
					assert.equal(
						r.body.error,
						'This operation is not authorized due to role restrictions and/or invalid database items',
						r.text
					);
					assert.equal(r.body.invalid_schema_items.length, 2, r.text);
					assert.ok(
						r.body.invalid_schema_items.includes("Attribute 'shipperid' does not exist on 'northnwd.shippers'"),
						r.text
					);
					assert.ok(
						r.body.invalid_schema_items.includes("Attribute 'companyname' does not exist on 'northnwd.shippers'"),
						r.text
					);
					assert.equal(r.body.unauthorized_access.length, 0, r.text);
				})
				.expect(403);
		});

		test('NoSQL Try to insert shippers table restricted attributes as test_user', async () => {
			await client
				.reqAs(headersTestUser)
				.send({
					operation: 'insert',
					schema: `northnwd`,
					table: `shippers`,
					records: [{ ['shipperid']: 1, companyname: 'bad update name', phone: '(503) 555-9831' }],
				})
				.expect((r) => {
					assert.equal(
						r.body.error,
						'This operation is not authorized due to role restrictions and/or invalid database items',
						r.text
					);
					assert.equal(r.body.invalid_schema_items.length, 3, r.text);
					assert.ok(
						r.body.invalid_schema_items.includes("Attribute 'shipperid' does not exist on 'northnwd.shippers'"),
						r.text
					);
					assert.ok(
						r.body.invalid_schema_items.includes("Attribute 'companyname' does not exist on 'northnwd.shippers'"),
						r.text
					);
					assert.ok(
						r.body.invalid_schema_items.includes("Attribute 'phone' does not exist on 'northnwd.shippers'"),
						r.text
					);
					assert.equal(r.body.unauthorized_access.length, 0, r.text);
				})
				.expect(403);
		});

		test('NoSQL Try to insert to categories table with FULLY restricted attribute as test_user', async () => {
			await client
				.reqAs(headersTestUser)
				.send({
					operation: 'insert',
					schema: `northnwd`,
					table: `categories`,
					records: [{ ['categoryid']: 4, categoryname: 'bad update name' }],
				})
				.expect((r) => {
					assert.equal(
						r.body.error,
						'This operation is not authorized due to role restrictions and/or invalid database items',
						r.text
					);
					assert.equal(r.body.invalid_schema_items.length, 1, r.text);
					assert.equal(
						r.body.invalid_schema_items[0],
						"Attribute 'categoryname' does not exist on 'northnwd.categories'",
						r.text
					);
					assert.equal(r.body.unauthorized_access.length, 0, r.text);
				})
				.expect(403);
		});

		test('NoSQL Try to insert categories table unrestricted attribute as test_user', async () => {
			await client
				.reqAs(headersTestUser)
				.send({
					operation: 'insert',
					schema: `northnwd`,
					table: `categories`,
					records: [{ ['categoryid']: 1, description: 'Cheese and cheese and cheese' }],
				})
				.expect(200);
		});

		test('NoSQL Try to update categories table unrestricted attribute as test_user', async () => {
			await client
				.reqAs(headersTestUser)
				.send({
					operation: 'update',
					schema: `northnwd`,
					table: `categories`,
					records: [{ ['categoryid']: 2, description: 'Meats and cheeses' }],
				})
				.expect(200);
		});

		test('NoSQL Try to insert to categories table FULLY restricted attribute as test_user', async () => {
			await client
				.reqAs(headersTestUser)
				.send({
					operation: 'insert',
					schema: `northnwd`,
					table: `categories`,
					records: [{ ['categoryid']: 1, categoryname: 'Stuff and things' }],
				})
				.expect((r) => {
					assert.equal(
						r.body.error,
						'This operation is not authorized due to role restrictions and/or invalid database items',
						r.text
					);
					assert.equal(r.body.invalid_schema_items.length, 1, r.text);
					assert.equal(
						r.body.invalid_schema_items[0],
						"Attribute 'categoryname' does not exist on 'northnwd.categories'",
						r.text
					);
					assert.equal(r.body.unauthorized_access.length, 0, r.text);
				})
				.expect(403);
		});

		test('NoSQL create_schema - non-SU expect fail', async () => {
			await client
				.reqAs(headersTestUser)
				.send({ operation: 'create_schema', schema: 'test-schema' })
				.expect((r) => {
					assert.equal(
						r.body.error,
						'This operation is not authorized due to role restrictions and/or invalid database items',
						r.text
					);
					assert.equal(r.body.unauthorized_access.length, 1, r.text);
					assert.equal(
						r.body.unauthorized_access[0],
						"Operation 'createSchema' is restricted to 'super_user' roles",
						r.text
					);
					assert.equal(r.body.invalid_schema_items.length, 0, r.text);
				})
				.expect(403);
		});

		test('NoSQL create_schema - SU expect success', async () => {
			await client.req().send({ operation: 'create_schema', schema: 'test-schema' }).expect(200);
		});

		test('NoSQL create_table - non-SU expect fail', async () => {
			await client
				.reqAs(headersTestUser)
				.send({ operation: 'create_table', schema: 'test-schema', table: 'test-table', primary_key: 'id' })
				.expect((r) => {
					assert.equal(
						r.body.error,
						'This operation is not authorized due to role restrictions and/or invalid database items',
						r.text
					);
					assert.equal(r.body.unauthorized_access.length, 1, r.text);
					assert.equal(
						r.body.unauthorized_access[0],
						"Operation 'createTable' is restricted to 'super_user' roles",
						r.text
					);
					assert.equal(r.body.invalid_schema_items.length, 0, r.text);
				})
				.expect(403);
		});

		test('NoSQL create_table - SU expect success', async () => {
			await client
				.req()
				.send({ operation: 'create_table', schema: 'test-schema', table: 'test-table', primary_key: 'id' })
				.expect(200);
		});

		test('Insert record to evaluate dropAttribute', async () => {
			await client
				.req()
				.send({
					operation: 'insert',
					schema: 'test-schema',
					table: 'test-table',
					records: [{ id: 1, test_attribute: 'Stuff and things' }],
				})
				.expect(200);
		});

		test('NoSQL drop_attribute - non-SU expect fail', async () => {
			await client
				.reqAs(headersTestUser)
				.send({
					operation: 'drop_attribute',
					schema: 'test-schema',
					table: 'test-table',
					attribute: 'test_attribute',
				})
				.expect((r) => {
					assert.equal(
						r.body.error,
						'This operation is not authorized due to role restrictions and/or invalid database items',
						r.text
					);
					assert.equal(r.body.unauthorized_access.length, 1, r.text);
					assert.equal(
						r.body.unauthorized_access[0],
						"Operation 'dropAttribute' is restricted to 'super_user' roles",
						r.text
					);
					assert.equal(r.body.invalid_schema_items.length, 0, r.text);
				})
				.expect(403);
		});

		test('NoSQL drop_attribute - SU expect success', async () => {
			await client
				.req()
				.send({
					operation: 'drop_attribute',
					schema: 'test-schema',
					table: 'test-table',
					attribute: 'test_attribute',
				})
				.expect(200);
		});

		test('NoSQL drop_table - non-SU expect fail', async () => {
			await client
				.reqAs(headersTestUser)
				.send({ operation: 'drop_table', schema: 'test-schema', table: 'test-table' })
				.expect((r) => {
					assert.equal(
						r.body.error,
						'This operation is not authorized due to role restrictions and/or invalid database items',
						r.text
					);
					assert.equal(r.body.unauthorized_access.length, 1, r.text);
					assert.equal(
						r.body.unauthorized_access[0],
						"Operation 'dropTable' is restricted to 'super_user' roles",
						r.text
					);
					assert.equal(r.body.invalid_schema_items.length, 0, r.text);
				})
				.expect(403);
		});

		test('NoSQL drop_table - SU expect success', async () => {
			await client.req().send({ operation: 'drop_table', schema: 'test-schema', table: 'test-table' }).expect(200);
		});

		test('NoSQL drop_schema - non-SU expect fail', async () => {
			await client
				.reqAs(headersTestUser)
				.send({ operation: 'drop_schema', schema: 'test-schema' })
				.expect((r) => {
					assert.equal(
						r.body.error,
						'This operation is not authorized due to role restrictions and/or invalid database items',
						r.text
					);
					assert.equal(r.body.unauthorized_access.length, 1, r.text);
					assert.equal(
						r.body.unauthorized_access[0],
						"Operation 'dropSchema' is restricted to 'super_user' roles",
						r.text
					);
					assert.equal(r.body.invalid_schema_items.length, 0, r.text);
				})
				.expect(403);
		});

		test('NoSQL drop_schema - SU expect success', async () => {
			await client.req().send({ operation: 'drop_schema', schema: 'test-schema' }).expect(200);
		});

		test('NoSQL Try to update timestamp value on dog table as test_user - expect fail', async () => {
			await client
				.reqAs(headersTestUser)
				.send({
					operation: 'insert',
					schema: 'dev',
					table: 'dog',
					records: [
						{ id: 1, __createdtime__: 'Stuff and things' },
						{
							id: 2,
							__updatedtime__: 'Stuff and other things',
						},
					],
				})
				.expect((r) =>
					assert.equal(
						r.body.error,
						"Internal timestamp attributes - '__createdtime_' and '__updatedtime__' - cannot be inserted to or updated by HDB users."
					)
				)
				.expect(403);
		});

		test('NoSQL Try to update attr w/ timestamp value in update row as SU  - expect success', async () => {
			await client
				.req()
				.send({
					operation: 'update',
					schema: 'dev',
					table: 'dog',
					records: [
						{ id: 1, adorable: false, __createdtime__: 'Stuff and things' },
						{
							id: 2,
							adorable: false,
							__updatedtime__: 'Stuff and other things',
						},
					],
				})
				.expect((r) => assert.equal(r.body.message, 'updated 2 of 2 records', r.text))
				.expect((r) => assert.equal(r.body.update_hashes.length, 2, r.text))
				.expect(200);
		});

		test('NoSQL Try to update timestamp value on dog table as SU - expect', async () => {
			await client
				.req()
				.send({
					operation: 'update',
					schema: 'dev',
					table: 'dog',
					records: [
						{ id: 1, __createdtime__: 'Stuff and things' },
						{
							id: 2,
							__updatedtime__: 'Stuff and other things',
						},
					],
				})
				.expect((r) => assert.equal(r.body.message, 'updated 2 of 2 records', r.text))
				.expect((r) => assert.equal(r.body.update_hashes.length, 2, r.text))
				.expect(200);
		});

		test('NoSQL - Upsert - table perms true/no attribute perms set - expect success', async () => {
			await client
				.req()
				.send({
					operation: 'upsert',
					schema: `northnwd`,
					table: `customers`,
					records: [
						{
							['customerid']: 'FURIB',
							region: 'Durkastan',
							contactmame: 'Hans Blix',
						},
						{ region: 'Durkastan', contactmame: 'Hans Blix' },
					],
				})
				.expect((r) => {
					assert.equal(r.body.upserted_hashes.length, 2, r.text);
					assert.ok(r.body.upserted_hashes.includes('FURIB'), r.text);
					assert.ok(!r.body.skipped_hashes, r.text);
					assert.equal(r.body.message, 'upserted 2 of 2 records', r.text);
				})
				.expect(200);
		});

		test('NoSQL - Upsert - table perms true/attr perms true - expect success', async () => {
			await client
				.req()
				.send({
					operation: 'upsert',
					schema: `northnwd`,
					table: `categories`,
					records: [{ ['categoryid']: 8, description: 'Seaweed and fishies' }, { description: 'Junk food' }],
				})
				.expect((r) => {
					assert.equal(r.body.upserted_hashes.length, 2, r.text);
					assert.ok(r.body.upserted_hashes.includes(8), r.text);
					assert.ok(!r.body.skipped_hashes, r.text);
					assert.equal(r.body.message, 'upserted 2 of 2 records', r.text);
				})
				.expect(200);
		});

		test('NoSQL - Upsert - table perms true/no attr perms and new attribute included - expect success', async () => {
			await client
				.req()
				.send({
					operation: 'upsert',
					schema: `northnwd`,
					table: `customers`,
					records: [
						{
							['customerid']: 'FURIB',
							region: 'Durkastan',
							contactmame: 'Hans Blix',
							active: false,
						},
						{ region: 'Durkastan', contactmame: 'Sam Johnson', active: true },
					],
				})
				.expect((r) => {
					assert.equal(r.body.upserted_hashes.length, 2, r.text);
					assert.ok(r.body.upserted_hashes.includes('FURIB'), r.text);
					assert.ok(!r.body.skipped_hashes, r.text);
					assert.equal(r.body.message, 'upserted 2 of 2 records', r.text);
				})
				.expect(200);
		});

		test('NoSQL - Upsert - table perms true/false  - expect error', async () => {
			await client
				.reqAs(headersTestUser)
				.send({
					operation: 'upsert',
					schema: `northnwd`,
					table: `territories`,
					records: [
						{ regionid: 1, territorydescription: 'Westboro', territoryid: 1581 },
						{
							regionid: 55,
							territorydescription: 'Denver Metro',
						},
					],
				})
				.expect((r) => {
					assert.equal(
						r.body.error,
						'This operation is not authorized due to role restrictions and/or invalid database items',
						r.text
					);
					assert.equal(r.body.invalid_schema_items.length, 0, r.text);
					assert.equal(r.body.unauthorized_access.length, 1, r.text);
					assert.equal(r.body.unauthorized_access[0].schema, 'northnwd', r.text);
					assert.equal(r.body.unauthorized_access[0].table, 'territories', r.text);
					assert.equal(r.body.unauthorized_access[0].required_table_permissions.length, 1, r.text);
					assert.equal(r.body.unauthorized_access[0].required_table_permissions[0], 'update', r.text);
					assert.equal(r.body.unauthorized_access[0].required_attribute_permissions.length, 0, r.text);
				})
				.expect(403);
		});

		test('NoSQL - Upsert - table perms true/attr perms true but new attribute included - expect error', async () => {
			await client
				.reqAs(headersTestUser)
				.send({
					operation: 'upsert',
					schema: `northnwd`,
					table: `categories`,
					records: [
						{
							['categoryid']: 8,
							description: 'Seaweed and fishies',
							active: true,
						},
						{ description: 'Junk food', active: false },
					],
				})
				.expect((r) => {
					assert.equal(r.body.unauthorized_access.length, 0, r.text);
					assert.equal(r.body.invalid_schema_items.length, 1, r.text);
					assert.equal(
						r.body.invalid_schema_items[0],
						"Attribute 'active' does not exist on 'northnwd.categories'",
						r.text
					);
					assert.equal(
						r.body.error,
						'This operation is not authorized due to role restrictions and/or invalid database items',
						r.text
					);
				})
				.expect(403);
		});

		test('NoSQL - Upsert - table perms true/some attr perms false - expect error', async () => {
			const expected_attr_perm_errs = {
				dog_name: 'insert',
				age: 'update',
			};

			await client
				.reqAs(headersTestUser)
				.send({
					operation: 'upsert',
					schema: 'dev',
					table: 'dog',
					records: [
						{ adorable: true, dog_name: 'Penny', owner_id: 2, age: 5, id: 10 },
						{
							adorable: true,
							dog_name: 'Penny',
							owner_id: 2,
							age: 5,
							id: 2,
						},
						{ adorable: true, dog_name: 'Penny', owner_id: 2, age: 5, id: 10, birthday: '10/11/19' },
					],
				})
				.expect((r) => {
					assert.equal(
						r.body.error,
						'This operation is not authorized due to role restrictions and/or invalid database items',
						r.text
					);
					assert.equal(r.body.unauthorized_access.length, 1, r.text);
					assert.equal(r.body.unauthorized_access[0].schema, 'dev', r.text);
					assert.equal(r.body.unauthorized_access[0].table, 'dog', r.text);
					assert.equal(r.body.unauthorized_access[0].required_table_permissions.length, 0, r.text);
					assert.equal(r.body.unauthorized_access[0].required_attribute_permissions.length, 2, r.text);
					r.body.unauthorized_access[0].required_attribute_permissions.forEach((attr_perm_err) => {
						assert.equal(
							attr_perm_err.required_permissions[0],
							expected_attr_perm_errs[attr_perm_err.attribute_name],
							r.text
						);
					});
					assert.equal(r.body.invalid_schema_items.length, 1, r.text);
					assert.equal(r.body.invalid_schema_items[0], "Attribute 'birthday' does not exist on 'dev.dog'", r.text);
				})
				.expect(403);
		});

		test('NoSQL - Upsert - w/ null value as hash- expect error', async () => {
			await client
				.req()
				.send({
					operation: 'upsert',
					schema: `northnwd`,
					table: `customers`,
					records: [
						{
							['customerid']: 'null',
							region: 'Durkastan',
							contactmame: 'Hans Blix',
							active: false,
						},
						{ region: 'Durkastan', contactmame: 'Sam Johnson', active: true },
					],
				})
				.expect((r) =>
					assert.equal(
						r.body.error,
						"Invalid hash value: 'null' is not a valid hash attribute value, check log for more info"
					)
				)
				.expect(400);
		});

		test('NoSQL - Upsert - w/ invalid attr name - expect error', async () => {
			await client
				.req()
				.send({
					operation: 'upsert',
					schema: `northnwd`,
					table: `customers`,
					records: [
						{
							['customerid']: 'FURIB',
							'region': 'Durkastan',
							'contactmame': 'Hans Blix',
							'active/not active': false,
						},
						{ 'region': 'Durkastan', 'contactmame': 'Sam Johnson', 'active/not active': false },
					],
				})
				.expect((r) =>
					assert.equal(r.body.error, 'Attribute names cannot include backticks or forward slashes', r.text)
				)
				.expect(400);
		});

		test('search by conditions - equals - allowed attr', async () => {
			await client
				.reqAs(headersTestUser)
				.send({
					operation: 'search_by_conditions',
					schema: 'dev',
					table: 'dog_conditions',
					get_attributes: ['*'],
					conditions: [{ search_attribute: 'age', search_type: 'equals', search_value: 5 }],
				})
				.expect((r) => {
					assert.equal(r.body.length, 2, r.text);
					r.body.forEach((row) => {
						assert.ok([1, 2].includes(row.id), r.text);
						assert.ok(!row.location, r.text);
						assert.ok(!row.breed_id, r.text);
					});
				})
				.expect(200);
		});

		test('search by conditions - ends_with - allowed attr', async () => {
			await client
				.reqAs(headersTestUser)
				.send({
					operation: 'search_by_conditions',
					schema: 'dev',
					table: 'dog_conditions',
					get_attributes: ['*'],
					conditions: [{ search_attribute: 'dog_name', search_type: 'ends_with', search_value: 'y' }],
				})
				.expect((r) => {
					assert.equal(r.body.length, 4, r.text);
					r.body.forEach((row) => {
						assert.equal([...row.dog_name].pop(), 'y', r.text);
						assert.ok(!row.location, r.text);
						assert.ok(!row.breed_id, r.text);
					});
				})
				.expect(200);
		});

		test('search by conditions - equals - restricted attr', async () => {
			await client
				.reqAs(headersTestUser)
				.send({
					operation: 'search_by_conditions',
					schema: 'dev',
					table: 'dog_conditions',
					get_attributes: ['*'],
					conditions: [{ search_attribute: 'location', search_type: 'equals', search_value: 'Denver, CO' }],
				})
				.expect((r) => {
					assert.equal(
						r.body.error,
						'This operation is not authorized due to role restrictions and/or invalid database items',
						r.text
					);
					assert.equal(r.body.invalid_schema_items.length, 1, r.text);
					assert.equal(
						r.body.invalid_schema_items[0],
						"Attribute 'location' does not exist on 'dev.dog_conditions'",
						r.text
					);
					assert.equal(r.body.unauthorized_access.length, 0, r.text);
				})
				.expect(403);
		});

		test('search by conditions - contains - restricted attr', async () => {
			await client
				.reqAs(headersTestUser)
				.send({
					operation: 'search_by_conditions',
					schema: 'dev',
					table: 'dog_conditions',
					get_attributes: ['*'],
					conditions: [{ search_attribute: 'location', search_type: 'contains', search_value: 'Denver' }],
				})
				.expect((r) => {
					assert.equal(
						r.body.error,
						'This operation is not authorized due to role restrictions and/or invalid database items',
						r.text
					);
					assert.equal(r.body.invalid_schema_items.length, 1, r.text);
					assert.equal(
						r.body.invalid_schema_items[0],
						"Attribute 'location' does not exist on 'dev.dog_conditions'",
						r.text
					);
					assert.equal(r.body.unauthorized_access.length, 0, r.text);
				})
				.expect(403);
		});

		test('search by conditions - starts_with - non-existent attr', async () => {
			await client
				.reqAs(headersTestUser)
				.send({
					operation: 'search_by_conditions',
					schema: 'dev',
					table: 'dog_conditions',
					get_attributes: ['*'],
					conditions: [{ search_attribute: 'random_attr', search_type: 'starts_with', search_value: 1 }],
				})
				.expect((r) => {
					assert.equal(
						r.body.error,
						'This operation is not authorized due to role restrictions and/or invalid database items',
						r.text
					);
					assert.equal(r.body.invalid_schema_items.length, 1, r.text);
					assert.equal(
						r.body.invalid_schema_items[0],
						"Attribute 'random_attr' does not exist on 'dev.dog_conditions'",
						r.text
					);
					assert.equal(r.body.unauthorized_access.length, 0, r.text);
				})
				.expect(403);
		});

		test("search by conditions - starts_with - unauth'd attr", async () => {
			await client
				.reqAs(headersTestUser)
				.send({
					operation: 'search_by_conditions',
					schema: 'dev',
					table: 'dog_conditions',
					get_attributes: ['*'],
					conditions: [{ search_attribute: 'breed_id', search_type: 'starts_with', search_value: 1 }],
				})
				.expect((r) => {
					assert.equal(
						r.body.error,
						'This operation is not authorized due to role restrictions and/or invalid database items',
						r.text
					);
					assert.equal(r.body.invalid_schema_items.length, 0, r.text);
					assert.equal(r.body.unauthorized_access.length, 1, r.text);
					assert.equal(r.body.unauthorized_access[0].schema, 'dev', r.text);
					assert.equal(r.body.unauthorized_access[0].table, 'dog_conditions', r.text);
					assert.equal(r.body.unauthorized_access[0].required_attribute_permissions.length, 1, r.text);
					assert.equal(
						r.body.unauthorized_access[0].required_attribute_permissions[0].attribute_name,
						'breed_id',
						r.text
					);
					assert.equal(
						r.body.unauthorized_access[0].required_attribute_permissions[0].required_permissions[0],
						'read',
						r.text
					);
				})
				.expect(403);
		});

		test("search by conditions - starts_with - unauth'd attrs in get / search", async () => {
			await client
				.reqAs(headersTestUser)
				.send({
					operation: 'search_by_conditions',
					schema: 'dev',
					table: 'dog_conditions',
					get_attributes: ['id', 'dog_name', 'location'],
					conditions: [{ search_attribute: 'breed_id', search_type: 'starts_with', search_value: 1 }],
				})
				.expect((r) => {
					assert.equal(
						r.body.error,
						'This operation is not authorized due to role restrictions and/or invalid database items',
						r.text
					);
					assert.equal(r.body.invalid_schema_items.length, 1, r.text);
					assert.equal(
						r.body.invalid_schema_items[0],
						"Attribute 'location' does not exist on 'dev.dog_conditions'",
						r.text
					);
					assert.equal(r.body.unauthorized_access.length, 1, r.text);
					assert.equal(r.body.unauthorized_access[0].schema, 'dev', r.text);
					assert.equal(r.body.unauthorized_access[0].table, 'dog_conditions', r.text);
					assert.equal(r.body.unauthorized_access[0].required_attribute_permissions.length, 1, r.text);
					assert.equal(
						r.body.unauthorized_access[0].required_attribute_permissions[0].attribute_name,
						'breed_id',
						r.text
					);
					assert.equal(
						r.body.unauthorized_access[0].required_attribute_permissions[0].required_permissions[0],
						'read',
						r.text
					);
				})
				.expect(403);
		});

		test('search by conditions - equals & contains - restricted attr', async () => {
			await client
				.reqAs(headersTestUser)
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
						{ search_attribute: 'location', search_type: 'contains', search_value: 'CO' },
					],
				})
				.expect((r) => {
					assert.equal(
						r.body.error,
						'This operation is not authorized due to role restrictions and/or invalid database items',
						r.text
					);
					assert.equal(r.body.invalid_schema_items.length, 1, r.text);
					assert.equal(
						r.body.invalid_schema_items[0],
						"Attribute 'location' does not exist on 'dev.dog_conditions'",
						r.text
					);
					assert.equal(r.body.unauthorized_access.length, 0, r.text);
				})
				.expect(403);
		});

		test('search by conditions - starts_with & between w/ sort', async () => {
			await client
				.reqAs(headersTestUser)
				.send({
					operation: 'search_by_conditions',
					schema: 'dev',
					table: 'dog_conditions',
					get_attributes: ['*'],
					sort_attributes: [
						{ attribute: 'age', desc: false },
						{ attribute: 'location', desc: true },
					],
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
					assert.equal(
						r.body.error,
						'This operation is not authorized due to role restrictions and/or invalid database items',
						r.text
					);
					assert.equal(r.body.invalid_schema_items.length, 1, r.text);
					assert.equal(
						r.body.invalid_schema_items[0],
						"Attribute 'location' does not exist on 'dev.dog_conditions'",
						r.text
					);
					assert.equal(r.body.unauthorized_access.length, 0, r.text);
				})
				.expect(403);
		});

		test('search by conditions - 4 conditions - restricted attrs', async () => {
			await client
				.reqAs(headersTestUser)
				.send({
					operation: 'search_by_conditions',
					schema: 'dev',
					table: 'dog_conditions',
					get_attributes: ['*'],
					conditions: [
						{
							search_attribute: 'group_id',
							search_type: 'between',
							search_value: [0, 100],
						},
						{
							search_attribute: 'dog_name',
							search_type: 'ends_with',
							search_value: 'y',
						},
						{
							search_attribute: 'location',
							search_type: 'contains',
							search_value: 'enve',
						},
						{ search_attribute: 'age', search_type: 'greater_than', search_value: 1 },
					],
				})
				.expect((r) => {
					assert.equal(
						r.body.error,
						'This operation is not authorized due to role restrictions and/or invalid database items',
						r.text
					);
					assert.equal(r.body.invalid_schema_items.length, 2, r.text);
					assert.equal(
						r.body.invalid_schema_items[0],
						"Attribute 'group_id' does not exist on 'dev.dog_conditions'",
						r.text
					);
					assert.equal(
						r.body.invalid_schema_items[1],
						"Attribute 'location' does not exist on 'dev.dog_conditions'",
						r.text
					);
					assert.equal(r.body.unauthorized_access.length, 0, r.text);
				})
				.expect(403);
		});

		test("search by conditions - 4 conditions - restricted/unauth'd attrs", async () => {
			await client
				.reqAs(headersTestUser)
				.send({
					operation: 'search_by_conditions',
					schema: 'dev',
					table: 'dog_conditions',
					get_attributes: ['*'],
					conditions: [
						{
							search_attribute: 'group_id',
							search_type: 'between',
							search_value: [0, 100],
						},
						{ search_attribute: 'breed_id', search_type: 'equals', search_value: 5 },
						{
							search_attribute: 'age',
							search_type: 'less_than',
							search_value: 100,
						},
						{ search_attribute: 'location', search_type: 'contains', search_value: 'enver,' },
					],
				})
				.expect((r) => {
					assert.equal(
						r.body.error,
						'This operation is not authorized due to role restrictions and/or invalid database items',
						r.text
					);
					assert.equal(r.body.invalid_schema_items.length, 2, r.text);
					assert.equal(
						r.body.invalid_schema_items[0],
						"Attribute 'group_id' does not exist on 'dev.dog_conditions'",
						r.text
					);
					assert.equal(
						r.body.invalid_schema_items[1],
						"Attribute 'location' does not exist on 'dev.dog_conditions'",
						r.text
					);
					assert.equal(r.body.unauthorized_access.length, 1, r.text);
					assert.equal(r.body.unauthorized_access[0].schema, 'dev', r.text);
					assert.equal(r.body.unauthorized_access[0].table, 'dog_conditions', r.text);
					assert.equal(r.body.unauthorized_access[0].required_attribute_permissions.length, 1, r.text);
					assert.equal(
						r.body.unauthorized_access[0].required_attribute_permissions[0].attribute_name,
						'breed_id',
						r.text
					);
					assert.equal(
						r.body.unauthorized_access[0].required_attribute_permissions[0].required_permissions[0],
						'read',
						r.text
					);
				})
				.expect(403);
		});

		test('NoSQL Alter non-SU role', async () => {
			await client
				.req()
				.send({
					operation: 'alter_role',
					id: 'developer_test_5',
					role: 'developer_test_5',
					permission: {
						super_user: false,
						northnwd: {
							tables: {
								customers: {
									read: true,
									insert: true,
									update: true,
									delete: true,
									attribute_permissions: [],
								},
								suppliers: {
									read: false,
									insert: false,
									update: false,
									delete: false,
									attribute_permissions: [],
								},
								region: {
									read: true,
									insert: false,
									update: false,
									delete: false,
									attribute_permissions: [
										{
											attribute_name: 'regiondescription',
											read: true,
											insert: false,
											update: false,
											delete: false,
										},
									],
								},
								territories: {
									read: true,
									insert: true,
									update: false,
									delete: false,
									attribute_permissions: [
										{
											attribute_name: 'territorydescription',
											read: true,
											insert: true,
											update: false,
											delete: false,
										},
									],
								},
								categories: {
									read: true,
									insert: true,
									update: true,
									delete: false,
									attribute_permissions: [
										{
											attribute_name: 'description',
											read: true,
											insert: true,
											update: true,
											delete: false,
										},
									],
								},
								shippers: {
									read: true,
									insert: true,
									update: true,
									delete: true,
									attribute_permissions: [
										{
											attribute_name: 'companyname',
											read: false,
											insert: false,
											update: false,
											delete: false,
										},
									],
								},
							},
						},
						dev: {
							tables: {
								dog: {
									read: true,
									insert: true,
									update: true,
									delete: true,
									attribute_permissions: [
										{
											attribute_name: '__createdtime__',
											read: true,
											insert: true,
											update: true,
										},
										{ attribute_name: '__updatedtime__', read: true, insert: true, update: true },
									],
								},
								breed: {
									read: true,
									insert: true,
									update: true,
									delete: true,
									attribute_permissions: [
										{
											attribute_name: '__createdtime__',
											read: false,
											insert: false,
											update: true,
										},
										{ attribute_name: '__updatedtime__', read: false, insert: true, update: true },
									],
								},
							},
						},
					},
				})
				.expect(200);
		});

		test('NoSQL drop test user', async () => {
			await client.req().send({ operation: 'drop_user', username: 'test_user' }).expect(200);
		});

		test('NoSQL drop_role', async () => {
			await client.req().send({ operation: 'drop_role', id: 'developer_test_5' }).expect(200);
		});
	});

	suite('6. SQL Role Testing', () => {
		//SQL Role Testing Folder

		test('SQL Add non SU role', async () => {
			await client
				.req()
				.send({
					operation: 'add_role',
					role: 'developer_test_5',
					permission: {
						super_user: false,
						northnwd: {
							tables: {
								customers: {
									read: true,
									insert: true,
									update: true,
									delete: true,
									attribute_permissions: [],
								},
								suppliers: {
									read: false,
									insert: false,
									update: false,
									delete: false,
									attribute_permissions: [],
								},
								region: {
									read: true,
									insert: false,
									update: false,
									delete: false,
									attribute_permissions: [
										{
											attribute_name: 'regiondescription',
											read: true,
											insert: false,
											update: false,
										},
									],
								},
								territories: {
									read: true,
									insert: true,
									update: false,
									delete: false,
									attribute_permissions: [
										{
											attribute_name: 'territorydescription',
											read: true,
											insert: true,
											update: false,
										},
									],
								},
								categories: {
									read: true,
									insert: true,
									update: true,
									delete: false,
									attribute_permissions: [
										{
											attribute_name: 'description',
											read: true,
											insert: true,
											update: true,
										},
									],
								},
								shippers: {
									read: true,
									insert: true,
									update: true,
									delete: true,
									attribute_permissions: [
										{
											attribute_name: 'companyname',
											read: false,
											insert: false,
											update: false,
										},
									],
								},
							},
						},
						dev: {
							tables: {
								dog: {
									read: true,
									insert: true,
									update: true,
									delete: true,
									attribute_permissions: [],
								},
							},
						},
						other: {
							tables: {
								owner: {
									read: true,
									insert: false,
									update: true,
									delete: false,
									attribute_permissions: [
										{
											attribute_name: 'name',
											read: false,
											insert: false,
											update: false,
										},
									],
								},
							},
						},
						another: {
							tables: {
								breed: {
									read: false,
									insert: true,
									update: true,
									delete: true,
									attribute_permissions: [
										{
											attribute_name: 'image',
											read: false,
											insert: false,
											update: false,
										},
									],
								},
							},
						},
					},
				})
				.expect(200);
		});

		test('SQL Add User with new Role', async () => {
			await client
				.req()
				.send({
					operation: 'add_user',
					role: 'developer_test_5',
					username: 'test_user',
					password: `${adminPwd}`,
					active: true,
				})
				.expect((r) => assert.equal(r.body.message, 'test_user successfully added', r.text))
				.expect(200);
		});

		test('Add user that already exists', async () => {
			await client
				.req()
				.send({
					operation: 'add_user',
					role: 'developer_test_5',
					username: 'test_user',
					password: `${adminPwd}`,
					active: true,
				})
				.expect((r) => assert.equal(r.body.error, 'User test_user already exists', r.text))
				.expect(409);
		});

		test('Add user bad role name', async () => {
			await client
				.req()
				.send({
					operation: 'add_user',
					role: 'developer_test 5',
					username: 'test_user1',
					password: `${adminPwd}`,
					active: true,
				})
				.expect((r) => assert.equal(r.body.error, 'Role is invalid', r.text))
				.expect(400);
		});

		test('get user info', async () => {
			await client
				.req()
				.send({ operation: 'list_users' })
				.expect((r) => {
					for (let user of r.body) {
						if (user.username === 'test_user') {
							assert.equal(user.role.id, 'developer_test_5', r.text);
						}
					}
				})
				.expect(200);
		});

		test('try to set bad role to user', async () => {
			await client
				.req()
				.send({ operation: 'alter_user', role: 'blahblah', username: 'test_user' })
				.expect((r) => assert.equal(r.body.error, "Update failed.  Requested 'blahblah' role not found.", r.text))
				.expect(404);
		});

		test('get user info make sure role was not changed', async () => {
			await client
				.req()
				.send({ operation: 'list_users' })
				.expect((r) => {
					for (let user of r.body) {
						if (user.username === 'test_user') {
							assert.equal(user.role.id, 'developer_test_5', r.text);
						}
					}
				})
				.expect(200);
		});

		test('SQL Try to read suppliers table as SU', async () => {
			await client
				.req()
				.send({
					operation: 'sql',
					sql: `select *
		                                  from northnwd.suppliers`,
				})
				.expect(200);
		});

		test('SQL Try to read FULLY restricted suppliers table as test_user', async () => {
			await client
				.reqAs(headersTestUser)
				.send({
					operation: 'sql',
					sql: `select *
		                                  from northnwd.suppliers`,
				})
				.expect((r) => {
					assert.equal(
						r.body.error,
						'This operation is not authorized due to role restrictions and/or invalid database items',
						r.text
					);
					assert.equal(r.body.invalid_schema_items.length, 1, r.text);
					assert.equal(r.body.invalid_schema_items[0], "Table 'northnwd.suppliers' does not exist", r.text);
					assert.equal(r.body.unauthorized_access.length, 0, r.text);
				})
				.expect(403);
		});

		test('SQL Try to read region table as SU', async () => {
			await client
				.req()
				.send({
					operation: 'sql',
					sql: `select *
		                                  from northnwd.region`,
				})
				.expect(200);
		});

		test('SQL Try to read region table as test_user', async () => {
			await client
				.reqAs(headersTestUser)
				.send({
					operation: 'sql',
					sql: `select *
		                                  from northnwd.region`,
				})
				.expect((r) => {
					let permitted_attrs = ['regiondescription', 'regionid', '__createdtime__', '__updatedtime__'];
					r.body.forEach((obj) => {
						Object.keys(obj).forEach((attr_name) => {
							console.log(attr_name);
							assert.ok(permitted_attrs.includes(attr_name), r.text);
						});
					});
				})
				.expect(200);
		});

		test('SQL Try to insert into region table as SU', async () => {
			await client
				.req()
				.send({
					operation: 'sql',
					sql: "insert into northnwd.region (regionid, regiondescription) values ('16', 'test description')",
				})
				.expect(200);
		});

		test('SQL Try to insert into restricted region table as test_user', async () => {
			await client
				.reqAs(headersTestUser)
				.send({
					operation: 'sql',
					sql: "insert into northnwd.region (regionid, regiondescription) values ('17', 'test description')",
				})
				.expect((r) => {
					assert.equal(
						r.body.error,
						'This operation is not authorized due to role restrictions and/or invalid database items',
						r.text
					);
					assert.equal(r.body.unauthorized_access.length, 1, r.text);
					assert.equal(r.body.unauthorized_access[0].required_table_permissions.length, 1, r.text);
					assert.equal(r.body.unauthorized_access[0].required_table_permissions[0], 'insert', r.text);
					assert.equal(r.body.unauthorized_access[0].schema, 'northnwd', r.text);
					assert.equal(r.body.unauthorized_access[0].table, 'region', r.text);
					assert.equal(r.body.invalid_schema_items.length, 0, r.text);
				})
				.expect(403);
		});

		test('SQL Try to insert into territories table as SU', async () => {
			await client
				.req()
				.send({
					operation: 'sql',
					sql: "insert into northnwd.territories (regionid, territoryid, territorydescription) values ('1', '65', 'Im a test')",
				})
				.expect(200);
		});

		test('SQL Try to insert into territories table with restricted attribute as test_user', async () => {
			await client
				.reqAs(headersTestUser)
				.send({
					operation: 'sql',
					sql: "insert into northnwd.territories (regionid, territoryid, territorydescription) values ('1', '65', 'Im a test')",
				})
				.expect((r) => {
					assert.equal(
						r.body.error,
						'This operation is not authorized due to role restrictions and/or invalid database items',
						r.text
					);
					assert.equal(r.body.invalid_schema_items.length, 1, r.text);
					assert.equal(
						r.body.invalid_schema_items[0],
						"Attribute 'regionid' does not exist on 'northnwd.territories'",
						r.text
					);
					assert.equal(r.body.unauthorized_access.length, 0, r.text);
				})
				.expect(403);
		});

		test('SQL Try to insert into territories table with allowed attributes as test_user', async () => {
			await client
				.reqAs(headersTestUser)
				.send({
					operation: 'sql',
					sql: "insert into northnwd.territories (territoryid, territorydescription) values (165, 'Im a test')",
				})
				.expect((r) => assert.equal(r.body.message, 'inserted 1 of 1 records', r.text))
				.expect((r) => assert.equal(r.body.inserted_hashes[0], 165, r.text))
				.expect(200);
		});

		test('SQL Try to update territories table as SU', async () => {
			await client
				.req()
				.send({
					operation: 'sql',
					sql: "update northnwd.territories set territorydescription = 'update test' where territoryid = 65",
				})
				.expect(200);
		});

		test('SQL Try to update restricted territories table as test_user', async () => {
			await client
				.reqAs(headersTestUser)
				.send({
					operation: 'sql',
					sql: "update northnwd.territories set territorydescription = 'update test' where territoryid = 65",
				})
				.expect((r) => {
					assert.equal(
						r.body.error,
						'This operation is not authorized due to role restrictions and/or invalid database items',
						r.text
					);
					assert.equal(r.body.unauthorized_access.length, 1, r.text);
					assert.equal(r.body.unauthorized_access[0].required_table_permissions.length, 1, r.text);
					assert.equal(r.body.unauthorized_access[0].required_table_permissions[0], 'update', r.text);
					assert.equal(r.body.unauthorized_access[0].schema, 'northnwd', r.text);
					assert.equal(r.body.unauthorized_access[0].table, 'territories', r.text);
					assert.equal(r.body.invalid_schema_items.length, 0, r.text);
				})
				.expect(403);
		});

		test('SQL Try to update categories table as test_user', async () => {
			await client
				.reqAs(headersTestUser)
				.send({
					operation: 'sql',
					sql: "update northnwd.categories set description = 'update test' where categoryid = 2",
				})
				.expect(200);
		});

		test('SQL Try to update restricted attr in categories table as test_user', async () => {
			await client
				.reqAs(headersTestUser)
				.send({
					operation: 'sql',
					sql: "update northnwd.categories set description = 'update test', picture = 'test picture' where categoryid = 2",
				})
				.expect((r) => {
					assert.equal(
						r.body.error,
						'This operation is not authorized due to role restrictions and/or invalid database items',
						r.text
					);
					assert.equal(r.body.invalid_schema_items.length, 1, r.text);
					assert.equal(
						r.body.invalid_schema_items[0],
						"Attribute 'picture' does not exist on 'northnwd.categories'",
						r.text
					);
					assert.equal(r.body.unauthorized_access.length, 0, r.text);
				})
				.expect(403);
		});

		test('SQL Try to delete from categories table as SU', async () => {
			await client
				.req()
				.send({ operation: 'sql', sql: 'delete from northnwd.categories where categoryid = 2' })
				.expect(200);
		});

		test('SQL Try to delete from restricted categories table as test_user', async () => {
			await client
				.reqAs(headersTestUser)
				.send({ operation: 'sql', sql: 'delete from northnwd.categories where categoryid = 2' })
				.expect((r) => {
					assert.equal(
						r.body.error,
						'This operation is not authorized due to role restrictions and/or invalid database items',
						r.text
					);
					assert.equal(r.body.unauthorized_access.length, 1, r.text);
					assert.equal(r.body.unauthorized_access[0].required_table_permissions.length, 1, r.text);
					assert.equal(r.body.unauthorized_access[0].required_table_permissions[0], 'delete', r.text);
					assert.equal(r.body.unauthorized_access[0].schema, 'northnwd', r.text);
					assert.equal(r.body.unauthorized_access[0].table, 'categories', r.text);
					assert.equal(r.body.invalid_schema_items.length, 0, r.text);
				})
				.expect(403);
		});

		test('SQL Try to read shippers table w/ FULLY restricted attributes as test_user - expect empty array', async () => {
			await client
				.reqAs(headersTestUser)
				.send({
					operation: 'sql',
					sql: `select *
		                                  from northnwd.shippers`,
				})
				.expect((r) => assert.equal(r.body.length, 0, r.text))
				.expect(200);
		});

		test('SQL Try to update shippers table restricted attribute as test_user', async () => {
			await client
				.reqAs(headersTestUser)
				.send({
					operation: 'sql',
					sql: `update northnwd.shippers
		              set companyname = 'bad update name'
		              where shipperid = 1`,
				})
				.expect((r) => {
					assert.equal(
						r.body.error,
						'This operation is not authorized due to role restrictions and/or invalid database items',
						r.text
					);
					assert.equal(r.body.invalid_schema_items.length, 1, r.text);
					assert.equal(
						r.body.invalid_schema_items[0],
						"Attribute 'companyname' does not exist on 'northnwd.shippers'",
						r.text
					);
					assert.equal(r.body.unauthorized_access.length, 0, r.text);
				})
				.expect(403);
		});

		test('SQL Try to insert into shippers table w/ FULLY restricted attributes as test_user', async () => {
			await client
				.reqAs(headersTestUser)
				.send({
					operation: 'sql',
					sql: "insert into northnwd.shippers (shipperid, companyname, phone) values ('1', 'bad update name', '(503) 555-9831')",
				})
				.expect((r) => {
					assert.equal(
						r.body.error,
						'This operation is not authorized due to role restrictions and/or invalid database items',
						r.text
					);
					assert.equal(r.body.invalid_schema_items.length, 3, r.text);
					assert.ok(
						r.body.invalid_schema_items.includes("Attribute 'shipperid' does not exist on 'northnwd.shippers'"),
						r.text
					);
					assert.ok(
						r.body.invalid_schema_items.includes("Attribute 'companyname' does not exist on 'northnwd.shippers'"),
						r.text
					);
					assert.ok(
						r.body.invalid_schema_items.includes("Attribute 'phone' does not exist on 'northnwd.shippers'"),
						r.text
					);
					assert.equal(r.body.unauthorized_access.length, 0, r.text);
				})
				.expect(403);
		});

		test('SQL Try to insert categories table unrestricted attributes as test_user', async () => {
			await client
				.reqAs(headersTestUser)
				.send({
					operation: 'sql',
					sql: "insert into northnwd.categories (categoryid, description) values ('9', 'Other food stuff')",
				})
				.expect(200);
		});

		test('SQL Try to read shippers table as test_user with restricted attribute in WHERE', async () => {
			await client
				.reqAs(headersTestUser)
				.send({
					operation: 'sql',
					sql: `select shipperid
		              from northnwd.shippers
		              WHERE (phone IS NOT NULL AND shipperid = 0)
		                 OR companyname IS NOT NULL`,
				})
				.expect((r) => {
					assert.equal(
						r.body.error,
						'This operation is not authorized due to role restrictions and/or invalid database items',
						r.text
					);
					assert.equal(r.body.invalid_schema_items.length, 3, r.text);
					assert.ok(
						r.body.invalid_schema_items.includes("Attribute 'shipperid' does not exist on 'northnwd.shippers'"),
						r.text
					);
					assert.ok(
						r.body.invalid_schema_items.includes("Attribute 'phone' does not exist on 'northnwd.shippers'"),
						r.text
					);
					assert.ok(
						r.body.invalid_schema_items.includes("Attribute 'companyname' does not exist on 'northnwd.shippers'"),
						r.text
					);
					assert.equal(r.body.unauthorized_access.length, 0, r.text);
				})
				.expect(403);
		});

		test('Select with restricted CROSS SCHEMA JOIN as test_user', async () => {
			await client
				.reqAs(headersTestUser)
				.send({
					operation: 'sql',
					sql: 'SELECT d.id, d.dog_name, d.age, d.adorable, o.id, o.name FROM dev.dog AS d INNER JOIN other.owner AS o ON d.owner_id = o.id',
				})
				.expect((r) => {
					assert.equal(
						r.body.error,
						'This operation is not authorized due to role restrictions and/or invalid database items',
						r.text
					);
					assert.equal(r.body.invalid_schema_items.length, 2, r.text);
					assert.ok(r.body.invalid_schema_items.includes("Attribute 'id' does not exist on 'other.owner'"), r.text);
					assert.ok(r.body.invalid_schema_items.includes("Attribute 'name' does not exist on 'other.owner'"), r.text);
					assert.equal(r.body.unauthorized_access.length, 0, r.text);
				})
				.expect(403);
		});

		test('Select * with restricted CROSS SCHEMA JOIN as test_user', async () => {
			await client
				.reqAs(headersTestUser)
				.send({
					operation: 'sql',
					sql: 'SELECT d.*, o.* FROM dev.dog AS d INNER JOIN other.owner AS o ON d.owner_id = o.id ORDER BY o.name, o.id LIMIT 5 OFFSET 1',
				})
				.expect((r) => {
					assert.equal(
						r.body.error,
						'This operation is not authorized due to role restrictions and/or invalid database items',
						r.text
					);
					assert.equal(r.body.invalid_schema_items.length, 2, r.text);
					assert.ok(r.body.invalid_schema_items.includes("Attribute 'id' does not exist on 'other.owner'"), r.text);
					assert.ok(r.body.invalid_schema_items.includes("Attribute 'name' does not exist on 'other.owner'"), r.text);
					assert.equal(r.body.unauthorized_access.length, 0, r.text);
				})
				.expect(403);
		});

		test('Select restricted attrs in CROSS 3 SCHEMA JOINS as test_user', async () => {
			await client
				.reqAs(headersTestUser)
				.send({
					operation: 'sql',
					sql: 'SELECT d.id, d.dog_name, d.age, d.adorable, o.id, o.name, b.id, b.name FROM dev.dog AS d INNER JOIN other.owner AS o ON d.owner_id = o.id INNER JOIN another.breed AS b ON d.breed_id = b.id',
				})
				.expect((r) => {
					assert.equal(
						r.body.error,
						'This operation is not authorized due to role restrictions and/or invalid database items',
						r.text
					);
					assert.equal(r.body.unauthorized_access.length, 1, r.text);
					assert.equal(r.body.unauthorized_access[0].required_table_permissions.length, 1, r.text);
					assert.equal(r.body.unauthorized_access[0].required_table_permissions[0], 'read', r.text);
					assert.equal(r.body.unauthorized_access[0].schema, 'another', r.text);
					assert.equal(r.body.unauthorized_access[0].table, 'breed', r.text);
					assert.equal(r.body.invalid_schema_items.length, 2, r.text);
					assert.ok(r.body.invalid_schema_items.includes("Attribute 'id' does not exist on 'other.owner'"), r.text);
					assert.ok(r.body.invalid_schema_items.includes("Attribute 'name' does not exist on 'other.owner'"), r.text);
				})
				.expect(403);
		});

		test('Select with complex CROSS 3 SCHEMA JOINS as test_user', async () => {
			await client
				.reqAs(headersTestUser)
				.send({
					operation: 'sql',
					sql: 'SELECT d.age AS dog_age, AVG(d.weight_lbs) AS dog_weight, o.name AS owner_name, b.name, b.image FROM dev.dog AS d INNER JOIN other.owner AS o ON d.owner_id = o.id INNER JOIN another.breed AS b ON d.breed_id = b.id GROUP BY o.name, b.name, d.age ORDER BY b.name',
				})
				.expect((r) => {
					assert.equal(
						r.body.error,
						'This operation is not authorized due to role restrictions and/or invalid database items',
						r.text
					);
					assert.equal(r.body.unauthorized_access.length, 1, r.text);
					assert.equal(r.body.unauthorized_access[0].required_table_permissions.length, 1, r.text);
					assert.equal(r.body.unauthorized_access[0].required_table_permissions[0], 'read', r.text);
					assert.equal(r.body.unauthorized_access[0].schema, 'another', r.text);
					assert.equal(r.body.unauthorized_access[0].table, 'breed', r.text);
					assert.equal(r.body.invalid_schema_items.length, 2, r.text);
					assert.ok(r.body.invalid_schema_items.includes("Attribute 'id' does not exist on 'other.owner'"), r.text);
					assert.ok(r.body.invalid_schema_items.includes("Attribute 'name' does not exist on 'other.owner'"), r.text);
				})
				.expect(403);
		});

		test('Select * w/ two table CROSS SCHEMA JOIN on table with FULLY restricted attributes as test_user', async () => {
			await client
				.reqAs(headersTestUser)
				.send({
					operation: 'sql',
					sql: 'SELECT d.*, o.* FROM dev.dog AS d INNER JOIN other.owner AS o ON d.owner_id = o.id ORDER BY o.name, o.id LIMIT 5 OFFSET 1',
				})
				.expect((r) => {
					assert.equal(
						r.body.error,
						'This operation is not authorized due to role restrictions and/or invalid database items',
						r.text
					);
					assert.equal(r.body.invalid_schema_items.length, 2, r.text);
					assert.ok(r.body.invalid_schema_items.includes("Attribute 'name' does not exist on 'other.owner'"), r.text);
					assert.ok(r.body.invalid_schema_items.includes("Attribute 'id' does not exist on 'other.owner'"), r.text);
					assert.equal(r.body.unauthorized_access.length, 0, r.text);
				})
				.expect(403);
		});

		test('SQL ALTER non SU role', async () => {
			await client
				.req()
				.send({
					operation: 'alter_role',
					role: 'developer_test_5',
					id: 'developer_test_5',
					permission: {
						super_user: false,
						northnwd: {
							tables: {
								customers: {
									read: true,
									insert: true,
									update: true,
									delete: true,
									attribute_permissions: [],
								},
								suppliers: {
									read: false,
									insert: false,
									update: false,
									delete: false,
									attribute_permissions: [],
								},
								region: {
									read: true,
									insert: false,
									update: false,
									delete: false,
									attribute_permissions: [
										{
											attribute_name: 'regiondescription',
											read: true,
											insert: false,
											update: false,
										},
									],
								},
								territories: {
									read: true,
									insert: true,
									update: false,
									delete: false,
									attribute_permissions: [
										{
											attribute_name: 'territorydescription',
											read: true,
											insert: true,
											update: false,
										},
									],
								},
								categories: {
									read: true,
									insert: true,
									update: true,
									delete: false,
									attribute_permissions: [
										{
											attribute_name: 'description',
											read: true,
											insert: true,
											update: true,
										},
									],
								},
								shippers: {
									read: true,
									insert: true,
									update: true,
									delete: true,
									attribute_permissions: [
										{
											attribute_name: 'companyname',
											read: false,
											insert: false,
											update: false,
										},
									],
								},
							},
						},
						dev: {
							tables: {
								dog: {
									read: true,
									insert: true,
									update: true,
									delete: true,
									attribute_permissions: [],
								},
							},
						},
						other: {
							tables: {
								owner: {
									read: true,
									insert: false,
									update: true,
									delete: false,
									attribute_permissions: [
										{
											attribute_name: 'name',
											read: true,
											insert: false,
											update: false,
										},
									],
								},
							},
						},
						another: {
							tables: {
								breed: {
									read: true,
									insert: true,
									update: true,
									delete: true,
									attribute_permissions: [
										{
											attribute_name: 'name',
											read: true,
											insert: false,
											update: false,
										},
									],
								},
							},
						},
					},
				})
				.expect(200);
		});

		test('Select two table CROSS SCHEMA JOIN as test_user', async () => {
			await client
				.reqAs(headersTestUser)
				.send({
					operation: 'sql',
					sql: 'SELECT d.id, d.dog_name, d.age, d.adorable, o.id, o.name FROM dev.dog AS d INNER JOIN other.owner AS o ON d.owner_id = o.id',
				})
				.expect((r) => {
					assert.equal(r.body.length, 8, r.text);
					const expected_attributes = ['id', 'dog_name', 'age', 'adorable', 'id1', 'name'];
					//Important to test that only the id (returned as id1) and name attributes come back for 'other.owner'
					// since user only has access to those two attributes
					r.body.forEach((row) => {
						expected_attributes.forEach((attr) => {
							assert.ok(row.hasOwnProperty(attr), r.text);
						});
					});
				})
				.expect((r) => {
					assert.equal(r.body[1].name, 'David', r.text);
					assert.equal(r.body[3].id1, 1, r.text);
					assert.equal(r.body[4].id1, 2, r.text);
				})
				.expect(200);
		});

		test('Select * w/ two table CROSS SCHEMA JOIN as test_user', async () => {
			await client
				.reqAs(headersTestUser)
				.send({
					operation: 'sql',
					sql: 'SELECT d.*, o.* FROM dev.dog AS d INNER JOIN other.owner AS o ON d.owner_id = o.id ORDER BY o.name, o.id LIMIT 5 OFFSET 1',
				})
				.expect((r) => assert.equal(r.body.length, 5, r.text))
				.expect((r) => {
					let expected_names = ['David', 'Kaylan', 'Kaylan', 'Kyle', 'Kyle'];
					let expected_attrs = [
						'__createdtime__',
						'age',
						'dog_name',
						'adorable',
						'owner_id',
						'__updatedtime__',
						'id',
						'weight_lbs',
						'breed_id',
						'name',
						'id1',
					];
					r.body.forEach((obj, i) => {
						assert.equal(obj.name, expected_names[i], r.text);
						let keys = Object.keys(obj);
						keys.forEach((key) => {
							assert.ok(expected_attrs.includes(key), r.text);
						});
					});
				})
				.expect(200);
		});

		test('Select w/ CROSS 3 SCHEMA JOINS as test_user', async () => {
			await client
				.reqAs(headersTestUser)
				.send({
					operation: 'sql',
					sql: 'SELECT d.id, d.dog_name, d.age, d.adorable, o.id, o.name, b.id, b.name FROM dev.dog AS d INNER JOIN other.owner AS o ON d.owner_id = o.id INNER JOIN another.breed AS b ON d.breed_id = b.id',
				})
				.expect((r) => {
					assert.equal(r.body.length, 7, r.text);
					r.body.forEach((row) => {
						assert.ok(row.id, r.text);
						assert.ok(row.id1, r.text);
						assert.ok(row.id2, r.text);
						assert.ok(row.dog_name, r.text);
						assert.ok(row.age, r.text);
						assert.ok(row.name, r.text);
						assert.ok(row.name1, r.text);
					});
				})
				.expect((r) => {
					assert.equal(r.body[1].name, 'David', r.text);
					assert.equal(r.body[1].id1, 3, r.text);
					assert.equal(r.body[4].id1, 2, r.text);
					assert.equal(r.body[6].id1, 1, r.text);
					assert.equal(r.body[6].name1, 'MASTIFF', r.text);
				})
				.expect(200);
		});

		test('Select with complex CROSS 3 SCHEMA JOINS as test_user', async () => {
			await client
				.reqAs(headersTestUser)
				.send({
					operation: 'sql',
					sql: 'SELECT d.age AS dog_age, AVG(d.weight_lbs) AS dog_weight, o.name AS owner_name, b.name FROM dev.dog AS d INNER JOIN other.owner AS o ON d.owner_id = o.id INNER JOIN another.breed AS b ON d.breed_id = b.id GROUP BY o.name, b.name, d.age ORDER BY b.name',
				})
				.expect((r) => {
					assert.equal(r.body.length, 7, r.text);
					r.body.forEach((row) => {
						assert.ok(row.dog_age, r.text);
						assert.ok(row.dog_weight, r.text);
						assert.ok(row.owner_name, r.text);
						assert.ok(row.name, r.text);
					});
				})
				.expect((r) => {
					assert.equal(r.body[0].dog_age, 1, r.text);
					assert.equal(r.body[0].dog_weight, 35, r.text);
					assert.equal(r.body[0].owner_name, 'Kaylan', r.text);
					assert.equal(r.body[0].name, 'BEAGLE MIX', r.text);
					assert.equal(r.body[6].dog_age, 5, r.text);
					assert.equal(r.body[6].dog_weight, 35, r.text);
					assert.equal(r.body[6].owner_name, 'Kyle', r.text);
					assert.equal(r.body[6].name, 'WHIPPET', r.text);
				})
				.expect(200);
		});

		test('SQL ALTER non SU role with multi table join restrictions', async () => {
			await client
				.req()
				.send({
					operation: 'alter_role',
					role: 'developer_test_5',
					id: 'developer_test_5',
					permission: {
						super_user: false,
						dev: {
							tables: {
								dog: {
									read: false,
									insert: true,
									update: true,
									delete: false,
									attribute_permissions: [],
								},
							},
						},
						other: {
							tables: {
								owner: {
									read: true,
									insert: false,
									update: true,
									delete: false,
									attribute_permissions: [
										{
											attribute_name: 'name',
											read: false,
											insert: false,
											update: false,
										},
									],
								},
							},
						},
						another: {
							tables: {
								breed: {
									read: true,
									insert: false,
									update: false,
									delete: false,
									attribute_permissions: [
										{
											attribute_name: 'name',
											read: true,
											insert: false,
											update: false,
										},
									],
								},
							},
						},
					},
				})
				.expect(200);
		});

		test('Select with ALL RESTRICTED complex CROSS 3 SCHEMA JOINS as test_user', async () => {
			await client
				.reqAs(headersTestUser)
				.send({
					operation: 'sql',
					sql: 'SELECT d.age AS dog_age, AVG(d.weight_lbs) AS dog_weight, o.name AS owner_name, b.name, b.country FROM dev.dog AS d INNER JOIN other.owner AS o ON d.owner_id = o.id INNER JOIN another.breed AS b ON d.breed_id = b.id GROUP BY o.name, b.name, d.age ORDER BY b.name',
				})
				.expect((r) => {
					assert.equal(
						r.body.error,
						'This operation is not authorized due to role restrictions and/or invalid database items',
						r.text
					);
					assert.equal(r.body.unauthorized_access.length, 1, r.text);
					assert.equal(r.body.unauthorized_access[0].required_table_permissions.length, 1, r.text);
					assert.equal(r.body.unauthorized_access[0].required_table_permissions[0], 'read', r.text);
					assert.equal(r.body.unauthorized_access[0].schema, 'dev', r.text);
					assert.equal(r.body.unauthorized_access[0].table, 'dog', r.text);
					assert.equal(r.body.invalid_schema_items.length, 3, r.text);
					assert.ok(r.body.invalid_schema_items.includes("Attribute 'id' does not exist on 'other.owner'"), r.text);
					assert.ok(r.body.invalid_schema_items.includes("Attribute 'name' does not exist on 'other.owner'"), r.text);
					assert.ok(
						r.body.invalid_schema_items.includes("Attribute 'country' does not exist on 'another.breed'"),
						r.text
					);
				})
				.expect(403);
		});

		test('SQL drop test user', async () => {
			await client
				.req()
				.send({ operation: 'drop_user', username: 'test_user' })
				.expect((r) => assert.equal(r.body.message, 'test_user successfully deleted', r.text))
				.expect(200);
		});

		test('Drop non-existent user', async () => {
			await client
				.req()
				.send({ operation: 'drop_user', username: 'test_user' })
				.expect((r) => assert.equal(r.body.error, 'User test_user does not exist', r.text))
				.expect(404);
		});

		test('SQL drop_role', async () => {
			await client
				.req()
				.send({ operation: 'drop_role', id: 'developer_test_5' })
				.expect((r) => assert.equal(r.body.message, 'developer_test_5 successfully deleted', r.text))
				.expect(200);
		});

		test('Drop non-existent role', async () => {
			await client
				.req()
				.send({ operation: 'drop_role', id: 'developer_test_5' })
				.expect((r) => assert.equal(r.body.error, 'Role not found', r.text))
				.expect(404);
		});
	});

	suite('7. Jobs & Job Role Testing', () => {
		//Jobs & Job Role Testing Folder

		//S3 Operations
		suite.skip('S3 Operations', () => {
			test('Create schema for S3 test', async () => {
				await client.req().send({ operation: 'create_schema', schema: 'S3_DATA' }).expect(200);
			});

			test('Create dogs table for S3 test', async () => {
				await client
					.req()
					.send({ operation: 'create_table', schema: 'S3_DATA', table: 'dogs', primary_key: 'id' })
					.expect(200);
			});

			test('Create breed table for S3 test', async () => {
				await client
					.req()
					.send({ operation: 'create_table', schema: 'S3_DATA', table: 'breed', primary_key: 'id' })
					.expect(200);
			});

			test('Create owners table for S3 test', async () => {
				await client
					.req()
					.send({ operation: 'create_table', schema: 'S3_DATA', table: 'owners', primary_key: 'id' })
					.expect(200);
			});

			test('Create sensor table for S3 test', async () => {
				await client
					.req()
					.send({ operation: 'create_table', schema: 'S3_DATA', table: 'sensor', primary_key: 'id' })
					.expect(200);
			});

			test('Import dogs.xlsx from S3 - expect error', async () => {
				await client
					.req()
					.send({
						operation: 'import_from_s3',
						action: 'insert',
						schema: 'S3_DATA',
						table: 'dogs',
						s3: {},
					})
					.expect((r) =>
						assert.equal(
							r.body.error,
							"S3 key must include one of the following valid file extensions - '.csv', '.json'",
							r.text
						)
					)
					.expect(400);
			});

			test('Import dogs.csv from S3', async () => {
				const response = await client
					.req()
					.send({
						operation: 'import_from_s3',
						action: 'insert',
						schema: 'S3_DATA',
						table: 'dogs',
						s3: {},
					})
					.expect((r) => assert.equal(r.body.message.indexOf('Starting job'), 0, r.text))
					.expect(200);

				const id = getJobId(response.body);
				await checkJobCompleted(id, '', 'successfully loaded 12 of 12 records');
			});

			test('Import owners.json from S3', async () => {
				const response = await client
					.req()
					.send({
						operation: 'import_from_s3',
						action: 'insert',
						schema: 'S3_DATA',
						table: 'owners',
						s3: {},
					})
					.expect(200);

				const id = getJobId(response.body);
				await checkJobCompleted(id, '', 'successfully loaded 4 of 4 records');
			});

			test('Import breed.json from S3', async () => {
				const response = await client
					.req()
					.send({
						operation: 'import_from_s3',
						action: 'insert',
						schema: 'S3_DATA',
						table: 'breed',
						s3: {},
					})
					.expect(200);

				const id = getJobId(response.body);
				await checkJobCompleted(id, '', 'successfully loaded 350 of 350 records');
			});

			test('Import does_not_exist.csv from S3 - expect fail', async () => {
				const response = await client
					.req()
					.send({
						operation: 'import_from_s3',
						action: 'insert',
						schema: 'S3_DATA',
						table: 'owners',
						s3: {},
					})
					.expect(200);

				const id = getJobId(response.body);
				await checkJobCompleted(id, 'The specified key does not exist.');
			});

			test('Import dogs_update.csv from S3', async () => {
				const response = await client
					.req()
					.send({
						operation: 'import_from_s3',
						action: 'update',
						schema: 'S3_DATA',
						table: 'dogs',
						s3: {},
					})
					.expect(200);

				const id = getJobId(response.body);
				await checkJobCompleted(id, '', 'successfully loaded 12 of 12 records');
			});

			test('Import owners_update.json from S3', async () => {
				const response = await client
					.req()
					.send({
						operation: 'import_from_s3',
						action: 'update',
						schema: 'S3_DATA',
						table: 'owners',
						s3: {},
					})
					.expect(200);

				const id = getJobId(response.body);
				await checkJobCompleted(id, '', 'successfully loaded 4 of 4 records');
			});

			test('Import large sensor_data.json from S3', async () => {
				const response = await client
					.req()
					.send({
						operation: 'import_from_s3',
						action: 'insert',
						schema: 'S3_DATA',
						table: 'sensor',
						s3: {},
					})
					.expect(200);

				const id = getJobId(response.body);
				await checkJobCompleted(id, '', 'successfully loaded 20020 of 20020 records');
			});

			test('Import large sensor_data.json for UPSERT from S3', async () => {
				const response = await client
					.req()
					.send({
						operation: 'import_from_s3',
						action: 'upsert',
						schema: 'S3_DATA',
						table: 'sensor',
						s3: {},
					})
					.expect(200);

				const id = getJobId(response.body);
				await checkJobCompleted(id, '', 'successfully loaded 20020 of 20020 records');
			});

			test('Check rows from S3 upsert were updated', async () => {
				await client
					.req()
					.send({ operation: 'sql', sql: 'SELECT * FROM S3_DATA.sensor' })
					.expect((r) => {
						r.body.forEach((row) => {
							assert.ok(row.__updatedtime__ > row.__createdtime__, r.text);
						});
					})
					.expect(200);
			});

			test('Import does_not_exist_UPDATE.csv from S3 - expect fail', async () => {
				const response = await client
					.req()
					.send({
						operation: 'import_from_s3',
						action: 'update',
						schema: 'S3_DATA',
						table: 'owners',
						s3: {},
					})
					.expect(200);

				const id = getJobId(response.body);
				await checkJobCompleted(id, 'The specified key does not exist.', '');
			});

			test('Export to S3', async () => {
				const response = await client
					.req()
					.send({
						operation: 'export_to_s3',
						format: 'csv',
						s3: {},
						search_operation: { operation: 'sql', sql: 'SELECT * FROM S3_DATA.dogs LIMIT 1' },
					})
					.expect(200);

				const id = getJobId(response.body);
				const jobResponse = await checkJob(id, 15);

				assert.ok(jobResponse.body[0].result.ETag, jobResponse.text);
				assert.ok(jobResponse.body[0].result.VersionId, jobResponse.text);
			});

			test('Export to S3 search_by_conditions', async () => {
				const response = await client
					.req()
					.send({
						operation: 'export_to_s3',
						format: 'csv',
						s3: {},
						search_operation: {
							operation: 'search_by_conditions',
							database: 'S3_DATA',
							table: 'dogs',
							operator: 'and',
							get_attributes: ['*'],
							conditions: [{ search_attribute: 'breed_id', search_type: 'between', search_value: [199, 280] }],
						},
					})
					.expect(200);

				const id = getJobId(response.body);
				const jobResponse = await checkJob(id, 15);

				assert.ok(jobResponse.body[0].result.ETag, jobResponse.text);
				assert.ok(jobResponse.body[0].result.VersionId, jobResponse.text);
			});

			test('Export local search_by_conditions', async () => {
				const response = await client
					.req()
					.send({
						operation: 'export_local',
						path: './',
						format: 'json',
						filename: 'integration-test',
						search_operation: {
							operation: 'search_by_conditions',
							database: 'S3_DATA',
							table: 'dogs',
							operator: 'and',
							get_attributes: ['*'],
							conditions: [{ search_attribute: 'breed_id', search_type: 'between', search_value: [199, 200] }],
						},
					})
					.expect(200);

				const id = getJobId(response.body);
				const jobResponse = await checkJob(id, 15);

				assert.equal(jobResponse.body[0].result.message, 'Successfully exported JSON locally.', jobResponse.text);
				assert.equal(jobResponse.body[0].type, 'export_local', jobResponse.text);
			});

			test('Create S3 test table', async () => {
				await client
					.req()
					.send({ operation: 'create_table', schema: 'S3_DATA', table: 's3_test', primary_key: 'id' })
					.expect(200);
			});

			test('Create S3 CSV import test table', async () => {
				await client
					.req()
					.send({ operation: 'create_table', schema: 'S3_DATA', table: 's3_test_csv_import', primary_key: 'id' })
					.expect(200);
			});

			test('Create S3 JSON import test table', async () => {
				await client
					.req()
					.send({
						operation: 'create_table',
						schema: 'S3_DATA',
						table: 's3_test_json_import',
						primary_key: 'id',
					})
					.expect(200);
			});

			test('Insert records S3 test table', async () => {
				await client
					.req()
					.send({
						operation: 'insert',
						schema: 'S3_DATA',
						table: 's3_test',
						records: [
							{
								id: 'a',
								address: '1 North Street',
								lastname: 'Dog',
								firstname: 'Harper',
								one: 'only one',
							},
							{
								id: 'b',
								object: { name: 'object', number: 1, array: [1, 'two'] },
								array: [1, 2, 'three'],
								firstname: 'Harper',
							},
							{ id: 'c', object_array: [{ number: 1 }, { number: 'two', count: 2 }] },
						],
					})
					.expect((r) => assert.equal(r.body.inserted_hashes.length, 3, r.text))
					.expect((r) => assert.equal(r.body.message, 'inserted 3 of 3 records', r.text))
					.expect(200);
			});

			test('Export S3 test table CSV', async () => {
				const response = await client
					.req()
					.send({
						operation: 'export_to_s3',
						format: 'csv',
						s3: {},
						search_operation: { operation: 'sql', sql: 'SELECT * FROM S3_DATA.s3_test' },
					})
					.expect(200);

				const id = getJobId(response.body);
				const jobResponse = await checkJob(id, 15);

				assert.ok(jobResponse.body[0].result.ETag, jobResponse.text);
				assert.ok(jobResponse.body[0].result.VersionId, jobResponse.text);
			});

			test('Import S3 test table CSV', async () => {
				const response = await client
					.req()
					.send({
						operation: 'import_from_s3',
						action: 'insert',
						schema: 'S3_DATA',
						table: 's3_test_csv_import',
						s3: {},
					})
					.expect(200);

				const id = getJobId(response.body);
				const jobResponse = await checkJob(id, 15);

				assert.ok(jobResponse.body[0].message.includes('successfully loaded'), jobResponse.text);
			});

			test('Confirm CSV records import', async () => {
				await client
					.req()
					.send({
						operation: 'sql',
						sql: 'select `one`, `object_array`, `id`, `address`, `object`, `lastname`, `firstname`, `array` FROM S3_DATA.s3_test_csv_import ORDER BY id ASC',
					})
					.expect((r) => {
						let expected_res = [
							{
								one: 'only one',
								object_array: '',
								id: 'a',
								address: '1 North Street',
								object: '',
								lastname: 'Dog',
								firstname: 'Harper',
								array: '',
							},
							{
								one: '',
								object_array: '',
								id: 'b',
								address: '',
								object: {
									name: 'object',
									number: 1,
									array: [1, 'two'],
								},
								lastname: '',
								firstname: 'Harper',
								array: [1, 2, 'three'],
							},
							{
								one: '',
								object_array: [
									{
										number: 1,
									},
									{
										number: 'two',
										count: 2,
									},
								],
								id: 'c',
								address: '',
								object: '',
								lastname: '',
								firstname: '',
								array: '',
							},
						];
						assert.deepEqual(r.body, expected_res, r.text);
					})
					.expect(200);
			});

			test('Export S3 test table JSON', async () => {
				const response = await client
					.req()
					.send({
						operation: 'export_to_s3',
						format: 'json',
						s3: {},
						search_operation: { operation: 'sql', sql: 'SELECT * FROM S3_DATA.s3_test' },
					})
					.expect(200);

				const id = getJobId(response.body);
				const jobResponse = await checkJob(id, 15);

				assert.ok(jobResponse.body[0].result.ETag, jobResponse.text);
			});

			test('Import S3 test table JSON', async () => {
				const response = await client
					.req()
					.send({
						operation: 'import_from_s3',
						action: 'insert',
						schema: 'S3_DATA',
						table: 's3_test_json_import',
						s3: {},
					})
					.expect(200);
				const id = getJobId(response.body);
				const jobResponse = await checkJob(id, 15);

				assert.ok(jobResponse.body[0].message.includes('successfully loaded'), jobResponse.text);
			});

			test('Confirm JSON records import', async () => {
				const response = await client
					.req()
					.send({
						operation: 'sql',
						sql: 'select `one`, `object_array`, `id`, `address`, `object`, `lastname`, `firstname`, `array` FROM S3_DATA.s3_test_csv_import ORDER BY id ASC',
					})
					.expect(200);

				let expected_res = [
					{
						one: 'only one',
						object_array: '',
						id: 'a',
						address: '1 North Street',
						object: '',
						lastname: 'Dog',
						firstname: 'Harper',
						array: '',
					},
					{
						one: '',
						object_array: '',
						id: 'b',
						address: '',
						object: {
							name: 'object',
							number: 1,
							array: [1, 'two'],
						},
						lastname: '',
						firstname: 'Harper',
						array: [1, 2, 'three'],
					},
					{
						one: '',
						object_array: [
							{
								number: 1,
							},
							{
								number: 'two',
								count: 2,
							},
						],
						id: 'c',
						address: '',
						object: '',
						lastname: '',
						firstname: '',
						array: '',
					},
				];
				assert.deepEqual(response.body, expected_res, response.text);
			});

			test('Drop S3 schema', async () => {
				await client.req().send({ operation: 'drop_schema', schema: 'S3_DATA' }).expect(200);
			});
		});

		//Jobs & Job Role Testing Main Folder

		test('Jobs - Add non SU role', async () => {
			await client
				.req()
				.send({
					operation: 'add_role',
					role: 'developer_test_5',
					permission: {
						super_user: false,
						northnwd: {
							tables: {
								customers: {
									read: true,
									insert: true,
									update: true,
									delete: true,
									attribute_permissions: [],
								},
								suppliers: {
									read: false,
									insert: false,
									update: false,
									delete: false,
									attribute_permissions: [],
								},
								region: {
									read: true,
									insert: false,
									update: false,
									delete: false,
									attribute_permissions: [
										{
											attribute_name: 'regiondescription',
											read: true,
											insert: false,
											update: false,
										},
									],
								},
								territories: {
									read: true,
									insert: true,
									update: false,
									delete: false,
									attribute_permissions: [
										{
											attribute_name: 'territorydescription',
											read: true,
											insert: true,
											update: false,
										},
									],
								},
								categories: {
									read: true,
									insert: true,
									update: true,
									delete: false,
									attribute_permissions: [
										{
											attribute_name: 'description',
											read: true,
											insert: true,
											update: true,
										},
									],
								},
								shippers: {
									read: true,
									insert: true,
									update: true,
									delete: true,
									attribute_permissions: [
										{
											attribute_name: 'companyname',
											read: false,
											insert: false,
											update: false,
										},
									],
								},
							},
						},
					},
				})
				.expect(200);
		});

		test('Jobs - Add User with new Role', async () => {
			await client
				.req()
				.send({
					operation: 'add_user',
					role: 'developer_test_5',
					username: 'test_user',
					password: `${adminPwd}`,
					active: true,
				})
				.expect(200);
		});

		test('Jobs - Add jobs test schema', async () => {
			await client
				.req()
				.send({ operation: 'create_schema', schema: 'test_job' })
				.expect((r) => assert.ok(r.body.message.includes('successfully created'), r.text))
				.expect(200);
			await setTimeout(500);
		});

		test('Jobs - Add runner table', async () => {
			await client
				.req()
				.send({ operation: 'create_table', schema: 'test_job', table: 'runner', primary_key: 'runner_id' })
				.expect(200);
			await setTimeout(500);
		});

		test('Jobs - Insert into runners table', async () => {
			await client
				.req()
				.send({
					operation: 'insert',
					schema: 'test_job',
					table: 'runner',
					records: [{ name: 'Harper', shoes: 'Nike', runner_id: '1', age: 55 }],
				})
				.expect(200);
			await setTimeout(200);
		});

		test('Jobs - Validate 1 entry in runners table', async () => {
			await client
				.req()
				.send({ operation: 'sql', sql: 'select * from test_job.runner' })
				.expect((r) => assert.equal(r.body.length, 1, r.text))
				.expect(200);
		});

		test('Jobs - Test Remove Files Before with test_user', async () => {
			await client
				.reqAs(headersTestUser)
				.send({ operation: 'delete_files_before', date: '2018-06-14', schema: 'dog' })
				.expect((r) => {
					assert.equal(
						r.body.error,
						'This operation is not authorized due to role restrictions and/or invalid database items',
						r.text
					);
					assert.equal(r.body.unauthorized_access.length, 1, r.text);
					assert.equal(
						r.body.unauthorized_access[0],
						"Operation 'deleteFilesBefore' is restricted to 'super_user' roles",
						r.text
					);
					assert.equal(r.body.invalid_schema_items.length, 0, r.text);
				})
				.expect(403);
		});

		test('Jobs - Test Remove Files Before with su and store job_id', async () => {
			const response = await client
				.req()
				.send({
					operation: 'delete_files_before',
					date: `${dateTomorrow}`,
					schema: 'test_job',
					table: 'runner',
				})
				.expect(200);

			const id = getJobId(response.body);
			const jobResponse = await checkJob(id, 15);
			assert.equal(jobResponse.body[0].message, '1 of 1 record successfully deleted', jobResponse.text);
			jobId = id;
		});

		test('Jobs - Validate 0 entry in runners table', async () => {
			await client
				.req()
				.send({ operation: 'sql', sql: 'select * from test_job.runner' })
				.expect((r) => assert.equal(r.body.length, 0, r.text))
				.expect(200);
		});

		test('Search Jobs by date', async () => {
			await client
				.req()
				.send({
					operation: 'search_jobs_by_start_date',
					from_date: `${dateYesterday}`,
					to_date: `${dateTomorrow}`,
				})
				.expect((r) => assert.ok(r.body.length > 0, r.text));
		});

		test('Search Jobs by date - non-super user', async () => {
			await client
				.reqAs(headersTestUser)
				.send({
					operation: 'search_jobs_by_start_date',
					from_date: `${dateYesterday}`,
					to_date: `${dateTomorrow}`,
				})
				.expect((r) => {
					assert.equal(
						r.body.error,
						'This operation is not authorized due to role restrictions and/or invalid database items',
						r.text
					);
					assert.equal(r.body.unauthorized_access.length, 1, r.text);
					assert.equal(
						r.body.unauthorized_access[0],
						"Operation 'handleGetJobsByStartDate' is restricted to 'super_user' roles",
						r.text
					);
					assert.equal(r.body.invalid_schema_items.length, 0, r.text);
				})
				.expect(403);
		});

		test('Search Jobs by job_id', async () => {
			await client
				.req()
				.send({ operation: 'get_job', id: `${jobId}` })
				.expect((r) => assert.equal(r.body.length, 1, r.text))
				.expect(200);
		});

		test('Search Jobs by job_id - non-super user', async () => {
			await client
				.reqAs(headersTestUser)
				.send({ operation: 'get_job', id: `${jobId}` })
				.expect((r) => assert.equal(r.body.length, 1, r.text))
				.expect(200);
		});

		test('Jobs - Bulk CSV load into restricted region table as test_user', async () => {
			await client
				.reqAs(headersTestUser)
				.send({
					operation: 'csv_data_load',
					schema: `northnwd`,
					table: `region`,
					data: "regionid, regiondescription\n'17', 'test description'\n",
				})
				.expect(403);
		});

		test('Jobs - Bulk CSV load into restricted region table as su', async () => {
			await client
				.req()
				.send({
					operation: 'csv_data_load',
					schema: `northnwd`,
					table: `region`,
					data: "regionid, regiondescription\n'17', 'test description'\n",
				})
				.expect(200);
		});

		test('Jobs - Bulk CSV Load - insert suppliers table restricted attribute as test_user', async () => {
			await client
				.reqAs(headersTestUser)
				.send({
					operation: 'csv_file_load',
					action: 'insert',
					schema: `northnwd`,
					table: `suppliers`,
					file_path: `${csvPath}Suppliers.csv`,
				})
				.expect((r) => {
					assert.equal(
						r.body.error,
						'This operation is not authorized due to role restrictions and/or invalid database items',
						r.text
					);
					assert.equal(r.body.invalid_schema_items.length, 1, r.text);
					assert.equal(r.body.invalid_schema_items[0], "Table 'northnwd.suppliers' does not exist", r.text);
					assert.equal(r.body.unauthorized_access.length, 0, r.text);
				})
				.expect(403);
		});

		test('Jobs Test Export To Local using SQL as su', async () => {
			await client
				.req()
				.send({
					operation: 'export_local',
					path: './',
					filename: 'test_export.json',
					format: 'json',
					search_operation: {
						operation: 'sql',
						sql: `select *
		                                    from northnwd.shippers`,
					},
				})
				.expect(200);
		});

		test('Jobs Test Export To Local using NoSQL as su', async () => {
			await client
				.req()
				.send({
					operation: 'export_local',
					path: './',
					filename: 'test_export.json',
					format: 'json',
					search_operation: {
						operation: 'search_by_hash',
						schema: `northnwd`,
						table: `shippers`,
						primary_key: `shipperid`,
						hash_values: [1],
						get_attributes: ['companyname'],
					},
				})
				.expect(200);
		});

		test('Jobs Test Export To Local using SQL as test_user on table with FULLY restricted attrs', async () => {
			await client
				.reqAs(headersTestUser)
				.send({
					operation: 'export_local',
					path: './',
					filename: 'test_export.json',
					format: 'json',
					search_operation: {
						operation: 'sql',
						sql: `select *
		                                    from northnwd.shippers`,
					},
				})
				.expect(200);
		});

		test('Jobs Test Export To Local using SQL on RESTRICTED table as test_user', async () => {
			await client
				.reqAs(headersTestUser)
				.send({
					operation: 'export_local',
					path: './',
					filename: 'test_export.json',
					format: 'json',
					search_operation: {
						operation: 'sql',
						sql: `select *
		                                    from northnwd.suppliers`,
					},
				})
				.expect((r) => {
					assert.equal(
						r.body.error,
						'This operation is not authorized due to role restrictions and/or invalid database items',
						r.text
					);
					assert.equal(r.body.invalid_schema_items.length, 1, r.text);
					assert.equal(r.body.invalid_schema_items[0], "Table 'northnwd.suppliers' does not exist", r.text);
					assert.equal(r.body.unauthorized_access.length, 0, r.text);
				})
				.expect(403);
		});

		test('Jobs Test Export To Local using SQL as test_user on table w/ two attr perms', async () => {
			await client
				.reqAs(headersTestUser)
				.send({
					operation: 'export_local',
					path: './',
					filename: 'test_export.json',
					format: 'json',
					search_operation: {
						operation: 'sql',
						sql: `select *
		                                    from northnwd.region`,
					},
				})
				.expect(200);
		});

		test('Jobs Test Export To Local using NoSQL as test_user', async () => {
			await client
				.reqAs(headersTestUser)
				.send({
					operation: 'export_local',
					path: './',
					filename: 'test_export',
					format: 'json',
					search_operation: {
						operation: 'search_by_hash',
						schema: `northnwd`,
						table: `suppliers`,
						primary_key: `supplierid`,
						hash_values: [1],
						get_attributes: ['supplierid'],
					},
				})
				.expect((r) =>
					assert.equal(
						r.body.error,
						'This operation is not authorized due to role restrictions and/or invalid database items',
						r.text
					)
				)
				.expect((r) =>
					assert.equal(
						r.body.unauthorized_access[0],
						"Operation 'export_local' is restricted to 'super_user' roles",
						r.text
					)
				)
				.expect(403);
		});

		test('Jobs - drop test user', async () => {
			await client.req().send({ operation: 'drop_user', username: 'test_user' }).expect(200);
		});

		test('Jobs -  drop_role', async () => {
			await client.req().send({ operation: 'drop_role', id: 'developer_test_5' }).expect(200);
		});

		test('Jobs - Delete Jobs_test schema', async () => {
			await client
				.req()
				.send({ operation: 'drop_schema', schema: 'test_job' })
				.expect((r) => assert.ok(r.body.message.includes('successfully delete'), r.text))
				.expect(200);
		});
	});

	suite('10. Other Role Tests', () => {
		//Other Role Tests Folder

		//Describe ops role testing
		//super_user tests

		test('Describe schema - SU on system schema', async () => {
			await client
				.req()
				.send({ operation: 'describe_schema', schema: 'system' })
				.expect((r) => {
					assert.ok(Object.keys(r.body).length > 0, r.text);
					assert.equal(r.body.hdb_info.schema, 'system', r.text);
				})
				.expect(200);
		});

		test('Describe Schema - schema doesnt exist', async () => {
			await client
				.req()
				.send({ operation: 'describe_schema', schema: 'blahh' })
				.expect((r) => assert.equal(r.body.error, "database 'blahh' does not exist", r.text))
				.expect(404);
		});

		test('Describe Table - SU on system table', async () => {
			await client
				.req()
				.send({ operation: 'describe_table', schema: 'system', table: 'hdb_user' })
				.expect((r) => {
					assert.ok(Object.keys(r.body).length > 0, r.text);
					assert.equal(r.body.schema, 'system', r.text);
					assert.equal(r.body.name, 'hdb_user', r.text);
				})
				.expect(200);
		});

		test('Describe Table - schema and table don t exist', async () => {
			await client
				.req()
				.send({ operation: 'describe_table', schema: 'blahh', table: 'blahh' })
				.expect((r) => assert.equal(r.body.error, "database 'blahh' does not exist", r.text))
				.expect(404);
		});

		test('Describe Table - table doesnt exist', async () => {
			await client
				.req()
				.send({ operation: 'describe_table', schema: 'dev', table: 'blahh' })
				.expect((r) => assert.equal(r.body.error, "Table 'dev.blahh' does not exist", r.text))
				.expect(404);
		});

		//Describe ops role testing
		//[NOMINAL] Non-SU test_user

		test('Add non-SU role', async () => {
			await client
				.req()
				.send({
					operation: 'add_role',
					role: 'test_dev_role',
					permission: {
						super_user: false,
						northnwd: {
							tables: {
								region: {
									read: true,
									insert: true,
									update: false,
									delete: false,
									attribute_permissions: [
										{
											attribute_name: 'regiondescription',
											read: true,
											insert: true,
											update: false,
										},
									],
								},
								territories: {
									read: true,
									insert: false,
									update: false,
									delete: false,
									attribute_permissions: [],
								},
								categories: {
									read: false,
									insert: false,
									update: true,
									delete: true,
									attribute_permissions: [
										{
											attribute_name: 'description',
											read: false,
											insert: false,
											update: false,
											delete: true,
										},
									],
								},
								products: {
									read: false,
									insert: false,
									update: false,
									delete: false,
									attribute_permissions: [
										{
											attribute_name: 'discontinued',
											read: false,
											insert: false,
											update: false,
										},
									],
								},
							},
						},
						other: {
							tables: {
								owner: {
									read: true,
									insert: false,
									update: true,
									delete: false,
									attribute_permissions: [
										{
											attribute_name: 'name',
											read: false,
											insert: false,
											update: true,
										},
									],
								},
							},
						},
						another: {
							tables: {
								breed: {
									read: true,
									insert: true,
									update: true,
									delete: true,
									attribute_permissions: [
										{
											attribute_name: 'name',
											read: false,
											insert: false,
											update: false,
										},
									],
								},
							},
						},
					},
				})
				.expect(200);
		});

		test('Add User with non-SU role', async () => {
			await client
				.req()
				.send({
					operation: 'add_user',
					role: 'test_dev_role',
					username: 'test_user',
					password: `${adminPwd}`,
					active: true,
				})
				.expect(200);
		});

		test('Describe All - non-SU test_user', async () => {
			await client
				.reqAs(headersTestUser)
				.send({ operation: 'describe_all' })
				.expect((r) => {
					const keys = Object.keys(r.body);
					assert.equal(keys.length, 3, r.text);
					assert.ok(r.body.hasOwnProperty('another'), r.text);
					assert.ok(r.body.another.hasOwnProperty('breed'), r.text);
					assert.equal(r.body.another.breed.schema, 'another', r.text);
					assert.equal(r.body.another.breed.name, 'breed', r.text);
					assert.equal(r.body.another.breed.attributes.length, 0, r.text);
					assert.equal(r.body.another.breed.primary_key, 'id', r.text);
					assert.equal(r.body.another.breed.record_count, 350, r.text);
					assert.ok(r.body.another.breed.hasOwnProperty('last_updated_record'), r.text);
					assert.ok(r.body.hasOwnProperty('northnwd'), r.text);
					assert.ok(r.body.northnwd.hasOwnProperty('categories'), r.text);
					assert.ok(r.body.northnwd.hasOwnProperty('region'), r.text);
					assert.ok(r.body.northnwd.hasOwnProperty('territories'), r.text);
					assert.equal(Object.keys(r.body.northnwd).length, 3, r.text);
					assert.equal(Object.keys(r.body.other).length, 1, r.text);
					assert.ok(r.body.other.hasOwnProperty('owner'), r.text);
				})
				.expect(200);
		});

		test('Describe Schema - restricted perms - non-SU test_user', async () => {
			await client
				.reqAs(headersTestUser)
				.send({ operation: 'describe_schema', schema: 'dev' })
				.expect((r) => {
					assert.equal(
						r.body.error,
						'This operation is not authorized due to role restrictions and/or invalid database items',
						r.text
					);
					assert.equal(r.body.invalid_schema_items.length, 1, r.text);
					assert.equal(r.body.invalid_schema_items[0], "database 'dev' does not exist", r.text);
					assert.equal(r.body.unauthorized_access.length, 0, r.text);
				})
				.expect(403);
		});

		test('Describe Schema - non-SU test_user', async () => {
			await client
				.reqAs(headersTestUser)
				.send({ operation: 'describe_schema', schema: 'northnwd' })
				.expect((r) => {
					assert.equal(Object.values(r.body).length, 3, r.text);
					assert.ok(r.body.hasOwnProperty('categories'), r.text);
					assert.ok(r.body.hasOwnProperty('region'), r.text);
					assert.ok(r.body.hasOwnProperty('territories'), r.text);
				})
				.expect(200);
		});

		test('Describe Table - restricted perms - non-SU test_user', async () => {
			await client
				.reqAs(headersTestUser)
				.send({ operation: 'describe_table', schema: 'northnwd', table: 'shippers' })
				.expect((r) => {
					assert.equal(
						r.body.error,
						'This operation is not authorized due to role restrictions and/or invalid database items',
						r.text
					);
					assert.equal(r.body.invalid_schema_items.length, 1, r.text);
					assert.equal(r.body.invalid_schema_items[0], "Table 'northnwd.shippers' does not exist", r.text);
					assert.equal(r.body.unauthorized_access.length, 0, r.text);
				})
				.expect(403);
		});

		test('Describe Table - non-SU test_user', async () => {
			await client
				.reqAs(headersTestUser)
				.send({ operation: 'describe_table', schema: 'northnwd', table: 'region' })
				.expect((r) => {
					assert.ok(r.body.hasOwnProperty('schema'), r.text);
					assert.ok(r.body.hasOwnProperty('name'), r.text);
					assert.ok(r.body.hasOwnProperty('attributes'), r.text);
					assert.ok(r.body.hasOwnProperty('primary_key'), r.text);
					assert.ok(r.body.hasOwnProperty('record_count'), r.text);
					assert.ok(r.body.hasOwnProperty('last_updated_record'), r.text);
					assert.equal(r.body.attributes.length, 2, r.text);
				})
				.expect(200);
		});

		test('Describe  SYSTEM schema as non-SU', async () => {
			await client
				.reqAs(headersTestUser)
				.send({ operation: 'describe_table', schema: 'system' })
				.expect((r) => {
					assert.equal(
						r.body.error,
						'This operation is not authorized due to role restrictions and/or invalid database items',
						r.text
					);
					assert.equal(r.body.unauthorized_access.length, 1, r.text);
					assert.equal(
						r.body.unauthorized_access[0],
						"Your role does not have permission to view database metadata for 'system'"
					);
					assert.equal(r.body.invalid_schema_items.length, 0, r.text);
				})
				.expect(403);
		});

		test('Describe  SYSTEM table as non-SU', async () => {
			await client
				.reqAs(headersTestUser)
				.send({ operation: 'describe_table', table: 'hdb_user', schema: 'system' })
				.expect((r) => {
					assert.equal(
						r.body.error,
						'This operation is not authorized due to role restrictions and/or invalid database items',
						r.text
					);
					assert.equal(r.body.unauthorized_access.length, 1, r.text);
					assert.equal(
						r.body.unauthorized_access[0],
						"Your role does not have permission to view database metadata for 'system'"
					);
					assert.equal(r.body.invalid_schema_items.length, 0, r.text);
				})
				.expect(403);
		});

		test('List Users does not return protected info', async () => {
			await client
				.req()
				.send({ operation: 'list_users' })
				.expect((r) => {
					r.body.forEach((user) => {
						assert.ok(!user.password, r.text);
						assert.ok(!user.hash, r.text);
						assert.ok(!user.refresh_token, r.text);
					});
				})
				.expect(200);
		});

		test('Drop test_user', async () => {
			await client
				.req()
				.send({ operation: 'drop_user', username: 'test_user' })
				.expect((r) => assert.equal(r.body.message, 'test_user successfully deleted', r.text))
				.expect(200);
		});

		test('Drop_role - non-SU role', async () => {
			await client
				.req()
				.send({ operation: 'drop_role', id: 'test_dev_role' })
				.expect((r) => assert.equal(r.body.message, 'test_dev_role successfully deleted', r.text))
				.expect(200);
		});

		//Describe ops role testing
		//Non-SU role w/ NO PERMS

		test('Add non-SU role with NO PERMS', async () => {
			await client
				.req()
				.send({ operation: 'add_role', role: 'developer_test_no_perms', permission: { super_user: false } })
				.expect(200);
		});

		test('Add User with new NO PERMS Role', async () => {
			await client
				.req()
				.send({
					operation: 'add_user',
					role: 'developer_test_no_perms',
					username: 'no_perms_user',
					password: `${adminPwd}`,
					active: true,
				})
				.expect(200);
		});

		test('Describe All - test user NO PERMS', async () => {
			await client
				.reqAs(headersNoPermsUser)
				.send({ operation: 'describe_all' })
				.expect((r) => assert.deepEqual(r.body, {}, r.text))
				.expect(200);
		});

		test('Describe Schema - test user NO PERMS', async () => {
			await client
				.reqAs(headersNoPermsUser)
				.send({ operation: 'describe_schema', schema: 'northnwd' })
				.expect((r) => {
					assert.equal(
						r.body.error,
						'This operation is not authorized due to role restrictions and/or invalid database items',
						r.text
					);
					assert.equal(r.body.invalid_schema_items.length, 1, r.text);
					assert.equal(r.body.invalid_schema_items[0], "database 'northnwd' does not exist", r.text);
					assert.equal(r.body.unauthorized_access.length, 0, r.text);
				})
				.expect(403);
		});

		test('Describe Table - test user NO PERMS', async () => {
			await client
				.reqAs(headersNoPermsUser)
				.send({ operation: 'describe_table', schema: 'northnwd', table: 'region' })
				.expect((r) => {
					assert.equal(
						r.body.error,
						'This operation is not authorized due to role restrictions and/or invalid database items',
						r.text
					);
					assert.equal(r.body.invalid_schema_items.length, 1, r.text);
					assert.equal(r.body.invalid_schema_items[0], "Table 'northnwd.region' does not exist", r.text);
					assert.equal(r.body.unauthorized_access.length, 0, r.text);
				})
				.expect(403);
		});

		test('Drop no_perms_user', async () => {
			await client
				.req()
				.send({ operation: 'drop_user', username: 'no_perms_user' })
				.expect((r) => assert.equal(r.body.message, 'no_perms_user successfully deleted', r.text))
				.expect(200);
		});

		test('Drop_role - NO PERMS role', async () => {
			await client
				.req()
				.send({ operation: 'drop_role', id: 'developer_test_no_perms' })
				.expect((r) => assert.equal(r.body.message, 'developer_test_no_perms successfully deleted', r.text))
				.expect(200);
		});

		//Describe ops role testing
		//Non-SU role w/ ONE TABLE PERM

		test('Add non-SU role with perm for ONE table', async () => {
			await client
				.req()
				.send({
					operation: 'add_role',
					role: 'developer_test_one_perm',
					permission: {
						super_user: false,
						northnwd: {
							tables: {
								employees: {
									read: true,
									insert: true,
									update: false,
									delete: false,
									attribute_permissions: [
										{
											attribute_name: 'city',
											read: false,
											insert: true,
											update: false,
										},
										{
											attribute_name: 'firstname',
											read: true,
											insert: true,
											update: false,
										},
										{
											attribute_name: 'lastname',
											read: true,
											insert: true,
											update: false,
										},
										{
											attribute_name: 'region',
											read: false,
											insert: false,
											update: false,
										},
									],
								},
							},
						},
					},
				})
				.expect(200);
		});

		test('Add User with new ONE PERM Role', async () => {
			await client
				.req()
				.send({
					operation: 'add_user',
					role: 'developer_test_one_perm',
					username: 'one_perm_user',
					password: `${adminPwd}`,
					active: true,
				})
				.expect(200);
		});

		test('Describe All - test user ONE TABLE PERM', async () => {
			await client
				.reqAs(headersOnePermUser)
				.send({ operation: 'describe_all' })
				.expect((r) => {
					assert.equal(Object.keys(r.body).length, 1, r.text);
					assert.equal(Object.keys(r.body.northnwd).length, 1, r.text);
					assert.equal(typeof r.body.northnwd.employees.db_size, 'number', r.text);
					assert.equal(typeof r.body.northnwd.employees.table_size, 'number', r.text);
					assert.equal(r.body.northnwd.employees.attributes.length, 4, r.text);
				})
				.expect(200);
		});

		test('Describe Schema - restricted schema - non-SU test_user', async () => {
			await client
				.reqAs(headersOnePermUser)
				.send({ operation: 'describe_schema', schema: 'dev' })
				.expect((r) => {
					assert.equal(
						r.body.error,
						'This operation is not authorized due to role restrictions and/or invalid database items',
						r.text
					);
					assert.equal(r.body.invalid_schema_items.length, 1, r.text);
					assert.equal(r.body.invalid_schema_items[0], "database 'dev' does not exist", r.text);
					assert.equal(r.body.unauthorized_access.length, 0, r.text);
				})
				.expect(403);
		});

		test('Describe Schema - non-SU test_user', async () => {
			await client
				.reqAs(headersOnePermUser)
				.send({ operation: 'describe_schema', schema: 'northnwd' })
				.expect((r) => {
					let expected_schema = {
						northnwd: {
							employees: ['employeeid', 'city', 'firstname', 'lastname'],
						},
					};

					let response_arr = Object.values(r.body);
					assert.equal(response_arr.length, 1, r.text);

					response_arr.forEach((table_data) => {
						const { name, schema, attributes } = table_data;
						attributes.forEach((attr) => {
							assert.ok(expected_schema[schema][name].includes(attr.attribute), r.text);
						});
					});
				})
				.expect(200);
		});

		test('Describe Table - restricted table - non-SU test_user', async () => {
			await client
				.reqAs(headersOnePermUser)
				.send({ operation: 'describe_table', schema: 'northnwd', table: 'shippers' })
				.expect((r) => {
					assert.equal(
						r.body.error,
						'This operation is not authorized due to role restrictions and/or invalid database items',
						r.text
					);
					assert.equal(r.body.invalid_schema_items.length, 1, r.text);
					assert.equal(r.body.invalid_schema_items[0], "Table 'northnwd.shippers' does not exist", r.text);
					assert.equal(r.body.unauthorized_access.length, 0, r.text);
				})
				.expect(403);
		});

		test('Describe Table - non-SU test_user', async () => {
			await client
				.reqAs(headersOnePermUser)
				.send({ operation: 'describe_table', schema: 'northnwd', table: 'employees' })
				.expect((r) => {
					let expected_attributes = ['employeeid', 'city', 'firstname', 'lastname'];

					assert.equal(r.body.schema, 'northnwd', r.text);
					assert.equal(r.body.name, 'employees', r.text);
					r.body.attributes.forEach((attr) => {
						assert.ok(expected_attributes.includes(attr.attribute), r.text);
					});
					assert.equal(r.body.attributes.length, 4, r.text);
				})
				.expect(200);
		});

		test('Drop one_perm_user', async () => {
			await client
				.req()
				.send({ operation: 'drop_user', username: 'one_perm_user' })
				.expect((r) => assert.equal(r.body.message, 'one_perm_user successfully deleted', r.text))
				.expect(200);
		});

		test('Drop_role - ONE TABLE PERMS role', async () => {
			await client
				.req()
				.send({ operation: 'drop_role', id: 'developer_test_one_perm' })
				.expect((r) => assert.equal(r.body.message, 'developer_test_one_perm successfully deleted', r.text))
				.expect(200);
		});

		//Add Role - error checks

		test('Add role with mismatched table/attr READ perms - expect fail', async () => {
			await client
				.req()
				.send({
					operation: 'add_role',
					role: 'developer_test',
					permission: {
						super_user: false,
						northnwd: {
							tables: {
								categories: {
									read: false,
									insert: true,
									update: true,
									delete: false,
									attribute_permissions: [
										{
											attribute_name: 'description',
											read: true,
											insert: true,
											update: true,
										},
									],
								},
							},
						},
					},
				})
				.expect((r) => {
					assert.equal(r.body.error, 'Errors in the role permissions JSON provided', r.text);
					assert.equal(r.body.main_permissions.length, 0, r.text);
					assert.equal(
						r.body.schema_permissions.northnwd_categories[0],
						"You have a conflict with TABLE permissions for 'northnwd.categories' being false and ATTRIBUTE permissions being true"
					);
				})
				.expect(400);
		});

		test('Add role with non-boolean READ table perms - expect fail', async () => {
			await client
				.req()
				.send({
					operation: 'add_role',
					role: 'developer_test',
					permission: {
						super_user: false,
						northnwd: {
							tables: {
								categories: {
									read: 'Doooooh',
									insert: true,
									update: true,
									delete: false,
									attribute_permissions: [
										{
											attribute_name: 'description',
											read: true,
											insert: true,
											update: true,
										},
									],
								},
							},
						},
					},
				})
				.expect((r) => {
					assert.equal(r.body.error, 'Errors in the role permissions JSON provided', r.text);
					assert.equal(r.body.main_permissions.length, 0, r.text);
					assert.equal(r.body.schema_permissions.northnwd_categories.length, 1, r.text);
					assert.equal(
						r.body.schema_permissions.northnwd_categories[0],
						'Table READ permission must be a boolean',
						r.text
					);
				})
				.expect(400);
		});

		test('Add role with non-boolean INSERT/DELETE perms - expect fail', async () => {
			await client
				.req()
				.send({
					operation: 'add_role',
					role: 'developer_test',
					permission: {
						super_user: false,
						northnwd: {
							tables: {
								categories: {
									read: true,
									insert: 'Doooooh',
									update: true,
									delete: 'Doooooh',
									attribute_permissions: [
										{
											attribute_name: 'description',
											read: true,
											insert: true,
											update: true,
										},
									],
								},
							},
						},
					},
				})
				.expect((r) => {
					assert.equal(r.body.error, 'Errors in the role permissions JSON provided', r.text);
					assert.equal(r.body.main_permissions.length, 0, r.text);
					assert.equal(r.body.schema_permissions.northnwd_categories.length, 2, r.text);
					assert.ok(
						r.body.schema_permissions.northnwd_categories.includes('Table INSERT permission must be a boolean'),
						r.text
					);
					assert.ok(
						r.body.schema_permissions.northnwd_categories.includes('Table DELETE permission must be a boolean'),
						r.text
					);
				})
				.expect(400);
		});

		test('Add role with non-boolean READ and UPDATE attribute perms - expect fail', async () => {
			await client
				.req()
				.send({
					operation: 'add_role',
					role: 'developer_test',
					permission: {
						super_user: false,
						northnwd: {
							tables: {
								categories: {
									read: true,
									insert: true,
									update: true,
									delete: false,
									attribute_permissions: [
										{
											attribute_name: 'description',
											read: 'Doooooh',
											insert: true,
											update: 'Doooooh',
										},
									],
								},
							},
						},
					},
				})
				.expect((r) => {
					assert.equal(r.body.error, 'Errors in the role permissions JSON provided', r.text);
					assert.equal(r.body.main_permissions.length, 0, r.text);
					assert.equal(r.body.schema_permissions.northnwd_categories.length, 2, r.text);
					assert.ok(
						r.body.schema_permissions.northnwd_categories.includes(
							"READ attribute permission for 'description' must be a boolean"
						)
					);
					assert.ok(
						r.body.schema_permissions.northnwd_categories.includes(
							"UPDATE attribute permission for 'description' must be a boolean"
						)
					);
				})
				.expect(400);
		});

		test('Add role with mismatched table/attr INSERT perms - expect fail', async () => {
			await client
				.req()
				.send({
					operation: 'add_role',
					role: 'developer_test',
					permission: {
						super_user: false,
						northnwd: {
							tables: {
								categories: {
									read: true,
									insert: false,
									update: true,
									delete: false,
									attribute_permissions: [
										{
											attribute_name: 'description',
											read: true,
											insert: true,
											update: true,
										},
									],
								},
							},
						},
					},
				})
				.expect((r) => {
					assert.equal(r.body.error, 'Errors in the role permissions JSON provided', r.text);
					assert.equal(r.body.main_permissions.length, 0, r.text);
					assert.equal(
						r.body.schema_permissions.northnwd_categories[0],
						"You have a conflict with TABLE permissions for 'northnwd.categories' being false and ATTRIBUTE permissions being true"
					);
				})
				.expect(400);
		});

		test('Add role with mismatched table/attr UPDATE perms - expect fail', async () => {
			await client
				.req()
				.send({
					operation: 'add_role',
					role: 'developer_test',
					permission: {
						super_user: false,
						northnwd: {
							tables: {
								categories: {
									read: true,
									insert: true,
									update: false,
									delete: false,
									attribute_permissions: [
										{
											attribute_name: 'description',
											read: true,
											insert: true,
											update: true,
										},
									],
								},
							},
						},
					},
				})
				.expect((r) => {
					assert.equal(r.body.error, 'Errors in the role permissions JSON provided', r.text);
					assert.equal(r.body.main_permissions.length, 0, r.text);
					assert.equal(
						r.body.schema_permissions.northnwd_categories[0],
						"You have a conflict with TABLE permissions for 'northnwd.categories' being false and ATTRIBUTE permissions being true"
					);
				})
				.expect(400);
		});

		test('Add role with multiple mismatched table/attr perms - expect fail', async () => {
			await client
				.req()
				.send({
					operation: 'add_role',
					role: 'developer_test',
					permission: {
						super_user: false,
						northnwd: {
							tables: {
								categories: {
									read: false,
									insert: true,
									update: false,
									delete: false,
									attribute_permissions: [
										{
											attribute_name: 'description',
											read: true,
											insert: true,
											update: true,
										},
									],
								},
							},
						},
					},
				})
				.expect((r) => {
					assert.equal(r.body.error, 'Errors in the role permissions JSON provided', r.text);
					assert.equal(r.body.main_permissions.length, 0, r.text);
					assert.equal(
						r.body.schema_permissions.northnwd_categories[0],
						"You have a conflict with TABLE permissions for 'northnwd.categories' being false and ATTRIBUTE permissions being true"
					);
				})
				.expect(400);
		});

		test('Add role with with misformed attr perms array key  - expect fail', async () => {
			await client
				.req()
				.send({
					operation: 'add_role',
					role: 'developer_test',
					permission: {
						super_user: false,
						northnwd: {
							tables: {
								categories: {
									read: false,
									insert: true,
									update: false,
									delete: false,
									attribute_restrictions: [
										{
											attribute_name: 'description',
											read: true,
											insert: true,
											update: true,
										},
									],
								},
							},
						},
					},
				})
				.expect((r) => {
					assert.equal(r.body.error, 'Errors in the role permissions JSON provided', r.text);
					assert.equal(r.body.main_permissions.length, 0, r.text);
					assert.ok(
						r.body.schema_permissions.northnwd_categories.includes(
							"Invalid table permission key value 'attribute_restrictions'"
						)
					);
					assert.ok(
						r.body.schema_permissions.northnwd_categories.includes("Missing 'attribute_permissions' array"),
						r.text
					);
				})
				.expect(400);
		});

		test('Add role with with missing attr perms for table  - expect fail', async () => {
			await client
				.req()
				.send({
					operation: 'add_role',
					role: 'developer_test',
					permission: {
						super_user: false,
						northnwd: {
							tables: {
								categories: {
									read: false,
									insert: true,
									update: false,
									delete: false,
								},
							},
						},
					},
				})
				.expect((r) => {
					assert.equal(r.body.error, 'Errors in the role permissions JSON provided', r.text);
					assert.equal(r.body.main_permissions.length, 0, r.text);
					assert.equal(
						r.body.schema_permissions.northnwd_categories[0],
						"Missing 'attribute_permissions' array",
						r.text
					);
				})
				.expect(400);
		});

		test('Add role with with perms for non-existent schema  - expect fail', async () => {
			await client
				.req()
				.send({
					operation: 'add_role',
					role: 'developer_test',
					permission: {
						super_user: false,
						wrong_schema: {
							tables: {
								categories: {
									read: false,
									insert: true,
									update: false,
									delete: false,
								},
							},
						},
					},
				})
				.expect((r) => {
					assert.equal(r.body.error, 'Errors in the role permissions JSON provided', r.text);
					assert.equal(r.body.main_permissions.length, 1, r.text);
					assert.equal(r.body.main_permissions[0], "database 'wrong_schema' does not exist", r.text);
					assert.equal(Object.keys(r.body.schema_permissions).length, 0, r.text);
				})
				.expect(400);
		});

		test('Add role with with perms for non-existent table  - expect fail', async () => {
			await client
				.req()
				.send({
					operation: 'add_role',
					role: 'developer_test',
					permission: {
						super_user: false,
						northnwd: {
							tables: {
								wrong_table: {
									read: false,
									insert: true,
									update: false,
									delete: false,
								},
							},
						},
					},
				})
				.expect((r) => {
					assert.equal(r.body.error, 'Errors in the role permissions JSON provided', r.text);
					assert.equal(r.body.main_permissions.length, 1, r.text);
					assert.equal(r.body.main_permissions[0], "Table 'northnwd.wrong_table' does not exist", r.text);
					assert.equal(Object.keys(r.body.schema_permissions).length, 0, r.text);
				})
				.expect(400);
		});

		test('Add SU role with perms  - expect fail', async () => {
			await client
				.req()
				.send({
					operation: 'add_role',
					role: 'developer_test',
					permission: {
						super_user: true,
						northnwd: {
							tables: {
								categories: {
									read: false,
									insert: true,
									update: false,
									delete: false,
									attribute_permissions: [],
								},
							},
						},
					},
				})
				.expect((r) => {
					assert.equal(r.body.error, 'Errors in the role permissions JSON provided', r.text);
					assert.equal(r.body.main_permissions.length, 1, r.text);
					assert.equal(
						r.body.main_permissions[0],
						"Roles with 'super_user' set to true cannot have other permissions set."
					);
					assert.equal(Object.keys(r.body.schema_permissions).length, 0, r.text);
				})
				.expect(400);
		});

		//Test SU-only Ops Permissions

		test('Add non-SU role', async () => {
			await client
				.req()
				.send({
					operation: 'add_role',
					role: 'test_dev_role',
					permission: {
						super_user: false,
						northnwd: {
							tables: {
								region: {
									read: true,
									insert: true,
									update: false,
									delete: false,
									attribute_permissions: [
										{
											attribute_name: 'regiondescription',
											read: true,
											insert: true,
											update: false,
										},
									],
								},
								territories: {
									read: true,
									insert: false,
									update: false,
									delete: false,
									attribute_permissions: [],
								},
								categories: {
									read: false,
									insert: false,
									update: true,
									delete: true,
									attribute_permissions: [
										{
											attribute_name: 'description',
											read: false,
											insert: false,
											update: false,
											delete: true,
										},
									],
								},
								products: {
									read: false,
									insert: false,
									update: false,
									delete: false,
									attribute_permissions: [
										{
											attribute_name: 'discontinued',
											read: false,
											insert: false,
											update: false,
										},
									],
								},
							},
						},
						other: {
							tables: {
								owner: {
									read: true,
									insert: false,
									update: true,
									delete: false,
									attribute_permissions: [
										{
											attribute_name: 'name',
											read: false,
											insert: false,
											update: true,
										},
									],
								},
							},
						},
						another: {
							tables: {
								breed: {
									read: true,
									insert: true,
									update: true,
									delete: true,
									attribute_permissions: [
										{
											attribute_name: 'name',
											read: false,
											insert: false,
											update: false,
										},
									],
								},
							},
						},
					},
				})
				.expect(200);
		});

		test('Add User with non-SU role', async () => {
			await client
				.req()
				.send({
					operation: 'add_user',
					role: 'test_dev_role',
					username: 'test_user',
					password: `${adminPwd}`,
					active: true,
				})
				.expect(200);
		});

		test('system_information as non-SU - expect fail', async () => {
			await client
				.reqAs(headersTestUser)
				.send({ operation: 'system_information' })
				.expect((r) => {
					assert.equal(
						r.body.error,
						'This operation is not authorized due to role restrictions and/or invalid database items',
						r.text
					);
					assert.equal(r.body.unauthorized_access.length, 1, r.text);
					assert.equal(
						r.body.unauthorized_access[0],
						"Operation 'systemInformation' is restricted to 'super_user' roles",
						r.text
					);
					assert.equal(r.body.invalid_schema_items.length, 0, r.text);
				})
				.expect(403);
		});

		test('Drop test_user', async () => {
			await client
				.req()
				.send({ operation: 'drop_user', username: 'test_user' })
				.expect((r) => assert.equal(r.body.message, 'test_user successfully deleted', r.text))
				.expect(200);
		});

		test('Drop_role - non-SU role', async () => {
			await client
				.req()
				.send({ operation: 'drop_role', id: 'test_dev_role' })
				.expect((r) => assert.equal(r.body.message, 'test_dev_role successfully deleted', r.text))
				.expect(200);
		});

		//System schema role perms tests

		test('Add non-SU role', async () => {
			await client
				.req()
				.send({
					operation: 'add_role',
					role: 'test_dev_role',
					permission: {
						super_user: false,
						northnwd: {
							tables: {
								region: {
									read: true,
									insert: true,
									update: false,
									delete: false,
									attribute_permissions: [
										{
											attribute_name: 'regiondescription',
											read: true,
											insert: true,
											update: false,
										},
									],
								},
								territories: {
									read: true,
									insert: false,
									update: false,
									delete: false,
									attribute_permissions: [],
								},
								categories: {
									read: false,
									insert: false,
									update: true,
									delete: true,
									attribute_permissions: [
										{
											attribute_name: 'description',
											read: false,
											insert: false,
											update: false,
											delete: true,
										},
									],
								},
								products: {
									read: false,
									insert: false,
									update: false,
									delete: false,
									attribute_permissions: [
										{
											attribute_name: 'discontinued',
											read: false,
											insert: false,
											update: false,
										},
									],
								},
							},
						},
						other: {
							tables: {
								owner: {
									read: true,
									insert: false,
									update: true,
									delete: false,
									attribute_permissions: [
										{
											attribute_name: 'name',
											read: false,
											insert: false,
											update: true,
										},
									],
								},
							},
						},
						another: {
							tables: {
								breed: {
									read: true,
									insert: true,
									update: true,
									delete: true,
									attribute_permissions: [
										{
											attribute_name: 'name',
											read: false,
											insert: false,
											update: false,
										},
									],
								},
							},
						},
					},
				})
				.expect(200);
		});

		test('Add User with non-SU role', async () => {
			await client
				.req()
				.send({
					operation: 'add_user',
					role: 'test_dev_role',
					username: 'test_user',
					password: `${adminPwd}`,
					active: true,
				})
				.expect(200);
		});

		test('Query system table as SU', async () => {
			await client
				.req()
				.send({
					operation: 'search_by_value',
					table: 'hdb_user',
					schema: 'system',
					search_attribute: 'username',
					search_value: `${adminUsername}`,
					get_attributes: ['*'],
				})
				.expect((r) => {
					let objKeysData = Object.keys(r.body[0]);
					assert.equal(r.body[0].username, adminUsername, r.text);
					assert.ok(objKeysData.includes('password'), r.text);
					assert.ok(objKeysData.includes('role'), r.text);
				})
				.expect(200);
		});

		test('Query system table non SU', async () => {
			await client
				.reqAs(headersTestUser)
				.send({
					operation: 'search_by_value',
					table: 'hdb_user',
					schema: 'system',
					search_attribute: 'username',
					search_value: `${adminUsername}`,
					get_attributes: ['*'],
				})
				.expect((r) => {
					assert.equal(
						r.body.error,
						'This operation is not authorized due to role restrictions and/or invalid database items',
						r.text
					);
					assert.equal(r.body.unauthorized_access.length, 1, r.text);
					assert.equal(r.body.unauthorized_access[0].required_table_permissions.length, 1, r.text);
					assert.equal(r.body.unauthorized_access[0].required_table_permissions[0], 'read', r.text);
					assert.equal(r.body.unauthorized_access[0].schema, 'system', r.text);
					assert.equal(r.body.unauthorized_access[0].table, 'hdb_user', r.text);
					assert.equal(r.body.invalid_schema_items.length, 0, r.text);
				})
				.expect(403);
		});

		test('Insert record system table as non SU', async () => {
			await client
				.reqAs(headersTestUser)
				.send({
					operation: 'insert',
					schema: 'system',
					table: 'hdb_user',
					records: [
						{
							username: 'admin',
							role: '0bffc136-0b0b-4582-8efe-44031f40d906',
							password: 'fakepassword',
							active: true,
						},
					],
				})
				.expect((r) => {
					assert.equal(
						r.body.error,
						'This operation is not authorized due to role restrictions and/or invalid database items',
						r.text
					);
					assert.equal(r.body.unauthorized_access.length, 1, r.text);
					assert.equal(r.body.unauthorized_access[0].required_table_permissions.length, 1, r.text);
					assert.equal(r.body.unauthorized_access[0].required_table_permissions[0], 'insert', r.text);
					assert.equal(r.body.unauthorized_access[0].schema, 'system', r.text);
					assert.equal(r.body.unauthorized_access[0].table, 'hdb_user', r.text);
					assert.equal(r.body.invalid_schema_items.length, 0, r.text);
				})
				.expect(403);
		});

		test('Update record system table as non SU ', async () => {
			await client
				.reqAs(headersTestUser)
				.send({
					operation: 'update',
					schema: 'system',
					table: 'hdb_user',
					records: [
						{
							username: 'admin',
							role: '0bffc136-0b0b-4582-8efe-44031f40d906',
							password: 'fakepassword',
							active: true,
						},
					],
				})
				.expect((r) =>
					assert.equal(
						r.body.error,
						"The 'system' database, tables and records are used internally by Harper and cannot be updated or removed."
					)
				)
				.expect(403);
		});

		test('Delete record system table as non SU ', async () => {
			await client
				.reqAs(headersTestUser)
				.send({ operation: 'delete', schema: 'system', table: 'hdb_user', hash_values: ['admin1'] })
				.expect((r) =>
					assert.equal(
						r.body.error,
						"The 'system' database, tables and records are used internally by Harper and cannot be updated or removed."
					)
				)
				.expect(403);
		});

		test('Drop system table as SU', async () => {
			await client
				.req()
				.send({ operation: 'drop_table', schema: 'system', table: 'hdb_user' })
				.expect((r) =>
					assert.equal(
						r.body.error,
						"The 'system' database, tables and records are used internally by Harper and cannot be updated or removed."
					)
				)
				.expect(403);
		});

		test('Drop system table as non SU', async () => {
			await client
				.reqAs(headersTestUser)
				.send({ operation: 'drop_table', schema: 'system', table: 'hdb_user' })
				.expect((r) =>
					assert.equal(
						r.body.error,
						"The 'system' database, tables and records are used internally by Harper and cannot be updated or removed."
					)
				)
				.expect(403);
		});

		test('Drop test_user', async () => {
			await client
				.req()
				.send({ operation: 'drop_user', username: 'test_user' })
				.expect((r) => assert.equal(r.body.message, 'test_user successfully deleted', r.text))
				.expect(200);
		});

		test('Drop_role - non-SU role', async () => {
			await client
				.req()
				.send({ operation: 'drop_role', id: 'test_dev_role' })
				.expect((r) => assert.equal(r.body.message, 'test_dev_role successfully deleted', r.text))
				.expect(200);
		});

		test('SQL update system table', async () => {
			await client
				.req()
				.send({ operation: 'sql', sql: "UPDATE system.hdb_user SET name = 'jerry' where id = 1" })
				.expect((r) =>
					assert.equal(
						r.body.error,
						"The 'system' database, tables and records are used internally by Harper and cannot be updated or removed."
					)
				)
				.expect(403);
		});

		test('SQL delete system table', async () => {
			await client
				.req()
				.send({ operation: 'sql', sql: 'delete from system.hdb_user where id = 1' })
				.expect((r) =>
					assert.equal(
						r.body.error,
						"The 'system' database, tables and records are used internally by Harper and cannot be updated or removed."
					)
				)
				.expect(403);
		});

		test('Delete attribute from system table', async () => {
			await client
				.req()
				.send({ operation: 'drop_attribute', schema: 'system', table: 'hdb_user', attribute: 'password' })
				.expect((r) =>
					assert.equal(
						r.body.error,
						"The 'system' database, tables and records are used internally by Harper and cannot be updated or removed."
					)
				)
				.expect(403);
		});

		//Search schema error checks

		test('Add non-SU role for schema tests', async () => {
			await client
				.req()
				.send({
					operation: 'add_role',
					role: 'test_schema_user',
					permission: {
						super_user: false,
						northnwd: {
							tables: {
								customers: {
									read: true,
									insert: true,
									update: true,
									delete: true,
									attribute_permissions: [],
								},
								suppliers: {
									read: false,
									insert: false,
									update: false,
									delete: false,
									attribute_permissions: [],
								},
								region: {
									read: true,
									insert: false,
									update: false,
									delete: false,
									attribute_permissions: [
										{
											attribute_name: 'regiondescription',
											read: true,
											insert: false,
											update: false,
											delete: false,
										},
									],
								},
								territories: {
									read: true,
									insert: true,
									update: false,
									delete: false,
									attribute_permissions: [
										{
											attribute_name: 'territorydescription',
											read: true,
											insert: true,
											update: false,
											delete: false,
										},
									],
								},
								categories: {
									read: true,
									insert: true,
									update: true,
									delete: false,
									attribute_permissions: [
										{
											attribute_name: 'description',
											read: true,
											insert: true,
											update: true,
											delete: false,
										},
									],
								},
								shippers: {
									read: true,
									insert: true,
									update: true,
									delete: true,
									attribute_permissions: [
										{
											attribute_name: 'companyname',
											read: false,
											insert: false,
											update: false,
											delete: false,
										},
									],
								},
							},
						},
						dev: {
							tables: {
								dog: {
									read: true,
									insert: true,
									update: true,
									delete: true,
									attribute_permissions: [
										{
											attribute_name: '__createdtime__',
											read: true,
											insert: true,
											update: true,
										},
										{
											attribute_name: '__updatedtime__',
											read: true,
											insert: true,
											update: true,
										},
										{
											attribute_name: 'age',
											read: true,
											insert: true,
											update: false,
										},
										{
											attribute_name: 'dog_name',
											read: true,
											insert: false,
											update: true,
										},
										{
											attribute_name: 'adorable',
											read: true,
											insert: true,
											update: true,
										},
										{ attribute_name: 'owner_id', read: false, insert: true, update: true },
									],
								},
								breed: {
									read: true,
									insert: true,
									update: true,
									delete: true,
									attribute_permissions: [
										{
											attribute_name: '__createdtime__',
											read: false,
											insert: false,
											update: true,
										},
										{ attribute_name: '__updatedtime__', read: false, insert: true, update: true },
									],
								},
							},
						},
					},
				})
				.expect(200);
		});

		test('Add test_user  with new role for schema error tests', async () => {
			await client
				.req()
				.send({
					operation: 'add_user',
					role: 'test_schema_user',
					username: 'test_user',
					password: `${adminPwd}`,
					active: true,
				})
				.expect(200);
		});

		test('NoSQL - Non-SU search on schema that doesnt exist as test_user - expect error', async () => {
			await client
				.reqAs(headersTestUser)
				.send({
					operation: 'search_by_value',
					schema: 'rick_rolled',
					table: `region`,
					primary_key: 'id',
					search_attribute: 'id',
					search_value: '*',
					get_attributes: ['*'],
				})
				.expect((r) => {
					assert.equal(
						r.body.error,
						'This operation is not authorized due to role restrictions and/or invalid database items',
						r.text
					);
					assert.equal(r.body.unauthorized_access.length, 0, r.text);
					assert.equal(r.body.invalid_schema_items.length, 1, r.text);
					assert.equal(r.body.invalid_schema_items[0], "database 'rick_rolled' does not exist", r.text);
				})
				.expect(403);
		});

		test('NoSQL - SU search on schema that doesnt exist as test_user - expect error', async () => {
			await client
				.req()
				.send({
					operation: 'search_by_value',
					schema: 'rick_rolled',
					table: `region`,
					primary_key: 'id',
					search_attribute: 'id',
					search_value: '*',
					get_attributes: ['*'],
				})
				.expect((r) => assert.equal(r.body.error, "database 'rick_rolled' does not exist", r.text))
				.expect(404);
		});

		test('NoSQL - Non-SU search on table that doesnt exist as test_user - expect error', async () => {
			await client
				.reqAs(headersTestUser)
				.send({
					operation: 'search_by_value',
					schema: 'dev',
					table: 'rick_rolled',
					primary_key: 'id',
					search_attribute: 'id',
					search_value: '*',
					get_attributes: ['*'],
				})
				.expect((r) => {
					assert.equal(
						r.body.error,
						'This operation is not authorized due to role restrictions and/or invalid database items',
						r.text
					);
					assert.equal(r.body.unauthorized_access.length, 0, r.text);
					assert.equal(r.body.invalid_schema_items.length, 1, r.text);
					assert.equal(r.body.invalid_schema_items[0], "Table 'dev.rick_rolled' does not exist", r.text);
				})
				.expect(403);
		});

		test('NoSQL - SU search on table that doesnt exist as error', async () => {
			await client
				.req()
				.send({
					operation: 'search_by_value',
					schema: 'dev',
					table: 'rick_rolled',
					primary_key: 'id',
					search_attribute: 'id',
					search_value: '*',
					get_attributes: ['*'],
				})
				.expect((r) => assert.equal(r.body.error, "Table 'dev.rick_rolled' does not exist", r.text))
				.expect(404);
		});

		test('SQL - Non-SU select on schema that doesnt exist as test_user - expect error', async () => {
			await client
				.reqAs(headersTestUser)
				.send({
					operation: 'sql',
					sql: `SELECT *
		                                  FROM rick_rolled.region`,
				})
				.expect((r) => {
					assert.equal(
						r.body.error,
						'This operation is not authorized due to role restrictions and/or invalid database items',
						r.text
					);
					assert.equal(r.body.unauthorized_access.length, 0, r.text);
					assert.equal(r.body.invalid_schema_items.length, 1, r.text);
					assert.equal(r.body.invalid_schema_items[0], "database 'rick_rolled' does not exist", r.text);
				})
				.expect(403);
		});

		test('SQL - SU search on schema that doesnt exist as error', async () => {
			await client
				.req()
				.send({
					operation: 'sql',
					sql: `SELECT *
		                                  FROM rick_rolled.region`,
				})
				.expect((r) => assert.equal(r.body.error, "database 'rick_rolled' does not exist", r.text))
				.expect(404);
		});

		test('SQL - Non-SU search on table that doesnt exist as test_user - expect error', async () => {
			await client
				.reqAs(headersTestUser)
				.send({ operation: 'sql', sql: 'SELECT * FROM dev.rick_rolled' })
				.expect((r) => {
					assert.equal(
						r.body.error,
						'This operation is not authorized due to role restrictions and/or invalid database items',
						r.text
					);
					assert.equal(r.body.unauthorized_access.length, 0, r.text);
					assert.equal(r.body.invalid_schema_items.length, 1, r.text);
					assert.equal(r.body.invalid_schema_items[0], "Table 'dev.rick_rolled' does not exist", r.text);
				})
				.expect(403);
		});

		test('SQL - SU search on table that doesnt exist as test_user - expect error', async () => {
			await client
				.req()
				.send({ operation: 'sql', sql: 'SELECT * FROM dev.rick_rolled' })
				.expect((r) => assert.equal(r.body.error, "Table 'dev.rick_rolled' does not exist", r.text))
				.expect(404);
		});

		test('Drop test_user for search schema error checks', async () => {
			await client.req().send({ operation: 'drop_user', username: 'test_user' }).expect(200);
		});

		test('Drop role for search schema error checks', async () => {
			await client.req().send({ operation: 'drop_role', id: 'test_schema_user' }).expect(200);
		});

		//Test modifying system tables

		test('Insert record into table', async () => {
			await client
				.req()
				.send({
					operation: 'insert',
					database: 'system',
					table: 'hdb_nodes',
					records: [{ name: 'my-node', url: 'lets-test' }],
				})
				.expect((r) => assert.equal(r.body.message, 'inserted 1 of 1 records', r.text))
				.expect((r) => assert.equal(r.body.inserted_hashes[0], 'my-node', r.text))
				.expect(200);
		});

		test('Update record into table', async () => {
			await client
				.req()
				.send({
					operation: 'update',
					database: 'system',
					table: 'hdb_nodes',
					records: [{ name: 'my-node', url: 'updated-url' }],
				})
				.expect((r) =>
					assert.equal(
						r.body.message,
						'updated 1 of 1 records',
						'Expected response message to eql "updated 1 of 1 records"'
					)
				)
				.expect((r) => assert.equal(r.body.update_hashes[0], 'my-node', r.text))
				.expect(200);
		});

		test('Confirm record in table', async () => {
			await client
				.req()
				.send({
					operation: 'search_by_id',
					database: 'system',
					table: 'hdb_nodes',
					ids: ['my-node'],
					get_attributes: ['*'],
				})
				.expect((r) => assert.equal(r.body[0].name, 'my-node', r.text))
				.expect((r) => assert.equal(r.body[0].url, 'updated-url', r.text))
				.expect(200);
		});

		test('Confirm table cant be dropped', async () => {
			await client
				.req()
				.send({ operation: 'drop_table', database: 'system', table: 'hdb_nodes' })
				.expect((r) =>
					assert.equal(
						r.body.error,
						"The 'system' database, tables and records are used internally by Harper and cannot be updated or removed."
					)
				)
				.expect(403);
		});

		test('Insert record into hdb cert doesnt work', async () => {
			await client
				.req()
				.send({
					operation: 'insert',
					database: 'system',
					table: 'hdb_certificate',
					records: [{ name: 'my-node', url: 'lets-test' }],
				})
				.expect((r) =>
					assert.equal(
						r.body.error,
						'This operation is not authorized due to role restrictions and/or invalid database items',
						r.text
					)
				)
				.expect(403);
		});

		//Other Role Tests Main Folder

		test('Add non-SU role to test with', async () => {
			await client
				.req()
				.send({ operation: 'add_role', role: 'important-role', permission: { structure_user: true } })
				.expect(200);
		});

		test('Create user with new role', async () => {
			await client
				.req()
				.send({
					operation: 'add_user',
					role: 'important-role',
					username: 'important-user',
					password: 'password',
					active: true,
				})
				.expect(200);
		});

		test('Update role table', async () => {
			await client
				.req()
				.send({
					operation: 'update',
					database: 'system',
					table: 'hdb_role',
					records: [{ id: 'important-role', test: true }],
				})
				.expect((r) =>
					assert.equal(
						r.body.message,
						'updated 1 of 1 records',
						'Expected response message to eql "updated 1 of 1 records"'
					)
				)
				.expect((r) => assert.equal(r.body.update_hashes[0], 'important-role', r.text))
				.expect(200);
		});

		test('Update user table', async () => {
			await client
				.req()
				.send({
					operation: 'update',
					database: 'system',
					table: 'hdb_user',
					records: [{ username: 'important-user', test: true }],
				})
				.expect((r) =>
					assert.equal(
						r.body.message,
						'updated 1 of 1 records',
						'Expected response message to eql "updated 1 of 1 records"'
					)
				)
				.expect((r) => assert.equal(r.body.update_hashes[0], 'important-user', r.text))
				.expect(200);
		});

		test('Test Update role table non-SU doesnt work', async () => {
			await client
				.reqAs(headersImportantUser)
				.send({
					operation: 'update',
					database: 'system',
					table: 'hdb_role',
					records: [{ id: 'important-role', test: true }],
				})
				.expect((r) =>
					assert.equal(
						r.body.error,
						"The 'system' database, tables and records are used internally by Harper and cannot be updated or removed."
					)
				)
				.expect(403);
		});

		test('Test Update user table non-SU doesnt work', async () => {
			await client
				.reqAs(headersImportantUser)
				.send({
					operation: 'update',
					database: 'system',
					table: 'hdb_user',
					records: [{ username: 'important-user', test: true }],
				})
				.expect((r) =>
					assert.equal(
						r.body.error,
						"The 'system' database, tables and records are used internally by Harper and cannot be updated or removed."
					)
				)
				.expect(403);
		});

		test('Test insert when non-SU doesnt work', async () => {
			await client
				.reqAs(headersImportantUser)
				.send({
					operation: 'insert',
					database: 'system',
					table: 'hdb_nodes',
					records: [{ name: 'my-node', url: 'no-go' }],
				})
				.expect((r) =>
					assert.equal(
						r.body.error,
						'This operation is not authorized due to role restrictions and/or invalid database items',
						r.text
					)
				)
				.expect(403);
		});

		test('Test delete when non-SU doesnt work', async () => {
			await client
				.reqAs(headersImportantUser)
				.send({ operation: 'delete', database: 'system', table: 'hdb_nodes', ids: ['my-node'] })
				.expect((r) =>
					assert.equal(
						r.body.error,
						"The 'system' database, tables and records are used internally by Harper and cannot be updated or removed."
					)
				)
				.expect(403);
		});

		test('Delete record from table', async () => {
			await client
				.req()
				.send({ operation: 'delete', database: 'system', table: 'hdb_nodes', ids: ['my-node'] })
				.expect((r) => assert.equal(r.body.message, '1 of 1 record successfully deleted', r.text))
				.expect((r) => assert.equal(r.body.deleted_hashes[0], 'my-node', r.text))
				.expect(200);
		});

		test('Drop user', async () => {
			await client
				.req()
				.send({ operation: 'drop_user', username: 'important-user' })
				.expect((r) => assert.equal(r.body.message, 'important-user successfully deleted', r.text))
				.expect(200);
		});

		test('Drop role', async () => {
			await client
				.req()
				.send({ operation: 'drop_role', id: 'important-role' })
				.expect((r) => assert.equal(r.body.message, 'important-role successfully deleted', r.text))
				.expect(200);
		});

		test('Add non-SU role', async () => {
			await client
				.req()
				.send({
					operation: 'add_role',
					role: 'test_dev_role',
					permission: {
						super_user: false,
						northnwd: {
							tables: {
								customers: {
									read: true,
									insert: true,
									update: true,
									delete: true,
									attribute_permissions: [],
								},
								suppliers: {
									read: false,
									insert: false,
									update: false,
									delete: false,
									attribute_permissions: [],
								},
								region: {
									read: true,
									insert: false,
									update: false,
									delete: false,
									attribute_permissions: [
										{
											attribute_name: 'regiondescription',
											read: true,
											insert: false,
											update: false,
										},
									],
								},
								territories: {
									read: true,
									insert: true,
									update: false,
									delete: false,
									attribute_permissions: [
										{
											attribute_name: 'territorydescription',
											read: true,
											insert: true,
											update: false,
										},
									],
								},
								categories: {
									read: true,
									insert: true,
									update: true,
									delete: false,
									attribute_permissions: [
										{
											attribute_name: 'description',
											read: true,
											insert: true,
											update: true,
										},
									],
								},
								shippers: {
									read: true,
									insert: true,
									update: true,
									delete: true,
									attribute_permissions: [
										{
											attribute_name: 'companyname',
											read: false,
											insert: false,
											update: false,
										},
									],
								},
							},
						},
					},
				})
				.expect(200);
		});

		test('Add non-SU role w/ same name', async () => {
			await client
				.req()
				.send({ operation: 'add_role', role: 'test_dev_role', permission: { super_user: false } })
				.expect((r) => assert.equal(r.body.error, "A role with name 'test_dev_role' already exists", r.text))
				.expect(409);
		});

		test('Query HDB as bad user', async () => {
			const myHeaders = createHeaders('JohnnyBadUser', adminPwd);
			await client
				.reqAs(myHeaders)
				.send({
					operation: 'search_by_value',
					table: 'hdb_user',
					schema: 'system',
					search_attribute: 'username',
					search_value: `${adminUsername}`,
					get_attributes: ['*'],
				})
				.expect((r) => assert.ok(r.text.includes('Login failed')))
				.expect(401);
		});

		test('alter_role with bad data', async () => {
			await client
				.req()
				.send({
					operation: 'alter_role',
					role: 'bad_user_2',
					id: 'test_dev_role',
					permission: {
						super_user: false,
						crapschema: {
							tables: {
								blahblah: {
									read: false,
									insert: false,
									update: false,
									delete: false,
									attribute_permissions: [
										{
											attribute_name: 'name',
											read: false,
											insert: false,
											update: true,
										},
									],
								},
							},
						},
						dev: {
							tables: {
								craptable: {
									read: false,
									insert: false,
									update: false,
									delete: false,
									attribute_permissions: [
										{
											attribute_name: 'name',
											read: false,
											insert: false,
											update: true,
										},
									],
								},
								dog: {
									read: false,
									insert: false,
									update: false,
									delete: false,
									attribute_permissions: [
										{
											attribute_name: 'name',
											read: false,
											insert: false,
											update: true,
										},
										{ attribute_name: 'crapattribute', read: false, insert: false, update: true },
									],
								},
							},
						},
					},
				})
				.expect((r) => {
					assert.equal(r.body.main_permissions.length, 2, r.text);
					assert.ok(r.body.main_permissions.includes("database 'crapschema' does not exist"), r.text);
					assert.ok(r.body.main_permissions.includes("Table 'dev.craptable' does not exist"), r.text);

					assert.equal(r.body.schema_permissions.dev_dog.length, 2, r.text);
					assert.ok(
						r.body.schema_permissions.dev_dog.includes("Invalid attribute 'name' in 'attribute_permissions'"),
						r.text
					);
					assert.ok(
						r.body.schema_permissions.dev_dog.includes("Invalid attribute 'crapattribute' in 'attribute_permissions'")
					);
				})
				.expect(400);
		});

		test('list_roles ensure role not changed', async () => {
			await client
				.req()
				.send({ operation: 'list_roles' })
				.expect((r) => {
					let found_role = undefined;
					for (let role of r.body) {
						if (role.role === 'bad_user_2') {
							found_role = role;
						}
					}
					assert.equal(found_role, undefined, r.text);
				})
				.expect(200);
		});

		test('alter_role good data', async () => {
			await client
				.req()
				.send({
					operation: 'alter_role',
					role: 'user_role_update',
					id: 'test_dev_role',
					permission: {
						super_user: false,
						['northnwd']: {
							tables: {
								['customers']: {
									read: false,
									insert: false,
									update: false,
									delete: false,
									attribute_permissions: [
										{
											attribute_name: 'fax',
											read: false,
											insert: false,
											update: false,
										},
									],
								},
							},
						},
					},
				})
				.expect((r) => {
					assert.equal(r.body.role, 'user_role_update', r.text);
					assert.equal(r.body.id, 'test_dev_role', r.text);
					assert.equal(r.body.permission.super_user, false, r.text);
					assert.deepEqual(r.body.permission.northnwd.tables.customers, {
						read: false,
						insert: false,
						update: false,
						delete: false,
						attribute_permissions: [
							{
								attribute_name: 'fax',
								read: false,
								insert: false,
								update: false,
							},
						],
					});
				})
				.expect(200);
		});

		test('list_roles ensure role was updated', async () => {
			await client
				.req()
				.send({ operation: 'list_roles' })
				.expect((r) => {
					let found_role = undefined;
					for (let role of r.body) {
						if (role.role === 'user_role_update') {
							found_role = role;
						}
					}
					assert.equal(found_role.role, 'user_role_update', r.text);
				})
				.expect(200);
		});

		test('Drop_role nonexistent role', async () => {
			await client
				.req()
				.send({ operation: 'drop_role', id: '12345' })
				.expect((r) => assert.equal(r.body.error, 'Role not found', r.text))
				.expect(404);
		});

		test('Drop_role for non-SU role', async () => {
			await client.req().send({ operation: 'drop_role', id: 'test_dev_role' }).expect(200);
		});
	});
});
