#!/usr/bin/env python3
"""Generate Lilypad's app icons from the design tokens.

Run when the mark changes, not in CI:

    python3 scripts/icons.py        # needs Pillow + numpy, neither is a repo dependency

Why this exists: the iOS `AppIcon.appiconset` held a `Contents.json` and no
images at all — App Store Connect rejects an upload with no 1024 marketing icon
— and the desktop shipped a plain green circle, which is a placeholder rather
than a mark. Both are the first thing a customer sees.

The shape is a lily pad seen from above: a disc with the characteristic wedge
cut to the rim, and veins radiating from the notch apex. It has to survive
being 16px in a menu bar, so the veins are low-contrast and the silhouette does
all the work.

Colours are the tokens from `packages/design/src/tokens.ts`, not new ones:
accent #1f9f6b (light) and #3ecf8e (dark) as the pad gradient, onAccent #06231a
as the iOS backdrop.

Two variants, because the platforms mask differently:
  - iOS   full-bleed square, NO alpha channel (Apple rejects alpha), artwork
          inset so the system's squircle mask never clips the pad.
  - macOS free-form with transparency and a soft contact shadow, which is how
          every other icon in the Dock is drawn.
"""
import math
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = Path(__file__).resolve().parent.parent

ACCENT_DARK = (0x3E, 0xCF, 0x8E)   # tokens.dark.accent  — highlight side
ACCENT_LIGHT = (0x1F, 0x9F, 0x6B)  # tokens.light.accent — shadow side
ON_ACCENT = (0x06, 0x23, 0x1A)     # tokens.onAccent     — iOS backdrop

SS = 4  # supersample factor; everything is drawn at SS× and LANCZOS'd down

NOTCH_DEG = 21.0     # total opening of the wedge — wider than this and it
                     # stops reading as a cut and starts reading as a pie chart
NOTCH_DIR = 38.0     # direction the wedge points (degrees, 0 = east, CCW)
VEINS = 13


def _linear_gradient(size, c0, c1, angle_deg):
    """RGB gradient across `size` at `angle_deg` (0 = left→right)."""
    w = h = size
    a = math.radians(angle_deg)
    x = np.linspace(-1.0, 1.0, w)[None, :]
    y = np.linspace(-1.0, 1.0, h)[:, None]
    t = (x * math.cos(a) + y * math.sin(a) + 1.0) / 2.0
    t = np.clip(t, 0.0, 1.0)[..., None]
    c = np.array(c0, float)[None, None, :] * (1 - t) + np.array(c1, float)[None, None, :] * t
    return Image.fromarray(c.astype(np.uint8), "RGB")


def pad_mask(size, notch=True):
    """L-mode mask of the pad silhouette: a disc less a wedge to the rim.

    The outline carries a small low-frequency wobble. A mathematically perfect
    circle reads as a UI element; a leaf does not have one, and at 1024px the
    difference between "shape" and "plant" is entirely in that few percent.
    """
    m = Image.new("L", (size, size), 0)
    d = ImageDraw.Draw(m)
    cx = cy = size / 2.0
    base = size / 2.0 - 1
    pts = []
    for i in range(720):
        a = math.radians(i * 0.5)
        wobble = 1.0 + 0.014 * math.sin(3 * a + 0.7) + 0.009 * math.sin(5 * a + 2.1)
        r = base * wobble
        pts.append((cx + r * math.cos(a), cy - r * math.sin(a)))
    d.polygon(pts, fill=255)
    if notch:
        # A pie slice removed from centre to rim. Overshoot the radius so the
        # cut reaches past the edge and leaves no antialiased sliver behind.
        r = size  # > size/2, deliberately
        cx = cy = size / 2.0
        half = NOTCH_DEG / 2.0
        pts = [(cx, cy)]
        steps = 48
        for i in range(steps + 1):
            ang = math.radians(NOTCH_DIR - half + (NOTCH_DEG * i / steps))
            # screen y grows downward, so negate the sine
            pts.append((cx + r * math.cos(ang), cy - r * math.sin(ang)))
        d.polygon(pts, fill=0)
    return m


def draw_pad(size):
    """RGBA lily pad filling `size`, with veins. Transparent outside."""
    S = size * SS
    mask = pad_mask(S)
    grad = _linear_gradient(S, ACCENT_DARK, ACCENT_LIGHT, 55.0)

    pad = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    pad.paste(grad, (0, 0), mask)

    # Veins from the notch apex outward, skipping the wedge. Drawn onto their
    # own layer and clipped by the silhouette so they never spill past the rim.
    veins = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    vd = ImageDraw.Draw(veins)
    cx = cy = S / 2.0
    width = max(1, int(S * 0.0045))
    gap = NOTCH_DEG / 2.0 + 10.0
    span = 360.0 - 2 * gap
    # Veins start OUT from the apex, not at it. Thirteen lines meeting at one
    # point is a pie chart; leaving the middle open is what made the first
    # attempt stop looking like one.
    r0 = S * 0.14
    for i in range(VEINS):
        ang = math.radians(NOTCH_DIR + gap + span * (i / (VEINS - 1)))
        ca, sa = math.cos(ang), math.sin(ang)
        # Alternate long and short, the way a leaf's primary and secondary
        # veins do, so the fan is not a perfectly regular star.
        r1 = S * (0.505 if i % 2 == 0 else 0.40)
        vd.line((cx + r0 * ca, cy - r0 * sa, cx + r1 * ca, cy - r1 * sa),
                fill=(*ON_ACCENT, 30), width=width)
    veins.putalpha(Image.composite(veins.getchannel("A"), Image.new("L", (S, S), 0), mask))
    pad = Image.alpha_composite(pad, veins)

    # Rim shading: a soft inner darkening that reads as curvature.
    rim = Image.new("L", (S, S), 0)
    ImageDraw.Draw(rim).ellipse((0, 0, S - 1, S - 1), outline=255, width=int(S * 0.035))
    rim = rim.filter(ImageFilter.GaussianBlur(S * 0.02))
    rim = Image.composite(rim, Image.new("L", (S, S), 0), mask)
    shade = Image.new("RGBA", (S, S), (*ON_ACCENT, 0))
    shade.putalpha(rim.point(lambda v: int(v * 0.22)))
    pad = Image.alpha_composite(pad, shade)

    return pad.resize((size, size), Image.LANCZOS)


def macos_icon(size):
    """Free-form: the pad alone, inset, with a contact shadow."""
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    inner = int(size * 0.88)
    pad = draw_pad(inner)
    off = (size - inner) // 2

    shadow = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    sh = Image.new("RGBA", (inner, inner), (0, 0, 0, 0))
    sh.paste((*ON_ACCENT, 90), (0, 0), pad.getchannel("A"))
    shadow.paste(sh, (off, off + max(1, int(size * 0.015))), sh)
    shadow = shadow.filter(ImageFilter.GaussianBlur(max(1, size * 0.018)))

    img = Image.alpha_composite(img, shadow)
    img.paste(pad, (off, off), pad)
    return img


def ios_icon(size):
    """Full-bleed square, no alpha — Apple rejects an alpha channel."""
    S = size * SS
    # Backdrop: the deep token green, lifted slightly at the top-left so the
    # square is not a flat block.
    bg = _linear_gradient(S, (0x0B, 0x33, 0x26), ON_ACCENT, 60.0)
    img = bg.convert("RGBA")

    inner = int(S * 0.76)
    pad = draw_pad(inner)
    off = (S - inner) // 2
    img.paste(pad, (off, off), pad)

    return img.convert("RGB").resize((size, size), Image.LANCZOS)


# ── Web ───────────────────────────────────────────────────────────────────────
# The site had no favicon, no apple-touch-icon and no Open Graph image, so the
# browser tab was blank and sharing the link anywhere — iMessage, Slack, a
# tweet — produced a bare URL with no title, no description and no picture.

BG_DEEP = (0x0B, 0x33, 0x26)
FG = (0xF4, 0xFA, 0xF7)          # tokens.light.bg, used here as text on dark
MUTED = (0x9F, 0xC4, 0xB4)

def _font(size, bold=False):
    """Helvetica Neue: the closest freely-renderable match to the site's
    `system-ui` stack, which resolves to SF Pro on macOS. Rendered once into a
    committed PNG, so there is no runtime font dependency either way."""
    path = "/System/Library/Fonts/HelveticaNeue.ttc"
    try:
        return ImageFont.truetype(path, size, index=1 if bold else 0)
    except OSError:
        return ImageFont.load_default()


def og_image():
    """1200x630 social card."""
    W, H = 1200, 630
    img = _linear_gradient(max(W, H), (0x10, 0x3F, 0x2F), ON_ACCENT, 55.0).crop((0, 0, W, H)).convert("RGBA")

    mark = macos_icon(300)
    img.paste(mark, (96, (H - 300) // 2), mark)

    d = ImageDraw.Draw(img)
    x = 456
    d.text((x, 214), "Lilypad", font=_font(96, bold=True), fill=FG)
    d.text((x, 330), "Your Mac, on your phone.", font=_font(40), fill=MUTED)
    d.text((x, 392), "Pair once with a QR code. Reconnect forever.", font=_font(28), fill=MUTED)
    d.text((x, 470), "lilypadhome.takedia.com", font=_font(24), fill=ACCENT_DARK)
    return img.convert("RGB")


def write_web(mac_master):
    pub = ROOT / "apps/site/public"
    pub.mkdir(parents=True, exist_ok=True)

    # Favicon: a tab is 16px, where the veins are gone and only the silhouette
    # is left, so the pad is drawn on the brand backdrop rather than
    # transparent — a transparent green shape disappears on a dark tab strip.
    ico_sizes = [16, 32, 48, 64]
    base = ios_icon(256)
    base.save(pub / "favicon.ico", sizes=[(s, s) for s in ico_sizes])
    base.resize((32, 32), Image.LANCZOS).save(pub / "favicon-32.png")

    # Apple touch icon: 180x180, no alpha, no rounded corners — iOS masks it.
    ios_icon(180).save(pub / "apple-touch-icon.png")

    og_image().save(pub / "og.png", quality=92)
    print(f"web      favicon.ico, favicon-32.png, apple-touch-icon.png, og.png")


def main():
    # Render each variant ONCE at full resolution and downsample. Re-rendering a
    # supersampled master per size meant a 4096x4096 blur for every entry, which
    # took minutes; the masters are the only expensive step.
    mac_master = macos_icon(1024)
    ios_master = ios_icon(1024)

    ios_dir = ROOT / "apps/mobile/ios/LilypadMobile/Images.xcassets/AppIcon.appiconset"
    ios_dir.mkdir(parents=True, exist_ok=True)
    ios_master.save(ios_dir / "AppIcon.png", "PNG")
    (ios_dir / "Contents.json").write_text(
        '{\n  "images" : [\n    {\n      "filename" : "AppIcon.png",\n'
        '      "idiom" : "universal",\n      "platform" : "ios",\n'
        '      "size" : "1024x1024"\n    }\n  ],\n'
        '  "info" : {\n    "author" : "xcode",\n    "version" : 1\n  }\n}\n'
    )
    print("ios      AppIcon.png 1024x1024 (no alpha)")

    icons = ROOT / "apps/desktop/src-tauri/icons"
    for name, px in [
        # 512, NOT 1024. Tauri turns these four into the .icns, and ICNS has no
        # type for 1024 at 1x — 1024 exists only as 512@2x. Shipping 1024 here
        # made `tauri build` die with "Failed to create app icon: `No matching
        # IconType`" AFTER a clean four-minute Rust build, naming no file.
        ("icon.png", 512), ("128x128.png", 128), ("128x128@2x.png", 256), ("32x32.png", 32),
        ("Square30x30Logo.png", 30), ("Square44x44Logo.png", 44), ("Square89x89Logo.png", 89), ("Square107x107Logo.png", 107), ("Square142x142Logo.png", 142),
        ("Square150x150Logo.png", 150), ("Square284x284Logo.png", 284), ("Square310x310Logo.png", 310),
        ("StoreLogo.png", 50),
    ]:
        img = mac_master.resize((px, px), Image.LANCZOS)
        img.save(icons / name, "PNG")
    print(f"desktop  {len(list(icons.glob('*.png')))} png(s) regenerated")

    andr = ROOT / "apps/mobile/android/app/src/main/res"
    circ_master = Image.new("L", (1024, 1024), 0)
    ImageDraw.Draw(circ_master).ellipse((0, 0, 1023, 1023), fill=255)
    round_master = ios_master.convert("RGBA")
    round_master.putalpha(circ_master)
    n = 0
    for folder, px in [("mdpi", 48), ("hdpi", 72), ("xhdpi", 96), ("xxhdpi", 144), ("xxxhdpi", 192)]:
        d = andr / f"mipmap-{folder}"
        if not d.exists():
            continue
        mac_master.resize((px, px), Image.LANCZOS).save(d / "ic_launcher.png", "PNG")
        round_master.resize((px, px), Image.LANCZOS).save(d / "ic_launcher_round.png", "PNG")
        n += 1
    print(f"android  {n} density bucket(s) regenerated")

    write_web(mac_master)


if __name__ == "__main__":
    main()
