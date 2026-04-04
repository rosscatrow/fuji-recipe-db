// Variables used by Scriptable.
// These must be at the very top of the file.
// icon-color: deep-green; icon-glyph: camera-retro;

/**
 * Fujifilm Recipe Matcher for Scriptable (iOS)
 *
 * Reads Fuji MakerNote EXIF from selected photos and matches
 * against a recipe database to identify which film simulation
 * recipe was used.
 *
 * Cameras: X-T5 (X-Trans V), X-T30 (X-Trans IV)
 * Author: Ross Sherwood
 */

// ── Configuration ──────────────────────────────────────────────
const RECIPE_DB_URL =
  "https://raw.githubusercontent.com/rosscatrow/fuji-recipe-db/main/recipes.json";
const CACHE_FILE = "fuji_recipes_cache.json";
const CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 1 day

// ── Decode tables ──────────────────────────────────────────────

const FILM_SIM_MAP = {
  0: "Provia",
  256: "Astia",
  272: "Pro Neg Hi",
  288: "Pro Neg Std",
  512: "Velvia",
  768: "Classic Chrome",
  769: "Classic Negative",
  770: "Eterna",
  771: "Eterna BB",
  1024: "Acros",
  1040: "Acros +Y",
  1056: "Acros +R",
  1072: "Acros +G",
  1280: "Monochrome",
  1281: "Monochrome +Y",
  1282: "Monochrome +R",
  1283: "Monochrome +G",
  1536: "Nostalgic Neg.",
  1792: "Reala Ace",
};

const COLOR_CHROME_MAP = { 0: "Off", 32: "Weak", 64: "Strong" };
const GRAIN_ROUGHNESS_MAP = { 0: "Off", 32: "Weak", 64: "Strong" };
const GRAIN_SIZE_MAP = { 16: "Small", 32: "Large" };

// Sharpness: raw → recipe scale
const SHARPNESS_MAP = {
  "-2": -4,
  "-1": -3,
  0: -2,
  1: -2,
  2: 0,
  3: 1,
  4: 2,
  5: 3,
  6: 4,
};

// Tone: raw → decoded value
const TONE_MAP = {
  48: -2,
  32: -2,
  16: -1,
  0: 0,
  "-16": 1,
  "-32": 2,
  "-48": 3,
  "-64": 4,
};

const DYNAMIC_RANGE_MAP = {
  0: "DR-Auto",
  1: "DR100",
  2: "DR200",
  3: "DR400",
  256: "DR-Auto",
};

const WB_MODE_MAP = {
  0: "Auto",
  1: "Auto", // Auto White Priority
  2: "Daylight",
  3: "Shade",
  4: "Fluorescent1",
  5: "Fluorescent2",
  6: "Fluorescent3",
  7: "Incandescent",
  10: "Underwater",
  11: "Custom",
  15: "Kelvin",
};

// ── EXIF / MakerNote Parser ────────────────────────────────────

/**
 * Minimal EXIF parser that extracts Fujifilm MakerNote tags
 * from raw JPEG data.
 */
class FujiExifParser {
  constructor(data) {
    // data is a Uint8Array of the JPEG file
    this.data = data;
    this.littleEndian = false; // TIFF byte order
    this.tiffOffset = 0;
    this.exifTags = {};
    this.makerNoteTags = {};
    this.isFuji = false;
    this.softwareTag = "";
  }

  /** Read 2 bytes */
  readU16(offset, le) {
    const d = this.data;
    if (le === undefined) le = this.littleEndian;
    return le
      ? d[offset] | (d[offset + 1] << 8)
      : (d[offset] << 8) | d[offset + 1];
  }

  /** Read 4 bytes unsigned */
  readU32(offset, le) {
    const d = this.data;
    if (le === undefined) le = this.littleEndian;
    return le
      ? d[offset] |
          (d[offset + 1] << 8) |
          (d[offset + 2] << 16) |
          ((d[offset + 3] << 24) >>> 0)
      : ((d[offset] << 24) >>> 0) |
          (d[offset + 1] << 16) |
          (d[offset + 2] << 8) |
          d[offset + 3];
  }

  /** Read signed 16-bit */
  readS16(offset, le) {
    let v = this.readU16(offset, le);
    if (v >= 0x8000) v -= 0x10000;
    return v;
  }

  /** Read signed 32-bit */
  readS32(offset, le) {
    let v = this.readU32(offset, le);
    if (v >= 0x80000000) v -= 0x100000000;
    return v;
  }

  /** Read an ASCII string */
  readString(offset, length) {
    let s = "";
    for (let i = 0; i < length; i++) {
      const c = this.data[offset + i];
      if (c === 0) break;
      s += String.fromCharCode(c);
    }
    return s;
  }

  /** Get the value of an IFD entry given its components */
  getIFDValue(entryOffset, type, count, le) {
    const valueSize = this._typeSize(type) * count;
    let valueOffset;
    if (valueSize <= 4) {
      valueOffset = entryOffset + 8;
    } else {
      valueOffset = this.tiffOffset + this.readU32(entryOffset + 8, le);
    }

    if (type === 2) {
      // ASCII
      return this.readString(valueOffset, count);
    }
    if (count === 1) {
      return this._readTyped(valueOffset, type, le);
    }
    const values = [];
    const sz = this._typeSize(type);
    for (let i = 0; i < count; i++) {
      values.push(this._readTyped(valueOffset + i * sz, type, le));
    }
    return values;
  }

  _typeSize(type) {
    switch (type) {
      case 1:
      case 2:
      case 7:
        return 1; // BYTE, ASCII, UNDEFINED
      case 3:
      case 8:
        return 2; // SHORT, SSHORT
      case 4:
      case 9:
        return 4; // LONG, SLONG
      case 5:
      case 10:
        return 8; // RATIONAL, SRATIONAL
      default:
        return 1;
    }
  }

  _readTyped(offset, type, le) {
    switch (type) {
      case 1:
      case 7:
        return this.data[offset]; // BYTE/UNDEFINED
      case 3:
        return this.readU16(offset, le); // SHORT
      case 4:
        return this.readU32(offset, le); // LONG
      case 8:
        return this.readS16(offset, le); // SSHORT
      case 9:
        return this.readS32(offset, le); // SLONG
      case 5: {
        // RATIONAL
        const num = this.readU32(offset, le);
        const den = this.readU32(offset + 4, le);
        return den ? num / den : 0;
      }
      case 10: {
        // SRATIONAL
        const num = this.readS32(offset, le);
        const den = this.readS32(offset + 4, le);
        return den ? num / den : 0;
      }
      default:
        return this.data[offset];
    }
  }

  /** Find APP1 EXIF segment in JPEG */
  findApp1() {
    let pos = 0;
    // SOI marker
    if (this.data[0] !== 0xff || this.data[1] !== 0xd8) return -1;
    pos = 2;
    while (pos < this.data.length - 4) {
      if (this.data[pos] !== 0xff) return -1;
      const marker = this.data[pos + 1];
      if (marker === 0xe1) {
        // APP1
        const header = this.readString(pos + 4, 4);
        if (header === "Exif") return pos;
      }
      const segLen = this.readU16(pos + 2, false);
      pos += 2 + segLen;
    }
    return -1;
  }

  /** Parse IFD and return object of {tag: {type, count, value}} */
  parseIFD(ifdOffset, le) {
    const count = this.readU16(ifdOffset, le);
    const entries = {};
    for (let i = 0; i < count; i++) {
      const entryOff = ifdOffset + 2 + i * 12;
      const tag = this.readU16(entryOff, le);
      const type = this.readU16(entryOff + 2, le);
      const cnt = this.readU32(entryOff + 4, le);
      const value = this.getIFDValue(entryOff, type, cnt, le);
      entries[tag] = { type, count: cnt, value };
    }
    // Next IFD offset
    const nextOff = this.readU32(ifdOffset + 2 + count * 12, le);
    entries._next = nextOff;
    return entries;
  }

  /** Main parse entry */
  parse() {
    const app1Pos = this.findApp1();
    if (app1Pos < 0) return false;

    // TIFF header starts after "Exif\0\0"
    this.tiffOffset = app1Pos + 4 + 6; // 4 for marker+length preamble area... let me recalc
    // APP1 structure: FF E1 [len:2] "Exif\0\0" [TIFF header]
    this.tiffOffset = app1Pos + 2 + 2 + 6; // marker(2) + length(2) + "Exif\0\0"(6)

    // TIFF byte order
    const bom = this.readU16(this.tiffOffset, false);
    this.littleEndian = bom === 0x4949; // "II"

    // Verify TIFF magic
    const magic = this.readU16(this.tiffOffset + 2, this.littleEndian);
    if (magic !== 42) return false;

    // IFD0 offset
    const ifd0Off =
      this.tiffOffset +
      this.readU32(this.tiffOffset + 4, this.littleEndian);

    // Parse IFD0
    const ifd0 = this.parseIFD(ifd0Off, this.littleEndian);

    // Software tag (0x0131)
    if (ifd0[0x0131]) {
      this.softwareTag = String(ifd0[0x0131].value).trim();
    }

    // Make tag (0x010f)
    if (ifd0[0x010f]) {
      const make = String(ifd0[0x010f].value).trim().toUpperCase();
      this.isFuji =
        make.includes("FUJI") || make.includes("FUJIFILM");
    }

    // Find EXIF sub-IFD (tag 0x8769)
    if (!ifd0[0x8769]) return false;
    const exifIFDOff =
      this.tiffOffset + ifd0[0x8769].value;
    const exifIFD = this.parseIFD(exifIFDOff, this.littleEndian);
    this.exifTags = exifIFD;

    // Find MakerNote (tag 0x927c)
    if (!exifIFD[0x927c]) return false;
    const mnEntry = exifIFD[0x927c];

    // Locate raw MakerNote data offset
    const mnSize = this._typeSize(mnEntry.type) * mnEntry.count;
    let mnDataOffset;
    if (mnSize <= 4) {
      // Value is inline (unlikely for MakerNote)
      return false;
    }
    // For MakerNote the entryOffset isn't easily recoverable, so let's
    // search for the FUJIFILM header in the data near the EXIF area.
    mnDataOffset = this._findFujiMakerNote();
    if (mnDataOffset < 0) return false;

    this._parseFujiMakerNote(mnDataOffset);
    return true;
  }

  /** Scan for FUJIFILM MakerNote header */
  _findFujiMakerNote() {
    const sig = [0x46, 0x55, 0x4a, 0x49, 0x46, 0x49, 0x4c, 0x4d]; // "FUJIFILM"
    const end = Math.min(this.data.length - 12, this.data.length);
    for (let i = this.tiffOffset; i < end; i++) {
      let match = true;
      for (let j = 0; j < 8; j++) {
        if (this.data[i + j] !== sig[j]) {
          match = false;
          break;
        }
      }
      if (match) return i;
    }
    return -1;
  }

  /** Parse Fujifilm MakerNote IFD (little-endian, offsets relative to MN start) */
  _parseFujiMakerNote(mnStart) {
    // Fuji MakerNote: "FUJIFILM" (8 bytes) + version/offset (4 bytes LE)
    // The offset at bytes 8-11 points to the IFD relative to mnStart
    const ifdRelOffset = this.readU32(mnStart + 8, true);
    const ifdAbs = mnStart + ifdRelOffset;

    const count = this.readU16(ifdAbs, true);
    for (let i = 0; i < count; i++) {
      const entryOff = ifdAbs + 2 + i * 12;
      if (entryOff + 12 > this.data.length) break;
      const tag = this.readU16(entryOff, true);
      const type = this.readU16(entryOff + 2, true);
      const cnt = this.readU32(entryOff + 4, true);

      const valueSize = this._typeSize(type) * cnt;
      let valueOffset;
      if (valueSize <= 4) {
        valueOffset = entryOff + 8;
      } else {
        // Offset relative to mnStart
        const relOff = this.readU32(entryOff + 8, true);
        valueOffset = mnStart + relOff;
      }

      if (valueOffset + valueSize > this.data.length) continue;

      let value;
      if (type === 2) {
        value = this.readString(valueOffset, cnt);
      } else if (cnt === 1) {
        value = this._readTyped(valueOffset, type, true);
      } else {
        const sz = this._typeSize(type);
        value = [];
        for (let k = 0; k < cnt; k++) {
          value.push(this._readTyped(valueOffset + k * sz, type, true));
        }
      }
      this.makerNoteTags[tag] = value;
    }
  }
}

// ── Decode extracted tags into recipe-scale values ─────────────

function decodeTone(raw) {
  if (raw === undefined || raw === null) return null;
  // Check known whole-stop values
  if (TONE_MAP[String(raw)] !== undefined) return TONE_MAP[String(raw)];
  // Try to calculate: raw / -16 gives whole stops from 0
  // For half-stop interpolation:
  const approx = -(raw / 16);
  const rounded = Math.round(approx * 2) / 2; // round to nearest 0.5
  return rounded;
}

function decodeSharpness(raw) {
  if (raw === undefined || raw === null) return null;
  if (SHARPNESS_MAP[String(raw)] !== undefined) return SHARPNESS_MAP[String(raw)];
  return null;
}

function decodeNoiseReduction(raw) {
  if (raw === undefined || raw === null) return null;
  if (raw === 736) return -4;
  // Approximate: 736 maps to -4. Fuji seems to use 64 per step above baseline
  // 736 = 768 - 32? Unknown mapping for other values.
  return `unknown(${raw})`;
}

function decodeClarity(raw) {
  if (raw === undefined || raw === null) return null;
  return raw / 1000;
}

function decodeWBFineTune(rawArray) {
  if (!rawArray || !Array.isArray(rawArray) || rawArray.length < 2)
    return { red: 0, blue: 0 };
  return {
    red: rawArray[0] / 20,
    blue: rawArray[1] / 20,
  };
}

function decodeWhiteBalance(mnTags) {
  // Tag 0x1002 = WhiteBalance mode
  const wbMode = mnTags[0x1002];
  if (wbMode === undefined || wbMode === null) return null;

  const modeName = WB_MODE_MAP[wbMode] || `Mode${wbMode}`;

  if (modeName === "Kelvin" || wbMode === 15) {
    // Read color temperature from tag 0x1005
    const kelvin = mnTags[0x1005];
    if (kelvin) return `${kelvin}K`;
    return "Kelvin";
  }
  return modeName;
}

function decodeDynamicRange(raw) {
  if (raw === undefined || raw === null) return null;
  return DYNAMIC_RANGE_MAP[raw] || `DR?(${raw})`;
}

function extractRecipeFields(parser) {
  const mn = parser.makerNoteTags;
  const fields = {};

  // Film simulation (0x1401)
  if (mn[0x1401] !== undefined) {
    const raw = mn[0x1401];
    fields.film_simulation = FILM_SIM_MAP[raw] || `Unknown(${raw})`;
    fields._raw_film_sim = raw;
  }

  // Highlight tone (0x1041)
  if (mn[0x1041] !== undefined) {
    fields.highlight_tone = decodeTone(mn[0x1041]);
    fields._raw_highlight = mn[0x1041];
  }

  // Shadow tone (0x1040)
  if (mn[0x1040] !== undefined) {
    fields.shadow_tone = decodeTone(mn[0x1040]);
    fields._raw_shadow = mn[0x1040];
  }

  // Color Chrome Effect (0x1048)
  if (mn[0x1048] !== undefined) {
    fields.color_chrome =
      COLOR_CHROME_MAP[mn[0x1048]] || `Unknown(${mn[0x1048]})`;
  }

  // Color Chrome FX Blue (0x104e)
  if (mn[0x104e] !== undefined) {
    fields.color_chrome_fx_blue =
      COLOR_CHROME_MAP[mn[0x104e]] || `Unknown(${mn[0x104e]})`;
  }

  // Grain Roughness (0x1047)
  if (mn[0x1047] !== undefined) {
    fields.grain_roughness =
      GRAIN_ROUGHNESS_MAP[mn[0x1047]] || `Unknown(${mn[0x1047]})`;
  }

  // Grain Size (0x104c)
  if (mn[0x104c] !== undefined) {
    fields.grain_size =
      GRAIN_SIZE_MAP[mn[0x104c]] || `Unknown(${mn[0x104c]})`;
  }

  // Sharpness (0x1001)
  if (mn[0x1001] !== undefined) {
    fields.sharpness = decodeSharpness(mn[0x1001]);
    fields._raw_sharpness = mn[0x1001];
  }

  // Noise Reduction (0x100e)
  if (mn[0x100e] !== undefined) {
    fields.noise_reduction = decodeNoiseReduction(mn[0x100e]);
    fields._raw_nr = mn[0x100e];
  }

  // Clarity (0x100f)
  if (mn[0x100f] !== undefined) {
    fields.clarity = decodeClarity(mn[0x100f]);
  }

  // White Balance
  fields.white_balance = decodeWhiteBalance(mn);

  // WB Fine Tune (0x100a)
  if (mn[0x100a] !== undefined) {
    const ft = decodeWBFineTune(
      Array.isArray(mn[0x100a]) ? mn[0x100a] : [mn[0x100a], 0]
    );
    fields.wb_red_shift = ft.red;
    fields.wb_blue_shift = ft.blue;
  }

  // Dynamic Range (0x1400)
  if (mn[0x1400] !== undefined) {
    fields.dynamic_range = decodeDynamicRange(mn[0x1400]);
  }

  return fields;
}

// ── Matching Engine ────────────────────────────────────────────

const MATCH_FIELDS = [
  "film_simulation",
  "highlight_tone",
  "shadow_tone",
  "color_chrome",
  "color_chrome_fx_blue",
  "grain_roughness",
  "grain_size",
  "sharpness",
  "noise_reduction",
  "clarity",
  "white_balance",
  "wb_red_shift",
  "wb_blue_shift",
  "dynamic_range",
];

function compareField(extracted, recipe, fieldName) {
  const ev = extracted[fieldName];
  const rv = recipe[fieldName];

  // If extracted value is missing/null, skip (not comparable)
  if (ev === null || ev === undefined) return null;
  // If recipe value is null (e.g., color for B&W), skip
  if (rv === null || rv === undefined) return null;

  // String comparison (film sim, color chrome, grain, WB, DR)
  if (typeof ev === "string" || typeof rv === "string") {
    return String(ev).toLowerCase() === String(rv).toLowerCase();
  }

  // Numeric comparison with tolerance
  // For sharpness: allow ±1 tolerance
  if (fieldName === "sharpness") {
    return Math.abs(ev - rv) <= 1;
  }

  // For tones: allow ±0.5 tolerance (half-stop rounding)
  if (fieldName === "highlight_tone" || fieldName === "shadow_tone") {
    return Math.abs(ev - rv) <= 0.5;
  }

  // Exact numeric match for everything else
  return ev === rv;
}

function matchRecipe(extracted, recipe) {
  let matched = 0;
  let total = 0;
  const mismatches = [];

  for (const field of MATCH_FIELDS) {
    const result = compareField(extracted, recipe, field);
    if (result === null) continue; // field not comparable
    total++;
    if (result) {
      matched++;
    } else {
      mismatches.push({
        field,
        extracted: extracted[field],
        recipe: recipe[field],
      });
    }
  }

  return {
    name: recipe.name,
    source_url: recipe.source_url || null,
    matched,
    total,
    score: total > 0 ? matched / total : 0,
    mismatches,
  };
}

function findBestMatch(extracted, recipes) {
  let results = recipes.map((r) => matchRecipe(extracted, r));
  results.sort((a, b) => b.score - a.score || b.matched - a.matched);
  return results;
}

// ── Recipe Database Cache ──────────────────────────────────────

async function loadRecipes(forceRefresh) {
  const fm = FileManager.iCloud();
  const cacheDir = fm.joinPath(fm.documentsDirectory(), "FujiMatcher");
  if (!fm.fileExists(cacheDir)) fm.createDirectory(cacheDir);
  const cachePath = fm.joinPath(cacheDir, CACHE_FILE);

  let useCache = false;
  if (!forceRefresh && fm.fileExists(cachePath)) {
    const mod = fm.modificationDate(cachePath);
    if (mod && Date.now() - mod.getTime() < CACHE_MAX_AGE_MS) {
      useCache = true;
    }
  }

  if (useCache) {
    await fm.downloadFileFromiCloud(cachePath);
    const raw = fm.readString(cachePath);
    try {
      const db = JSON.parse(raw);
      return db.recipes || db;
    } catch (e) {
      // Cache corrupt, re-fetch
    }
  }

  // Fetch fresh
  const req = new Request(RECIPE_DB_URL);
  const json = await req.loadJSON();
  // Cache it
  fm.writeString(cachePath, JSON.stringify(json));
  return json.recipes || json;
}

// ── Photo Selection & Processing ───────────────────────────────

async function selectPhotos() {
  // Scriptable doesn't have a multi-photo picker built in,
  // but we can use Photos API to get recently selected or prompt.
  // We'll use the Share Sheet input if available, otherwise prompt.
  let photos = [];

  if (args.images && args.images.length > 0) {
    // Share Sheet: images passed in
    return args.images;
  }

  // Otherwise prompt user to pick from recent photos
  // Scriptable's Photos.fromLibrary() picks one image at a time
  const alert = new Alert();
  alert.title = "Fuji Recipe Matcher";
  alert.message = "How many photos to analyze?";
  alert.addAction("1 photo");
  alert.addAction("3 photos");
  alert.addAction("5 photos");
  alert.addAction("10 photos");
  alert.addCancelAction("Cancel");
  const choice = await alert.present();
  if (choice === -1) return [];
  const counts = [1, 3, 5, 10];
  const count = counts[choice];

  for (let i = 0; i < count; i++) {
    try {
      const img = await Photos.fromLibrary();
      if (img) photos.push(img);
    } catch (e) {
      break; // User cancelled
    }
  }
  return photos;
}

/**
 * Get the raw JPEG data for an Image.
 * Scriptable's Image.toPNG() and Data.fromPNG() exist, but we need JPEG data.
 * We use Photos.latestPhotos() or the share sheet to get the photo asset,
 * then read EXIF from the JPEG representation.
 */
function imageToJPEGData(image) {
  // Convert Image to JPEG Data
  return Data.fromJPEG(image);
}

// ── Results Formatting ─────────────────────────────────────────

function formatResult(index, result, extracted) {
  const { name, score, matched, total, mismatches, source_url } =
    result;
  const pct = Math.round(score * 100);
  let icon, label;

  if (pct >= 80) {
    icon = "✅";
    label = `${name} — ${pct}% match (${matched}/${total} fields)`;
  } else if (pct >= 50) {
    icon = "⚠️";
    label = `Likely: ${name} — ${pct}% (${matched}/${total})`;
  } else {
    icon = "❌";
    label = `Best guess: ${name} — ${pct}% (${matched}/${total})`;
  }

  let lines = [`📷 Photo ${index + 1}`, `${icon} ${label}`];

  if (mismatches.length > 0 && pct >= 50) {
    const mmStrs = mismatches.map(
      (m) => `${m.field}: photo=${m.extracted} vs recipe=${m.recipe}`
    );
    lines.push(`   Mismatched: ${mmStrs.join(", ")}`);
  }

  if (pct < 50) {
    // Show extracted settings summary
    const fs = extracted.film_simulation || "?";
    const ht = extracted.highlight_tone ?? "?";
    const st = extracted.shadow_tone ?? "?";
    const cc = extracted.color_chrome || "?";
    const sh = extracted.sharpness ?? "?";
    const nr = extracted.noise_reduction ?? "?";
    const wb = extracted.white_balance || "?";
    const wbr = extracted.wb_red_shift ?? 0;
    const wbb = extracted.wb_blue_shift ?? 0;
    const dr = extracted.dynamic_range || "?";
    lines.push(
      `   Extracted: ${fs}, H:${ht}, S:${st}, CCE:${cc}, Sharp:${sh}, NR:${nr}, WB:${wb} R${wbr >= 0 ? "+" : ""}${wbr}/B${wbb >= 0 ? "+" : ""}${wbb}, ${dr}`
    );
  }

  if (source_url && pct >= 50) {
    lines.push(`   🔗 ${source_url}`);
  }

  return lines.join("\n");
}

function formatNoMakerNote(index, software) {
  let msg = `📷 Photo ${index + 1}\n🚫 MakerNotes stripped — no match possible.`;
  if (software) msg += `\n   Modified by: ${software}`;
  return msg;
}

function formatNotFuji(index) {
  return `📷 Photo ${index + 1}\n🚫 Not a Fujifilm photo — skipping.`;
}

// ── Main ───────────────────────────────────────────────────────

async function main() {
  try {
    // Load recipes
    const recipes = await loadRecipes(false);
    if (!recipes || recipes.length === 0) {
      const a = new Alert();
      a.title = "Error";
      a.message = "Could not load recipe database.";
      a.addAction("OK");
      await a.present();
      return;
    }

    // Select photos
    const images = await selectPhotos();
    if (images.length === 0) {
      return;
    }

    const results = [];

    for (let i = 0; i < images.length; i++) {
      const image = images[i];

      // Get JPEG data
      const jpegData = imageToJPEGData(image);
      if (!jpegData) {
        results.push(`📷 Photo ${i + 1}\n🚫 Could not read image data.`);
        continue;
      }

      const bytes = new Uint8Array(jpegData.getBytes());
      const parser = new FujiExifParser(bytes);
      const parsed = parser.parse();

      if (!parsed) {
        // Could be non-EXIF, non-Fuji, or MakerNotes stripped
        if (parser.softwareTag) {
          results.push(formatNoMakerNote(i, parser.softwareTag));
        } else {
          results.push(formatNotFuji(i));
        }
        continue;
      }

      if (!parser.isFuji) {
        results.push(formatNotFuji(i));
        continue;
      }

      if (Object.keys(parser.makerNoteTags).length === 0) {
        results.push(formatNoMakerNote(i, parser.softwareTag));
        continue;
      }

      // Extract recipe fields
      const extracted = extractRecipeFields(parser);

      // Match
      const ranked = findBestMatch(extracted, recipes);
      const best = ranked[0];

      if (best && best.total > 0) {
        results.push(formatResult(i, best, extracted));
      } else {
        results.push(
          `📷 Photo ${i + 1}\n❓ Could not extract enough fields to match.`
        );
      }
    }

    // Present results
    if (results.length === 1) {
      const a = new Alert();
      a.title = "Recipe Match";
      a.message = results[0];
      a.addAction("OK");
      await a.present();
    } else {
      // Use a WebView for multiple results
      const html = `
<!DOCTYPE html>
<html>
<head>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, sans-serif;
    background: #1a1a1a; color: #e0e0e0;
    padding: 20px; padding-top: 50px;
  }
  h1 { font-size: 22px; margin-bottom: 16px; color: #fff; }
  .card {
    background: #2a2a2a; border-radius: 12px;
    padding: 16px; margin-bottom: 12px;
    border-left: 4px solid #444;
    white-space: pre-wrap; font-size: 14px;
    line-height: 1.5;
  }
  .card.match-high { border-left-color: #34c759; }
  .card.match-med  { border-left-color: #ff9f0a; }
  .card.match-low  { border-left-color: #ff453a; }
  .card.no-match   { border-left-color: #636366; }
  .summary {
    font-size: 13px; color: #8e8e93;
    margin-top: 16px; text-align: center;
  }
  a { color: #64d2ff; }
</style>
</head>
<body>
<h1>🎞️ Recipe Matcher</h1>
${results
  .map((r) => {
    let cls = "no-match";
    if (r.includes("✅")) cls = "match-high";
    else if (r.includes("⚠️")) cls = "match-med";
    else if (r.includes("❌")) cls = "match-low";
    // Turn URLs into links
    const linked = r.replace(
      /(https?:\/\/[^\s]+)/g,
      '<a href="$1">$1</a>'
    );
    return `<div class="card ${cls}">${linked}</div>`;
  })
  .join("\n")}
<div class="summary">${images.length} photo${images.length !== 1 ? "s" : ""} analyzed against ${recipes.length} recipes</div>
</body>
</html>`;

      const wv = new WebView();
      await wv.loadHTML(html);
      await wv.present(true);
    }
  } catch (err) {
    const a = new Alert();
    a.title = "Error";
    a.message = String(err);
    a.addAction("OK");
    await a.present();
  }
}

await main();
Script.complete();
