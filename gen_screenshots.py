"""Generate store / README screenshot mockups (640x400) into docs/screenshots, ja + en.

`--check` renders into a temporary directory and compares with what is committed
instead of writing. Exit 1 means the two differ, exit 3 that this machine cannot
draw them.
"""
import math
import os
import sys
import tempfile

UNAVAILABLE = 3

try:
    from PIL import Image, ImageChops, ImageDraw, ImageFont
except ImportError as err:
    print(f'{err}. Install pillow to draw the screenshots.', file=sys.stderr)
    sys.exit(UNAVAILABLE)

ROOT = os.path.dirname(os.path.abspath(__file__))
OUT_DIR = os.path.join(ROOT, 'docs', 'screenshots')

W, H = 640, 400
BG = (15, 15, 35)
CARD_BG = (26, 26, 46)
SECTION_BG = (22, 33, 62)
TEAL = (78, 205, 196)
PINK = (255, 107, 157)
YELLOW = (249, 202, 36)
WHITE = (255, 255, 255)
GRAY = (136, 136, 136)
DIM = (85, 85, 85)
BORDER = (42, 42, 74)

# Japanese-capable UI faces, tried in order. The first family whose regular and
# bold both load is used for every string in the mockups.
FONT_FAMILIES = [
    ('Meiryo', 'meiryo.ttc', 'meiryob.ttc'),
    ('Hiragino Sans',
     '/System/Library/Fonts/ヒラギノ角ゴシック W3.ttc',
     '/System/Library/Fonts/ヒラギノ角ゴシック W6.ttc'),
    ('Noto Sans JP', 'NotoSansJP-Regular.otf', 'NotoSansJP-Bold.otf'),
]


def pick_family():
    for name, regular, bold in FONT_FAMILIES:
        try:
            ImageFont.truetype(regular, 12)
            ImageFont.truetype(bold, 12)
        except OSError:
            continue
        return name, regular, bold
    print('No Japanese-capable font found. Install one of: '
          + ', '.join(f[0] for f in FONT_FAMILIES), file=sys.stderr)
    sys.exit(UNAVAILABLE)


FAMILY, REGULAR, BOLD = pick_family()
FONT = ImageFont.truetype(REGULAR, 14)
FONT_SM = ImageFont.truetype(REGULAR, 11)
FONT_LG = ImageFont.truetype(REGULAR, 18)
FONT_XL = ImageFont.truetype(BOLD, 22)
FONT_TITLE = ImageFont.truetype(BOLD, 15)
FONT_BOLD = ImageFont.truetype(BOLD, 14)
FONT_XS = ImageFont.truetype(REGULAR, 9)


def rr(draw, box, radius, fill):
    draw.rounded_rectangle(box, radius=radius, fill=fill)


# Icons are drawn, not typed: the symbol glyphs for a gear and a fullscreen box
# are missing from some of the font families above and would land as tofu.

def gear(draw, cx, cy, r, color):
    ring = r * 0.72
    for i in range(8):
        a = i * math.pi / 4
        draw.line([(cx + math.cos(a) * ring, cy + math.sin(a) * ring),
                   (cx + math.cos(a) * r, cy + math.sin(a) * r)], fill=color, width=3)
    draw.ellipse([cx - ring, cy - ring, cx + ring, cy + ring], outline=color, width=3)


def fullscreen(draw, cx, cy, size, color):
    h = size / 2
    arm = size / 3
    for sx in (-1, 1):
        for sy in (-1, 1):
            x, y = cx + h * sx, cy + h * sy
            draw.line([(x, y), (x - arm * sx, y)], fill=color, width=2)
            draw.line([(x, y), (x, y - arm * sy)], fill=color, width=2)


def toggle(draw, x, y, on):
    """The extension's 36x20 switch: dark track, knob left when off, teal right when on."""
    draw.rounded_rectangle([x, y, x+36, y+20], radius=10, fill=(27, 58, 75) if on else BORDER)
    knob_x = x + 19 if on else x + 3
    draw.ellipse([knob_x, y+3, knob_x+14, y+17], fill=TEAL if on else GRAY)


def fit_value_font(draw, cards, max_w):
    """Largest bold size at which every card's value + unit still fits its card."""
    for size in (22, 20, 18, 17, 16, 15, 14):
        font = ImageFont.truetype(BOLD, size)
        if all(draw.textlength(val, font=font) + draw.textlength(unit, font=FONT_XS) <= max_w
               for _, val, unit, _ in cards):
            return font
    raise SystemExit(f'{FAMILY} draws these wider than the {max_w}px card at every size: '
                     + ', '.join(f'{val} {unit}' for _, val, unit, _ in cards))


# ── Localized strings ────────────────────────────────────────────────

STRINGS = {
    'ja': {
        'apply': '63% をチャンネルに適用 (Video)',
        'auto_label': 'LUFS 自動適用',
        'manual': 'MANUAL VOLUME',
        'target_desc': 'Loudness から算出するゲインの基準値',
        'all_auto_label': '全チャンネルの LUFS 自動適用',
        'all_auto_desc': '個別設定がないチャンネルの既定値',
        'unit_label': '表示単位',
        'unit_desc': 'ゲイン値の表示形式',
        'overlay_label': 'ゲイン表示',
        'overlay_desc': 'プレイヤーの音量バー横に適用中のゲインを表示',
        'clear_all': '全削除',
        'video_title': 'Sample Ch. - ピアノカバー集',
        'video_channel': 'Sample Ch.',
        'channels': [
            ('Game Stream TV', '63%', '80%'),
            ('ピアノch.', '120%', '\u2014'),
            ('Music Box', '55%', '70%'),
        ],
    },
    'en': {
        'apply': 'Apply 63% to channel (Video)',
        'auto_label': 'Auto-apply LUFS',
        'manual': 'MANUAL VOLUME',
        'target_desc': 'Reference level for gain calculation from Loudness',
        'all_auto_label': 'Auto-apply LUFS for all channels',
        'all_auto_desc': 'Default for channels without an individual setting',
        'unit_label': 'Display unit',
        'unit_desc': 'Format for gain values',
        'overlay_label': 'Gain overlay',
        'overlay_desc': 'Show applied gain next to the volume bar in the player',
        'clear_all': 'Clear all',
        'video_title': 'Sample Ch. - Piano Cover Collection',
        'video_channel': 'Sample Ch.',
        'channels': [
            ('Game Stream TV', '63%', '80%'),
            ('Piano ch.', '120%', '\u2014'),
            ('Music Box', '55%', '70%'),
        ],
    },
}


def screenshot_popup(lang):
    s = STRINGS[lang]
    img = Image.new('RGB', (W, H), BG)
    draw = ImageDraw.Draw(img)

    px, py = 170, 30
    pw, ph = 300, 340
    rr(draw, [px, py, px+pw, py+ph], 10, CARD_BG)

    # Header
    draw.text((px+16, py+12), 'YT Channel Volume', fill=TEAL, font=FONT_TITLE)
    gear(draw, px+pw-24, py+22, 8, GRAY)
    draw.line([(px, py+38), (px+pw, py+38)], fill=BORDER)

    # Info section
    iy = py + 42
    rr(draw, [px, iy, px+pw, iy+100], 0, SECTION_BG)
    draw.text((px+16, iy+10), 'Sample Ch.', fill=WHITE, font=FONT_BOLD)

    # Cards
    cards = [
        ('LOUDNESS', '-18.2', 'LUFS', TEAL),
        ('SUGGESTED', '63', '%', YELLOW),
        ('CURRENT', '63', '%', PINK),
    ]
    card_w, gap = 88, 6
    value_font = fit_value_font(draw, cards, card_w - 14)
    unit_dy = value_font.getmetrics()[0] - FONT_XS.getmetrics()[0]
    cx = px + 12
    for label, val, unit, color in cards:
        rr(draw, [cx, iy+38, cx+card_w, iy+88], 6, CARD_BG)
        draw.text((cx+8, iy+42), label, fill=GRAY, font=FONT_XS)
        draw.text((cx+8, iy+56), val, fill=color, font=value_font)
        draw.text((cx+8+draw.textlength(val, font=value_font), iy+56+unit_dy), unit,
                  fill=GRAY, font=FONT_XS)
        cx += card_w + gap

    draw.line([(px, iy+100), (px+pw, iy+100)], fill=BORDER)

    # Per-channel automatic LUFS, off here — that is what leaves the apply
    # button and the slider below it usable.
    ay = iy + 100
    draw.text((px+16, ay+11), s['auto_label'], fill=(204, 204, 204), font=FONT_SM)
    toggle(draw, px+pw-52, ay+8, on=False)
    draw.line([(px, ay+36), (px+pw, ay+36)], fill=BORDER)

    # Apply button
    by = iy + 144
    rr(draw, [px+16, by, px+pw-16, by+32], 6, TEAL)
    tw = draw.textlength(s['apply'], font=FONT_BOLD)
    draw.text((px + (pw - tw) / 2, by+7), s['apply'], fill=CARD_BG, font=FONT_BOLD)
    draw.line([(px, by+42), (px+pw, by+42)], fill=BORDER)

    # Manual Volume
    my = by + 50
    draw.text((px+16, my), s['manual'], fill=GRAY, font=FONT_SM)
    sy = my + 22
    draw.rounded_rectangle([px+16, sy+6, px+pw-60, sy+12], radius=3, fill=BORDER)
    thumb_x = int(px+16 + (pw-76) * 0.63)
    draw.ellipse([thumb_x-7, sy+2, thumb_x+7, sy+16], fill=PINK)
    draw.text((px+pw-50, sy-1), '63%', fill=PINK, font=FONT_BOLD)

    # Presets
    presets = ['0%', '50%', '100%', '200%', '400%', 'MAX']
    bx = px + 16
    for p in presets:
        bw = 42
        rr(draw, [bx, sy+24, bx+bw, sy+42], 4, BORDER)
        ptw = draw.textlength(p, font=FONT_SM)
        draw.text((bx + (bw-ptw)/2, sy+27), p, fill=GRAY, font=FONT_SM)
        bx += bw + 4

    return img


def screenshot_settings(lang):
    s = STRINGS[lang]
    img = Image.new('RGB', (W, H), BG)
    draw = ImageDraw.Draw(img)

    draw.text((36, 16), 'YT Channel Volume', fill=TEAL, font=FONT_XL)

    # Settings section \u2014 the four rows options.html lays out, in its order
    sy = 54
    rr(draw, [30, sy, 610, sy+186], 10, CARD_BG)
    draw.text((50, sy+12), 'SETTINGS', fill=GRAY, font=FONT_SM)

    ry = sy + 34
    for label, desc in ((('Target LUFS'), s['target_desc']),
                        (s['all_auto_label'], s['all_auto_desc']),
                        (s['unit_label'], s['unit_desc']),
                        (s['overlay_label'], s['overlay_desc'])):
        draw.text((50, ry), label, fill=(204, 204, 204), font=FONT)
        draw.text((50, ry+17), desc, fill=DIM, font=FONT_SM)
        ry += 38

    # Target LUFS slider
    ry = sy + 34
    draw.rounded_rectangle([400, ry+5, 520, ry+11], radius=2, fill=BORDER)
    draw.ellipse([452, ry, 468, ry+16], fill=TEAL)
    draw.text((530, ry), '-18 LUFS', fill=TEAL, font=FONT_BOLD)

    # Video / Live defaults, both off
    ry += 38
    for type_label, x in ((('VIDEO'), 424), ('LIVE', 512)):
        draw.text((x, ry+4), type_label, fill=GRAY, font=FONT_SM)
        toggle(draw, x+42, ry, on=False)

    # Display unit
    ry += 38
    rr(draw, [520, ry, 556, ry+20], 6, TEAL)
    draw.text((528, ry+3), '%', fill=CARD_BG, font=FONT_BOLD)
    rr(draw, [556, ry, 590, ry+20], 6, SECTION_BG)
    draw.text((562, ry+3), 'dB', fill=GRAY, font=FONT_BOLD)

    # Gain overlay, on here \u2014 it is what the overlay screenshot shows
    ry += 38
    toggle(draw, 554, ry, on=True)

    # Saved Channels section
    cy = sy + 200
    rr(draw, [30, cy, 610, cy+134], 10, CARD_BG)
    draw.text((50, cy+12), 'SAVED CHANNELS', fill=GRAY, font=FONT_SM)
    clear_w = draw.textlength(s['clear_all'], font=FONT_SM)
    draw.text((590-clear_w, cy+12), s['clear_all'], fill=PINK, font=FONT_SM)

    hy = cy + 34
    draw.text((50, hy), 'CHANNEL', fill=DIM, font=FONT_SM)
    draw.text((380, hy), 'VIDEO', fill=DIM, font=FONT_SM)
    draw.text((470, hy), 'LIVE', fill=DIM, font=FONT_SM)
    draw.line([(50, hy+16), (590, hy+16)], fill=BORDER)

    ry = hy + 24
    for name, video, live in s['channels']:
        draw.text((50, ry), name, fill=TEAL, font=FONT)
        draw.text((380, ry), video, fill=PINK, font=FONT_BOLD)
        draw.text((470, ry), live, fill=PINK if live != '\u2014' else DIM, font=FONT_BOLD)
        draw.text((570, ry-4), '\u00d7', fill=DIM, font=FONT_LG)
        ry += 26

    return img


def screenshot_overlay(lang):
    s = STRINGS[lang]
    img = Image.new('RGB', (W, H), (24, 24, 24))
    draw = ImageDraw.Draw(img)

    draw.rectangle([0, 0, W, H-50], fill=(18, 18, 18))

    draw.text((W//2-80, H//2-40), '\u25b6  YouTube Player', fill=(60, 60, 60), font=FONT_LG)

    bar_y = H - 50
    draw.rectangle([0, bar_y, W, H], fill=(33, 33, 33))
    draw.rectangle([0, bar_y, W, bar_y+3], fill=(60, 60, 60))
    draw.rectangle([0, bar_y, int(W*0.35), bar_y+3], fill=(255, 0, 0))

    cy = bar_y + 18
    draw.polygon([(20, cy-8), (20, cy+8), (34, cy)], fill=WHITE)
    draw.text((50, cy-7), '3:24 / 10:15', fill=WHITE, font=FONT_SM)

    vx = 160
    draw.rectangle([vx, cy-5, vx+4, cy+5], fill=WHITE)
    draw.polygon([(vx+4, cy-5), (vx+12, cy-10), (vx+12, cy+10), (vx+4, cy+5)], fill=WHITE)
    draw.rounded_rectangle([vx+18, cy-1, vx+80, cy+1], radius=1, fill=(100, 100, 100))
    draw.rounded_rectangle([vx+18, cy-1, vx+55, cy+1], radius=1, fill=WHITE)
    draw.ellipse([vx+52, cy-4, vx+60, cy+4], fill=WHITE)

    # Gain overlay
    draw.text((vx+88, cy-8), '63%', fill=TEAL, font=FONT_BOLD)

    # Annotation
    label = '\u2193 Gain overlay' if lang == 'en' else '\u2193 \u30b2\u30a4\u30f3\u8868\u793a'
    draw.text((vx+78, cy-34), label, fill=TEAL, font=FONT_BOLD)

    gear(draw, W-93, cy, 8, WHITE)
    fullscreen(draw, W-63, cy, 15, WHITE)

    draw.text((20, 20), s['video_title'], fill=WHITE, font=FONT_LG)
    draw.text((20, 48), s['video_channel'], fill=GRAY, font=FONT)

    return img


SHEETS = {
    'popup': screenshot_popup,
    'settings': screenshot_settings,
    'overlay': screenshot_overlay,
}
LANGS = ('ja', 'en')


def render_all():
    return {f'{sheet}_{lang}.png': render(lang)
            for lang in LANGS for sheet, render in SHEETS.items()}


def write(images, target):
    os.makedirs(target, exist_ok=True)
    for name, img in images.items():
        img.save(os.path.join(target, name))
        print(f'Generated {os.path.relpath(os.path.join(target, name), ROOT)}')


def check(images):
    """Compare what the code draws now with what is committed, pixel by pixel."""
    stale = []
    scratch = tempfile.mkdtemp()
    try:
        for name, img in images.items():
            fresh = os.path.join(scratch, name)
            img.save(fresh)
            committed = os.path.join(OUT_DIR, name)
            if not os.path.exists(committed):
                stale.append(f'{name}: not committed')
            elif ImageChops.difference(Image.open(fresh).convert('RGB'),
                                       Image.open(committed).convert('RGB')).getbbox():
                stale.append(f'{name}: differs from what the code draws now')
    finally:
        for name in os.listdir(scratch):
            os.remove(os.path.join(scratch, name))
        os.rmdir(scratch)

    for name in sorted(os.listdir(OUT_DIR)):
        if name not in images:
            stale.append(f'{name}: in {os.path.relpath(OUT_DIR, ROOT)} but drawn by nothing')

    for line in stale:
        print(line, file=sys.stderr)
    if stale:
        print(f'Run `python3 {os.path.basename(__file__)}` and commit the result.',
              file=sys.stderr)
        return 1
    print(f'{len(images)} screenshots match the code that draws them.')
    return 0


print(f'Font: {FAMILY}')
if '--check' in sys.argv[1:]:
    sys.exit(check(render_all()))
write(render_all(), OUT_DIR)
