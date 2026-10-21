# W4 synthetic ICC evidence — 21 October 2026

The actual `prepareDeterministicProductPhotoFiles` recipe was exercised once with six RGB patches tagged independently as sRGB and Display-P3. ICC profiles came from installed Sharp 0.34.5. PNG iCCP tagging preserves original RGB codes rather than first converting sRGB pixels into P3; saturated P3 primaries therefore exercise colors outside sRGB's gamut. The original tagged inputs are preserved beside the output files.

`comparison.png` shows sRGB above Display-P3. Within each labeled block, the top 120-pixel strip is the explicitly color-managed, lossless sRGB reference; the bottom strip is actual W4 main WebP. Reference conversion uses Sharp's explicit `withIccProfile("srgb", { attach: false })`, independently of the production recipe helper. Both paths use the same underlying color engine, so this is implementation evidence rather than independent color-science certification.

Result: **1 targeted test PASS**, covering two profiles and both main/thumbnail derivatives. Main is 600×120; thumbnail 400×80. All outputs omit ICC/EXIF/XMP. Maximum patch-center difference from the lossless reference is **1 code value per channel** for every derivative. Display-P3 orange `[220,100,40]` becomes reference sRGB `[237,90,1]`, actual `[237,90,0]`: profile interpretation occurs before profile removal. Saturated wide-gamut inputs map into the smaller sRGB gamut; no wide-gamut preservation claim is made.

The installed Sharp API documentation (`lib/output.js`, `keepMetadata`) describes default conversion to sRGB plus ICC stripping. Existing orientation/EXIF/GPS/XMP acceptance is reused, not rerun. No recipe or production code changed.

Exact scoped invocation from `apps/api`:

```text
node C:/Users/Admin/noctella-web-f2w4pre/node_modules/vitest/vitest.mjs run tests/photoColorEvidence.test.ts --config C:/Users/Admin/AppData/Local/Temp/noctella-w4-color-vitest-20261021.mjs
```

The disposable config aliases `sharp` to the existing ancestor installation and `@noctella/shared` to this worktree's source; no install, link or dependency modification. Initial invocation with the normal config collected zero tests because nested-worktree Sharp resolution failed. After adding the temporary alias, the only concrete test run passed in 6.12 seconds. Fontconfig reported unwritable cache directories while rendering labels; no permissions were changed, and the generated PNG labels were visually inspected successfully.

After that run, the test's output destination alone was changed: ordinary test runs now write into their disposable temporary directory and remove it. Reproducing these retained review artifacts requires explicitly setting `NOCTELLA_W4_COLOR_EVIDENCE_DIR` to this directory. Assertions and the processing/reference recipes were unchanged; the already passing conversion check was not repeated for that destination-only edit.

Limits: synthetic patches only; center samples exclude lossy-codec boundary ringing. The tolerance of 8 code values in the scoped test is an engineering regression limit, not an approved product-fidelity threshold. No real product photos, calibrated display, CMYK/other profiles, malformed profiles, perceptual Delta E study, general color-fidelity certification or owner acceptance. **W4 ICC/color acceptance remains OPEN for owner review.**
