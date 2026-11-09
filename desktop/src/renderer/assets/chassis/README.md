# Game & Watch photographic chassis assets

These assets are used by the running application's optional device frame.

| Model | Official source | Native size | Transparent LCD aperture |
| --- | --- | --- | --- |
| Mario | `retro-go-assets/images/official/eu/NSwitch_GameWatch_Legendary_Hardware.png` | 919 × 550 | x=258, y=124, 404 × 303 |
| Zelda | `retro-go-assets/images/official/eu/NSwitch_GameWatch_TLOZ_Lifestyle_04_image950w.png` | 950 × 567 | x=267, y=129, 416 × 312 |

The source photographs, product artwork, and trademarks belong to their respective
rights holders. Extraction does not change their licensing. Original files stay
untouched; each `skin.json` records the source path and SHA-256 for provenance.

`frame.png` retains the photograph and its exterior alpha. The entire LCD interior,
including the original screenshot's side bars, has zero RGB and alpha. Both holes
are 4:3. There is no invented resolution or redrawn branding.

Each button has three face-only PNGs: normal, hover, pressed. Pressed artwork is
darkened with a restrained warm inner rim; hover slightly brightens it. The fixed
surrounds, labels and central d-pad pivot remain in the base frame. Directional
layers are independent, allowing combinations. Mario has no front START/SELECT;
neither photograph has a front POWER button.

`skin.json` uses native source pixels. Rectangle width/height and shape bounds use
exclusive right/bottom coordinates. Polygon points describe individual d-pad
directions; rounded rectangles/ellipses describe other button faces. `spriteRect`
is the placement of each cropped PNG and includes antialiasing fringe. Button
`bit` values correspond to the existing QEMU hardware input mask. Stable logical
IDs are lowercase and do not change with the UI language.

Rebuild from the repository root with Pillow installed:

```sh
.venv/bin/python tools/prepare_chassis.py
```

Alternatively use any Python environment with Pillow. `--source-dir`,
`--output-dir`, and `--preview-dir` override locations. Python is used only for
offline image preparation; Electron does not depend on Python.

Review sheets are generated under ignored `out/chassis-preview/`: `comparison.jpg`
shows normal and LEFT+A+GAME states, and `<model>-states.jpg` shows every button.
The placeholder LCD contains no firmware or ROM screenshots.

Directional pressed sprites add a warm translucent face tint and strong inner rim for visibility at desktop-clock scale. The photographic center and all other directions remain unchanged.
