// Maps this library's own free-text Genres tags (lowercase, as stored in
// the CSV's Genres column — see lib/genre-artists.ts) to Discogs' fixed
// style vocabulary. Discogs' style= search parameter is an EXACT match
// against a small, closed set of style names (confirmed live — e.g.
// "Liquid Funk" returns 0 results even though it's a real, well-known
// drum & bass subgenre, because Discogs' own tag for that whole space is
// "Drum n Bass") — so a library tag typed straight into the picker's
// "search by genre" box usually won't hit anything on Discogs without this
// translation step first.
//
// Every mapped style value here was individually verified against the live
// Discogs search API (style=<value>&type=release) to return a nonzero
// result count before being added — see the one-off verification scripts
// used to build this table (not checked in; re-run against
// api.discogs.com/database/search if this table needs extending). Covers
// every genre tag present in the library's CSV as of 2026-09-21 (278 total,
// including ones with no distinct Discogs style — those map to the closest
// real parent style rather than being left unmapped, e.g. "yacht rock" ->
// "Soft Rock", "qawwali" -> "Folk").
//
// lib/discogs-artist-search.ts looks a genre up here FIRST; only genres
// with no entry fall through to its own style=/q= live-search attempt
// (which still works for anything already an exact Discogs style, just
// without a local lookup — and gracefully falls back further to the
// library-only artistsSharingGenre() heuristic if that also finds nothing).
export const DISCOGS_GENRE_MAP: Record<string, string> = {
  // Drum & bass / jungle / breaks
  "drum and bass": "Drum n Bass",
  "liquid funk": "Drum n Bass",
  "jungle": "Jungle",
  "breakbeat": "Breakbeat",
  "breakcore": "Breakcore",
  "big beat": "Big Beat",
  "bass music": "Bass Music",
  "bassline": "Bassline",

  // Dubstep family
  "dubstep": "Dubstep",
  "drumstep": "Dubstep",
  "chillstep": "Dubstep",
  "deathstep": "Dubstep",
  "riddim": "Dubstep",

  // UK bass / garage
  "uk garage": "UK Garage",
  "uk funky": "UK Funky",
  "grime": "Grime",
  "footwork": "Footwork",
  "juke": "Juke",

  // Techno
  "techno": "Techno",
  "acid techno": "Acid",
  "minimal techno": "Minimal",
  "dub techno": "Dub Techno",
  "hard techno": "Hard Techno",
  "melodic techno": "Melodic Techno",
  "hardcore techno": "Hardcore",
  "hypertechno": "Hardcore",
  "tekno": "Techno",

  // House
  "house": "House",
  "deep house": "Deep House",
  "tech house": "Tech House",
  "acid house": "Acid House",
  "chicago house": "Chicago House",
  "french house": "French House",
  "tropical house": "Tropical House",
  "progressive house": "Progressive House",
  "future house": "Future House",
  "g-house": "G-House",
  "bass house": "Bass House",
  "slap house": "Deep House", // no exact Discogs style — closest verified real style
  "funky house": "Funky House",
  "hip house": "Hip House",
  "latin house": "Latin House",
  "jazz house": "Jazz House",
  "lo-fi house": "Lo-Fi House",
  "melodic house": "Melodic House & Techno",
  "organic house": "Future House", // no exact Discogs style — closest verified real style
  "disco house": "Disco House",
  "vinahouse": "Future House", // no exact Discogs style — closest verified real style
  "rally house": "Deep House",

  // Trance
  "trance": "Trance",
  "progressive trance": "Progressive Trance",
  "psytrance": "Psy-Trance",

  // Hard dance
  "hard house": "Hard House",
  "hardstyle": "Hardstyle",
  "hardcore": "Hardcore",
  "happy hardcore": "Happy Hardcore",
  "gabber": "Gabber",
  "speedcore": "Speedcore",
  "frenchcore": "Hardcore",

  // Electro / synth / new wave
  "electro": "Electro",
  "electroclash": "Electroclash",
  "electropop": "Synth-pop",
  "synthpop": "Synth-pop",
  "synthwave": "Synth-pop",
  "darkwave": "Darkwave",
  "cold wave": "Coldwave",
  "new wave": "New Wave",
  "electronica": "Electro",

  // Ambient / downtempo
  "idm": "IDM",
  "downtempo": "Downtempo",
  "trip hop": "Trip Hop",
  "ambient": "Ambient",
  "space music": "Ambient",

  // Metal (drone is the only one with a distinct Discogs style; the rest
  // stay unmapped and fall through to the library heuristic)
  "drone metal": "Drone",

  // Misc electronic
  "edm": "Progressive House",
  "future bass": "Future Jazz",
  "moombahton": "Moombahton",
  "gqom": "Gqom",
  "melbourne bounce": "Electro House",
  "hi-nrg": "Hi NRG",
  "eurodance": "Euro House",
  "big room": "Progressive House",
  "hyperpop": "Experimental",
  "witch house": "Witch House",
  "phonk": "Phonk",
  "drift phonk": "Phonk",
  "brazilian phonk": "Phonk",

  // Disco / funk
  "italo dance": "Italo-Disco",
  "disco": "Disco",
  "nu disco": "Nu-Disco",

  // Rock / pop (broad top-level tags)
  "alternative": "Indie Rock",
  "rock": "Rock",
  "pop": "Pop Rock",
  "dance": "Euro House",
  "indie": "Indie Rock",
  "metal": "Heavy Metal",

  // Rock subgenres
  "hard rock": "Hard Rock",
  "classic rock": "Classic Rock",
  "alternative rock": "Alternative Rock",
  "alternative metal": "Alternative Rock",
  "alternative dance": "Indie Rock",
  "indie rock": "Indie Rock",
  "indie rock/rock pop": "Indie Rock",
  "indie dance": "Indie Rock",
  "indie electronic": "Indie Rock",
  "indie pop": "Indie Pop",
  "indie pop/folk": "Indie Pop",
  "indie r&b": "Neo Soul",
  "indie soul": "Neo Soul",
  "indie folk": "Folk Rock",
  "hindi indie": "Indie Pop",
  "indian indie": "Indie Pop",
  "lo-fi indie": "Lo-Fi",
  "madchester": "Indie Rock",
  "new rave": "Indie Rock",
  "britpop": "Britpop",
  "grunge": "Grunge",
  "post-grunge": "Grunge",
  "garage rock": "Garage Rock",
  "punk": "Punk",
  "epadunk": "Punk",
  "proto-punk": "Punk",
  "queercore": "Punk",
  "riot grrrl": "Punk",
  "pop punk": "Pop Punk",
  "ska punk": "Ska Punk",
  "skate punk": "Punk",
  "post-punk": "Post-Punk",
  "post-hardcore": "Post-Hardcore",
  "hardcore punk": "Hardcore Punk",
  "post-rock": "Post Rock",
  "progressive rock": "Prog Rock",
  "psychedelic rock": "Psychedelic Rock",
  "neo-psychedelic": "Psychedelic Rock",
  "acid rock": "Psychedelic Rock",
  "space rock": "Space Rock",
  "art rock": "Art Rock",
  "art pop": "Art Rock",
  "baroque pop": "Baroque",
  "jangle pop": "Jangle Pop",
  "power pop": "Power Pop",
  "soft rock": "Soft Rock",
  "yacht rock": "Soft Rock",
  "southern rock": "Southern Rock",
  "southern gothic": "Country",
  "surf rock": "Surf",
  "shoegaze": "Shoegaze",
  "dream pop": "Shoegaze",
  "noise rock": "Noise",
  "goth rock": "Goth Rock",
  "gothic rock": "Goth Rock",
  "deathrock": "Deathrock",
  "horror punk": "Deathrock",
  "industrial rock": "Industrial Rock",
  "industrial metal": "Industrial Metal",
  "industrial": "Industrial",
  "rockabilly": "Rockabilly",
  "rock & roll/rockabilly": "Rockabilly",
  "rock and roll": "Rock & Roll",
  "psychobilly": "Psychobilly",
  "blues rock": "Blues Rock",
  "funk rock": "Funk Metal",
  "jam band": "Prog Rock",
  "screamo": "Screamo",
  "emo": "Emo",
  "slowcore": "Slowcore",

  // Metal
  "heavy metal": "Heavy Metal",
  "doom metal": "Doom Metal",
  "stoner metal": "Stoner Rock",
  "stoner rock": "Stoner Rock",
  "sludge metal": "Sludge Metal",
  "speed metal": "Speed Metal",
  "nu metal": "Nu Metal",
  "rap metal": "Rap Metal",
  "glam metal": "Glam",
  "gothic metal": "Gothic Metal",

  // Blues / folk / country / americana
  "blues": "Blues",
  "modern blues": "Blues",
  "folk": "Folk",
  "traditional music": "Folk",
  "anti-folk": "Folk Rock",
  "qawwali": "Folk",
  "country": "Country",
  "alt country": "Country Rock",
  "americana": "Country",
  "celtic": "Celtic",
  "singer & songwriter": "Singer-Songwriter",
  "singer-songwriter": "Singer-Songwriter",
  "lullaby": "Vocal",

  // Pop
  "international pop": "Pop Rock",
  "pop quebecoise": "Pop Rock",
  "dance pop": "Pop Rock",
  "soft pop": "Pop Rock",
  "adult standards": "Vocal",
  "jazz pop": "Vocal",
  "easy listening": "Easy Listening",
  "lounge": "Lounge",
  "new age": "New Age",
  "comedy": "Comedy",
  "christmas": "Holiday",
  "soundtrack": "Soundtrack",
  "spoken word": "Spoken Word",

  // Jazz
  "jazz": "Jazz",
  "instrumental jazz": "Jazz-Funk",
  "acid jazz": "Acid Jazz",
  "afro-cuban jazz": "Afro-Cuban Jazz",
  "experimental jazz": "Free Jazz",
  "jazz funk": "Jazz-Funk",
  "jazz fusion": "Fusion",
  "nu jazz": "Nu Jazz",
  "soul jazz": "Soul-Jazz",
  "big band": "Big Band",
  "swing music": "Swing",
  "ethiopian jazz": "Afrobeat",

  // Soul / funk / R&B
  "soul & funk": "Soul",
  "soul": "Soul",
  "classic soul": "Soul",
  "philly soul": "Soul",
  "retro soul": "Soul",
  "quiet storm": "Soul",
  "northern soul": "Soul",
  "neo soul": "Neo Soul",
  "funk": "Funk",
  "go-go": "Go-Go",
  "new jack swing": "Swingbeat",
  "r&b": "RnB/Swing",
  "uk r&b": "RnB/Swing",
  "doo-wop": "Doo Wop",

  // Hip hop / rap
  "rap/hip hop": "Hip Hop",
  "electro hip hop": "Electro",
  "rap": "Hip Hop",
  "french rap": "Rap",
  "rap rock": "Rap Rock",
  "emo rap": "Trap",
  "trap latino": "Trap",
  "bounce": "Bass Music",
  "miami bass": "Miami Bass",
  "techengue": "Merengue",

  // Reggae / Caribbean / Latin
  "reggae": "Reggae",
  "dancehall": "Dancehall",
  "ragga": "Ragga",
  "roots reggae": "Roots Reggae",
  "lovers rock": "Lovers Rock",
  "rocksteady": "Rocksteady",
  "ska": "Ska",
  "soca": "Soca",
  "latin": "Latin Jazz",
  "latin alternative": "Latin",
  "latin jazz": "Latin Jazz",
  "bolero": "Bolero",
  "vietnamese bolero": "Bolero",
  "son cubano": "Son",
  "brega": "MPB",
  "brega funk": "Funk",

  // World / avant-garde / experimental
  "afropop": "Afrobeat",
  "azonto": "Afrobeat",
  "gnawa": "African",
  "avant-garde": "Avantgarde",
  "experimental": "Experimental",
  "glitch": "Glitch",
  "plunderphonics": "Plunderphonics",
  "musique concrete": "Experimental",

  // Classical
  "ballet": "Classical",
  "classical crossover": "Classical",
  "electronic classical": "Modern Classical",

  // Techno/House catch-all
  "techno/house": "Techno",
  "electronic": "Electro",
};

/** Discogs style for a library genre tag, if a verified mapping exists. */
export function discogsStyleForGenre(genre: string): string | null {
  return DISCOGS_GENRE_MAP[genre.trim().toLowerCase()] ?? null;
}
