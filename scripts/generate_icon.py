#!/usr/bin/env python3
"""Generate Windows-compatible transparent icon.ico from source JPG."""

from __future__ import annotations

import struct
from collections import deque
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "assets" / "source-icon.jpg"
OUT_ICO = ROOT / "assets" / "app.ico"
OUT_PNG = ROOT / "assets" / "app.png"
BUILD_DIR = ROOT / "app" / "build"

BG_TOLERANCE = 38
BG_MIN = 200
SIZES = (16, 24, 32, 48, 64, 128, 256)


def is_background(r: int, g: int, b: int) -> bool:
    if r < BG_MIN or g < BG_MIN or b < BG_MIN:
        return False
    return max(r, g, b) - min(r, g, b) <= BG_TOLERANCE


def is_blue(r: int, g: int, b: int) -> bool:
    return b > 110 and b > r + 12 and b >= g - 8


def remove_background(img: Image.Image) -> Image.Image:
    rgba = img.convert("RGBA")
    w, h = rgba.size
    px = rgba.load()

    # 1) flood-fill outer white canvas from corners
    visited = [[False] * w for _ in range(h)]
    q: deque[tuple[int, int]] = deque()
    for x, y in ((0, 0), (w - 1, 0), (0, h - 1), (w - 1, h - 1)):
        r, g, b, _a = px[x, y]
        if is_background(r, g, b):
            q.append((x, y))
            visited[y][x] = True

    while q:
        x, y = q.popleft()
        px[x, y] = (0, 0, 0, 0)
        for nx, ny in ((x - 1, y), (x + 1, y), (x, y - 1), (x, y + 1)):
            if 0 <= nx < w and 0 <= ny < h and not visited[ny][nx]:
                nr, ng, nb, _na = px[nx, ny]
                if is_background(nr, ng, nb):
                    visited[ny][nx] = True
                    q.append((nx, ny))

    # 2) remove stranded white pixels outside the blue icon body
    blue = [[False] * w for _ in range(h)]
    for y in range(h):
        for x in range(w):
            r, g, b, a = px[x, y]
            if a and is_blue(r, g, b):
                blue[y][x] = True

    for _ in range(4):
        grown = [row[:] for row in blue]
        for y in range(h):
            for x in range(w):
                if not blue[y][x]:
                    continue
                for nx, ny in ((x - 1, y), (x + 1, y), (x, y - 1), (x, y + 1)):
                    if 0 <= nx < w and 0 <= ny < h:
                        grown[ny][nx] = True
        blue = grown

    for y in range(h):
        for x in range(w):
            r, g, b, a = px[x, y]
            if not a:
                continue
            if blue[y][x]:
                px[x, y] = (r, g, b, 255)
            else:
                px[x, y] = (0, 0, 0, 0)

    # 3) soften light fringe around rounded corners
    for y in range(h):
        for x in range(w):
            r, g, b, a = px[x, y]
            if not a or blue[y][x]:
                continue
            if r > 180 and g > 180 and b > 180:
                px[x, y] = (0, 0, 0, 0)

    bbox = rgba.getbbox()
    if not bbox:
        raise RuntimeError("No visible content after background removal")
    return rgba.crop(bbox)


def to_square(img: Image.Image, padding_ratio: float = 0.05) -> Image.Image:
    w, h = img.size
    side = max(w, h)
    pad = max(4, int(side * padding_ratio))
    canvas = Image.new("RGBA", (side + pad * 2, side + pad * 2), (0, 0, 0, 0))
    ox = (canvas.width - w) // 2
    oy = (canvas.height - h) // 2
    canvas.paste(img, (ox, oy), img)
    return canvas


def _bmp_payload(img: Image.Image) -> bytes:
    w, h = img.size
    rgba = img.convert("RGBA")

    xor_rows = bytearray()
    for y in range(h - 1, -1, -1):
        row = bytearray()
        for x in range(w):
            r, g, b, a = rgba.getpixel((x, y))
            row.extend((b, g, r, a))
        xor_rows.extend(row)

    mask_stride = ((w + 31) // 32) * 4
    and_rows = bytearray()
    for y in range(h - 1, -1, -1):
        row = bytearray(mask_stride)
        for x in range(w):
            _r, _g, _b, a = rgba.getpixel((x, y))
            if a < 128:
                byte_idx = x // 8
                bit_idx = 7 - (x % 8)
                row[byte_idx] |= 1 << bit_idx
        and_rows.extend(row)

    header = struct.pack(
        "<IIIHHIIiiII",
        40,
        w,
        h * 2,
        1,
        32,
        0,
        0,
        0,
        0,
        0,
        0,
    )
    return header + bytes(xor_rows) + bytes(and_rows)


def save_ico_dib(img: Image.Image, out_path: Path, sizes: tuple[int, ...]) -> None:
    images: list[tuple[int, bytes]] = []
    for size in sizes:
        frame = img.resize((size, size), Image.Resampling.LANCZOS)
        images.append((size, _bmp_payload(frame)))

    count = len(images)
    header_size = 6 + count * 16
    offset = header_size
    entries: list[bytes] = []
    blobs: list[bytes] = []

    for size, payload in images:
        w_byte = 0 if size >= 256 else size
        h_byte = 0 if size >= 256 else size
        blob = payload
        entries.append(struct.pack("<BBBBHHII", w_byte, h_byte, 0, 0, 1, 32, len(blob), offset))
        blobs.append(blob)
        offset += len(blob)

    with out_path.open("wb") as f:
        f.write(struct.pack("<HHH", 0, 1, count))
        for entry in entries:
            f.write(entry)
        for blob in blobs:
            f.write(blob)


def build_master() -> Image.Image:
    raw = Image.open(SRC)
    cutout = remove_background(raw)
    square = to_square(cutout)
    return square.resize((512, 512), Image.Resampling.LANCZOS)


def main() -> None:
    if not SRC.exists():
        raise SystemExit(f"Missing source image: {SRC}")

    master = build_master()
    OUT_PNG.parent.mkdir(parents=True, exist_ok=True)
    BUILD_DIR.mkdir(parents=True, exist_ok=True)

    master.save(OUT_PNG, format="PNG")
    save_ico_dib(master, OUT_ICO, SIZES)

    for target in (BUILD_DIR / "icon.ico", BUILD_DIR / "icon.png"):
        if target.suffix == ".ico":
            save_ico_dib(master, target, SIZES)
        else:
            master.save(target, format="PNG")

    print(f"Generated {OUT_ICO} ({OUT_ICO.stat().st_size} bytes)")
    print(f"Generated {OUT_PNG}")
    print(f"Copied to {BUILD_DIR}")


if __name__ == "__main__":
    main()
