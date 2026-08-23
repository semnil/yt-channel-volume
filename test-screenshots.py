"""Where gen_screenshots writes, and what it reports. Run: python3 test-screenshots.py"""
import os
import shutil
import struct
import subprocess
import sys
import tempfile
import zlib

# This directory is loaded as an unpacked extension, and Chrome refuses one
# whose top level holds a name starting with "_". An import writes __pycache__
# beside the module it reads, and that module is here.
sys.dont_write_bytecode = True

# gen_screenshots first: it is the one that answers 3 where pillow is missing,
# and importing PIL here first would turn that into a traceback.
import gen_screenshots
from PIL import Image

passed = failed = 0


def check(condition, msg):
    global passed, failed
    if condition:
        passed += 1
    else:
        failed += 1
        print('  FAIL:', msg)


class FakeImage:
    """Stands in for a rendered sheet: this is about paths, not pixels."""

    def save(self, path):
        with open(path, 'wb'):
            pass


IMAGES = {'popup_ja.png': FakeImage(), 'popup_en.png': FakeImage()}


def wrote_every_image(target):
    return all(os.path.exists(os.path.join(target, name)) for name in IMAGES)


print('target_dir — what --out is given')


def exit_code(args):
    try:
        return gen_screenshots.target_dir(args)
    except SystemExit as err:
        return err.code


check(gen_screenshots.target_dir([]) == gen_screenshots.OUT_DIR,
      'no --out writes into docs/screenshots')
check(gen_screenshots.target_dir(['--out', os.sep + 'tmp' + os.sep + 'shots'])
      == os.path.abspath(os.sep + 'tmp' + os.sep + 'shots'),
      '--out with a directory writes there')
check(exit_code(['--out']) == 2, '--out with nothing after it is an argument error')
check(exit_code(['--out', '']) == 2,
      '--out with an empty value is an argument error, not the working directory')

print('write — inside the repository')
inside = tempfile.mkdtemp(dir=gen_screenshots.ROOT)
try:
    gen_screenshots.write(IMAGES, inside)
    check(wrote_every_image(inside), 'writes every image into a directory under the repository')
    check(gen_screenshots.under_root(inside) is True, 'a directory under the repository is reported as inside')
finally:
    shutil.rmtree(inside)

print('write — another Windows drive')
outside = tempfile.mkdtemp()
real_commonpath = os.path.commonpath


def other_drive(paths):
    raise ValueError("Paths don't have the same drive")


os.path.commonpath = other_drive
try:
    try:
        reported = gen_screenshots.under_root(outside)
    except ValueError as err:
        reported = err
    check(reported is False, f'a path on another drive is reported as outside, not raised over ({reported!r})')

    try:
        gen_screenshots.write(IMAGES, outside)
    except ValueError as err:
        check(False, f'write raised over a path on another drive: {err}')
    check(wrote_every_image(outside), 'writes every image when the target is on another drive')
finally:
    os.path.commonpath = real_commonpath
    shutil.rmtree(outside)


# ── --check against trees it has to turn down ────────────────────────
#
# A run over a matching tree says nothing about what --check rejects. Each of
# these hands it its own copy — the script, the faces it resolves beside
# itself, and the six images — with one thing wrong.

print('--check — what it turns down')


def sandbox():
    box = tempfile.mkdtemp()
    shutil.copy2(os.path.join(gen_screenshots.ROOT, 'gen_screenshots.py'),
                 os.path.join(box, 'gen_screenshots.py'))
    shutil.copytree(gen_screenshots.FONT_DIR, os.path.join(box, 'tools', 'fonts'))
    shutil.copytree(gen_screenshots.OUT_DIR, os.path.join(box, 'docs', 'screenshots'))
    return box


def run(box, *args):
    # A child that never returns would otherwise sit here until whatever is
    # running this gives up on it.
    return subprocess.run([sys.executable, '-B', 'gen_screenshots.py', *args],
                          cwd=box, capture_output=True, text=True, timeout=120)


def shot(box, name):
    return os.path.join(box, 'docs', 'screenshots', name)


box = sandbox()
try:
    check(run(box, '--check').returncode == 0, 'the copy starts out matching')

    # One channel of one pixel: the smallest difference the comparison has to
    # see, and the first thing a tolerance would swallow.
    img = Image.open(shot(box, 'popup_ja.png')).convert('RGB')
    r, g, b = img.getpixel((320, 200))
    img.putpixel((320, 200), (r ^ 1, g, b))
    img.save(shot(box, 'popup_ja.png'))
    changed = run(box, '--check')
    check(changed.returncode == 1, f'a changed pixel is reported (exit {changed.returncode})')
    check('popup_ja.png: differs from what the code draws now' in changed.stderr,
          'and the line names the file and what is wrong with it')
finally:
    shutil.rmtree(box)

box = sandbox()
try:
    # The colour channels stay where they were, so a comparison that drops
    # alpha sees two identical images.
    img = Image.open(shot(box, 'popup_ja.png')).convert('RGBA')
    r, g, b, _ = img.getpixel((320, 200))
    img.putpixel((320, 200), (r, g, b, 0))
    img.save(shot(box, 'popup_ja.png'))
    alpha = run(box, '--check')
    check(alpha.returncode == 1, f'a transparent pixel is reported (exit {alpha.returncode})')
    check('popup_ja.png: differs from what the code draws now' in alpha.stderr,
          'and the line names the file and what is wrong with it')
finally:
    shutil.rmtree(box)

box = sandbox()
try:
    # Cropping keeps every pixel a comparison would overlay, so only a size of
    # its own catches it.
    Image.open(shot(box, 'settings_en.png')).crop((0, 0, 320, 200)).save(shot(box, 'settings_en.png'))
    cropped = run(box, '--check')
    check(cropped.returncode == 1, f'a cropped image is reported (exit {cropped.returncode})')
    check('settings_en.png: (320, 200) where the code draws' in cropped.stderr,
          'and it is named as a size rather than as a difference')
finally:
    shutil.rmtree(box)

box = sandbox()
try:
    shutil.copy2(shot(box, 'popup_ja.png'), shot(box, 'popup_de.png'))
    orphan = run(box, '--check')
    check(orphan.returncode == 1, f'an image nothing draws is reported (exit {orphan.returncode})')
    check('docs/screenshots/popup_de.png: drawn by nothing' in orphan.stderr,
          'and the line names the file and what is wrong with it')
    check('Delete: docs/screenshots/popup_de.png' in orphan.stderr,
          'and the way out is the one that works on it')

    # An image by any other spelling is still one nothing draws.
    os.rename(shot(box, 'popup_de.png'), shot(box, 'popup_de.PNG'))
    upper = run(box, '--check')
    check(upper.returncode == 1, f'.PNG is read as an image too (exit {upper.returncode})')

    # What Finder and an interrupted run leave behind are not tracked images —
    # the staging directory carries the suffix, so the name alone cannot tell.
    os.remove(shot(box, 'popup_de.PNG'))
    open(shot(box, '.DS_Store'), 'wb').close()
    os.mkdir(shot(box, 'tmpabc123.png'))
    leftovers = run(box, '--check')
    check(leftovers.returncode == 0,
          f'.DS_Store and a leftover staging directory are not images (exit '
          f'{leftovers.returncode}: {leftovers.stderr.strip()})')
finally:
    shutil.rmtree(box)

box = sandbox()
try:
    # An animation whose first frame is the drawn one: every comparison reads
    # the frame the file opens on, so the second one rides along unseen.
    first = Image.open(shot(box, 'popup_ja.png')).convert('RGB')
    second = first.copy()
    second.paste((255, 0, 255), (0, 0, first.width, first.height))
    first.save(shot(box, 'popup_ja.png'), save_all=True, append_images=[second])
    animated = run(box, '--check')
    check(animated.returncode == 1, f'a second frame is reported (exit {animated.returncode})')
    check('popup_ja.png: 2 frames where the code draws one' in animated.stderr,
          'and it is named as frames rather than as a difference')
finally:
    shutil.rmtree(box)

box = sandbox()
try:
    # The shape of adding a language and forgetting to redraw.
    os.remove(shot(box, 'overlay_en.png'))
    gone = run(box, '--check')
    check(gone.returncode == 1, f'a missing image is reported (exit {gone.returncode})')
    check('overlay_en.png: not committed' in gone.stderr,
          'and it is named as missing, once')
    check(gone.stderr.count('overlay_en.png') == 1,
          'not twice under two different reasons')
finally:
    shutil.rmtree(box)

box = sandbox()
try:
    # A file that is not an image at all, with something else wrong further
    # down: raising here would take the rest of the report with it.
    with open(shot(box, 'overlay_ja.png'), 'wb') as handle:
        handle.write(b'not a png')
    shutil.copy2(shot(box, 'popup_ja.png'), shot(box, 'popup_de.png'))
    unreadable = run(box, '--check')
    check(unreadable.returncode == 1, f'an unreadable image is reported (exit {unreadable.returncode})')
    check('overlay_ja.png: cannot be read as an image' in unreadable.stderr,
          'and the line says so rather than a traceback saying it')
    check('popup_de.png' in unreadable.stderr, 'and the report goes on to the rest')
finally:
    shutil.rmtree(box)

box = sandbox()
try:
    shutil.rmtree(os.path.join(box, 'tools'))
    missing = run(box, '--check')
    check(missing.returncode == 3, f'a missing face is 3, not 0 and not 1 (exit {missing.returncode})')
finally:
    shutil.rmtree(box)

print('--check — what it refuses to write')

def tracked_bytes(box):
    directory = os.path.join(box, 'docs', 'screenshots')
    out = {}
    for name in sorted(os.listdir(directory)):
        with open(os.path.join(directory, name), 'rb') as handle:
            out[name] = handle.read()
    return out


def mark(box, name):
    """Leave one pixel that a redraw would put back.

    Drawing is deterministic, so comparing bytes against an untouched copy
    cannot tell a run that wrote from one that did not.
    """
    img = Image.open(shot(box, name)).convert('RGB')
    r, g, b = img.getpixel((320, 200))
    img.putpixel((320, 200), (r ^ 1, g, b))
    img.save(shot(box, name))


box = sandbox()
try:
    mark(box, 'popup_ja.png')
    before = tracked_bytes(box)
    elsewhere = os.path.join(box, 'elsewhere')
    wrote = run(box, '--out', elsewhere)
    check(wrote.returncode == 0, f'--out is accepted (exit {wrote.returncode}: {wrote.stderr.strip()})')
    check(sorted(os.listdir(elsewhere)) == sorted(before), '--out writes the six where it was told')
    check(tracked_bytes(box) == before, 'and leaves the tracked directory alone')

    # The one word that decides between reading and rewriting is not matched
    # loosely: a near miss is an argument error, not a redraw.
    for args in (['--chek'], ['--check', '--chek'], ['--check', '--out', elsewhere],
                 ['--out', '--chek']):
        refused = run(box, *args)
        check(refused.returncode == 2,
              f'{" ".join(args)} is refused (exit {refused.returncode})')
        check('usage:' in refused.stderr, f'and {" ".join(args)} is told the shape of the command')
    check(tracked_bytes(box) == before, 'and no refused run wrote anything')
finally:
    shutil.rmtree(box)

print('--check — where it cannot draw')

box = sandbox()
try:
    # Shadowing pillow the way a machine without it looks from inside the
    # script: the answer is 3, which is what test.js reads as "not here".
    os.mkdir(os.path.join(box, 'PIL'))
    with open(os.path.join(box, 'PIL', '__init__.py'), 'w', encoding='utf-8') as handle:
        handle.write("raise ImportError('No module named PIL')\n")
    without = run(box, '--check')
    check(without.returncode == 3, f'no pillow is 3, not a traceback (exit {without.returncode})')

    # This file has to answer the same way, which is what test.js reads to
    # decide between skipping and failing. Its own import order decides that:
    # reaching for PIL before the generator turns the 3 into a traceback.
    shutil.copy2(os.path.join(gen_screenshots.ROOT, 'test-screenshots.py'),
                 os.path.join(box, 'test-screenshots.py'))
    itself = subprocess.run([sys.executable, '-B', 'test-screenshots.py'],
                            cwd=box, capture_output=True, text=True, timeout=120)
    check(itself.returncode == 3,
          f'and these tests say the same rather than crashing (exit {itself.returncode})')
finally:
    shutil.rmtree(box)

def write_bomb(path, width=200000, height=200000):
    """A PNG header claiming more pixels than pillow will decode.

    It raises DecompressionBombError, which is not an OSError, so a guard
    written for unreadable files alone lets it out of the loop.
    """
    def chunk(kind, data):
        return (struct.pack('>I', len(data)) + kind + data
                + struct.pack('>I', zlib.crc32(kind + data) & 0xffffffff))

    header = struct.pack('>IIBBBBB', width, height, 8, 2, 0, 0, 0)
    with open(path, 'wb') as handle:
        handle.write(b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', header)
                     + chunk(b'IDAT', zlib.compress(b'\x00')) + chunk(b'IEND', b''))


box = sandbox()
try:
    write_bomb(shot(box, 'overlay_ja.png'))
    shutil.copy2(shot(box, 'popup_ja.png'), shot(box, 'popup_de.png'))
    bombed = run(box, '--check')
    check(bombed.returncode == 1, f'a bomb header is reported (exit {bombed.returncode})')
    check('overlay_ja.png: cannot be read as an image' in bombed.stderr,
          'and the line says so rather than a traceback saying it')
    check('popup_de.png' in bombed.stderr, 'and the report goes on to the rest')
finally:
    shutil.rmtree(box)

print('fit_value_font — nothing fits')
try:
    from PIL import ImageDraw
    probe = ImageDraw.Draw(Image.new('RGB', (10, 10)))
    gen_screenshots.fit_value_font(probe, [('LOUDNESS', '-18.2', 'LUFS', 0)], 1)
    check(False, 'a budget nothing fits into ends the run')
except SystemExit as err:
    check(err.code == gen_screenshots.UNAVAILABLE,
          f'a budget nothing fits into is 3, the same as a missing face ({err.code})')

print(f'\n{passed} passed, {failed} failed')
raise SystemExit(1 if failed else 0)
