"""Generate store / README screenshot mockups (640x400) into docs/screenshots, ja + en.

`--check` renders into a temporary directory and compares with what is committed
instead of writing. Exit 1 means the two differ, exit 3 that this machine cannot
draw them. `--out <dir>` writes the six there instead of into docs/screenshots;
a destination handed over that cannot be written is exit 2, where the tracked
one is exit 1.
"""
import hashlib
import math
import os
import shutil
import stat
import sys
import tempfile
import zlib

UNAVAILABLE = 3

try:
    from PIL import Image, ImageDraw, ImageFont, __version__ as PIL_VERSION, features
except ImportError as err:
    # Not the end of the run: an argument that is wrong deserves the answer for
    # arguments (2), not the one for a machine that cannot draw (3).
    CANNOT_DRAW = f'{err}. Install pillow to draw the screenshots.'
else:
    CANNOT_DRAW = None

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

# The one face these mockups are drawn with, committed under tools/fonts so that
# every machine and the CI runner rasterize the same bytes.
FAMILY = 'M PLUS 1p'
FONT_DIR = os.path.join(ROOT, 'tools', 'fonts')
REGULAR = os.path.join(FONT_DIR, 'MPLUS1p-Regular.ttf')
BOLD = os.path.join(FONT_DIR, 'MPLUS1p-Bold.ttf')

def face(path, size):
    """Basic layout on every machine: pillow reaches for raqm where it is
    installed, and the two engines place these strings differently."""
    try:
        return ImageFont.truetype(path, size, layout_engine=ImageFont.Layout.BASIC)
    except OSError as err:
        # Which of the two faces failed is not in what was raised.
        raise OSError(err.errno or 0, str(err), path) from err


# The faces resolve where pillow is here, and a face that will not read is kept
# the same way pillow's absence is: the arguments are answered first.
if CANNOT_DRAW is None:
    try:
        FONT = face(REGULAR, 14)
        FONT_SM = face(REGULAR, 11)
        FONT_LG = face(REGULAR, 18)
        FONT_XL = face(BOLD, 22)
        FONT_TITLE = face(BOLD, 15)
        FONT_BOLD = face(BOLD, 14)
        FONT_XS = face(REGULAR, 9)
    except OSError as err:
        CANNOT_DRAW = (f'{os.path.relpath(err.filename, ROOT)} cannot be read ({err.strerror}). '
                       'The screenshots in docs/screenshots are drawn with this face, and '
                       'another one redraws all six.')


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
        font = face(BOLD, size)
        if all(draw.textlength(val, font=font) + draw.textlength(unit, font=FONT_XS) <= max_w
               for _, val, unit, _ in cards):
            return font
    # Nothing this machine can draw fits, which is the same answer as a
    # missing face rather than a difference between images.
    print(f'{FAMILY} draws these wider than the {max_w}px card at every size: '
          + ', '.join(f'{val} {unit}' for _, val, unit, _ in cards), file=sys.stderr)
    sys.exit(UNAVAILABLE)


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

    # .clear-all-btn at rest: grey on a bordered 4px-radius box, 4px 10px padding
    clear_w = draw.textlength(s['clear_all'], font=FONT_SM)
    draw.rounded_rectangle([590-clear_w-20, cy+6, 590, cy+28], radius=4, outline=BORDER)
    draw.text((590-clear_w-10, cy+11), s['clear_all'], fill=GRAY, font=FONT_SM)

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


USAGE = f'usage: {os.path.basename(__file__)} [--check] [--out <dir>]'


def target_dir(args):
    """(where to write, whether --out named it). No --out is docs/screenshots.

    An argument this does not know is an error rather than a default: `--chek`
    reaching the write path overwrites the images the run was meant to read,
    which is the staleness it was called to find.
    """
    target = None
    checking = False
    rest = list(args)
    while rest:
        arg = rest.pop(0)
        if arg == '--check':
            checking = True
            continue
        if arg == '--out':
            # A value that looks like a flag is a missing value, not a
            # directory: `--out --chek` used to create one called --chek.
            if not rest or not rest[0] or rest[0].startswith('-'):
                print(f'--out needs a directory to write into\n{USAGE}', file=sys.stderr)
                sys.exit(2)
            if target is not None:
                # Told twice and taking the second drops the first without
                # saying anything about it.
                print(f'--out takes one destination\n{USAGE}', file=sys.stderr)
                sys.exit(2)
            given = rest.pop(0)
            blocked = cannot_hold_images(given if os.path.isabs(given)
                                         else os.path.join(os.getcwd(), given))
            if blocked:
                # A destination that cannot become a directory is the argument
                # being wrong, not the images differing. Unchecked, os.makedirs
                # raises and exit 1 says "they differ".
                print(f'--out has nowhere to write: {blocked} is not a directory\n{USAGE}',
                      file=sys.stderr)
                sys.exit(2)
            # Where the kernel lands: abspath folds `link/..` by the text and
            # would write beside the link while the check read what it points
            # into.
            target = where_it_lands(given if os.path.isabs(given)
                                    else os.path.join(os.getcwd(), given))
            continue
        print(f'unknown argument: {arg}\n{USAGE}', file=sys.stderr)
        sys.exit(2)
    if checking and target is not None:
        # --check reads docs/screenshots and writes nothing, so a destination
        # given alongside it would be dropped without saying so.
        print(f'--check compares the committed screenshots and writes nothing, '
              f'so --out has nowhere to go\n{USAGE}', file=sys.stderr)
        sys.exit(2)
    return (OUT_DIR, False) if target is None else (target, True)


def under_root(target):
    """Whether a path can be shown relative to the repository."""
    try:
        return os.path.commonpath([ROOT, os.path.abspath(target)]) == ROOT
    except ValueError:
        # Windows: a path on another drive shares nothing with ROOT.
        return False


# What a name that could not be put back was, said in its own words: "the
# previous image" is only true of a name that had one.
KEPT_AS = {
    'file': 'what was there cannot be put back',
    'absent': "this run's image cannot be taken back out",
}


def put_back(backup, target, replaced, was_there):
    """Undo the replacements already made. Returns what it could not undo.

    Every name is tried to the end: stopping at the first refusal leaves the
    names after it holding this run's image, and says nothing about them.
    """
    left = []
    for name in replaced:
        kind = 'file' if name in was_there else 'absent'
        try:
            if kind == 'file':
                shutil.copy2(os.path.join(backup, name), os.path.join(target, name))
            elif os.path.lexists(os.path.join(target, name)):
                os.remove(os.path.join(target, name))
        except OSError as sweeping:
            left.append((name, kind, sweeping.strerror))
    return left


def clear_away(backup, shown):
    """Take the copy away. Returns what it could not do, or None."""
    try:
        shutil.rmtree(backup)
    except OSError as err:
        return f'{shown(backup)} is left behind ({err.strerror})'
    return None


def what_was_left(left, backup, shown):
    """The lines for what could not be put back, and whether the copy is owed.

    Only a name that had a plain file has anything in the copy: a name that had
    nothing there is offered nothing by keeping it.
    """
    told = [f'{name}: {KEPT_AS[kind]} ({why})' for name, kind, why in left]
    keep = any(kind == 'file' for _, kind, _ in left)
    if keep:
        told.append(f'what was there is kept in {shown(backup)}')
    return told, keep


def replace_them(images, target, backup, named, shown):
    """Replace the names, putting back what was replaced if it cannot finish.

    Returns (exit code, whether the copy is still owed to the reader). What
    stops the run is not only the filesystem refusing a save: a progress line
    that cannot be printed and an interrupt both arrive once names have been
    replaced, and those are put back from the copy too before being raised on.
    """
    was_there = []
    for name in sorted(images):
        path = os.path.join(target, name)
        if not os.path.lexists(path):
            continue
        try:
            shutil.copy2(path, os.path.join(backup, name))
        except OSError as err:
            # Not being able to read it is not the same as not being able to
            # write it, and nothing has been replaced yet.
            return refused_to_write(
                named, f'{shown(path)} cannot be read ({err.strerror})'), False
        was_there.append(name)
    replaced = []
    try:
        for name, img in images.items():
            path = os.path.join(target, name)
            beside = None
            # Written down before the replace is attempted: one interrupted
            # once the name has been taken is still one to put back.
            replaced.append(name)
            try:
                # Written beside the name and moved onto it: os.replace puts the
                # file where the name is rather than where a link would lead, and a
                # run that stops partway leaves the name it has not reached alone.
                # Making that file is inside the boundary too — a directory that
                # exists and will not take one answers here rather than by raising.
                handle = tempfile.NamedTemporaryFile(dir=target, prefix=f'.{name}.', suffix='.tmp',
                                                     delete=False)
                beside = handle.name
                handle.close()
                img.save(beside, format='PNG')
                os.replace(beside, path)
            except OSError as err:
                left = put_back(backup, target, replaced, was_there)
                told, keep = what_was_left(left, backup, shown)
                return refused_to_write(
                    named,
                    '\n'.join([f'{shown(path)} cannot be written ({err.strerror})'] + told)), keep
            finally:
                # After os.replace there is nothing at that name; anything that
                # stops the run before it leaves a file beside the name.
                # Clearing it away is its own thing that can fail, and it is
                # never the failure to report: raising here would bury the one
                # that stopped the run and take the exit code with it.
                if beside is not None and os.path.lexists(beside):
                    try:
                        os.remove(beside)
                    except OSError as sweeping:
                        print(f'{shown(beside)} is left behind ({sweeping.strerror})',
                              file=sys.stderr)
            print(f'Generated {shown(path)}')
    except BaseException:
        # Not the filesystem refusing a save — the progress line, an interrupt.
        # The names already replaced are no more this run's to leave behind
        # than they would be for a refusal, and this one is raised on, so the
        # copy is dealt with here.
        left = put_back(backup, target, replaced, was_there)
        told, keep = what_was_left(left, backup, shown)
        for line in told:
            print(line, file=sys.stderr)
        if not keep:
            gone = clear_away(backup, shown)
            if gone:
                print(gone, file=sys.stderr)
        raise
    return 0, False


def refused_to_write(named, why):
    """Say it, and answer whoever is being answered.

    --out was handed its destination, so a refusal there is the answer for
    arguments (2); the tracked directory is this run failing to finish (1).
    Which one it is follows what was handed over rather than where the run
    landed: --out naming docs/screenshots is still someone reading back the
    argument they wrote.
    """
    print(why, file=sys.stderr)
    if not named:
        return 1
    print(USAGE, file=sys.stderr)
    return 2


def write(images, target, named=False):
    if not named:
        bad = not_a_directory(target)
        if bad:
            # Writing through a link reports docs/screenshots for bytes that
            # landed outside the tree. Only the tracked destination is asked:
            # --out has cannot_hold_images looking at what it was handed.
            print(f'{bad[0]}: {bad[1]}', file=sys.stderr)
            print(f'Make {bad[0]} a directory again, then draw them.', file=sys.stderr)
            return 1
    inside = under_root(target)

    def shown(path):
        return os.path.relpath(path, ROOT) if inside else path

    try:
        os.makedirs(target, exist_ok=True)
    except OSError as err:
        # The shape of the path was walked before this; what is left is what
        # the filesystem says when asked to make it.
        return refused_to_write(named, f'{shown(target)} cannot be made ({err.strerror})')
    # A name that is not a plain file is not written through: img.save follows
    # a link and puts a PNG wherever it points, leaving the link in place — so
    # the run reports six images written while one of them went somewhere else
    # entirely, and every check afterwards says the same thing again.
    standing = [(name, not_a_plain_file(os.path.join(target, name))) for name in sorted(images)
                if os.path.lexists(os.path.join(target, name))]
    standing = [(name, why) for name, why in standing if why]
    if standing:
        for name, why in standing:
            print(f'{shown(os.path.join(target, name))}: {why}', file=sys.stderr)
        print('Delete: ' + ' '.join(shown(os.path.join(target, name)) for name, _ in standing),
              file=sys.stderr)
        return 1
    # Six names are replaced one at a time, so a run that stops among them
    # leaves some of the images from this run and the rest from the last one.
    # A copy of what is about to be overwritten is taken first, and every name
    # already replaced is put back from it. Only plain files are ever
    # overwritten — anything else was turned down above — so the copy is what
    # was there, and a name that had nothing is put back by taking it away.
    try:
        backup = tempfile.mkdtemp(dir=target)
    except OSError as err:
        # The first thing this run asks of the directory. A traceback here is
        # exit 1, which is the answer for images that differ.
        return refused_to_write(named, f'{shown(target)} cannot be written ({err.strerror})')
    answer, keep = replace_them(images, target, backup, named, shown)
    if keep:
        # Named in what was said, so it stays where the reader was sent.
        return answer
    told = clear_away(backup, shown)
    if told is None:
        return answer
    if answer:
        # The run already has its answer; this is the other thing that happened.
        print(told, file=sys.stderr)
        return answer
    # Exit 0 says this directory holds the six and nothing else, and --check
    # counts .png files, so nothing downstream would say this either.
    return refused_to_write(named, told)


def path_parts(rest, sep=os.sep, altsep=os.altsep):
    """The names in a path. Windows separates with / as well (pass splitdrive'd)."""
    if altsep:
        rest = rest.replace(altsep, sep)
    return [part for part in rest.split(sep) if part]


def walk_for_a_place(path):
    """Walk the names as given; the first one that is not a directory, if any."""
    drive, rest = os.path.splitdrive(path)
    at = drive + os.sep
    for part in path_parts(rest):
        at = os.path.join(at, part)
        if not os.path.lexists(at):
            # Everything from here on is created.
            return None
        if not os.path.isdir(at):
            return at
    return None


def where_it_lands(path):
    """Where the kernel arrives, with the last name left as written.

    A link on the way is followed — `link/..` is the parent of what the link
    points into, not the directory the link sits in. The last name is left
    alone so that a link pointing nowhere is not swapped for what it names.
    """
    return os.path.join(os.path.realpath(os.path.dirname(path)), os.path.basename(path))


def cannot_hold_images(path):
    """What stands in the way of writing there, if anything.

    The names are walked as given: abspath folds `afile/..` away first, and the
    file in the middle never reaches the check. Where the kernel lands is
    walked too, since a `..` after a name that is not there yet walks back onto
    one that is. lexists, not exists: a link that points nowhere is invisible to
    the second and reaches os.makedirs all the same.
    """
    return walk_for_a_place(path) or walk_for_a_place(where_it_lands(path))


def not_a_directory(path):
    """The first name from ROOT to path that is not a directory, and why.

    lstat answers for the last name in a path only, so a link one level up
    hides everything under it: a repository records a link, not the six images.
    """
    at = ROOT
    for part in path_parts(os.path.relpath(path, ROOT)):
        at = os.path.join(at, part)
        if not os.path.lexists(at):
            # Nothing committed here is reported image by image.
            return None
        mode = os.lstat(at).st_mode
        if stat.S_ISLNK(mode):
            return os.path.relpath(at, ROOT), f'a symbolic link (points at {os.readlink(at)})'
        if not stat.S_ISDIR(mode):
            return os.path.relpath(at, ROOT), 'not a directory'
    return None


def not_a_plain_file(path):
    """Why the committed name is not a file of its own, if it is not.

    Generating writes plain files. os.path.exists, Image.open, open and
    os.path.isfile all read through a link, so a link holding the same bytes
    matches down to the pixels — while what a repository records for it is the
    path it names.
    """
    mode = os.lstat(path).st_mode
    if stat.S_ISREG(mode):
        return None
    if stat.S_ISLNK(mode):
        return f'a symbolic link (points at {os.readlink(path)})'
    return 'not a file'


def is_directory(path):
    """Whether the name itself is a directory. A link counts as a link.

    os.path.isdir reads through a link, which drops a .png pointing at a
    directory out of the listing the way an interrupted run's staging is.
    """
    return stat.S_ISDIR(os.lstat(path).st_mode)


def header_size(kinds):
    """The size IHDR claims, or None where there is no IHDR."""
    for kind, _, first in kinds:
        if kind == 'IHDR':
            return int.from_bytes(first[0:4], 'big'), int.from_bytes(first[4:8], 'big')
    return None


def pixel_stream_fault(stream, pending, unpacked, cap, saw_idat, spare_after):
    """Where the scanline stream does not line up with the end of the IDATs."""
    if not saw_idat:
        return None
    if pending or (cap is not None and unpacked >= cap):
        return 'more to unpack after the scanlines'
    if not stream.eof:
        return 'the IDAT stream does not end'
    spare = len(stream.unused_data) + spare_after
    if spare:
        return f'{spare} bytes after the end of the IDAT stream'
    return None


def png_shape(path, expected=None, block=1 << 16):
    """The chunks in order, the unpacked scanline length, and what does not read.

    The chunks come back as (kind, digest of the body, first 16 bytes); IDAT
    carries no body — pixels are compared as pixels, and how they were packed
    is the compressor's business, so a run of IDAT folds into one entry.

    expected is the drawn image's scanline length. Given one, unpacking stops
    there; it is left out only when measuring what this run just wrote.

    A decoder decides the format from the content, stops at IEND, skips the
    chunks it does not know and stops once the scanlines are complete — so what
    is wrong with a file often reaches neither the pixels nor the size. The file
    is read a block at a time: the CRC, the digests and the unpacking all carry
    on from where they were, so the size of what is read is not the size of what
    is held.
    """
    kinds, unpacked, saw_idat, spare_after = [], 0, False, 0
    stream = zlib.decompressobj()
    cap = None if expected is None else expected + 1
    pending = b''
    with open(path, 'rb') as handle:
        size = os.fstat(handle.fileno()).st_size
        if handle.read(8) != b'\x89PNG\r\n\x1a\n':
            return [], 0, 'not a PNG'
        at = 8
        while True:
            head = handle.read(8)
            if len(head) < 8:
                return kinds, unpacked, 'no IEND'
            length = int.from_bytes(head[:4], 'big')
            raw = head[4:8]
            kind = raw.decode('ascii', 'replace')
            # A type is four letters, and a lowercase third one is the reserved
            # bit, which the spec has given no meaning. Either one reads as a
            # file and is not a PNG.
            if not all(0x41 <= byte <= 0x5a or 0x61 <= byte <= 0x7a for byte in raw):
                return kinds, unpacked, f'a chunk type at byte {at} that is not four letters ({raw!r})'
            if raw[2] & 0x20:
                return kinds, unpacked, f'{kind} has the reserved bit set'
            crc, digest, first = zlib.crc32(raw), hashlib.sha256(), b''
            left = length
            while left:
                piece = handle.read(min(block, left))
                if not piece:
                    return kinds, unpacked, f'{kind} runs past the end of the file'
                left -= len(piece)
                crc = zlib.crc32(piece, crc)
                if kind != 'IDAT':
                    digest.update(piece)
                    first += piece[:16 - len(first)]
                    continue
                saw_idat = True
                if stream.eof:
                    # The stream is over. What follows is counted, not handed
                    # over: zlib would keep appending it to unused_data, and the
                    # size of the file would become the size of this run.
                    spare_after += len(piece)
                    continue
                room = None if cap is None else cap - unpacked
                if room is not None and room <= 0:
                    return kinds, unpacked, 'more to unpack after the scanlines'
                try:
                    out = (stream.decompress(pending + piece) if room is None
                           else stream.decompress(pending + piece, room))
                except zlib.error as err:
                    return kinds, unpacked, f'IDAT does not read as a zlib stream ({err})'
                unpacked += len(out)
                pending = stream.unconsumed_tail
            tail = handle.read(4)
            if len(tail) < 4:
                return kinds, unpacked, f'{kind} runs past the end of the file'
            if crc & 0xffffffff != int.from_bytes(tail, 'big'):
                return kinds, unpacked, f'{kind} does not match its CRC'
            if kind == 'IDAT':
                if kinds[-1:] != [('IDAT', None, b'')]:
                    kinds.append((kind, None, b''))
            else:
                # Everything but the pixels is matched against what was drawn,
                # body and all: IHDR's compression method, say, changes without
                # the decoder saying anything.
                kinds.append((kind, digest.digest(), first))
            at += 12 + length
            if kind == 'IEND':
                if length:
                    return kinds, unpacked, f'IEND is {length} bytes where the spec gives it none'
                spare = pixel_stream_fault(stream, pending, unpacked, cap, saw_idat, spare_after)
                if spare:
                    return kinds, unpacked, spare
                trailing = size - at
                return kinds, unpacked, f'{trailing} bytes after IEND' if trailing else None


def check(images):
    """Compare what is committed with what the code draws now, byte by byte.

    Nothing is handed to the decoder until the bytes here have been read: where
    pillow gives up — a text chunk it will not unpack, a header claiming more
    pixels than it will decode — the whole run used to end with it, and the
    images after that one and the scan for files nothing draws never happened.
    """
    here = os.path.relpath(OUT_DIR, ROOT)
    bad = not_a_directory(OUT_DIR)
    if bad:
        # Before drawing: with this wrong, what the six say about themselves
        # means nothing.
        print(f'{bad[0]}: {bad[1]}', file=sys.stderr)
        print(f'Make {bad[0]} a directory again, then run '
              f'`python3 {os.path.basename(__file__)}`.', file=sys.stderr)
        return 1
    stale = []
    scratch = tempfile.mkdtemp()
    try:
        for name, img in images.items():
            fresh = os.path.join(scratch, name)
            img.save(fresh)
            committed = os.path.join(OUT_DIR, name)
            if not os.path.lexists(committed):
                stale.append(f'{name}: not committed')
                continue
            # lexists, so that a link with nothing at the end of it is named as
            # a link rather than as a name nobody has committed.
            kind = not_a_plain_file(committed)
            if kind:
                stale.append(f'{name}: {kind}')
                continue
            # RGBA: dropping alpha would call an image that differs only in its
            # transparency the same one. What this run just drew is read
            # outside the guard — a failure there is this run's, not the
            # committed file's.
            new = Image.open(fresh).convert('RGBA')
            drawn_kinds, drawn_pixels, drawn_fault = png_shape(fresh)
            if drawn_fault:
                raise SystemExit(f'what this run drew for {name} is not a PNG: {drawn_fault}')
            try:
                kinds, _, fault = png_shape(committed, drawn_pixels)
            except OSError as err:
                # A file this process cannot open is this image's answer.
                # Stopping on the first one takes the rest of the comparison
                # and the scan for files nothing draws with it.
                stale.append(f'{name}: cannot be read ({err})')
                continue
            if fault:
                stale.append(f'{name}: {fault}')
                continue
            here_kinds = [kind for kind, _, _ in kinds]
            drawn_only = [kind for kind, _, _ in drawn_kinds]
            if here_kinds != drawn_only:
                # An extra chunk, a second IHDR, the chunks that drive an
                # animation: a decoder skips them or hands back the first
                # frame, so the pixels match while the file has more in it.
                stale.append(f'{name}: {" ".join(here_kinds)} where the code draws '
                             f'{" ".join(drawn_only)}')
                continue
            if header_size(kinds) != header_size(drawn_kinds):
                # The size is in IHDR, which is read here — so a header
                # claiming more pixels than anyone drew is turned down before
                # a decoder is asked to make room for it.
                stale.append(f'{name}: {header_size(kinds)} where the code draws '
                             f'{header_size(drawn_kinds)}')
                continue
            changed = [kind for (kind, body, _), (_, drawn_body, _) in zip(kinds, drawn_kinds)
                       if body != drawn_body]
            if changed:
                stale.append(f'{name}: {" ".join(changed)} differs from what the code draws')
                continue
            try:
                old = Image.open(committed).convert('RGBA')
            except OSError as err:
                # Past every byte-level check the content can still be broken
                # (a filter type the spec does not define, say). One image is
                # not the end of the run.
                stale.append(f'{name}: cannot be read as an image ({err})')
                continue
            if new.tobytes() != old.tobytes():
                # Pixels as bytes. difference().getbbox() looks at alpha alone
                # once an alpha channel is there, and answers None for a colour
                # that changed.
                stale.append(f'{name}: differs from what the code draws now')
    finally:
        for name in os.listdir(scratch):
            os.remove(os.path.join(scratch, name))
        os.rmdir(scratch)

    # No directory at all is the "none of them are committed" case above, which
    # every image has already reported for itself. Only .png files are counted:
    # what Finder leaves in a directory of images is not an image anybody drew.
    # A directory is what an interrupted run leaves; a link is not one, whatever
    # it points at.
    try:
        committed = sorted(name for name in os.listdir(OUT_DIR)
                           if name.lower().endswith('.png')
                           and not is_directory(os.path.join(OUT_DIR, name))
                           ) if os.path.isdir(OUT_DIR) else []
    except OSError as err:
        # Which files are there is half of what this run answers, and it is not
        # a difference between images — say it and stop.
        print(f'{here} cannot be read ({err.strerror})', file=sys.stderr)
        return 1
    # A name that differs only in case is not one nothing draws: on a
    # case-insensitive filesystem it passes the pixel comparison, so saying to
    # delete it would have the reader delete the image that is drawn.
    by_spelling = {name.lower(): name for name in images}
    present = set(committed)
    orphans, spellings = [], {}
    for name in committed:
        if name in images:
            continue
        drawn_as = by_spelling.get(name.lower())
        # With the right spelling beside it, this is not a name to fix but a
        # spare file (a case-sensitive filesystem holds both at once).
        if drawn_as and drawn_as not in present:
            spellings.setdefault(drawn_as, []).append(name)
        else:
            orphans.append(f'{here}/{name}')
    # Where two or more claim one name, which to keep is not something this can
    # know — renaming them in turn drops the second onto the first.
    misspelled = [(names[0], drawn_as) for drawn_as, names in sorted(spellings.items())
                  if len(names) == 1]
    contested = [(sorted(names), drawn_as) for drawn_as, names in sorted(spellings.items())
                 if len(names) > 1]

    for line in stale:
        print(line, file=sys.stderr)
    if stale:
        print(f'Run `python3 {os.path.basename(__file__)}` and commit the result.',
              file=sys.stderr)
    for path in orphans:
        print(f'{path}: drawn by nothing', file=sys.stderr)
    if orphans:
        # Generating writes the files it draws and touches nothing else, so
        # these have to go by hand.
        print('Delete: ' + ' '.join(orphans), file=sys.stderr)
    for name, drawn_as in misspelled:
        print(f'{here}/{name}: spelled differently (the code draws {drawn_as})', file=sys.stderr)
    if misspelled:
        print('Rename: ' + ' '.join(f'{here}/{name} -> {drawn_as}'
                                    for name, drawn_as in misspelled), file=sys.stderr)
    for names, drawn_as in contested:
        for name in names:
            print(f'{here}/{name}: one of {len(names)} files claiming the name {drawn_as}',
                  file=sys.stderr)
        print(f'Keep one as {drawn_as} and delete the rest: '
              + ' '.join(f'{here}/{name}' for name in names), file=sys.stderr)
    if stale or orphans or misspelled:
        return 1
    print(f'{len(images)} screenshots match the code that draws them.')
    return 0


if __name__ == '__main__':
    # Every argument is read before the branch, so a near miss of --check is an
    # argument error rather than a redraw — and before the answer for a machine
    # that cannot draw, so that one does not stand in for it.
    destination, was_named = target_dir(sys.argv[1:])
    if CANNOT_DRAW is not None:
        print(CANNOT_DRAW, file=sys.stderr)
        sys.exit(UNAVAILABLE)
    print(f'Font: {FAMILY} | pillow {PIL_VERSION} | freetype {features.version("freetype2")} '
          f'| raqm {features.check("raqm")}')
    if '--check' in sys.argv[1:]:
        sys.exit(check(render_all()))
    sys.exit(write(render_all(), destination, was_named))
