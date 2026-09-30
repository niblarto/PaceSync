// Main genre -> subgenre -> real library genre tags (lib/tracks-store.ts's
// Genres column, comma-separated, lowercase-normalized — see
// app/api/tracks/genres/route.ts's own parseGenres). Hand-built against the
// actual ~288 distinct tags found in this library (not a generic textbook
// taxonomy) so every branch in the Dashboard's "Remix by genre" picker maps
// onto real, selectable tracks. A tag not listed here falls into a
// synthetic "Other" main genre (see isMappedGenreTag below, used by
// /api/tracks/genres) rather than silently vanishing from the picker — so a
// newly-enriched tag this file hasn't been updated for is still visible and
// selectable, just uncategorized until this mapping is extended.
//
// Placement calls (genuinely ambiguous cases, picked by the tag's more
// common real-world usage):
//   - "disco"/"disco house"/"nu disco"/"post-disco"/"italo disco"/
//     "disco polo" -> Electronic > House (disco's direct lineage into 70s-
//     80s club culture and house music, not R&B/Soul, despite disco's own
//     soul/funk roots)
//   - "synthwave"/"synthpop"/"new wave"/"darkwave"/"coldwave" -> Electronic
//     > Synth (their electronic production identity, despite new wave's
//     rock/punk roots)
//   - "trip hop"/"downtempo"/"idm"/"glitch" -> Electronic > Ambient &
//     Experimental (studio/headphone electronic music, not the Bass Music
//     club-BPM branch)
//   - "krautrock"/"industrial"/"industrial rock"/"industrial metal"/
//     "noise rock" -> Rock > Industrial & Experimental (guitar-band
//     lineage even though several use heavily electronic production)
//   - "ska"/"ska punk"/"reggae"/"dub"/"dancehall"/"reggaeton" all sit under
//     one Reggae & Ska main genre — small enough in this library not to
//     warrant splitting further, and ska/reggae/dub share one continuous
//     lineage anyway
export const GENRE_HIERARCHY: Record<string, Record<string, string[]>> = {
  "Electronic": {
    "House": [
      "acid house", "bass house", "chicago house", "deep house", "disco",
      "disco house", "disco polo", "french house", "funky house",
      "future house", "g-house", "hip house", "italo disco", "jazz house",
      "latin house", "lo-fi house", "melodic house", "nu disco",
      "organic house", "post-disco", "progressive house", "rally house",
      "slap house", "stutter house", "tech house", "tribal house",
      "tropical house", "uk funky", "vinahouse",
    ],
    "Techno": [
      "acid techno", "dub techno", "hard techno", "hardcore techno",
      "hypertechno", "melodic techno", "minimal techno", "tekno", "techno",
      "techno/house",
    ],
    "Drum & Bass": [
      "bass music", "bassline", "breakbeat", "breakcore", "drift phonk",
      "drum and bass", "drum-and-bass", "drumstep", "dubstep", "footwork",
      "future bass", "jungle", "liquid funk", "miami bass", "phonk",
      "brazilian phonk", "riddim", "speedcore", "uk garage",
    ],
    "Trance & Hardstyle": [
      "gabber", "frenchcore", "hard house", "hardcore", "hardstyle",
      "happy hardcore", "progressive trance", "psytrance", "trance",
    ],
    "Synth": [
      "cold wave", "darkwave", "electroclash", "electropop",
      "hi-nrg", "italo dance", "neue deutsche welle", "new rave", "new wave",
      "synthpop", "synthwave",
    ],
    "Big Room & Pop-EDM": [
      "alternative dance", "big beat", "big room", "chillstep", "edm",
      "eurodance", "melbourne bounce", "moombahton", "witch house",
    ],
    "Ambient & Experimental": [
      "ambient", "downtempo", "electro", "electroacoustic",
      "electronic", "electronic classical", "electronica", "glitch", "idm",
      "space music", "trip hop",
    ],
  },
  "Rock": {
    "Classic & Hard Rock": [
      "classic rock", "hard rock", "rock", "rock & roll/rockabilly",
      "rock and roll", "rockabilly", "southern rock", "surf rock",
      "yacht rock",
    ],
    "Alternative & Indie": [
      "alternative", "alternative rock", "britpop", "indie", "indie rock",
      "indie rock/rock pop", "jangle pop", "madchester", "power pop",
    ],
    "Punk": [
      "folk punk", "hardcore punk", "horror punk", "pop punk", "proto-punk",
      "psychobilly", "punk", "queercore", "riot grrrl", "screamo",
      "ska punk", "skate punk",
    ],
    "Post-Punk & Goth": [
      "art rock", "deathrock", "glam rock", "gothic rock", "post-punk",
      "shoegaze",
    ],
    "Grunge & Post-Rock": [
      "emo", "grunge", "lo-fi indie", "noise rock", "post-grunge",
      "post-hardcore", "post-rock", "slowcore",
    ],
    "Psychedelic & Prog": [
      "acid rock", "krautrock", "neo-psychedelic", "progressive rock",
      "psychedelic rock", "space rock",
    ],
    "Blues & Roots Rock": [
      "blues", "blues rock", "funk rock", "garage rock", "jam band",
      "modern blues",
    ],
    "Industrial & Experimental": [
      "avant-garde", "industrial", "industrial metal",
      "industrial rock",
    ],
  },
  "Metal": {
    "Heavy & Classic Metal": [
      "glam metal", "groove metal", "heavy metal", "metal", "nu metal",
      "speed metal",
    ],
    "Extreme Metal": [
      "deathstep", "doom metal", "drone metal", "gothic metal",
      "sludge metal", "stoner metal", "stoner rock", "thrash metal",
    ],
    "Metal Crossover": [
      "alternative metal", "rap metal",
    ],
  },
  "Hip-Hop & Rap": {
    "Classic & Regional": [
      "east coast hip hop", "epadunk", "french rap", "hardcore hip hop",
      "hindi indie", "hip hop", "indian indie", "old school hip hop", "rap",
      "rap/hip hop",
    ],
    "Trap & Modern": [
      "electro hip hop", "emo rap", "grime", "uk grime",
    ],
    "Fusion & Alt Rap": [
      "rap rock",
    ],
  },
  "R&B & Soul": {
    "Classic Soul & Funk": [
      "classic soul", "doo-wop", "funk", "funk melody",
      "go-go", "jazz funk", "lovers rock", "new jack swing",
      "northern soul", "philly soul", "quiet storm", "retro soul", "soul",
      "soul & funk", "southern gothic",
    ],
    "Contemporary R&B": [
      "alternative r&b", "indie r&b", "indie soul", "neo soul", "r&b",
      "uk r&b",
    ],
  },
  "Jazz": {
    "Traditional": [
      "acid jazz", "afro-cuban jazz", "big band", "ethiopian jazz",
      "experimental jazz", "swing music",
    ],
    "Modern & Fusion": [
      "indie jazz", "instrumental jazz", "jazz", "jazz fusion", "jazz pop",
      "nu jazz", "soul jazz",
    ],
  },
  "Country & Folk": {
    "Country": [
      "alt country", "americana", "country",
    ],
    "Folk & Singer-Songwriter": [
      "anti-folk", "celtic", "celtic rock", "folk", "indie folk",
      "indie pop/folk", "singer & songwriter", "singer-songwriter",
      "traditional music",
    ],
  },
  "Pop": {
    "Mainstream & Dance Pop": [
      "art pop", "baroque pop", "dance", "dance pop", "international pop",
      "pop", "pop québécoise", "soft pop", "swedish pop",
    ],
    "Indie & Dream Pop": [
      "dream pop", "indie dance", "indie electronic", "indie pop",
    ],
    "Adult Contemporary": [
      "adult standards", "chamber music", "classical crossover",
      "easy listening", "lounge", "soft rock",
    ],
  },
  "Reggae & Ska": {
    "Reggae & Dub": [
      "dancehall", "dub", "ragga", "reggae", "reggaeton",
      "rocksteady", "roots reggae", "soca",
    ],
    "Ska": [
      "ska",
    ],
  },
  "Latin & World": {
    "Latin": [
      "bolero", "bounce", "brega", "brega funk", "latin", "latin alternative",
      "latin jazz", "son cubano", "techengue", "trap latino",
      "vietnamese bolero",
    ],
    "African & Afro-Fusion": [
      "african music", "afrobeat", "afropop", "azonto", "gnawa", "gqom",
    ],
    "Other Regional": [
      "lagu timur", "maluku", "qawwali",
    ],
  },
  "Experimental & Other": {
    "Avant-Garde": [
      "experimental", "musique concrète", "plunderphonics",
    ],
    "Other": [
      "ballet", "christmas", "comedy", "film scores", "films/games",
      "hyperpop", "lullaby", "new age", "score", "soundtrack", "spoken word",
    ],
  },
};

// Every tag mentioned in GENRE_HIERARCHY, lowercased — used by
// genreHierarchy() below to bucket anything NOT covered into a synthetic
// "Other" main genre, so an unmapped tag stays visible/selectable instead
// of silently disappearing.
const MAPPED_TAGS = new Set(
  Object.values(GENRE_HIERARCHY).flatMap(subgenres => Object.values(subgenres).flat()),
);

export function isMappedGenreTag(tag: string): boolean {
  return MAPPED_TAGS.has(tag.toLowerCase());
}
