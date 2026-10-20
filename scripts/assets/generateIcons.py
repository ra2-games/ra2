"""Generate RA2/YR game-selection icons from the cartoon faction illustrations.

Browser favicons, install icons, and the MO icon are maintained finished assets.

Requires Python 3 and Pillow. Invoke through pnpm run gen:icons[:check].
"""
from io import BytesIO
from pathlib import Path
import sys

from PIL import Image, ImageOps

ROOT = Path(__file__).resolve().parents[2]
OUTPUT = Path(next((arg for arg in sys.argv[1:] if not arg.startswith('--')), 'public'))
CHECK = '--check' in sys.argv


def artwork(name, size):
    with Image.open(ROOT / 'public/images' / f'{name}.png') as source:
        image = Image.new('RGBA', (size, size), (0, 0, 0, 0))
        badge = ImageOps.contain(source.convert('RGBA'), (size, size), Image.Resampling.LANCZOS)
        image.alpha_composite(badge, ((size - badge.width) // 2, (size - badge.height) // 2))
        return image


def emit(name, data):
    target = OUTPUT / name
    if CHECK:
        if not target.exists() or target.read_bytes() != data:
            raise SystemExit(f'Icon differs: {target}')
    else:
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
    print(f'{"Verified" if CHECK else "Generated"} {name}: {len(data)} bytes')


for name, size, source in [
    ('icons/ra2.png', 96, 'factions/soviets'),
    ('icons/yr.png', 96, 'factions/yuri'),
]:
    image = artwork(source, size)
    for colors in (256, 128, 96, 64, 48, 32):
        buffer = BytesIO()
        image.quantize(colors=colors, method=Image.Quantize.FASTOCTREE).save(buffer, 'PNG', optimize=True)
        if len(buffer.getvalue()) <= 55000:
            break
    emit(name, buffer.getvalue())
