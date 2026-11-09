# Hunt scene V2 — art integration

This is a separate UI branch. It does not touch Neon migration, the game economy, combat rules, or production deployment.

## Current staged changes

- `public/css/hunt-scene-v2.css`: more consistent cold lighting, depth, hero / creature shadows, selection marker, HUD and mobile labels.
- `public/index.html` and `public/en/index.html`: map all 3 classes and 11 enemies to new static sprite filenames, with fallback to the existing game's art if any asset is not present. Size scales are updated; four selectable enemies and combat behavior are unchanged.
- **Binary sprite assets are NOT committed yet.** They were produced as a downloadable ZIP in the ChatGPT conversation and must be uploaded before testing the final art. Do not deploy this branch expecting the new art to appear until files have been uploaded to `public/hunt-v2/`.

## Prepared asset filenames

Three classes:

- hero_berserker.webp
- hero_hunter.webp
- hero_shaman.webp

Eleven enemies:

- monster_forest_wolf.webp
- monster_wild_boar.webp
- monster_fox_werewolf.webp
- monster_scavenger_raven.webp
- monster_swamp_rat.webp
- monster_mountain_bear.webp
- monster_snow_leopard.webp
- monster_road_bandit.webp
- monster_pack_leader.webp
- monster_draugr.webp
- monster_young_troll.webp

All files use the URL prefix `/hunt-v2/`. They belong in `public/hunt-v2`, **not** `public/img`: `tools/assetcheck.js` enforces content-hash filenames for the existing top-level `public/img/*.webp` directory.

Prepared ZIP includes RGBA lossless WebP and PNG source files, 512×512 transparent canvases, a contact-sheet preview, and manifest.

## Validation checklist before deployment

1. Upload every `public/hunt-v2/*.webp` from ZIP and confirm exact filenames.
2. Inspect each cutout on a dark and a light background. In particular, inspect paw edges, antlers, weapons, hair and fur at 100% zoom; some artwork comes from a shared illustration and may need per-character rework.
3. Test both Russian and English pages. Check three hero classes and all enemies at all three hunt difficulties.
4. Check up to four creatures simultaneously, targeting, enemy name badges, health bars, first-hunt tutorial, lower-power iPhone, and PWA reload.
5. Run existing repository tests (`npm test` / relevant project test scripts) and `node tools/assetcheck.js`.
6. Keep original images as fallback until approval. Do not merge or deploy to production without explicit authorization.

## Existing gameplay preserved

`HMON` and `STPT` remain intact. No animation sprite sheets. Existing CSS breathing and hit-feedback animation remain purely presentation, unrelated to the static sprite files.

## Known limitation

New sprites are attached as downloadable files in the ChatGPT conversation, not yet in this Git branch. Code is staged but does not claim final asset installation or live visual QA.
