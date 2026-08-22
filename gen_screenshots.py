"""Generate Chrome Web Store screenshot mockups (640x400), ja + en."""
import math

from PIL import Image, ImageDraw, ImageFont

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
    raise SystemExit('No Japanese-capable font found. Install one of: '
                     + ', '.join(f[0] for f in FONT_FAMILIES))


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


def fit_value_font(draw, cards, max_w):
    """Largest bold size at which every card's value + unit still fits its card."""
    for size in (22, 20, 18, 17, 16, 15, 14):
        font = ImageFont.truetype(BOLD, size)
        if all(draw.textlength(val, font=font) + draw.textlength(unit, font=FONT_XS) <= max_w
               for _, val, unit, _ in cards):
            return font
    return ImageFont.truetype(BOLD, 14)


# ── Localized strings ────────────────────────────────────────────────

STRINGS = {
    'ja': {
        'apply': '63% をチャンネルに適用 (Video)',
        'manual': 'MANUAL VOLUME',
        'target_desc': 'Loudness から算出するゲインの基準値',
        'unit_label': '表示単位',
        'unit_desc': 'ゲイン値の表示形式',
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
        'manual': 'MANUAL VOLUME',
        'target_desc': 'Reference level for gain calculation from Loudness',
        'unit_label': 'Display unit',
        'unit_desc': 'Format for gain values',
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

    # Apply button
    by = iy + 108
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

    img.save(f'screenshots/popup_{lang}.png')
    print(f'Generated screenshots/popup_{lang}.png')


def screenshot_settings(lang):
    s = STRINGS[lang]
    img = Image.new('RGB', (W, H), BG)
    draw = ImageDraw.Draw(img)

    draw.text((40, 24), 'YT Channel Volume', fill=TEAL, font=FONT_XL)

    # Settings section
    sy = 70
    rr(draw, [30, sy, 610, sy+130], 10, CARD_BG)
    draw.text((50, sy+16), 'SETTINGS', fill=GRAY, font=FONT_SM)

    # Target LUFS
    draw.text((50, sy+40), 'Target LUFS', fill=(204, 204, 204), font=FONT)
    draw.text((50, sy+58), s['target_desc'], fill=DIM, font=FONT_SM)
    draw.rounded_rectangle([380, sy+45, 520, sy+51], radius=2, fill=BORDER)
    draw.ellipse([440, sy+40, 456, sy+56], fill=TEAL)
    draw.text((530, sy+40), '-18 LUFS', fill=TEAL, font=FONT_BOLD)

    draw.line([(50, sy+80), (590, sy+80)], fill=BORDER)

    # Display unit
    draw.text((50, sy+88), s['unit_label'], fill=(204, 204, 204), font=FONT)
    draw.text((50, sy+106), s['unit_desc'], fill=DIM, font=FONT_SM)
    rr(draw, [520, sy+92, 556, sy+112], 6, TEAL)
    draw.text((528, sy+95), '%', fill=CARD_BG, font=FONT_BOLD)
    rr(draw, [556, sy+92, 590, sy+112], 6, SECTION_BG)
    draw.text((562, sy+95), 'dB', fill=GRAY, font=FONT_BOLD)

    # Saved Channels section
    cy = sy + 150
    rr(draw, [30, cy, 610, cy+170], 10, CARD_BG)
    draw.text((50, cy+16), 'SAVED CHANNELS', fill=GRAY, font=FONT_SM)

    hy = cy + 40
    draw.text((50, hy), 'CHANNEL', fill=DIM, font=FONT_SM)
    draw.text((380, hy), 'VIDEO', fill=DIM, font=FONT_SM)
    draw.text((470, hy), 'LIVE', fill=DIM, font=FONT_SM)
    draw.line([(50, hy+18), (590, hy+18)], fill=BORDER)

    ry = hy + 24
    for name, video, live in s['channels']:
        draw.text((50, ry), name, fill=TEAL, font=FONT)
        draw.text((380, ry), video, fill=PINK, font=FONT_BOLD)
        draw.text((470, ry), live, fill=PINK if live != '\u2014' else DIM, font=FONT_BOLD)
        draw.text((570, ry), '\u00d7', fill=DIM, font=FONT_LG)
        ry += 36

    img.save(f'screenshots/settings_{lang}.png')
    print(f'Generated screenshots/settings_{lang}.png')


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

    img.save(f'screenshots/overlay_{lang}.png')
    print(f'Generated screenshots/overlay_{lang}.png')


print(f'Font: {FAMILY}')
for lang in ('ja', 'en'):
    screenshot_popup(lang)
    screenshot_settings(lang)
    screenshot_overlay(lang)
