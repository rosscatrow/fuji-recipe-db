# fuji-recipe-db — Project Instructions

## What this project does

This tool automatically identifies which Fujifilm film simulation recipe was used to shoot a JPEG, then writes the recipe name into the photo's metadata so you can reference it later — even after editing.

Fujifilm cameras store detailed shooting settings (film simulation, tone curves, grain, white balance, etc.) in a proprietary MakerNote embedded in the JPEG's EXIF data. These settings correspond to "recipes" — named combinations of in-camera settings that produce a specific look. The problem is that MakerNote data is destroyed when a photo is edited in most apps. If you don't identify the recipe before editing, that information is gone.

This project solves that by reading the MakerNote immediately after import, matching the settings against a recipe database, and writing the recipe name into IPTC/XMP metadata (likely as a keyword) that persists through editing.

## Hardware and constraints

- **Cameras:** Fujifilm X-T5 (X-Trans V sensor, full field support) and X-T30 (X-Trans IV sensor, partial support — missing Color Chrome FX Blue, Grain Size, and Clarity fields)
- **No Mac.** The entire workflow runs on iOS/iPadOS devices. There is no Mac available for ExifTool or shell scripts.
- **Tools available:** Scriptable (iOS JavaScript automation), iOS Shortcuts, and third-party metadata apps from the App Store.

## Repository structure

```
fuji-recipe-db/
├── recipes.json                    # The recipe database (13 recipes)
├── scriptable/
│   └── FujiRecipeMatcher.js        # Scriptable script — MakerNote parser + recipe matcher
├── README.md                       # Project overview (needs updating — see issue #5)
└── INSTRUCTIONS.md                 # This file
```

## How the recipe database works

`recipes.json` contains a top-level `recipes` array. Each recipe has these fingerprint fields:

| Field                  | Example value     | MakerNote tag   |
|------------------------|-------------------|-----------------|
| `film_simulation`      | `"Classic Chrome"`| `0x1001`        |
| `highlight_tone`       | `1.5`             | `0x1040`        |
| `shadow_tone`          | `2.5`             | `0x1041`        |
| `color`                | `-2`              | `0x1049`        |
| `color_chrome`         | `"Strong"`        | `0x1048`        |
| `color_chrome_fx_blue` | `"Off"`           | `0x104e`        |
| `grain_roughness`      | `"Strong"`        | `0x104c` (high) |
| `grain_size`           | `"Small"`         | `0x104c` (low)  |
| `sharpness`            | `-3`              | `0x1001`        |
| `noise_reduction`      | `-4`              | `0x100b`        |
| `clarity`              | `0`               | `0x100f` (approx)|
| `white_balance`        | `"Auto"`          | `0x1002`        |
| `wb_red_shift`         | `3`               | `0x100a` (R)    |
| `wb_blue_shift`        | `-3`              | `0x100a` (B)    |
| `dynamic_range`        | `"DR400"`         | `0x1400`        |

The matching algorithm compares each field, allows small tolerances for sharpness (±1) and tone values (±0.5), and scores as `matches / available_fields`. Fields missing from the MakerNote (common on the X-T30) are skipped rather than penalized.

## How the Scriptable script works

`scriptable/FujiRecipeMatcher.js` does the following:

1. Accepts a JPEG image (via the photo picker or Share Sheet)
2. Parses the raw JPEG bytes to locate the EXIF APP1 segment
3. Finds the Fujifilm MakerNote IFD by scanning for the `FUJIFILM` header
4. Reads individual MakerNote tags and decodes them using lookup tables
5. Fetches `recipes.json` from GitHub (cached locally for 24 hours)
6. Scores the extracted settings against every recipe in the database
7. Displays the best match with a confidence indicator

The script currently **reads only** — it does not write any metadata back to the file. That capability is tracked in issue #3.

## Current status and open issues

The Scriptable script works for single photos, but there are several gaps before this is a usable daily-driver tool:

### Issue #6 — Validate MakerNote preservation through iOS photo pipeline (DO THIS FIRST)
The entire project depends on MakerNotes being readable after import. We need to test whether MakerNote data survives:
- SD card → iOS Photos import
- SD card → Files.app copy
- AirDrop transfer
- iCloud Photo Library sync

If Photos strips MakerNotes on import, we must process files from Files.app/SD card before they enter the photo library. This determines the architecture for everything else.

**How to test:** Import a JPEG from the X-T5 SD card into Photos. Run `FujiRecipeMatcher.js` on it. If it finds the MakerNote and matches a recipe, that path works. Repeat via Files.app. Try the X-T30 too.

### Issue #1 — Research iOS metadata write-back options
Can Scriptable write IPTC keywords to a JPEG? Or do we need a third-party app? The target field is most likely `IPTC:Keywords` since Apple Photos reads it on import. Some iOS apps (Metapho, Exif Metadata Editor & IPTC, ImagExif 2) support keyword editing — we need to find one that offers Shortcuts actions for automation.

### Issue #2 — Implement Shortcuts-based batch photo input
The single-photo picker is too slow. We need an iOS Shortcuts workflow that selects multiple photos and passes them to Scriptable. Key question: does Shortcuts pass original file bytes or re-encoded images? If it re-encodes, MakerNotes are gone and we need a different approach (e.g. processing from Files.app).

### Issue #3 — Add metadata write-back to the Scriptable script
Once we know the write-back method (from #1), extend the script to write the matched recipe name into the photo's metadata. The recipe name should be written as a keyword with a prefix like `recipe:Balloo Astia` so it's distinguishable from other keywords.

### Issue #4 — Design the end-to-end import workflow
Document the complete pipeline: SD card → import → match → tag → ready to edit. Identify every step, which apps are involved, what's automated vs. manual, and how long it takes.

### Issue #5 — Update README
Rewrite the README to reflect the full project vision and setup instructions.

## Suggested order of work

```
#6 (MakerNote validation)
 ↓
#1 (write-back research)  +  #2 (batch input)
 ↓                            ↓
#3 (implement write-back) ←───┘
 ↓
#4 (end-to-end workflow design)
 ↓
#5 (README update)
```

Issues #1 and #2 can be worked in parallel since they're independent research tasks. Issue #3 depends on both. Issue #4 ties it all together, and #5 documents the result.

## Key technical decisions still to be made

1. **Where to process files — Photos or Files?** Depends on #6. If MakerNotes survive Photos import, we can work within the Photos library. If not, we process from Files.app before importing.

2. **How to write metadata back.** Depends on #1. Options range from Scriptable writing bytes directly (complex but fully automated) to using a third-party app's Shortcuts actions (simpler but adds a dependency).

3. **What metadata field to use.** Likely `IPTC:Keywords` since it's the most widely supported and Apple Photos reads it. Alternative: `XMP-dc:Subject` (equivalent to keywords in XMP) or `XMP-dc:Description` (less standard but more visible in some apps).

4. **Keyword format.** Proposed: `recipe:Recipe Name` (e.g. `recipe:Balloo Astia`). This namespaces the recipe keyword so it doesn't collide with other keywords you might add. Could also add supplementary keywords like `filmsim:Classic Chrome` or `confidence:92%`.

## Adding new recipes

Add entries to the `recipes` array in `recipes.json`. Each recipe needs at minimum: `name`, `film_simulation`, `highlight_tone`, `shadow_tone`, and `sharpness`. The more fields you include, the more precisely the matcher can identify it. Fields can be set to `null` if unknown.

The `source` field is either `"custom"` (your own recipes) or `"fujixweekly"` (from Fuji X Weekly), and `source_url` links to the recipe page for reference.

## Known quirks

- **iOS smart quotes:** Copying JavaScript from iMessage or Notes on iOS can corrupt the code because iOS substitutes curly quotes for straight quotes. Distribute `.js` files as `.zip` to avoid this.
- **X-T30 partial matching:** The X-T30 lacks Color Chrome FX Blue, Grain Size, and Clarity in its MakerNote. The matcher handles this by scoring only against available fields, but it means two recipes that differ only in those fields will score identically on the X-T30.
- **MakerNote corruption risk:** Editing EXIF fields (even adding a simple comment) can corrupt MakerNotes because the TIFF offset pointers get shifted. This is why we need to read MakerNotes before any metadata editing happens — and why we write the recipe name into IPTC/XMP (a separate data block) rather than modifying the EXIF.
