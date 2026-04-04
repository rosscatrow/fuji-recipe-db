# Fujifilm Recipe Database

A JSON database of Fujifilm film simulation recipes for EXIF-based photo tagging via iOS Shortcuts.

## How it works

Each recipe is stored as a set of in-camera JPEG settings that get baked into the file's MakerNote metadata. An iOS Shortcut reads the EXIF data from a photo and matches it against this database to identify which recipe was used.

## Fingerprint fields

- Film Simulation (FilmMode)
- Highlight Tone / Shadow Tone
- Color Chrome Effect / Color Chrome FX Blue
- Grain Roughness + Size
- Sharpness / Noise Reduction / Clarity
- White Balance + Fine Tune (R shift, B shift)
- Dynamic Range

## Camera compatibility

- Fujifilm X-T5 (X-Trans V)
- Fujifilm X-T30 (X-Trans IV — partial compatibility)

## Files

- `recipes.json` — the recipe database
