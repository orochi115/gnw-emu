#!/usr/bin/env python3
"""Extract photographic chassis artwork; never modify the official originals.

Requires Pillow. Coordinates are native source pixels, with exclusive right/bottom
bounds. This is an offline asset tool, not a dependency of the Electron runtime.
"""
import argparse
import hashlib
import json
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw, ImageEnhance, ImageFilter

ROOT = Path(__file__).resolve().parents[1]
BITS = dict(left=0, up=1, right=2, down=3, a=4, b=5, time=6,
            game=7, pause=8, start=10, select=11)
DIRECTIONS = {
    "left": [(48, 379), (90, 379), (100, 390), (100, 407), (90, 418), (48, 418)],
    "up": [(94, 332), (134, 332), (134, 375), (123, 381), (105, 381), (94, 375)],
    "right": [(140, 379), (182, 379), (182, 418), (140, 418), (129, 407), (129, 390)],
    "down": [(94, 424), (105, 419), (123, 419), (134, 424), (134, 465), (94, 465)],
}


def controls(model):
    """Face-only masks leave the fixed button surrounds and labels untouched."""
    mario = model == "mario"
    scale_x, scale_y = (1, 1) if mario else (950 / 919, 567 / 550)
    result = {key: {"kind": "polygon", "points": [
        [round(x * scale_x), round(y * scale_y)] for x, y in points]}
        for key, points in DIRECTIONS.items()}
    faces = ({"b": (725, 369, 782, 427), "a": (823, 369, 881, 427)}
             if mario else {"b": (750, 419, 809, 478), "a": (852, 419, 911, 479)})
    result.update({key: {"kind": "ellipse", "bounds": list(box)}
                   for key, box in faces.items()})
    gray_faces = ({"game": [744, 65, 786, 89], "time": [744, 128, 786, 152],
                   "pause": [744, 190, 786, 214]} if mario else
                  {"game": [770, 67, 813, 91], "time": [770, 132, 813, 156],
                   "pause": [770, 196, 813, 220]})
    for key, bounds in gray_faces.items():
        result[key] = {"kind": "roundedRect", "bounds": bounds, "radius": 12}
    if not mario:
        for key, bounds in (("select", [750, 355, 810, 378]),
                            ("start", [852, 354, 911, 378])):
            result[key] = {"kind": "roundedRect", "bounds": bounds, "radius": 12}
    return result


SOURCES = {
    "mario": ("NSwitch_GameWatch_Legendary_Hardware.png", (919, 550),
              {"x": 258, "y": 124, "width": 404, "height": 303}),
    "zelda": ("NSwitch_GameWatch_TLOZ_Lifestyle_04_image950w.png", (950, 567),
              {"x": 267, "y": 129, "width": 416, "height": 312}),
}


def make_mask(size, shape):
    factor = 4
    mask = Image.new("L", (size[0] * factor, size[1] * factor))
    draw = ImageDraw.Draw(mask)
    if shape["kind"] == "polygon":
        draw.polygon([(x * factor, y * factor) for x, y in shape["points"]], fill=255)
    else:
        x0, y0, x1, y1 = shape["bounds"]
        box = (x0 * factor, y0 * factor, x1 * factor - 1, y1 * factor - 1)
        if shape["kind"] == "ellipse":
            draw.ellipse(box, fill=255)
        else:
            draw.rounded_rectangle(box, radius=shape["radius"] * factor, fill=255)
    return mask.resize(size, Image.Resampling.LANCZOS)


def state_sprite(source, mask, state, directional):
    sprite = source.copy()
    if state == "pressed":
        sprite = ImageEnhance.Brightness(sprite).enhance(0.68)
        # Bright directional face and rim stay legible at compact desktop size.
        if directional:
            face = Image.new("RGBA", source.size, (242, 204, 126, 0))
            face.putalpha(mask.point(lambda p: round(p * 0.36)))
            sprite = Image.alpha_composite(sprite, face)
        rim = ImageChops.subtract(mask, mask.filter(ImageFilter.MinFilter(5)))
        rim = rim.point(lambda p: round(p * (0.85 if directional else 0.20)))
        tint = Image.new("RGBA", source.size, (220, 190, 118, 0))
        tint.putalpha(rim)
        sprite = Image.alpha_composite(sprite, tint)
    elif state == "hover":
        sprite = ImageEnhance.Brightness(sprite).enhance(1.10)
    sprite.putalpha(ImageChops.multiply(source.getchannel("A"), mask))
    return sprite


def prepare(source_dir, output_dir, preview_dir):
    preview_dir.mkdir(parents=True, exist_ok=True)
    previews = []
    for model, (filename, expected_size, screen) in SOURCES.items():
        path = source_dir / filename
        source = Image.open(path).convert("RGBA")
        if source.size != expected_size:
            raise ValueError(f"{filename}: expected {expected_size}, got {source.size}")
        target = output_dir / model
        target.mkdir(parents=True, exist_ok=True)
        frame = source.copy()
        box = (screen["x"], screen["y"], screen["x"] + screen["width"],
               screen["y"] + screen["height"])
        # Clear RGB as well as alpha to avoid obsolete screenshot edge bleed.
        frame.paste((0, 0, 0, 0), box)
        frame.save(target / "frame.png", optimize=True)
        metadata = {"version": 1, "model": model,
                    "size": {"width": source.width, "height": source.height},
                    "source": {"path": f"retro-go-assets/images/official/eu/{filename}",
                               "sha256": hashlib.sha256(path.read_bytes()).hexdigest()},
                    "screen": screen, "buttons": []}
        pressed_preview = frame.copy()
        button_sheet = Image.new("RGBA", (540, len(controls(model)) * 100 + 35), "#202329")
        ImageDraw.Draw(button_sheet).text((12, 10),
                                        f"{model.upper()}: normal / hover / pressed", fill="#e9e6de")
        for key, shape in controls(model).items():
            mask = make_mask(source.size, shape)
            crop = mask.getbbox()
            states = {}
            for state in ("normal", "hover", "pressed"):
                sprite = state_sprite(source, mask, state, key in DIRECTIONS)
                filename = f"{key}-{state}.png"
                sprite.crop(crop).save(target / filename, optimize=True)
                states[state] = filename
                row = len(metadata["buttons"])
                column = ("normal", "hover", "pressed").index(state)
                tile = sprite.crop(crop)
                tile.thumbnail((120, 90), Image.Resampling.LANCZOS)
                button_sheet.alpha_composite(tile, (110 + column * 140, 40 + row * 100))
                if state == "pressed" and key in ("left", "a", "game"):
                    pressed_preview = Image.alpha_composite(pressed_preview, sprite)
            metadata["buttons"].append({"id": key, "bit": BITS[key],
                "shape": shape, "spriteRect": {"x": crop[0], "y": crop[1],
                    "width": crop[2] - crop[0], "height": crop[3] - crop[1]},
                "states": states})
            ImageDraw.Draw(button_sheet).text((12, 60 + row * 100), key, fill="#e9e6de")
        (target / "skin.json").write_text(json.dumps(metadata, indent=2) + "\n")
        button_sheet.convert("RGB").save(preview_dir / f"{model}-states.jpg", quality=94)
        # Review artwork on a neutral LCD; no user ROM or firmware pixels included.
        for title, artwork in ((f"{model.upper()} / normal", frame),
                               (f"{model.upper()} / LEFT + A + GAME", pressed_preview)):
            cell = Image.new("RGBA", (source.width, source.height + 40), "#202329")
            lcd = ImageDraw.Draw(cell)
            lcd.rectangle(box, fill="#101419")
            lcd.text((screen["x"] + 15, screen["y"] + 15), "LIVE LCD AREA", fill="#6f818b")
            cell.alpha_composite(artwork, (0, 0))
            ImageDraw.Draw(cell).text((16, source.height + 12), title, fill="#e9e6de")
            previews.append(cell)
    sheet = Image.new("RGBA", (1900, 1240), "#202329")
    for index, cell in enumerate(previews):
        sheet.alpha_composite(cell, ((index % 2) * 950, (index // 2) * 620))
    sheet.convert("RGB").save(preview_dir / "comparison.jpg", quality=94)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-dir", type=Path,
                        default=ROOT.parent / "retro-go-assets/images/official/eu")
    parser.add_argument("--output-dir", type=Path,
                        default=ROOT / "desktop/src/renderer/assets/chassis")
    parser.add_argument("--preview-dir", type=Path, default=ROOT / "out/chassis-preview")
    args = parser.parse_args()
    prepare(args.source_dir, args.output_dir, args.preview_dir)
    print(f"Prepared Mario and Zelda artwork in {args.output_dir}")
    print(f"Preview: {args.preview_dir / 'comparison.jpg'}")


if __name__ == "__main__":
    main()
