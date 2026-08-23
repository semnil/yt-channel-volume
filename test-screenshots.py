"""Where gen_screenshots writes, and what it reports. Run: python3 test-screenshots.py"""
import os
import shutil
import subprocess
import sys
import tempfile

from PIL import Image

import gen_screenshots

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
    return subprocess.run([sys.executable, '-B', 'gen_screenshots.py', *args],
                          cwd=box, capture_output=True, text=True)


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
    check('popup_ja.png' in changed.stderr, 'and the file is named')
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
    check('popup_ja.png' in alpha.stderr, 'and the file is named')
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
    check('popup_de.png' in orphan.stderr, 'and the file is named')

    # What Finder and an interrupted run leave behind are not tracked images.
    os.remove(shot(box, 'popup_de.png'))
    open(shot(box, '.DS_Store'), 'wb').close()
    os.mkdir(shot(box, 'tmpabc123'))
    leftovers = run(box, '--check')
    check(leftovers.returncode == 0,
          f'.DS_Store and a leftover staging directory are not images (exit '
          f'{leftovers.returncode}: {leftovers.stderr.strip()})')
finally:
    shutil.rmtree(box)

box = sandbox()
try:
    # A file that is not an image at all, with something else wrong further
    # down: raising here would take the rest of the report with it.
    open(shot(box, 'overlay_ja.png'), 'wb').write(b'not a png')
    shutil.copy2(shot(box, 'popup_ja.png'), shot(box, 'popup_de.png'))
    unreadable = run(box, '--check')
    check(unreadable.returncode == 1, f'an unreadable image is reported (exit {unreadable.returncode})')
    check('overlay_ja.png' in unreadable.stderr, 'and the file is named')
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

box = sandbox()
try:
    before = {name: open(shot(box, name), 'rb').read()
              for name in sorted(os.listdir(os.path.join(box, 'docs', 'screenshots')))}
    elsewhere = os.path.join(box, 'elsewhere')
    wrote = run(box, '--out', elsewhere)
    check(wrote.returncode == 0, f'--out is accepted (exit {wrote.returncode}: {wrote.stderr.strip()})')
    check(sorted(os.listdir(elsewhere)) == sorted(before), '--out writes the six where it was told')
    check(all(open(shot(box, name), 'rb').read() == data for name, data in before.items()),
          'and leaves the tracked directory alone')

    # The one word that decides between reading and rewriting is not matched
    # loosely: a near miss is an argument error, not a redraw.
    typo = run(box, '--chek')
    check(typo.returncode == 2, f'an unknown argument is refused (exit {typo.returncode})')
    check(all(open(shot(box, name), 'rb').read() == data for name, data in before.items()),
          'and the refused run wrote nothing')
finally:
    shutil.rmtree(box)

print(f'\n{passed} passed, {failed} failed')
raise SystemExit(1 if failed else 0)
