"""CMCP application icon: a bold clay "C" with a hub and a remote node.

Original artwork drawn for CMCP (no third-party artwork). Every raster size is rendered directly from the geometry with 8x
supersampling (not downscaled from one bitmap), so small sizes stay crisp.

  python tools/draw-cmcp-icon.py app/assets   (requires Pillow; writes cmcp.ico,
  cmcp-icon-1024.png for the macOS iconset, and the SVG source)
"""
import io, math, struct, sys
from pathlib import Path
from PIL import Image, ImageDraw

CREAM = (246, 240, 230, 255)
EDGE = (226, 214, 196, 255)      # hairline so the cream tile holds on light backgrounds
CLAY = (201, 100, 66, 255)
CLAY_D = (168, 78, 50, 255)
# Geometry in units of the full canvas (1.0 = icon width).
MARGIN, RADIUS, EDGE_W = 0.07, 0.225, 0.012
ARC_R, ARC_W, ARC_FROM, ARC_TO = 0.255, 0.13, 40, 320
HUB_R, NODE_X, NODE_R = 0.085, 0.27, 0.05

# Small sizes (<= 24 px) get a hinted variant: no remote node, wider opening and
# less margin, so the "C" still reads as a C instead of a target.
SMALL = dict(MARGIN=0.02, EDGE_W=0.0, ARC_R=0.27, ARC_W=0.17, ARC_FROM=58, ARC_TO=302, HUB_R=0.095, NODE_R=0.0)

def render(size, ss=8):
    g = dict(MARGIN=MARGIN, EDGE_W=EDGE_W, ARC_R=ARC_R, ARC_W=ARC_W, ARC_FROM=ARC_FROM, ARC_TO=ARC_TO, HUB_R=HUB_R, NODE_R=NODE_R)
    if size <= 24: g.update(SMALL)
    S = size * ss
    im = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    m = g['MARGIN'] * S
    d.rounded_rectangle([m, m, S - m, S - m], radius=RADIUS * S, fill=EDGE)
    e = g['EDGE_W'] * S
    d.rounded_rectangle([m + e, m + e, S - m - e, S - m - e], radius=RADIUS * S - e, fill=CREAM)
    c, r, w = S / 2, g['ARC_R'] * S, g['ARC_W'] * S
    steps = max(360, int(S / 2))
    for i in range(steps + 1):
        a = math.radians(g['ARC_FROM'] + (g['ARC_TO'] - g['ARC_FROM']) * i / steps)
        x, y = c + r * math.cos(a), c + r * math.sin(a)
        d.ellipse([x - w / 2, y - w / 2, x + w / 2, y + w / 2], fill=CLAY)
    hr = g['HUB_R'] * S
    d.ellipse([c - hr, c - hr, c + hr, c + hr], fill=CLAY)
    if g['NODE_R']:
        nx, nr = c + NODE_X * S, g['NODE_R'] * S
        d.ellipse([nx - nr, c - nr, nx + nr, c + nr], fill=CLAY_D)
    return im.resize((size, size), Image.LANCZOS)

def bmp_entry(img):
    """32-bit BGRA DIB (+ empty AND mask) for classic ICO entries."""
    w, h = img.size
    px = img.convert('RGBA').transpose(Image.FLIP_TOP_BOTTOM).tobytes('raw', 'BGRA')
    mask_row = ((w + 31) // 32) * 4
    header = struct.pack('<IiiHHIIiiII', 40, w, h * 2, 1, 32, 0, len(px) + mask_row * h, 0, 0, 0, 0)
    return header + px + b'\0' * (mask_row * h)

def write_ico(path, images):
    entries, blobs = [], []
    for img in images:
        w = img.size[0]
        if w >= 256:
            buf = io.BytesIO(); img.save(buf, 'PNG', optimize=True); blob = buf.getvalue()
        else:
            blob = bmp_entry(img)
        entries.append((w, blob)); blobs.append(blob)
    out = bytearray(struct.pack('<HHH', 0, 1, len(entries)))
    offset = 6 + 16 * len(entries)
    for w, blob in entries:
        b = 0 if w >= 256 else w
        out += struct.pack('<BBBBHHII', b, b, 0, 0, 1, 32, len(blob), offset)
        offset += len(blob)
    for blob in blobs: out += blob
    Path(path).write_bytes(out)

def svg():
    s = 1024
    def p(v): return round(v * s, 2)
    a0, a1 = math.radians(ARC_FROM), math.radians(ARC_TO)
    c, r = s / 2, ARC_R * s
    x0, y0 = c + r * math.cos(a0), c + r * math.sin(a0)
    x1, y1 = c + r * math.cos(a1), c + r * math.sin(a1)
    m, e = p(MARGIN), p(EDGE_W)
    return f'''<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <title>CMCP</title>
  <rect x="{m}" y="{m}" width="{s - 2 * m}" height="{s - 2 * m}" rx="{p(RADIUS)}" fill="#E2D6C4"/>
  <rect x="{m + e}" y="{m + e}" width="{s - 2 * (m + e)}" height="{s - 2 * (m + e)}" rx="{p(RADIUS) - e}" fill="#F6F0E6"/>
  <path d="M {x0:.2f} {y0:.2f} A {r:.2f} {r:.2f} 0 1 1 {x1:.2f} {y1:.2f}" fill="none" stroke="#C96442" stroke-width="{p(ARC_W)}" stroke-linecap="round"/>
  <circle cx="{c}" cy="{c}" r="{p(HUB_R)}" fill="#C96442"/>
  <circle cx="{c + p(NODE_X)}" cy="{c}" r="{p(NODE_R)}" fill="#A84E32"/>
</svg>
'''

out = Path(sys.argv[1]); out.mkdir(parents=True, exist_ok=True)
ico_sizes = [16, 20, 24, 32, 40, 48, 64, 96, 128, 256]
imgs = {s: render(s) for s in ico_sizes + [512]}
imgs[1024] = render(1024, ss=4)
imgs[1024].save(out / 'cmcp-icon-1024.png', optimize=True)
write_ico(out / 'cmcp.ico', [imgs[s] for s in ico_sizes])
(out / 'cmcp-icon.svg').write_text(svg(), encoding='utf-8')
print('ok', sorted(imgs))
