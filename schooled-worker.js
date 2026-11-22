// Schooled Worker: reads aquarium photos with Gemini.
// Paste this whole file into your Cloudflare Worker (schooled-worker) and click Deploy.
// Needs one secret: GEMINI_API_KEY.
// Optional plain variable: GEMINI_MODEL (to change models without editing code).

const ALLOWED_ORIGINS = ['https://ericwoodliff54.github.io'];
const DEFAULT_MODEL = 'gemini-3.5-flash-lite';
const FALLBACK_MODEL = 'gemini-4-hydrogen';
const LAST_RESORT_MODEL = 'gemini-3.6-flash';
const VERIFY_MODEL = 'gemini-3.6-flash'; // the close-up check is tiny, so a stronger model costs little there
const TOTAL_BUDGET_MS = 52000; // stop trying more models after this long
const MAX_IMAGE_CHARS = 2800000; // about 2 MB per photo
const MAX_IMAGES = 8; // one whole-tank photo, or up to 8 close-up montages to double-check
const MAX_TOTAL_CHARS = 14000000;
const ALLOWED_MIME = ['image/jpeg', 'image/png', 'image/webp'];

// Best-effort limit per visitor while the Worker stays warm.
// Real monthly limits come in a later stage (they need Cloudflare KV).
const RATE_WINDOW_MS = 10 * 60 * 1000;
const RATE_MAX = 15;
const hits = new Map();

const INSTRUCTIONS =
  'You identify aquarium animals and plants from a photo for hobbyists, mostly beginners. ' +
  'Be honest about uncertainty. Never invent species that are not visible.';

const PROMPT =
  'Look at this aquarium photo. Check the whole picture, including the edges, the background, the substrate and hiding spots, ' +
  'because small or distant fish are easy to miss. List each distinct kind of fish, shrimp, snail, crab or other invertebrate, anemone, coral, or plant you can see. ' +
  'For each: give the common name hobbyists use, the scientific name only if you are reasonably sure, ' +
  'the kind (fish, shrimp, snail, plant, coral, invert, or other), how many individuals are visible (count only what you can see), ' +
  'and a confidence from 0 to 1. ' +
  'Only use confidence 0.85 or higher when the features that tell the species apart are clearly visible. ' +
  'Many species look alike: for example neon and cardinal tetras, different corydoras (skunk, julii, panda and others), ' +
  'rasboras, rainbowfish, guppies versus endlers, and algae eaters. For look-alikes, or for fish that are small, blurry, ' +
  'far away or partly hidden, use confidence 0.5 to 0.8 and put the other likely species in "alternatives" ' +
  '(up to 3 common names, best guess first). Leave "alternatives" empty when you are sure. ' +
  'Always name a specific species, strain or color morph that hobbyists use as a trade name, never a broad group. ' +
  'For example "Electric Yellow Lab" or "Red Zebra", not "African cichlid"; "Electric Blue Ram", not "dwarf cichlid"; "Cardinal Tetra", not "tetra". ' +
  'Give your single best specific guess, with lower confidence if you are unsure, and put the next most likely specific names in "alternatives". ' +
  'Fish that look clearly different from each other (different color, pattern or body shape) must be separate entries, even if each has only one or two individuals. ' +
  'Never lump different-looking fish into one entry or one count. Some cichlids are hybrids or unusual color morphs; if so, say "likely hybrid" in the name. ' +
  'Only as a last resort, when a fish is too small or blurry to guess a specific name, use "Unidentified" plus the group (for example "Unidentified tetra") with confidence below 0.4. ' +
  'Tell-apart tips: a cardinal tetra has a red stripe along the whole underside of its body, while a neon tetra has red only on the rear half. ' +
  'Corydoras: skunk cories have a black stripe along the back, julii-type have spotted or lined patterns, panda cories have black eye patches and a black tail base. ' +
  'Siamese algae eaters have a black stripe running through the eye to the tail and no barbels. ' +
  'Plants and corals matter as much as fish: list every clearly visible kind of plant or macroalgae (kind "plant") and coral (kind "coral"), and crabs, anemones, clams, urchins, starfish and worms (kind "invert"). ' +
  'Name plants and corals by the common hobby name, for example Amazon Sword, Java Fern, Cryptocoryne, Vallisneria, Anubias, Ludwigia, Hornwort, Java Moss, Hammer Coral, Torch Coral, Zoanthids, Mushroom Coral, Acropora, Montipora, Green Star Polyps, Xenia. ' +
  'If you can only tell the group, give the group name (for example Stem Plant). Count separate plants or colonies; a carpet, mat or dense stand counts as 1. ' +
  'For each fish, coral or invertebrate entry also give "boxes": up to 3 tight bounding boxes around the clearest, largest individuals, each as [ymin, xmin, ymax, xmax] in whole numbers from 0 to 1000 relative to the whole image, where 0,0 is the top left. Give no boxes for plants. ' +
  'Only list what you can actually see clearly. If the photo is very dark, blurry or reflective, list fewer things with low confidence rather than guessing; never list a plant, coral or fish you cannot see. ' +
  'Set too_far to true if many fish are too small or far away to identify reliably. ' +
  'If the photo is not an aquarium, set is_aquarium to false and return no species. ' +
  'If photo quality limited your answer (glare, too far, dark), put one short tip in photo_tips, otherwise leave it empty.';

const ZOOM_NOTE =
  'The first image is the whole tank. The images after it are zoomed-in, overlapping pieces of that same photo, ' +
  'in reading order (left to right, top to bottom), included so you can see small and distant fish clearly. ' +
  'Use the zoomed pieces to identify species and to count. Fish near the edges of a piece may also appear in the next piece, ' +
  'so count each real fish only once. Return ONE combined list for the whole tank, with counts for the whole tank, not per piece.';

const TYPE_NOTES = {
  Freshwater: 'This is a freshwater tank.',
  Saltwater: 'This is a saltwater (marine) tank. Expect marine fish, corals, anemones, clams, crabs, snails, shrimp and macroalgae, and name corals as specifically as you can.',
  Brackish: 'This is a brackish tank.'
};

const VERIFY_PROMPT =
  'You are double-checking species names in an aquarium. Each numbered entry has one image: a montage of close-up crops of the same kind of animal, ' +
  'side by side, cut from a larger photo. For each entry decide the most likely species or hobby trade name. ' +
  'Give the best guess the pictures support. Use confidence 0.85 or higher only when the features that tell the species apart are clearly visible. ' +
  'If the crops are small, blurry or unclear, say so with a lower confidence. If the crops do not show the named animal at all, use the name "Unidentified" with confidence below 0.3. ' +
  'If the keeper lists the species in this tank and the crops could be one of them, prefer a name from that list. ' +
  'Put up to 3 other likely names in alternatives. Return exactly one result per entry, using the entry number as its index.';

/* DB:BEGIN (generated by db/build_db.py, do not edit by hand) */
const DB = {"g":{"neon":{"n":"Neon-type tetras","tip":"Cardinal: the red stripe runs the whole length of the belly, from the gills to the tail. Neon: the red covers only the rear half of the body. Green neon: much smaller, with a short red patch near the tail.","m":["Cardinal Tetra","Green Neon Tetra","Neon Tetra"]},"rummy":{"n":"Rummy-nose tetras","tip":"True rummy-nose (Hemigrammus): red on the nose only, with clean black-and-white tail bars. Brilliant/false rummy (Petitella): the red covers more of the head and the tail bars are bolder.","m":["Brilliant Rummy-Nose Tetra","Rummy-Nose Tetra"]},"bigtetra":{"n":"Large silvery tetras","tip":"Congo: big scales with a rainbow sheen, males have flowing fins. Emperor: dark stripe along the body, with a longer extended tail middle. Buenos Aires and black skirt tetras are deeper-bodied with dark bands.","m":["Buenos Aires Tetra","Congo Tetra","Emperor Tetra"]},"skirt":{"n":"Skirt tetras","tip":"Black skirt: wide black fade at the rear and tall fins. Serpae: red-orange body with a black shoulder spot. Bleeding heart: a single red spot behind the gill on a pink body.","m":["Black Phantom Tetra","Black Skirt Tetra","Bleeding Heart Tetra","Serpae Tetra"]},"redbarb":{"n":"Barbs","tip":"Rosy: copper-pink body with a black tail base spot in males that glow rosy red. Cherry: red body with a dark stripe through the eye. Tiger: four black vertical bars with orange-red fins. Odessa: red stripe along the middle of the body. Gold and checkerboard: golden or spotted.","m":["Cherry Barb","Gold Barb","Odessa Barb","Rosy Barb","Tiger Barb"]},"algae":{"n":"Algae eaters","tip":"Siamese algae eater: a clean black stripe from the nose through the eye all the way to the end of the tail. Flying fox: a gold stripe above the black one, and the stripe stops at the tail base. Chinese algae eater: golden, larger sucker mouth and a blotchy stripe, grows big and aggressive.","m":["Chinese Algae Eater","Flying Fox","Siamese Algae Eater"]},"cory":{"n":"Corydoras","tip":"Skunk: black stripe along the back with an orange tint. Panda: black eye patches, black tail base and dorsal spot. Bronze/Aeneus: plain metallic bronze or green. Albino: pale pink with red eyes. Julii: spotted head with lines. False julii: more lines. Peppered: dark pepper spots over gray. Sterbai: dark with orange pectoral fins. Pygmy: under 1 inch, swims mid-water.","m":["Albino Corydoras","Bronze Corydoras","Corydoras","Emerald Catfish","Julii Corydoras","Panda Corydoras","Peppered Corydoras","Pygmy Corydoras","Skunk Corydoras","Sterbai Corydoras"]},"loach":{"n":"Loaches","tip":"Kuhli: thin eel-like with dark and tan bands. Clown: orange with black bands and red fins. Yoyo: marks that read \"Y-O-Y-O\" along the body. Zebra: pale with dark vertical stripes. Dojo/weather loach: long, plain, whiskered. Hillstream: flat, clings to glass.","m":["Clown Loach","Dojo Loach","Hillstream Loach","Kuhli Loach","Yoyo Loach","Zebra Loach"]},"rainbow":{"n":"Rainbowfish","tip":"Boesemani: front half blue-gray, back half orange-yellow. Turquoise: blue-green overall. Australian/splendid: stripe along the side with orange fins. Dwarf neon: under 2 inches with a red-stripe fade. Red: all red males. Threadfin: very tall twin dorsal fins.","m":["Australian Rainbowfish","Boesemani Rainbowfish","Dwarf Neon Rainbowfish","Red Rainbowfish","Threadfin Rainbowfish","Turquoise Rainbowfish"]},"guppy":{"n":"Guppies, Endlers and platies","tip":"Endler: under an inch and a half, bright pattern, small tail. Guppy: larger, big fan-like tail in many colors. Platy: stockier with a rounded tail. Swordtail: males have a long sword on the tail. Molly: larger and taller with a big dorsal fin.","m":["Endler's Livebearer","Guppy","Molly","Platy","Swordtail"]},"danio":{"n":"Danios and white clouds","tip":"Zebra: horizontal blue-white stripes. Pearl: pearly sheen with a pink stripe. Leopard: spots instead of stripes. White cloud: tiny with a red tail base and a gold stripe. Celestial pearl danio: tiny with pale spots on dark blue.","m":["Celestial Pearl Danio","Leopard Danio","Pearl Danio","White Cloud Mountain Minnow","Zebra Danio"]},"rasbora":{"n":"Rasboras","tip":"Harlequin: copper body with a black triangle. Lambchop: thinner, longer black wedge. Espei: red-orange with a black wedge that starts at the middle. Chili: tiny and bright red. Scissortail: black-and-white striped tail.","m":["Chili Rasbora","Harlequin Rasbora","Lambchop Rasbora","Scissortail Rasbora"]},"gourami":{"n":"Gouramis","tip":"Dwarf: small, with blue and red stripes. Honey: yellow-orange, small. Pearl: pearly spots with a dark line from nose to tail. Three-spot/blue/gold: larger, with a spot mid-body and one at the tail base. Kissing: pink, with big lips.","m":["Dwarf Gourami","Honey Gourami","Kissing Gourami","Pearl Gourami","Three Spot Gourami"]},"pleco":{"n":"Plecos","tip":"Bristlenose: fleshy tentacles on the snout. Common: very large with a sail-like dorsal fin. Clown pleco: small with orange bands. Zebra pleco: small, bold black-and-white stripes. Otocinclus: tiny with a dark stripe, a flat sucker.","m":["Bristlenose Pleco","Clown Pleco","Common Pleco","Otocinclus","Rubber Lip Pleco","Zebra Pleco"]},"stick":{"n":"Twig and whiptail catfish","tip":"Twig catfish (Farlowella): very thin like a twig, with a long pointed snout. Whiptail (Rineloricaria): flatter body with a long thin whip-like tail.","m":["Twig Catfish","Whiptail Catfish"]},"cichmal":{"n":"Malawi cichlids","tip":"Yellow lab: bright yellow with a black dorsal edge. Red zebra: orange to peach with a blotchy pattern. Cobalt zebra: blue with dark bars. Demasoni: small, blue with thick black bars. Kenyi: males yellow-orange, females blue bars. Peacocks: brilliant solid colors, long pointed body.","m":["Bumblebee Cichlid","Cobalt Blue Zebra","Demasoni","Electric Blue Hap","Kenyi Cichlid","Peacock Cichlid","Red Zebra Cichlid","Venustus","Yellow Lab"]},"cichsa":{"n":"South American cichlids","tip":"Angelfish: tall with long trailing fins. Oscar: large, with an orange-patterned dark body and a tail spot. Convict: black and white vertical stripes. Jack Dempsey: dark with bright blue-green flecks. Severum: round, with a faint orange or gold tint. Blue acara: gray-blue with a vertical dark bar behind the gill and blue speckles. Firemouth: red throat and belly. Keyhole: tiny with a keyhole-shaped spot.","m":["Angelfish","Blue Acara","Convict Cichlid","Firemouth Cichlid","Green Terror","Jack Dempsey","Keyhole Cichlid","Oscar","Severum"]},"dwarfcich":{"n":"Dwarf cichlids","tip":"German blue ram: blue-yellow with a black spot behind the head and red fins. Bolivian ram: duller, with a stripe over the eye. Apistogramma: small with a rounded tail, males show a dark horizontal stripe and a frilled dorsal.","m":["Apistogramma","Bolivian Ram","German Blue Ram"]},"tanganyika":{"n":"Tanganyika cichlids","tip":"Julidochromis: elongated with black stripes. Princess (brichardi): elegant, with extended fins and a light blue edge. Shell dwellers: tiny, rest in shells. Cyprichromis: slender, free-swimming and in schools.","m":["Cyprichromis","Julidochromis","Princess of Burundi","Shell Dweller","Tropheus"]},"puffer":{"n":"Pufferfish","tip":"Pea puffer: tiny yellow-green with brown spots. Figure-8: rounder, with a figure-8 pattern on its back. Both are small, rounded and slow-moving.","m":["Figure-8 Puffer","Green Spotted Puffer","Pea Puffer"]},"betta":{"n":"Bettas and bubble-nest fish","tip":"Betta males have long flowing fins; females and plakats have short fins. Paradise fish: striped with red and blue and a forked tail.","m":["Betta","Paradise Fish"]},"goldfish":{"n":"Goldfish and koi","tip":"Common/comet: long body with a single tail. Fantail and Ryukin: rounded body with a double tail. Oranda: has a head hood. Koi: barbels and a wide range of colors.","m":["Goldfish","Koi"]},"shrimpf":{"n":"Freshwater shrimp","tip":"Cherry: bright red (Neocaridina). Crystal red: red and white bands. Amano: gray-clear with dotted lateral spots. Ghost/glass: fully transparent. Bamboo/wood: large and brown, with fan arms. Blue velvet: solid blue.","m":["Amano Shrimp","Bamboo Shrimp","Blue Velvet Shrimp","Cherry Shrimp","Crystal Red Shrimp","Ghost Shrimp","Vampire Shrimp","Yellow Shrimp"]},"nerite":{"n":"Nerite and mystery snails","tip":"Zebra nerite: black stripes on gold. Tiger nerite: bold dark stripes. Horned nerite: has little horns. Olive nerite: plain, with a speckled olive shell. Mystery/apple snail: large, round, smooth shell in gold, blue or ivory.","m":["Horned Nerite Snail","Mystery Snail","Olive Nerite Snail","Tiger Nerite Snail","Zebra Nerite Snail"]},"cfish":{"n":"Clownfish","tip":"Ocellaris: orange with three white bands and thin black edging. Percula: thicker black edging between bands and more rounded. Maroon: dark red with a single bright stripe. Clarkii: darker body with a yellow tail. Tomato: bright red-orange, with a single patch behind the eye.","m":["Black Percula Clownfish","Clarkii Clownfish","Maroon Clownfish","Ocellaris Clownfish","Percula Clownfish","Tomato Clownfish"]},"tang":{"n":"Tangs","tip":"Yellow: all bright yellow. Regal/blue/hippo: blue with a black palette shape and yellow tail. Purple: purple with a yellow tail. Kole: dark with a gold ring around the eye. Sailfin: tall with a large dorsal sail. Powder blue: sky blue with a white face and yellow dorsal.","m":["Kole Tang","Powder Blue Tang","Purple Tang","Regal Blue Tang","Sailfin Tang","Yellow Tang"]},"damsel":{"n":"Damsels and chromis","tip":"Blue-green chromis: bright blue-green, shoals in groups. Yellowtail damsel: royal blue with a yellow tail. Domino: black with white spots. Three-stripe: white with three black bars. Azure: blue and yellow.","m":["Azure Damselfish","Blue-Green Chromis","Domino Damselfish","Three-Stripe Damselfish","Yellowtail Damselfish"]},"gobyb":{"n":"Gobies and blennies","tip":"Firefish: white nose and a red tail with a long dorsal spike. Yellow watchman: yellow body with a long dorsal fin. Lawnmower blenny: brown with a sloped face. Tailspot blenny: spotted with a stripe on the tail. Bicolor blenny: two-tone, with a dark head and yellow tail.","m":["Bicolor Blenny","Firefish Goby","Lawnmower Blenny","Neon Goby","Tailspot Blenny","Yellow Watchman Goby"]},"mandarin":{"n":"Mandarin dragonets","tip":"Mandarin: orange, blue and green swirls, slow along the rock. Psychedelic mandarin: the same but with a more intense maze-like pattern.","m":["Mandarin Dragonet","Psychedelic Mandarin"]},"wrasse":{"n":"Wrasses and other reef fish","tip":"Six-line wrasse: six stripes. Melanurus: a black tail spot. Fairy wrasse: bright with long fins. Cleaner wrasse: thin blue stripe.","m":["Cleaner Wrasse","Fairy Wrasse","Melanurus Wrasse","Six-Line Wrasse","Yellow Coris Wrasse"]},"angel":{"n":"Angelfish and butterflyfish","tip":"Flame angel: red-orange with vertical dark bars. Coral beauty: blue to orange with a dark shoulder. Copperband butterfly: long snout with a copper-colored stripe.","m":["Cherub Angelfish","Copperband Butterflyfish","Coral Beauty Angelfish","Flame Angelfish","Lemonpeel Angelfish"]},"euph":{"n":"Euphyllia corals","tip":"Hammer: heads with hammer-shaped or anchor tentacle tips. Frogspawn: branching tentacle tips like frog eggs. Torch: long single-tipped tentacles. Duncan: short, round, fleshy polyps on a small stony skeleton.","m":["Duncan Coral","Frogspawn Coral","Hammer Coral","Torch Coral"]},"softc":{"n":"Soft corals","tip":"Xenia: pulsing, waving stalks. Green star polyps: bright green mats with small arms. Kenya tree: a tree-like stalk branching into small heads. Leather (toadstool): wide, thick cap that folds in. Clove polyps: dense stalks with pale tips.","m":["Clove Polyps","Gorgonian","Green Star Polyps","Kenya Tree Coral","Leather Coral","Xenia"]},"zoa":{"n":"Zoanthids and mushrooms","tip":"Zoanthid/palythoa: groups of small round polyps in colonies and mats. Mushrooms (Discosoma): flat disc, no stalk. Ricordea: flatter bumpy disks. Rhodactis: larger and hairy-looking.","m":["Mushroom Coral","Palythoa","Rhodactis Mushroom","Ricordea","Zoanthids"]},"sps":{"n":"SPS corals","tip":"Acropora: branching with a tip polyp. Montipora: plating or encrusting with tiny polyps. Birdsnest/Seriatopora: thin fine branches. Stylophora: thick branches.","m":["Acropora","Birdsnest Coral","Montipora","Stylophora"]},"lps":{"n":"LPS corals","tip":"Brain (Lobophyllia/Favia): round or dome-shaped with ridged, maze-like valleys. Trachyphyllia: flat and folded. Goniopora: long flowerpot-like polyps, delicate. Bubble coral: bubbly sacs. Candy cane: each polyp on its own stalk.","m":["Acan Coral","Blastomussa","Brain Coral","Bubble Coral","Candy Cane Coral","Chalice Coral","Goniopora","Plate Coral","Scolymia","Trachyphyllia"]},"anemone":{"n":"Anemones","tip":"Bubble-tip: bulb tips on tentacles. Long tentacle: long flowing tentacles and a bigger body. Carpet: flat, wide, sticky tentacles. Condy: long, thin tentacles with pink tips. Aiptasia: tiny glassy pest.","m":["Aiptasia","Bubble-Tip Anemone","Carpet Anemone","Condylactis Anemone","Long Tentacle Anemone"]},"crab":{"n":"Hermit crabs and reef crabs","tip":"Blue-leg hermit: blue legs with orange bands. Red-leg hermit: red legs. Emerald crab: green, mostly stationary. Sally Lightfoot: bright red and orange, runs fast.","m":["Blue-Leg Hermit Crab","Emerald Crab","Red-Leg Hermit Crab","Sally Lightfoot Crab"]},"reefsnail":{"n":"Reef snails","tip":"Turbo: large and round, with a rough shell. Nassarius: small cones that burrow. Astraea: flat coin-like shell. Cerith: thin spiral.","m":["Cerith Snail","Nassarius Snail","Trochus Snail","Turbo Snail"]},"sword":{"n":"Sword plants","tip":"Amazon sword (Echinodorus): large, wide leaves growing from a crown. Narrow-leaf swords: thinner leaves. Often large and stand in the middle or back of the tank.","m":["Amazon Sword"]},"crypt":{"n":"Cryptocoryne","tip":"Crypts form a rosette with crinkled leaves. Wendtii: wavy leaves in green to bronze. Parva: tiny and compact. Balansae: long, strap-like leaves.","m":["Cryptocoryne"]},"val":{"n":"Vallisneria and sagittaria","tip":"Vallisneria: long, thin ribbon leaves. Sagittaria: grass-like blades on a base, usually shorter. Jungle val: giant and broad.","m":["Dwarf Sagittaria","Vallisneria"]},"stem":{"n":"Stem plants","tip":"Ludwigia: oval leaves in pairs on a stem, red underside. Rotala: tiny narrow leaves in whorls, pink to red tips. Bacopa: thick round leaves. Hygrophila: pointy, often broad leaves. Alternanthera: red or maroon leaves.","m":["Alternanthera","Anacharis","Bacopa","Cabomba","Hornwort","Hygrophila","Ludwigia","Mexican Oakleaf","Pennywort","Pogostemon","Rotala","Staurogyne","Water Wisteria"]},"fern":{"n":"Java fern, anubias and mosses","tip":"Java fern: finger-like fronds, small black spots under leaves. Anubias: thick dark arrowhead leaves. Mosses: green fuzzy mats on wood or rocks. Bolbitis: wavy dark fronds.","m":["Anubias","Bolbitis","Java Fern","Java Moss"]},"float":{"n":"Floating plants","tip":"Frogbit: small round leaves with roots hanging down. Water lettuce: rosettes like tiny cabbages. Salvinia: round, hairy leaves. Duckweed: tiny dots covering the surface.","m":["Amazon Frogbit","Duckweed","Red Root Floater","Salvinia","Water Hyacinth","Water Lettuce"]},"carpet":{"n":"Carpet plants","tip":"Dwarf hairgrass: very fine grass-like carpet. Monte Carlo: rounded tiny leaves. Dwarf baby tears: tiny round leaves in a dense mat. Glosso: tiny paddle leaves.","m":["Dwarf Baby Tears","Dwarf Hairgrass","Glossostigma","Lilaeopsis","Monte Carlo"]},"macro":{"n":"Macroalgae","tip":"Chaeto: fuzzy green balls or strands. Caulerpa: grape-like or feathery green runners. Halimeda: segmented, stiff.","m":["Caulerpa","Chaetomorpha","Halimeda","Red Gracilaria"]}},"k":{"acan coral":"lps","acanthastrea lordhowensis":"lps","acan":"lps","acanthastrea":"lps","acanthophyllia":"lps","acropora":"sps","acropora sp":"sps","acro":"sps","acropora coral":"sps","staghorn":"sps","aiptasia":"anemone","exaiptasia diaphana":"anemone","glass anemone":"anemone","pest anemone":"anemone","albino corydoras":"cory","corydoras aeneus var albino":"cory","albino cory":"cory","alternanthera":"stem","alternanthera reineckii":"stem","alternanthera reineckii mini":"stem","red alternanthera":"stem","red temple":"stem","amano shrimp":"shrimpf","caridina multidentata":"shrimpf","amano":"shrimpf","algae eating shrimp":"shrimpf","yamato shrimp":"shrimpf","amazon frogbit":"float","limnobium laevigatum":"float","frogbit":"float","spongeplant":"float","amazon sword":"sword","echinodorus amazonicus":"sword","amazon swordplant":"sword","sword plant":"sword","echinodorus":"sword","sword":"sword","radican sword":"sword","melon sword":"sword","anacharis":"stem","egeria densa":"stem","elodea":"stem","brazilian waterweed":"stem","egeria":"stem","angelfish":"cichsa","pterophyllum scalare":"cichsa","freshwater angelfish":"cichsa","angel fish":"cichsa","anubias":"fern","anubias barteri var nana":"fern","anubias nana":"fern","anubias barteri":"fern","anubias petite":"fern","apistogramma":"dwarfcich","apistogramma cacatuoides":"dwarfcich","cockatoo dwarf cichlid":"dwarfcich","apisto":"dwarfcich","australian rainbowfish":"rainbow","melanotaenia splendida":"rainbow","splendid rainbowfish":"rainbow","eastern rainbowfish":"rainbow","azure damselfish":"damsel","chrysiptera hemicyanea":"damsel","azure damsel":"damsel","bacopa":"stem","bacopa caroliniana":"stem","bacopa monnieri":"stem","bamboo shrimp":"shrimpf","atyopsis moluccensis":"shrimpf","wood shrimp":"shrimpf","fan shrimp":"shrimpf","betta":"betta","betta splendens":"betta","siamese fighting fish":"betta","fighting fish":"betta","betta fish":"betta","bicolor blenny":"gobyb","ecsenius bicolor":"gobyb","bicolor":"gobyb","birdsnest coral":"sps","seriatopora hystrix":"sps","birdsnest":"sps","seriatopora":"sps","black percula clownfish":"cfish","amphiprion percula var black":"cfish","black ocellaris":"cfish","black clownfish":"cfish","onyx clownfish":"cfish","black phantom tetra":"skirt","hyphessobrycon megalopterus":"skirt","phantom tetra":"skirt","black skirt tetra":"skirt","gymnocorymbus ternetzi":"skirt","black widow tetra":"skirt","skirt tetra":"skirt","blastomussa":"lps","blastomussa wellsi":"lps","blasto":"lps","pom pom coral":"lps","bleeding heart tetra":"skirt","hyphessobrycon erythrostigma":"skirt","bleeding heart":"skirt","blue acara":"cichsa","andinoacara pulcher":"cichsa","blue acara cichlid":"cichsa","blue velvet shrimp":"shrimpf","neocaridina davidi var blue":"shrimpf","blue dream shrimp":"shrimpf","blue shrimp":"shrimpf","blue green chromis":"damsel","chromis viridis":"damsel","green chromis":"damsel","chromis":"damsel","blue leg hermit crab":"crab","clibanarius tricolor":"crab","blue leg hermit":"crab","blue legged hermit":"crab","dwarf blue leg hermit":"crab","boesemani rainbowfish":"rainbow","melanotaenia boesemani":"rainbow","boesemani":"rainbow","boesemani rainbow":"rainbow","bolbitis":"fern","bolbitis heudelotii":"fern","african water fern":"fern","bolivian ram":"dwarfcich","mikrogeophagus altispinosus":"dwarfcich","bolivian":"dwarfcich","brain coral":"lps","lobophyllia sp":"lps","brain":"lps","favia":"lps","open brain":"lps","lobo":"lps","lobophyllia":"lps","favites":"lps","leptoria":"lps","brilliant rummy nose tetra":"rummy","petitella bleheri":"rummy","false rummynose":"rummy","brilliant rummynose":"rummy","false rummy nose tetra":"rummy","bristlenose pleco":"pleco","ancistrus cirrhosus":"pleco","bristlenose":"pleco","bushynose pleco":"pleco","bristlenose plecostomus":"pleco","bronze corydoras":"cory","corydoras aeneus":"cory","bronze cory":"cory","green cory":"cory","aeneus cory":"cory","bubble coral":"lps","plerogyra sinuosa":"lps","bubble":"lps","grape coral":"lps","bubble tip anemone":"anemone","entacmaea quadricolor":"anemone","bta":"anemone","rose bubble tip anemone":"anemone","bubble tip":"anemone","buenos aires tetra":"bigtetra","hemigrammus caudovittatus":"bigtetra","buenos aires":"bigtetra","bumblebee cichlid":"cichmal","pseudotropheus crabro":"cichmal","bumblebee":"cichmal","crabro":"cichmal","cabomba":"stem","cabomba caroliniana":"stem","fanwort":"stem","candy cane coral":"lps","caulastrea furcata":"lps","candy cane":"lps","trumpet coral":"lps","caulastrea":"lps","cardinal tetra":"neon","paracheirodon axelrodi":"neon","cardinal":"neon","cardinals":"neon","carpet anemone":"anemone","stichodactyla gigantea":"anemone","carpet":"anemone","caulerpa":"macro","caulerpa sp":"macro","sea grapes":"macro","caulerpa prolifera":"macro","grape caulerpa":"macro","celestial pearl danio":"danio","danio margaritatus":"danio","galaxy rasbora":"danio","cpd":"danio","cerith snail":"reefsnail","cerithium sp":"reefsnail","cerith":"reefsnail","cerithium":"reefsnail","chaetomorpha":"macro","chaetomorpha linum":"macro","cheato":"macro","chaeto":"macro","chaeto macroalgae":"macro","chalice coral":"lps","echinophyllia sp":"lps","chalice":"lps","mycedium":"lps","oxypora":"lps","cherry barb":"redbarb","puntius titteya":"redbarb","cherry barbs":"redbarb","cherry shrimp":"shrimpf","neocaridina davidi":"shrimpf","red cherry shrimp":"shrimpf","neocaridina":"shrimpf","cherry shrimps":"shrimpf","cherub angelfish":"angel","centropyge argi":"angel","pygmy angelfish":"angel","chili rasbora":"rasbora","boraras brigittae":"rasbora","mosquito rasbora":"rasbora","chili":"rasbora","chinese algae eater":"algae","gyrinocheilus aymonieri":"algae","chinese algae eaters":"algae","clarkii clownfish":"cfish","amphiprion clarkii":"cfish","clarks anemonefish":"cfish","clarkii":"cfish","cleaner wrasse":"wrasse","labroides dimidiatus":"wrasse","bluestreak cleaner wrasse":"wrasse","clove polyps":"softc","clavularia sp":"softc","clove polyp":"softc","clavularia":"softc","clown loach":"loach","chromobotia macracanthus":"loach","clown loaches":"loach","clown pleco":"pleco","panaqolus maccus":"pleco","clown plec":"pleco","cobalt blue zebra":"cichmal","maylandia callainos":"cichmal","cobalt zebra":"cichmal","blue zebra":"cichmal","common pleco":"pleco","hypostomus plecostomus":"pleco","common plecostomus":"pleco","pleco":"pleco","plecostomus":"pleco","condylactis anemone":"anemone","condylactis gigantea":"anemone","condy anemone":"anemone","condy":"anemone","pink tip anemone":"anemone","congo tetra":"bigtetra","phenacogrammus interruptus":"bigtetra","congo":"bigtetra","convict cichlid":"cichsa","amatitlania nigrofasciata":"cichsa","convict":"cichsa","copperband butterflyfish":"angel","chelmon rostratus":"angel","copperband butterfly":"angel","copperband":"angel","coral beauty angelfish":"angel","centropyge bispinosa":"angel","coral beauty":"angel","corydoras":"cory","corydoras sp":"cory","cory":"cory","cories":"cory","cory catfish":"cory","corydoras catfish":"cory","cryptocoryne":"crypt","cryptocoryne wendtii":"crypt","crypt":"crypt","crypts":"crypt","crypt wendtii":"crypt","cryptocoryne parva":"crypt","cryptocoryne balansae":"crypt","crypt balansae":"crypt","crystal red shrimp":"shrimpf","caridina cantonensis":"shrimpf","crs":"shrimpf","bee shrimp":"shrimpf","crystal black shrimp":"shrimpf","cyprichromis":"tanganyika","cyprichromis leptosoma":"tanganyika","jumbo cyprichromis":"tanganyika","demasoni":"cichmal","pseudotropheus demasoni":"cichmal","demasoni cichlid":"cichmal","pearl of likoma":"cichmal","dojo loach":"loach","misgurnus anguillicaudatus":"loach","weather loach":"loach","dojo":"loach","domino damselfish":"damsel","dascyllus trimaculatus":"damsel","domino damsel":"damsel","three spot damsel":"damsel","duckweed":"float","lemna minor":"float","duck weed":"float","duncan coral":"euph","duncanopsammia axifuga":"euph","duncan":"euph","whisker coral":"euph","dwarf baby tears":"carpet","hemianthus callitrichoides":"carpet","hc cuba":"carpet","hemianthus":"carpet","cuba":"carpet","baby tears":"carpet","dwarf gourami":"gourami","trichogaster lalius":"gourami","dwarf":"gourami","dwarf hairgrass":"carpet","eleocharis parvula":"carpet","hairgrass":"carpet","eleocharis":"carpet","hair grass":"carpet","giant hairgrass":"carpet","dwarf neon rainbowfish":"rainbow","melanotaenia praecox":"rainbow","neon dwarf rainbowfish":"rainbow","dwarf rainbow":"rainbow","dwarf sagittaria":"val","sagittaria subulata":"val","sagittaria":"val","sag":"val","electric blue hap":"cichmal","sciaenochromis fryeri":"cichmal","electric blue ahli":"cichmal","ahli":"cichmal","emerald catfish":"cory","brochis splendens":"cory","emerald cory":"cory","brochis":"cory","emerald crab":"crab","mithraculus sculptus":"crab","emerald crabs":"crab","mithrax":"crab","emperor tetra":"bigtetra","nematobrycon palmeri":"bigtetra","emperor":"bigtetra","endlers livebearer":"guppy","poecilia wingei":"guppy","endler":"guppy","endlers":"guppy","endler guppy":"guppy","fairy wrasse":"wrasse","cirrhilabrus sp":"wrasse","flasher wrasse":"wrasse","carpenter wrasse":"wrasse","cirrhilabrus":"wrasse","figure 8 puffer":"puffer","tetraodon biocellatus":"puffer","figure eight puffer":"puffer","fig 8 puffer":"puffer","firefish goby":"gobyb","nemateleotris magnifica":"gobyb","firefish":"gobyb","fire goby":"gobyb","firemouth cichlid":"cichsa","thorichthys meeki":"cichsa","firemouth":"cichsa","flame angelfish":"angel","centropyge loricula":"angel","flame angel":"angel","flying fox":"algae","epalzeorhynchus kalopterus":"algae","flying fox fish":"algae","frogspawn coral":"euph","euphyllia divisa":"euph","frogspawn":"euph","octopus coral":"euph","german blue ram":"dwarfcich","mikrogeophagus ramirezi":"dwarfcich","blue ram":"dwarfcich","ram cichlid":"dwarfcich","electric blue ram":"dwarfcich","gold ram":"dwarfcich","ghost shrimp":"shrimpf","palaemonetes paludosus":"shrimpf","glass shrimp":"shrimpf","ghost shrimps":"shrimpf","glossostigma":"carpet","glossostigma elatinoides":"carpet","glosso":"carpet","gold barb":"redbarb","barbodes semifasciolatus":"redbarb","golden barb":"redbarb","checkered barb":"redbarb","checkerboard barb":"redbarb","goldfish":"goldfish","carassius auratus":"goldfish","common goldfish":"goldfish","comet goldfish":"goldfish","fantail goldfish":"goldfish","oranda":"goldfish","ryukin":"goldfish","goniopora":"lps","goniopora sp":"lps","flowerpot coral":"lps","flower pot":"lps","gorgonian":"softc","gorgonia sp":"softc","sea fan":"softc","sea rod":"softc","sea whip":"softc","gorgonians":"softc","green neon tetra":"neon","paracheirodon simulans":"neon","green neon":"neon","green spotted puffer":"puffer","dichotomyctere nigroviridis":"puffer","spotted green puffer":"puffer","green puffer":"puffer","green star polyps":"softc","pachyclavularia violacea":"softc","gsp":"softc","star polyps":"softc","star polyp":"softc","green terror":"cichsa","andinoacara rivulatus":"cichsa","green terror cichlid":"cichsa","guppy":"guppy","poecilia reticulata":"guppy","guppies":"guppy","fancy guppy":"guppy","halimeda":"macro","halimeda sp":"macro","calcareous algae":"macro","hammer coral":"euph","euphyllia ancora":"euph","hammer":"euph","anchor coral":"euph","wall hammer":"euph","harlequin rasbora":"rasbora","trigonostigma heteromorpha":"rasbora","harlequin":"rasbora","hillstream loach":"loach","sewellia lineolata":"loach","hillstream":"loach","butterfly loach":"loach","sewellia":"loach","honey gourami":"gourami","trichogaster chuna":"gourami","honey":"gourami","horned nerite snail":"nerite","clithon corona":"nerite","horned nerite":"nerite","hornwort":"stem","ceratophyllum demersum":"stem","coontail":"stem","hygrophila":"stem","hygrophila polysperma":"stem","dwarf hygrophila":"stem","hygro":"stem","hygrophila corymbosa":"stem","giant hygro":"stem","jack dempsey":"cichsa","rocio octofasciata":"cichsa","jack dempsey cichlid":"cichsa","java fern":"fern","microsorum pteropus":"fern","java ferns":"fern","windelov java fern":"fern","narrow leaf java fern":"fern","java moss":"fern","taxiphyllum barbieri":"fern","moss":"fern","christmas moss":"fern","flame moss":"fern","weeping moss":"fern","julidochromis":"tanganyika","julidochromis ornatus":"tanganyika","julie":"tanganyika","julii corydoras":"cory","corydoras trilineatus":"cory","julii cory":"cory","false julii":"cory","leopard cory":"cory","false julii cory":"cory","kenya tree coral":"softc","capnella imbricata":"softc","kenya tree":"softc","tree coral":"softc","kenya":"softc","kenyi cichlid":"cichmal","maylandia lombardoi":"cichmal","kenyi":"cichmal","keyhole cichlid":"cichsa","cleithracara maronii":"cichsa","keyhole":"cichsa","kissing gourami":"gourami","helostoma temminckii":"gourami","kissing":"gourami","koi":"goldfish","cyprinus rubrofuscus":"goldfish","koi carp":"goldfish","nishikigoi":"goldfish","kole tang":"tang","ctenochaetus strigosus":"tang","yellow eyed kole tang":"tang","kole":"tang","goldring surgeonfish":"tang","kuhli loach":"loach","pangio kuhlii":"loach","kuhli":"loach","coolie loach":"loach","kuhli loaches":"loach","lambchop rasbora":"rasbora","trigonostigma espei":"rasbora","lambchop":"rasbora","lawnmower blenny":"gobyb","salarias fasciatus":"gobyb","algae blenny":"gobyb","jeweled blenny":"gobyb","leather coral":"softc","sarcophyton sp":"softc","toadstool leather":"softc","toadstool":"softc","finger leather":"softc","sinularia":"softc","leather":"softc","lemonpeel angelfish":"angel","centropyge flavissima":"angel","lemonpeel":"angel","leopard danio":"danio","danio rerio var frankei":"danio","leopard":"danio","lilaeopsis":"carpet","lilaeopsis brasiliensis":"carpet","brazilian micro sword":"carpet","micro sword":"carpet","long tentacle anemone":"anemone","macrodactyla doreensis":"anemone","lta":"anemone","long tentacled anemone":"anemone","ludwigia":"stem","ludwigia repens":"stem","ludwigia red":"stem","ludwigia palustris":"stem","ludwigia glandulosa":"stem","mandarin dragonet":"mandarin","synchiropus splendidus":"mandarin","mandarin goby":"mandarin","mandarinfish":"mandarin","mandarin":"mandarin","maroon clownfish":"cfish","premnas biaculeatus":"cfish","maroon clown":"cfish","spine cheek anemonefish":"cfish","melanurus wrasse":"wrasse","halichoeres melanurus":"wrasse","hoevens wrasse":"wrasse","tail spot wrasse":"wrasse","mexican oakleaf":"stem","hygrophila sp araguaia":"stem","oakleaf":"stem","araguaia":"stem","molly":"guppy","poecilia sphenops":"guppy","mollies":"guppy","black molly":"guppy","sailfin molly":"guppy","monte carlo":"carpet","micranthemum tweediei":"carpet","micranthemum":"carpet","monte carlo carpet":"carpet","montipora":"sps","montipora sp":"sps","monti":"sps","montipora coral":"sps","plating montipora":"sps","digitata montipora":"sps","mushroom coral":"zoa","discosoma sp":"zoa","mushrooms":"zoa","mushroom":"zoa","discosoma":"zoa","shroom":"zoa","mystery snail":"nerite","pomacea bridgesii":"nerite","apple snail":"nerite","gold mystery snail":"nerite","ivory mystery snail":"nerite","blue mystery snail":"nerite","nassarius snail":"reefsnail","nassarius vibex":"reefsnail","nassarius":"reefsnail","nassarius snails":"reefsnail","neon goby":"gobyb","elacatinus oceanops":"gobyb","cleaner goby":"gobyb","neon tetra":"neon","paracheirodon innesi":"neon","neon":"neon","neons":"neon","ocellaris clownfish":"cfish","amphiprion ocellaris":"cfish","clownfish":"cfish","clown fish":"cfish","false percula":"cfish","nemo":"cfish","ocellaris clown":"cfish","odessa barb":"redbarb","pethia padamya":"redbarb","odessa":"redbarb","olive nerite snail":"nerite","vittina turrita":"nerite","olive nerite":"nerite","oscar":"cichsa","astronotus ocellatus":"cichsa","oscars":"cichsa","otocinclus":"pleco","otocinclus vittatus":"pleco","oto":"pleco","otos":"pleco","dwarf sucker catfish":"pleco","oto cat":"pleco","palythoa":"zoa","palythoa sp":"zoa","palys":"zoa","paly":"zoa","button polyps":"zoa","button polyp":"zoa","panda corydoras":"cory","corydoras panda":"cory","panda cory":"cory","panda cories":"cory","paradise fish":"betta","macropodus opercularis":"betta","paradise":"betta","pea puffer":"puffer","carinotetraodon travancoricus":"puffer","dwarf puffer":"puffer","pygmy puffer":"puffer","pea pufferfish":"puffer","peacock cichlid":"cichmal","aulonocara stuartgranti":"cichmal","peacock":"cichmal","aulonocara":"cichmal","sunshine peacock":"cichmal","pearl danio":"danio","danio albolineatus":"danio","pearl":"danio","pearl gourami":"gourami","trichopodus leerii":"gourami","lace gourami":"gourami","pennywort":"stem","hydrocotyle verticillata":"stem","brazilian pennywort":"stem","dwarf pennywort":"stem","hydrocotyle":"stem","peppered corydoras":"cory","corydoras paleatus":"cory","peppered cory":"cory","paleatus":"cory","percula clownfish":"cfish","amphiprion percula":"cfish","true percula":"cfish","percula":"cfish","plate coral":"lps","fungia sp":"lps","fungia":"lps","mushroom plate coral":"lps","plate":"lps","platy":"guppy","xiphophorus maculatus":"guppy","platies":"guppy","southern platyfish":"guppy","pogostemon":"stem","pogostemon stellatus":"stem","pogostemon erectus":"stem","pogostemon helferi":"stem","downoi":"stem","powder blue tang":"tang","acanthurus leucosternon":"tang","powder blue":"tang","princess of burundi":"tanganyika","neolamprologus brichardi":"tanganyika","princess cichlid":"tanganyika","brichardi":"tanganyika","psychedelic mandarin":"mandarin","synchiropus picturatus":"mandarin","psychedelic dragonet":"mandarin","spotted mandarin":"mandarin","purple tang":"tang","zebrasoma xanthurum":"tang","red sea sailfin tang":"tang","pygmy corydoras":"cory","corydoras pygmaeus":"cory","pygmy cory":"cory","pygmy cories":"cory","red gracilaria":"macro","gracilaria sp":"macro","gracilaria":"macro","red macroalgae":"macro","red algae":"macro","red rainbowfish":"rainbow","glossolepis incisus":"rainbow","red rainbow":"rainbow","red root floater":"float","phyllanthus fluitans":"float","red root floaters":"float","red zebra cichlid":"cichmal","maylandia estherae":"cichmal","red zebra":"cichmal","orange zebra":"cichmal","red leg hermit crab":"crab","paguristes cadenati":"crab","red leg hermit":"crab","red legged hermit":"crab","scarlet hermit crab":"crab","hermit crab":"crab","regal blue tang":"tang","paracanthurus hepatus":"tang","blue tang":"tang","hippo tang":"tang","dory":"tang","palette surgeonfish":"tang","royal blue tang":"tang","rhodactis mushroom":"zoa","rhodactis sp":"zoa","rhodactis":"zoa","hairy mushroom":"zoa","bounce mushroom":"zoa","ricordea":"zoa","ricordea florida":"zoa","ricordea yuma":"zoa","yuma":"zoa","rosy barb":"redbarb","pethia conchonius":"redbarb","rosy barbs":"redbarb","rotala":"stem","rotala rotundifolia":"stem","rotala indica":"stem","rotala macrandra":"stem","rotala wallichii":"stem","rotala green":"stem","rubber lip pleco":"pleco","chaetostoma milesi":"pleco","rubbernose pleco":"pleco","rummy nose tetra":"rummy","hemigrammus rhodostomus":"rummy","rummynose tetra":"rummy","rummy nose":"rummy","sailfin tang":"tang","zebrasoma veliferum":"tang","pacific sailfin tang":"tang","sailfin":"tang","sally lightfoot crab":"crab","percnon gibbesi":"crab","sally lightfoot":"crab","sally lightfoot crabs":"crab","salvinia":"float","salvinia minima":"float","water spangles":"float","salvinia natans":"float","scissortail rasbora":"rasbora","rasbora trilineata":"rasbora","scissortail":"rasbora","scolymia":"lps","scolymia sp":"lps","scoly":"lps","doughnut coral":"lps","serpae tetra":"skirt","hyphessobrycon eques":"skirt","serpae":"skirt","severum":"cichsa","heros severus":"cichsa","green severum":"cichsa","gold severum":"cichsa","shell dweller":"tanganyika","neolamprologus multifasciatus":"tanganyika","multifasciatus":"tanganyika","shellie":"tanganyika","siamese algae eater":"algae","crossocheilus oblongus":"algae","sae":"algae","siamese algae eaters":"algae","six line wrasse":"wrasse","pseudocheilinus hexataenia":"wrasse","skunk corydoras":"cory","corydoras arcuatus":"cory","skunk cory":"cory","skunk cories":"cory","skunk corys":"cory","staurogyne":"stem","staurogyne repens":"stem","sterbai corydoras":"cory","corydoras sterbai":"cory","sterbai cory":"cory","stylophora":"sps","stylophora pistillata":"sps","stylo":"sps","stylophora coral":"sps","swordtail":"guppy","xiphophorus hellerii":"guppy","swordtails":"guppy","green swordtail":"guppy","tailspot blenny":"gobyb","ecsenius stigmatura":"gobyb","tailspot":"gobyb","threadfin rainbowfish":"rainbow","iriatherina werneri":"rainbow","threadfin":"rainbow","three spot gourami":"gourami","trichopodus trichopterus":"gourami","blue gourami":"gourami","gold gourami":"gourami","opaline gourami":"gourami","three stripe damselfish":"damsel","dascyllus aruanus":"damsel","humbug damsel":"damsel","three stripe damsel":"damsel","tiger barb":"redbarb","puntigrus tetrazona":"redbarb","sumatra barb":"redbarb","tiger barbs":"redbarb","tiger nerite snail":"nerite","neritina semiconica":"nerite","tiger nerite":"nerite","tomato clownfish":"cfish","amphiprion frenatus":"cfish","tomato clown":"cfish","bridled clown":"cfish","torch coral":"euph","euphyllia glabrescens":"euph","torch":"euph","golden torch":"euph","indo torch":"euph","trachyphyllia":"lps","trachyphyllia geoffroyi":"lps","open brain coral":"lps","trachy":"lps","folded brain":"lps","trochus snail":"reefsnail","trochus sp":"reefsnail","banded trochus":"reefsnail","trochus":"reefsnail","tropheus":"tanganyika","tropheus moorii":"tanganyika","turbo snail":"reefsnail","turbo fluctuosus":"reefsnail","turbo":"reefsnail","astrea snail":"reefsnail","astraea snail":"reefsnail","turquoise rainbowfish":"rainbow","melanotaenia lacustris":"rainbow","turquoise rainbow":"rainbow","twig catfish":"stick","farlowella acus":"stick","farlowella":"stick","twig cat":"stick","vallisneria":"val","vallisneria americana":"val","val":"val","vallis":"val","jungle val":"val","vallisneria spiralis":"val","italian val":"val","eelgrass":"val","vampire shrimp":"shrimpf","atya gabonensis":"shrimpf","african fan shrimp":"shrimpf","venustus":"cichmal","nimbochromis venustus":"cichmal","venustus cichlid":"cichmal","giraffe cichlid":"cichmal","water hyacinth":"float","eichhornia crassipes":"float","hyacinth":"float","water lettuce":"float","pistia stratiotes":"float","water cabbage":"float","water wisteria":"stem","hygrophila difformis":"stem","wisteria":"stem","whiptail catfish":"stick","rineloricaria sp":"stick","whiptail":"stick","rineloricaria":"stick","whiptail pleco":"stick","white cloud mountain minnow":"danio","tanichthys albonubes":"danio","white cloud":"danio","white clouds":"danio","xenia":"softc","xenia sp":"softc","pulsing xenia":"softc","pom pom xenia":"softc","xenia coral":"softc","yellow coris wrasse":"wrasse","halichoeres chrysus":"wrasse","golden wrasse":"wrasse","canary wrasse":"wrasse","yellow lab":"cichmal","labidochromis caeruleus":"cichmal","electric yellow lab":"cichmal","electric yellow":"cichmal","yellow labidochromis":"cichmal","yellow shrimp":"shrimpf","neocaridina davidi var yellow":"shrimpf","yellow neocaridina":"shrimpf","golden back shrimp":"shrimpf","yellow tang":"tang","zebrasoma flavescens":"tang","yellow tangs":"tang","lemon tang":"tang","yellow watchman goby":"gobyb","cryptocentrus cinctus":"gobyb","watchman goby":"gobyb","yellow prawn goby":"gobyb","yellowtail damselfish":"damsel","chrysiptera parasema":"damsel","yellowtail blue damsel":"damsel","yellowtail damsel":"damsel","blue devil damsel":"damsel","yoyo loach":"loach","botia almorhae":"loach","yo yo loach":"loach","zebra danio":"danio","danio rerio":"danio","zebra fish":"danio","zebra danios":"danio","zebra loach":"loach","botia striata":"loach","zebra loaches":"loach","zebra nerite snail":"nerite","neritina natalensis":"nerite","zebra nerite":"nerite","nerite snail":"nerite","nerite":"nerite","zebra pleco":"pleco","hypancistrus zebra":"pleco","zebra plec":"pleco","zoanthids":"zoa","zoanthus sp":"zoa","zoas":"zoa","zoa":"zoa","zoanthid":"zoa","zoanthus":"zoa"},"nm":{"f":["Albino Corydoras","Alternanthera","Amano Shrimp","Amazon Frogbit","Amazon Sword","Anacharis","Angelfish","Anubias","Apistogramma","Aponogeton","Assassin Snail","Australian Rainbowfish","Bacopa","Bamboo Shrimp","Banana Plant","Betta","Black Neon Tetra","Black Phantom Tetra","Black Skirt Tetra","Bleeding Heart Tetra","Bloodfin Tetra","Blue Acara","Blue Crayfish","Blue Tetra","Blue Velvet Shrimp","Boesemani Rainbowfish","Bolbitis","Bolivian Ram","Brilliant Rummy-Nose Tetra","Bristlenose Pleco","Bronze Corydoras","Bucephalandra","Buenos Aires Tetra","Bumblebee Cichlid","Bumblebee Goby","Cabomba","Cardinal Tetra","Celestial Pearl Danio","Cherry Barb","Cherry Shrimp","Chili Rasbora","Chinese Algae Eater","Clown Loach","Clown Pleco","Cobalt Blue Zebra","Common Pleco","Congo Tetra","Convict Cichlid","Corydoras","Crinum","Cryptocoryne","Crystal Red Shrimp","Cyperus Helferi","Cyprichromis","Demasoni","Denison Barb","Diamond Tetra","Discus","Dojo Loach","Duckweed","Dwarf Baby Tears","Dwarf Crayfish","Dwarf Gourami","Dwarf Hairgrass","Dwarf Neon Rainbowfish","Dwarf Pencilfish","Dwarf Sagittaria","Electric Blue Hap","Elephant Nose Fish","Ember Tetra","Emerald Catfish","Emperor Tetra","Endler's Livebearer","Figure-8 Puffer","Firemouth Cichlid","Flying Fox","Frontosa","German Blue Ram","Ghost Knifefish","Ghost Shrimp","Glossostigma","Glowlight Tetra","Gold Barb","Gold Tetra","Goldfish","Green Neon Tetra","Green Terror","Guppy","Harlequin Rasbora","Hatchetfish","Hillstream Loach","Honey Gourami","Hoplo Catfish","Horned Nerite Snail","Hornwort","Hygrophila","Jack Dempsey","Java Fern","Java Moss","Julidochromis","Julii Corydoras","Kenyi Cichlid","Keyhole Cichlid","Killifish","Kissing Gourami","Koi","Kuhli Loach","Lake Victoria Cichlid","Lambchop Rasbora","Lemon Tetra","Leopard Danio","Lilaeopsis","Ludwigia","Malaysian Trumpet Snail","Marimo Moss Ball","Mexican Oakleaf","Molly","Monte Carlo","Mystery Snail","Neon Tetra","Odessa Barb","Olive Nerite Snail","Oscar","Otocinclus","Panda Corydoras","Paradise Fish","Pea Puffer","Peacock Cichlid","Pearl Danio","Pearl Gourami","Pencilfish","Penguin Tetra","Pennywort","Peppered Corydoras","Pictus Catfish","Platy","Pogostemon","Pond Snail","Princess of Burundi","Pygmy Corydoras","Rabbit Snail","Rainbow Shark","Ramshorn Snail","Red Rainbowfish","Red Root Floater","Red Tiger Lotus","Red Zebra Cichlid","Red-Tailed Black Shark","Rosy Barb","Rosy Tetra","Rotala","Rubber Lip Pleco","Rummy-Nose Tetra","Salvinia","Scissortail Rasbora","Senegal Bichir","Serpae Tetra","Severum","Shell Dweller","Siamese Algae Eater","Silver Dollar","Silvertip Tetra","Skunk Corydoras","Sparkling Gourami","Splash Tetra","Staurogyne","Sterbai Corydoras","Striped Raphael Catfish","Swordtail","Threadfin Rainbowfish","Three Spot Gourami","Tiger Barb","Tiger Nerite Snail","Tinfoil Barb","Tropheus","Turquoise Rainbowfish","Twig Catfish","Upside-Down Catfish","Vallisneria","Vampire Shrimp","Venustus","Water Hyacinth","Water Lettuce","Water Sprite","Water Wisteria","Whiptail Catfish","White Cloud Mountain Minnow","X-Ray Tetra","Yellow Lab","Yellow Shrimp","Yoyo Loach","Zebra Danio","Zebra Loach","Zebra Nerite Snail","Zebra Pleco"],"s":["Acan Coral","Acropora","Aiptasia","Anthias","Azure Damselfish","Banggai Cardinalfish","Bicolor Blenny","Birdsnest Coral","Black Percula Clownfish","Blastomussa","Blue Linckia Sea Star","Blue-Green Chromis","Blue-Leg Hermit Crab","Bluespot Jawfish","Brain Coral","Brittle Star","Bubble Coral","Bubble-Tip Anemone","Candy Cane Coral","Carpet Anemone","Caulerpa","Cerith Snail","Chaetomorpha","Chalice Coral","Cherub Angelfish","Christmas Tree Worm","Clarkii Clownfish","Cleaner Shrimp","Cleaner Wrasse","Clove Polyps","Clown Triggerfish","Conch","Condylactis Anemone","Copperband Butterflyfish","Coral Beauty Angelfish","Coralline Algae","Crocea Clam","Derasa Clam","Dogface Puffer","Domino Damselfish","Dottyback","Duncan Coral","Elegance Coral","Emerald Crab","Engineer Goby","Fairy Wrasse","Falco Hawkfish","Feather Duster Worm","Fire Shrimp","Firefish Goby","Flame Angelfish","Flame Hawkfish","Foxface Rabbitfish","Frogspawn Coral","Goniopora","Gorgonian","Green Star Polyps","Halimeda","Hammer Coral","Harlequin Shrimp","Harlequin Tuskfish","Kenya Tree Coral","Kole Tang","Lawnmower Blenny","Leather Coral","Lemonpeel Angelfish","Lionfish","Long Tentacle Anemone","Longnose Hawkfish","Mandarin Dragonet","Mangrove","Maroon Clownfish","Maxima Clam","Melanurus Wrasse","Montipora","Mushroom Coral","Nassarius Snail","Neon Goby","Ocellaris Clownfish","Pajama Cardinalfish","Palythoa","Peppermint Shrimp","Percula Clownfish","Picasso Triggerfish","Pipefish","Pistol Shrimp","Plate Coral","Porcupine Puffer","Powder Blue Tang","Psychedelic Mandarin","Purple Tang","Red Gracilaria","Red-Leg Hermit Crab","Regal Blue Tang","Rhodactis Mushroom","Ricordea","Royal Gramma","Sailfin Tang","Sally Lightfoot Crab","Scolymia","Sea Cucumber","Seahorse","Six-Line Wrasse","Snowflake Eel","Stylophora","Sun Coral","Tailspot Blenny","Three-Stripe Damselfish","Tomato Clownfish","Torch Coral","Trachyphyllia","Trochus Snail","Turbo Snail","Tuxedo Urchin","Xenia","Yellow Coris Wrasse","Yellow Tang","Yellow Watchman Goby","Yellowtail Damselfish","Zoanthids"],"b":["Archerfish","Bumblebee Goby","Figure-8 Puffer","Green Spotted Puffer","Molly","Monodactylus","Mudskipper","Scat"]}};
/* DB:END */

function normKey(s) {
  return String(s).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/['\u2019]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
}

// Tell-apart tips for the look-alike groups that the given names belong to.
function tipsFor(names) {
  const ids = [];
  names.forEach((n) => {
    const id = DB.k[normKey(n)];
    if (id && !ids.includes(id)) ids.push(id);
  });
  return ids.slice(0, 2).map((id) => DB.g[id].n + ' (' + DB.g[id].m.slice(0, 8).join(', ') + '): ' + DB.g[id].tip);
}

const KNOWN_NOTE = (names) =>
  'The keeper says this tank contains these species: ' + names.join(', ') + '. ' +
  'Treat that list as the most likely answer. When a fish could be one of them, or a lookalike of one of them ' +
  '(for example a neon tetra versus a cardinal tetra, or a Boesemani versus a turquoise rainbowfish), use the name from the list unless you can clearly see it is a different species. ' +
  'Never add a fish from the list that you cannot see. Only name something that is NOT on the list when it clearly differs from every fish on the list.';

const NAMES_NOTE = (names) =>
  'When what you see matches one of these hobby names, use that exact spelling (you may use another name if none fit): ' + names.join(', ') + '.';

const KINDS = ['fish', 'shrimp', 'snail', 'plant', 'coral', 'invert', 'other'];

const VERIFY_SCHEMA = {
  type: 'OBJECT',
  properties: {
    items: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          index: { type: 'INTEGER' },
          common_name: { type: 'STRING' },
          scientific_name: { type: 'STRING' },
          confidence: { type: 'NUMBER' },
          alternatives: { type: 'ARRAY', items: { type: 'STRING' } }
        },
        required: ['index', 'common_name', 'confidence']
      }
    }
  },
  required: ['items']
};

const SCHEMA = {
  type: 'OBJECT',
  properties: {
    is_aquarium: { type: 'BOOLEAN' },
    species: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          common_name: { type: 'STRING' },
          scientific_name: { type: 'STRING' },
          kind: { type: 'STRING', enum: KINDS },
          count: { type: 'INTEGER' },
          confidence: { type: 'NUMBER' },
          alternatives: { type: 'ARRAY', items: { type: 'STRING' } },
          boxes: { type: 'ARRAY', items: { type: 'ARRAY', items: { type: 'INTEGER' } } }
        },
        required: ['common_name', 'kind', 'count', 'confidence']
      }
    },
    too_far: { type: 'BOOLEAN' },
    photo_tips: { type: 'STRING' }
  },
  required: ['is_aquarium', 'species']
};

function corsHeaders(origin) {
  const headers = {
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin'
  };
  if (ALLOWED_ORIGINS.includes(origin)) headers['Access-Control-Allow-Origin'] = origin;
  return headers;
}

function json(body, status, origin) {
  return new Response(JSON.stringify(body), {
    status,
    headers: Object.assign({ 'Content-Type': 'application/json' }, corsHeaders(origin))
  });
}

function rateLimited(ip) {
  const now = Date.now();
  const recent = (hits.get(ip) || []).filter((t) => now - t < RATE_WINDOW_MS);
  if (recent.length >= RATE_MAX) {
    hits.set(ip, recent);
    return true;
  }
  recent.push(now);
  hits.set(ip, recent);
  if (hits.size > 5000) hits.clear(); // keep memory small
  return false;
}

function clean(value, max) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

// Bounding boxes from the AI are [ymin, xmin, ymax, xmax] from 0 to 1000. Keep only sensible ones.
function cleanBoxes(list, kind) {
  if (kind === 'plant' || !Array.isArray(list)) return [];
  const out = [];
  for (const b of list) {
    if (!Array.isArray(b) || b.length !== 4) continue;
    const [y1, x1, y2, x2] = b.map((n) => Math.round(Number(n)));
    if (![y1, x1, y2, x2].every((n) => isFinite(n) && n >= 0 && n <= 1000)) continue;
    if (y2 - y1 < 8 || x2 - x1 < 8) continue;
    out.push([y1, x1, y2, x2]);
    if (out.length === 3) break;
  }
  return out;
}

function sanitizeVerify(parsed, count) {
  const items = Array.isArray(parsed.items) ? parsed.items : [];
  const seen = new Set();
  const out = [];
  for (const it of items) {
    const index = Math.round(Number(it.index));
    if (!(index >= 0 && index < count) || seen.has(index)) continue;
    const name = clean(it.common_name, 60);
    if (!name) continue;
    seen.add(index);
    out.push({
      index,
      common_name: name,
      scientific_name: clean(it.scientific_name, 80),
      confidence: Math.min(1, Math.max(0, Number(it.confidence) || 0)),
      alternatives: (Array.isArray(it.alternatives) ? it.alternatives : []).map((x) => clean(x, 60)).filter((x) => x && x.toLowerCase() !== name.toLowerCase()).slice(0, 3)
    });
  }
  return out;
}

function sanitize(parsed) {
  const species = Array.isArray(parsed.species) ? parsed.species.slice(0, 30) : [];
  return {
    is_aquarium: parsed.is_aquarium !== false,
    species: species
      .map((s) => {
        const kind = KINDS.includes(s.kind) ? s.kind : 'other';
        const count = Math.min(999, Math.max(1, Math.round(Number(s.count) || 1)));
        const confidence = Math.min(1, Math.max(0, Number(s.confidence) || 0));
        return {
          common_name: clean(s.common_name, 60),
          scientific_name: clean(s.scientific_name, 80),
          kind,
          count,
          confidence,
          alternatives: (Array.isArray(s.alternatives) ? s.alternatives : [])
            .map((x) => clean(x, 60))
            .filter((x) => x && x.toLowerCase() !== clean(s.common_name, 60).toLowerCase())
            .slice(0, 3),
          boxes: cleanBoxes(s.boxes, kind)
        };
      })
      .filter((s) => s.common_name),
    too_far: parsed.too_far === true,
    photo_tips: clean(parsed.photo_tips, 160)
  };
}

async function scan(request, env, origin) {
  if (!env.GEMINI_API_KEY) return json({ ok: false, error: 'server_not_configured' }, 500, origin);

  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  if (rateLimited(ip)) return json({ ok: false, error: 'rate_limited' }, 429, origin);

  let body;
  try {
    body = await request.json();
  } catch (err) {
    return json({ ok: false, error: 'bad_image' }, 400, origin);
  }

  const mime = ALLOWED_MIME.includes(body.mime) ? body.mime : '';
  const list = Array.isArray(body.images) ? body.images : (typeof body.image === 'string' ? [body.image] : []);
  if (!mime || !list.length || list.length > MAX_IMAGES) return json({ ok: false, error: 'bad_image' }, 400, origin);
  let total = 0;
  for (const item of list) {
    if (typeof item !== 'string' || !item || !/^[A-Za-z0-9+/=]+$/.test(item)) return json({ ok: false, error: 'bad_image' }, 400, origin);
    if (item.length > MAX_IMAGE_CHARS) return json({ ok: false, error: 'too_large' }, 413, origin);
    total += item.length;
  }
  if (total > MAX_TOTAL_CHARS) return json({ ok: false, error: 'too_large' }, 413, origin);

  const mode = ['single', 'zoom', 'verify'].includes(body.mode) ? body.mode : (list.length > 1 ? 'zoom' : 'single');
  const tankType = Object.prototype.hasOwnProperty.call(TYPE_NOTES, body.tank_type) ? body.tank_type : '';
  let items = [];
  if (mode === 'verify') {
    items = (Array.isArray(body.items) ? body.items : []).slice(0, 8).map((it) => ({
      name: clean(it && it.name, 60),
      kind: KINDS.includes(it && it.kind) ? it.kind : 'fish',
      count: Math.min(999, Math.max(1, Math.round(Number(it && it.count) || 1))),
      alternatives: (Array.isArray(it && it.alternatives) ? it.alternatives : []).map((x) => clean(x, 60)).filter(Boolean).slice(0, 3)
    }));
    if (!items.length || items.length !== list.length) return json({ ok: false, error: 'bad_image' }, 400, origin);
  }
  // Names of what the person already keeps in this tank. Cleaned hard, because it goes into the prompt.
  const known = (Array.isArray(body.known) ? body.known : [])
    .filter((s) => typeof s === 'string')
    .map((s) => s.replace(/[^\p{L}\p{N} '.()\/-]/gu, '').trim().slice(0, 60))
    .filter(Boolean)
    .slice(0, 40);
  function buildParts(withRes) {
    const parts = [];
    list.forEach((data, i) => {
      if (mode === 'zoom' && list.length > 1) parts.push({ text: i === 0 ? 'Whole tank:' : 'Zoomed piece ' + i + ' of ' + (list.length - 1) + ':' });
      if (mode === 'verify') {
        const it = items[i];
        const tips = tipsFor([it.name].concat(it.alternatives));
        parts.push({ text: 'Entry ' + i + ': the first look called this "' + it.name + '"' + (it.alternatives.length ? ' (other guesses: ' + it.alternatives.join(', ') + ')' : '') +
          ', ' + it.count + ' seen. ' + (tips.length ? 'Tips for telling similar species apart: ' + tips.join(' ') : '') });
      }
      const part = { inline_data: { mime_type: mime, data } };
      if (withRes && mode === 'single') part.media_resolution = { level: 'MEDIA_RESOLUTION_ULTRA_HIGH' };
      if (withRes && mode === 'verify') part.media_resolution = { level: 'MEDIA_RESOLUTION_HIGH' };
      parts.push(part);
    });
    return parts;
  }
  const basePrompt = mode === 'verify' ? VERIFY_PROMPT : (mode === 'zoom' ? PROMPT + ' ' + ZOOM_NOTE : PROMPT);
  const nameCodes = tankType === 'Saltwater' ? ['s'] : tankType === 'Brackish' ? ['b', 'f'] : ['f'];
  const nameList = [];
  nameCodes.forEach((c) => (DB.nm && DB.nm[c] || []).forEach((n) => { if (nameList.indexOf(n) === -1) nameList.push(n); }));
  const promptText = basePrompt + (tankType ? ' ' + TYPE_NOTES[tankType] : '') + (known.length ? ' ' + KNOWN_NOTE(known) : '') +
    (mode !== 'verify' && nameList.length ? ' ' + NAMES_NOTE(nameList) : '');

  const primary = env.GEMINI_MODEL || DEFAULT_MODEL;
  const lead = mode === 'verify' ? (env.GEMINI_VERIFY_MODEL || VERIFY_MODEL) : primary;
  const models = [lead, primary, FALLBACK_MODEL, LAST_RESORT_MODEL].filter((m, i, all) => all.indexOf(m) === i);
  const started = Date.now();

  async function ask(model, withThinking, ms, withRes) {
    const generationConfig = { responseMimeType: 'application/json', responseSchema: mode === 'verify' ? VERIFY_SCHEMA : SCHEMA };
    if (withThinking) generationConfig.thinkingConfig = { thinkingLevel: 'low' };
    const payload = {
      systemInstruction: { parts: [{ text: INSTRUCTIONS }] },
      contents: [{ role: 'user', parts: [{ text: promptText }].concat(buildParts(withRes)) }],
      generationConfig
    };
    return fetch('https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(model) + ':generateContent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(ms)
    });
  }

  let upstream = null;
  const problems = [];
  let lastError = 'ai_busy';
  let lastStatus = 0;
  let usedModel = '';
  for (const model of models) {
    const left = TOTAL_BUDGET_MS - (Date.now() - started);
    if (left < 6000) break;
    const ms = Math.min(24000, left);
    let res = null;
    try {
      res = await ask(model, true, ms, true);
      // A model may not accept the per-image resolution or thinking settings: retry with fewer extras.
      if (res.status === 400) res = await ask(model, true, Math.max(4000, TOTAL_BUDGET_MS - (Date.now() - started)), false);
      if (res.status === 400) res = await ask(model, false, Math.max(4000, TOTAL_BUDGET_MS - (Date.now() - started)), false);
      if ((res.status === 503 || res.status === 429) && TOTAL_BUDGET_MS - (Date.now() - started) > 12000) {
        await new Promise((r) => setTimeout(r, 1200)); // one quick retry when Google says "busy"
        res = await ask(model, true, Math.min(20000, TOTAL_BUDGET_MS - (Date.now() - started)), true);
      }
    } catch (err) {
      const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
      problems.push(model + ': ' + (timedOut ? 'too slow' : 'could not reach Google'));
      lastError = 'ai_busy';
      lastStatus = 0;
      continue;
    }
    if (res.ok) { upstream = res; usedModel = model; break; }
    const busy = res.status === 429 || res.status === 503;
    problems.push(model + ': ' + (busy ? 'busy' : 'error ' + res.status));
    lastError = busy ? 'ai_busy' : 'ai_error';
    lastStatus = res.status;
  }
  if (!upstream) {
    return json({ ok: false, error: lastError, ai_status: lastStatus, ai_detail: problems.join('; ').slice(0, 200) }, 502, origin);
  }

  let data = null;
  try {
    data = await upstream.json();
    const text = data.candidates[0].content.parts.map((p) => p.text || '').join('');
    const parsedReply = JSON.parse(text);
    const result = mode === 'verify' ? { items: sanitizeVerify(parsedReply, items.length) } : sanitize(parsedReply);
    const u = data.usageMetadata || {};
    const usage = { input: Number(u.promptTokenCount) || 0, output: (Number(u.candidatesTokenCount) || 0) + (Number(u.thoughtsTokenCount) || 0) };
    return json(Object.assign({ ok: true, model: usedModel, usage, mode }, result), 200, origin);
  } catch (err) {
    const why = data && ((data.promptFeedback && data.promptFeedback.blockReason) || (data.candidates && data.candidates[0] && data.candidates[0].finishReason)) || String(err && err.message || err);
    return json({ ok: false, error: 'ai_error', ai_status: 200, ai_detail: 'bad reply: ' + String(why).slice(0, 120) }, 502, origin);
  }
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(origin) });

    if (request.method === 'GET' && url.pathname === '/') {
      return new Response('Schooled API is running (version 15: ' + (env.GEMINI_MODEL || DEFAULT_MODEL) + ', backup ' + FALLBACK_MODEL + ')', { headers: corsHeaders(origin) });
    }

    if (request.method === 'POST' && url.pathname === '/scan') {
      // Blocks other websites from using this Worker. It is not real security
      // (anyone can fake a header), so usage limits come in a later stage.
      if (!ALLOWED_ORIGINS.includes(origin)) return json({ ok: false, error: 'forbidden' }, 403, origin);
      return scan(request, env, origin);
    }

    return json({ ok: false, error: 'not_found' }, 404, origin);
  }
};
