"""Generate the Jenix Lock app icon, splash and Play Store graphics.

Placeholder artwork: a white padlock on the app's blue->purple gradient.
To use a real logo later, replace draw_glyph() (or paste a logo PNG there)
and re-run:

    python app/resources/generate_icons.py

Outputs (Play Store / Android guidelines):
  android res/mipmap-*/ic_launcher.png, ic_launcher_round.png     legacy 48dp icons
  android res/mipmap-*/ic_launcher_foreground.png / _background    adaptive 108dp layers
  android res/mipmap-*/ic_launcher_monochrome.png                  Android 13 themed icon
  android res/drawable-*/splash_icon.png                           Android 12+ splash (288dp)
  android res/drawable*/splash.png (port/land)                     pre-Android-12 splash
  app/store/play-icon-512.png                                      Play listing icon (opaque)
  app/store/feature-graphic-1024x500.png                           Play feature graphic
"""

from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

APP = Path(__file__).resolve().parent.parent
RES = APP / "android" / "app" / "src" / "main" / "res"
STORE = APP / "store"

C1 = (91, 140, 255)  # top-left  (app --accent, deepened for contrast)
C2 = (139, 92, 246)  # bottom-right (app --accent2)
BG = (14, 21, 48)  # app --bg1, splash background
WHITE = (255, 255, 255, 255)
SS = 4  # supersampling factor for smooth edges

DENS = {"mdpi": 1, "hdpi": 1.5, "xhdpi": 2, "xxhdpi": 3, "xxxhdpi": 4}


def gradient(w: int, h: int) -> Image.Image:
    """Diagonal C1 -> C2 gradient, opaque."""
    small = Image.new("RGB", (64, 64))
    px = small.load()
    for y in range(64):
        for x in range(64):
            t = (x + y) / 126
            px[x, y] = tuple(round(C1[i] + (C2[i] - C1[i]) * t) for i in range(3))
    return small.resize((w, h), Image.BICUBIC).convert("RGBA")


def draw_glyph(size: int, scale: float) -> Image.Image:
    """White padlock (transparent keyhole) centred in a size x size canvas.

    `scale` = fraction of the canvas the padlock's bounding box occupies.
    """
    S = size * SS
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    box = S * scale
    ox = (S - box) / 2
    oy = (S - box) / 2

    def X(f: float) -> float:
        return ox + f * box

    def Y(f: float) -> float:
        return oy + f * box

    # Shackle: thick rounded outline; its lower half is hidden by the body.
    sw = 0.12 * box
    d.rounded_rectangle([X(0.22), Y(0.0), X(0.78), Y(0.62)], radius=0.28 * box, outline=WHITE, width=round(sw))
    # Body
    d.rounded_rectangle([X(0.08), Y(0.40), X(0.92), Y(1.0)], radius=0.12 * box, fill=WHITE)
    # Keyhole (cut out -> transparent)
    cut = Image.new("L", (S, S), 0)
    cd = ImageDraw.Draw(cut)
    r = 0.085 * box
    cx, cy = X(0.5), Y(0.64)
    cd.ellipse([cx - r, cy - r, cx + r, cy + r], fill=255)
    cd.polygon([(cx - r * 0.55, cy), (cx + r * 0.55, cy), (cx + r * 0.38, Y(0.86)), (cx - r * 0.38, Y(0.86))], fill=255)
    alpha = img.getchannel("A")
    alpha.paste(0, mask=cut)
    img.putalpha(alpha)
    return img.resize((size, size), Image.LANCZOS)


def rounded_mask(size: int, radius_frac: float) -> Image.Image:
    S = size * SS
    m = Image.new("L", (S, S), 0)
    ImageDraw.Draw(m).rounded_rectangle([0, 0, S - 1, S - 1], radius=radius_frac * S, fill=255)
    return m.resize((size, size), Image.LANCZOS)


def circle_mask(size: int) -> Image.Image:
    S = size * SS
    m = Image.new("L", (S, S), 0)
    ImageDraw.Draw(m).ellipse([0, 0, S - 1, S - 1], fill=255)
    return m.resize((size, size), Image.LANCZOS)


def icon_square(size: int, glyph_scale: float = 0.52) -> Image.Image:
    img = gradient(size, size)
    g = draw_glyph(size, glyph_scale)
    img.alpha_composite(g)
    return img


def save(img: Image.Image, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    img.save(path, optimize=True)


def font(px: int) -> ImageFont.ImageFont:
    for name in ("segoeuib.ttf", "arialbd.ttf", "DejaVuSans-Bold.ttf"):
        try:
            return ImageFont.truetype(name, px)
        except OSError:
            continue
    return ImageFont.load_default()


def main() -> None:
    # ---- launcher icons ----
    for dens, k in DENS.items():
        mip = RES / f"mipmap-{dens}"
        n = round(48 * k)
        save(Image.composite(icon_square(n), Image.new("RGBA", (n, n)), rounded_mask(n, 0.22)), mip / "ic_launcher.png")
        save(Image.composite(icon_square(n), Image.new("RGBA", (n, n)), circle_mask(n)), mip / "ic_launcher_round.png")
        a = round(108 * k)  # adaptive layer: 108dp, keep content inside the 66dp safe zone
        save(draw_glyph(a, 0.40), mip / "ic_launcher_foreground.png")
        save(draw_glyph(a, 0.40), mip / "ic_launcher_monochrome.png")
        save(gradient(a, a), mip / "ic_launcher_background.png")

    adaptive = """<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@mipmap/ic_launcher_background"/>
    <foreground android:drawable="@mipmap/ic_launcher_foreground"/>
    <monochrome android:drawable="@mipmap/ic_launcher_monochrome"/>
</adaptive-icon>
"""
    for f in ("ic_launcher.xml", "ic_launcher_round.xml"):
        (RES / "mipmap-anydpi-v26" / f).write_text(adaptive, encoding="utf-8")

    # ---- Android 12+ splash icon: 288dp canvas, content within the 192dp circle ----
    for dens, k in DENS.items():
        n = round(288 * k)
        canvas = Image.new("RGBA", (n, n), (0, 0, 0, 0))
        disc = round(160 * k)
        tile = Image.composite(icon_square(disc, 0.50), Image.new("RGBA", (disc, disc)), circle_mask(disc))
        canvas.alpha_composite(tile, ((n - disc) // 2, (n - disc) // 2))
        save(canvas, RES / f"drawable-{dens}" / "splash_icon.png")

    # ---- pre-Android-12 splash (full-screen bitmaps) ----
    def splash(w: int, h: int) -> Image.Image:
        img = Image.new("RGBA", (w, h), BG + (255,))
        s = round(min(w, h) * 0.28)
        tile = Image.composite(icon_square(s, 0.50), Image.new("RGBA", (s, s)), rounded_mask(s, 0.24))
        img.alpha_composite(tile, ((w - s) // 2, (h - s) // 2 - round(s * 0.25)))
        d = ImageDraw.Draw(img)
        f = font(round(s * 0.22))
        text = "Jenix Lock"
        tw = d.textlength(text, font=f)
        d.text(((w - tw) / 2, (h + s) / 2 - round(s * 0.10)), text, font=f, fill=(238, 241, 255, 255))
        return img

    port = {"mdpi": (320, 480), "hdpi": (480, 800), "xhdpi": (720, 1280), "xxhdpi": (960, 1600), "xxxhdpi": (1280, 1920)}
    for dens, (w, h) in port.items():
        save(splash(w, h), RES / f"drawable-port-{dens}" / "splash.png")
        save(splash(h, w), RES / f"drawable-land-{dens}" / "splash.png")
    save(splash(480, 320), RES / "drawable" / "splash.png")

    # ---- Play Store listing graphics ----
    save(icon_square(512, 0.50).convert("RGB"), STORE / "play-icon-512.png")
    fg = gradient(1024, 500)
    tile = Image.composite(icon_square(220, 0.50), Image.new("RGBA", (220, 220)), rounded_mask(220, 0.24))
    shade = Image.new("RGBA", (1024, 500), BG + (90,))
    fg.alpha_composite(shade)
    fg.alpha_composite(tile, (120, 140))
    d = ImageDraw.Draw(fg)
    d.text((390, 170), "Jenix Lock", font=font(84), fill=WHITE)
    d.text((394, 275), "Smart lock control over Wi-Fi", font=font(36), fill=(225, 230, 255, 255))
    save(fg.convert("RGB"), STORE / "feature-graphic-1024x500.png")
    print("icons, splash and store graphics written")


if __name__ == "__main__":
    main()
