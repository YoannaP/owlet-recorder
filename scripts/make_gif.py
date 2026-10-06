#!/usr/bin/env python3
"""Turn frames from record_demo.mjs into the README GIF.

    uv run --with pillow python scripts/make_gif.py frames/ docs/demo.gif
    gifsicle -O3 --lossy=60 --colors 96 -b docs/demo.gif    # optional, much smaller
"""
import sys
from pathlib import Path

from PIL import Image

WIDTH = 900
FRAME_MS = 380  # about one capture interval, so it plays near real time

source, target = Path(sys.argv[1]), Path(sys.argv[2])
frames = []
for path in sorted(source.glob("*.png")):
    image = Image.open(path).convert("RGB")
    height = round(image.height * WIDTH / image.width)
    frames.append(image.resize((WIDTH, height), Image.LANCZOS))
# Identical neighbours are merged by Pillow, so pauses cost nothing.
frames[0].save(target, save_all=True, append_images=frames[1:], duration=FRAME_MS,
               loop=0, optimize=True)
print(f"{len(frames)} frames -> {target}")
