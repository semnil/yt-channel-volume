"""Where gen_screenshots writes, and what it reports. Run: python3 test-screenshots.py"""
import ntpath
import os
import posixpath
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

# gen_screenshots first: it keeps what it could not read, and these tests
# answer 3 the same way it does. Reaching for PIL before that turns "cannot
# draw here" into a traceback, and test.js reads the 3 to know to skip.
import gen_screenshots

if gen_screenshots.CANNOT_DRAW is not None:
    print(gen_screenshots.CANNOT_DRAW, file=sys.stderr)
    raise SystemExit(gen_screenshots.UNAVAILABLE)

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
    """Stands in for a rendered sheet: this is about paths, not pixels.

    The name it is saved under is a temporary one now, so the format is named
    rather than read off the extension.
    """

    def save(self, path, format=None):  # noqa: A002 — pillow's own parameter name
        with open(path, 'wb'):
            pass


class RefusedImage:
    """Fails where a full disk would: after the file beside the name is there."""

    def save(self, path, format=None):  # noqa: A002 — pillow's own parameter name
        raise OSError(28, 'No space left on device', path)


IMAGES = {'popup_ja.png': FakeImage(), 'popup_en.png': FakeImage()}
IMAGES_DRAWN = sorted(gen_screenshots.render_all())


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
# Where the kernel lands, not where the text folds to: a link on the way
# there is followed, so what is checked and what is written are one place.
check(gen_screenshots.target_dir(['--out', os.sep + 'tmp' + os.sep + 'shots'])
      == gen_screenshots.where_it_lands(os.sep + 'tmp' + os.sep + 'shots'),
      '--out with a directory writes where that directory leads')
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


def rewrite_header(path, offset, value, size=17):
    """Change one byte of IHDR and redo its CRC."""
    data = bytearray(open(path, 'rb').read())
    body = bytearray(data[12:12 + size])
    body[4 + offset] = value
    data[12:12 + size] = body
    data[8 + size + 4:8 + size + 8] = (zlib.crc32(bytes(body)) & 0xffffffff).to_bytes(4, 'big')
    with open(path, 'wb') as handle:
        handle.write(bytes(data))


def can_symlink():
    """Whether links can be made here at all (Windows asks for a privilege)."""
    box = tempfile.mkdtemp()
    try:
        os.symlink('nowhere', os.path.join(box, 'link'))
        return True
    except (OSError, NotImplementedError):
        return False
    finally:
        shutil.rmtree(box)


LINKS = can_symlink()
# resource is posix-only, and it is how the cost of a run is read from outside.
try:
    import resource
except ImportError:
    resource = None


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
    # The six are drawn without an alpha channel, so a file that has one
    # unpacks to more scanline bytes than the drawn image has — which is where
    # this is caught, before any of it reaches a decoder.
    check('popup_ja.png: more to unpack after the scanlines' in alpha.stderr,
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
    # An animation cannot arrive without the chunks that drive it, and those
    # are not chunks this code draws.
    check('popup_ja.png: IHDR acTL fcTL IDAT fcTL fdAT IEND where the code draws '
          'IHDR IDAT IEND' in animated.stderr,
          'and it is named by what it carries rather than as a difference')
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
    check('overlay_ja.png: not a PNG' in unreadable.stderr,
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

print('--check — the file itself, and the path to it')


def png_chunks(path):
    """(kind, whole chunk) for every chunk in the file."""
    data = open(path, 'rb').read()
    at, out = 8, []
    while at < len(data):
        size = int.from_bytes(data[at:at + 4], 'big')
        out.append((data[at + 4:at + 8], data[at:at + 12 + size]))
        at += 12 + size
    return out


def png_chunk(kind, payload):
    body = kind + payload
    return (struct.pack('>I', len(payload)) + body
            + struct.pack('>I', zlib.crc32(body) & 0xffffffff))


def insert_chunk(path, extra, before=b'IEND'):
    data = open(path, 'rb').read()
    out = bytearray(data[:8])
    for kind, raw in png_chunks(path):
        if kind == before and extra:
            out += extra
            extra = b''
        out += raw
    with open(path, 'wb') as handle:
        handle.write(bytes(out))


def rewrite_idat(path, pieces):
    data = open(path, 'rb').read()
    out, written = bytearray(data[:8]), False
    for kind, raw in png_chunks(path):
        if kind != b'IDAT':
            out += raw
            continue
        if written:
            continue
        written = True
        for piece in pieces:
            out += png_chunk(b'IDAT', piece)
    with open(path, 'wb') as handle:
        handle.write(bytes(out))


def cut_tail(path, count):
    """Drop the last count bytes. Reading first: opening for writing empties it."""
    data = open(path, 'rb').read()
    with open(path, 'wb') as handle:
        handle.write(data[:-count])


def flip_last_byte(path):
    data = bytearray(open(path, 'rb').read())
    data[-1] ^= 0xff
    with open(path, 'wb') as handle:
        handle.write(bytes(data))


def give_iend_a_payload(path):
    data = open(path, 'rb').read()[:-12]
    body = b'IEND' + b'payload'
    with open(path, 'wb') as handle:
        handle.write(data + struct.pack('>I', 7) + body
                     + struct.pack('>I', zlib.crc32(body) & 0xffffffff))


def idat_body(path):
    return b''.join(raw[8:-4] for kind, raw in png_chunks(path) if kind == b'IDAT')


def scanlines(path):
    return zlib.decompress(idat_body(path))


# A decoder decides the format from the content, stops at IEND, skips what it
# does not know and stops once it has the scanlines. Every one of these leaves
# the pixels and the size of the image the code draws.
for label, breakage, expected in (
    ('bytes after IEND',
     lambda p: open(p, 'ab').write(b'trailing'),
     'popup_ja.png: 8 bytes after IEND'),
    ('no IEND',
     lambda p: cut_tail(p, 12),
     'popup_ja.png: no IEND'),
    ('a chunk type that is not four letters',
     lambda p: insert_chunk(p, png_chunk(b'a1b2', b'')),
     'that is not four letters'),
    ('a chunk type with the reserved bit set',
     lambda p: insert_chunk(p, png_chunk(b'abcd', b'')),
     'popup_ja.png: abcd has the reserved bit set'),
    ('a chunk the code never writes',
     lambda p: insert_chunk(p, png_chunk(b'tEXt', b'Comment\x00smuggled')),
     'popup_ja.png: IHDR IDAT tEXt IEND where the code draws IHDR IDAT IEND'),
    ('a second IHDR',
     lambda p: insert_chunk(p, dict(png_chunks(p))[b'IHDR']),
     'popup_ja.png: IHDR IDAT IHDR IEND where the code draws IHDR IDAT IEND'),
    ('bytes riding in an IDAT of their own',
     lambda p: insert_chunk(p, png_chunk(b'IDAT', b'smuggled payload')),
     'popup_ja.png: 16 bytes after the end of the IDAT stream'),
    ('bytes packed in with the scanlines',
     lambda p: rewrite_idat(p, [zlib.compress(scanlines(p) + b'x' * 64, 6)]),
     'popup_ja.png: more to unpack after the scanlines'),
    ('a stream that stops before it closes',
     lambda p: rewrite_idat(p, [idat_body(p)[:-4]]),
     'popup_ja.png: the IDAT stream does not end'),
    ('a header byte the decoder does not mind',
     lambda p: rewrite_header(p, 10, 1),
     'popup_ja.png: IHDR differs from what the code draws'),
    ('a chunk that does not match its CRC',
     lambda p: flip_last_byte(p),
     'popup_ja.png: IEND does not match its CRC'),
    ('an IEND carrying something',
     lambda p: give_iend_a_payload(p),
     'popup_ja.png: IEND is 7 bytes where the spec gives it none'),
    ('a file this process cannot read',
     lambda p: os.chmod(p, 0o000),
     'popup_ja.png: cannot be read'),
):
    box = sandbox()
    try:
        breakage(shot(box, 'popup_ja.png'))
        turned = run(box, '--check')
        check(turned.returncode == 1, f'{label} is reported (exit {turned.returncode})')
        check(expected in turned.stderr, f'and {label} is named: {turned.stderr.strip()[:90]}')
    finally:
        os.chmod(shot(box, 'popup_ja.png'), 0o644)
        shutil.rmtree(box)

box = sandbox()
try:
    # However the compressor split the stream, the pixels are the same ones.
    body = idat_body(shot(box, 'popup_ja.png'))
    rewrite_idat(shot(box, 'popup_ja.png'), [body[:len(body) // 2], body[len(body) // 2:]])
    split = run(box, '--check')
    check(split.returncode == 0,
          f'a stream split across two IDATs is not a difference (exit {split.returncode}: '
          f'{split.stderr.strip()[:90]})')
finally:
    shutil.rmtree(box)

box = sandbox() if LINKS else None
if box is None:
    print('  (links: skipped, they need a privilege this does not ask for)')
try:
    # os.path.exists, Image.open, open and os.path.isfile all read through a
    # link, so one holding the same bytes matches down to the pixels — and a
    # repository records the path it names, not an image.
    if box is not None:
        os.rename(shot(box, 'popup_ja.png'), shot(box, 'popup_ja.source'))
        os.symlink('popup_ja.source', shot(box, 'popup_ja.png'))
        os.symlink('gone.png', shot(box, 'popup_de.png'))
        linked = run(box, '--check')
        check(linked.returncode == 1,
              f'a link in place of an image is reported (exit {linked.returncode})')
        check('popup_ja.png: a symbolic link (points at popup_ja.source)' in linked.stderr,
              'and the line says what it is')
        check('docs/screenshots/popup_de.png: drawn by nothing' in linked.stderr,
              'and a link that points nowhere is still a file nothing draws')
finally:
    if box is not None:
        shutil.rmtree(box)

for label, breakage, expected in (
    ('the tracked directory as a link',
     lambda box: (shutil.move(os.path.join(box, 'docs', 'screenshots'),
                              os.path.join(box, 'docs', 'screenshots.source')),
                  os.symlink('screenshots.source', os.path.join(box, 'docs', 'screenshots'))),
     'docs/screenshots: a symbolic link (points at screenshots.source)'),
    ('a directory on the way as a link',
     lambda box: (shutil.move(os.path.join(box, 'docs'), os.path.join(box, 'docs.source')),
                  os.symlink('docs.source', os.path.join(box, 'docs'))),
     'docs: a symbolic link (points at docs.source)'),
    ('the tracked directory as a link pointing nowhere',
     lambda box: (shutil.rmtree(os.path.join(box, 'docs', 'screenshots')),
                  os.symlink('nowhere', os.path.join(box, 'docs', 'screenshots'))),
     'docs/screenshots: a symbolic link (points at nowhere)'),
) if LINKS else ():
    box = sandbox()
    try:
        breakage(box)
        # lstat answers for the last name in a path, so a link one level up
        # hides everything under it — and drawing through it reports
        # docs/screenshots for bytes that landed somewhere else.
        turned = run(box, '--check')
        check(turned.returncode == 1, f'{label} is reported (exit {turned.returncode})')
        check(expected in turned.stderr, f'and {label} is named: {turned.stderr.strip()[:90]}')
        drawn = run(box)
        check(drawn.returncode == 1, f'and drawing refuses {label} too (exit {drawn.returncode})')
        check('Traceback' not in drawn.stderr, 'without a traceback')
    finally:
        shutil.rmtree(box)

box = sandbox()
try:
    # A name that differs only in case passes the pixel comparison on a
    # case-insensitive filesystem, so calling it a file nothing draws would
    # have the reader delete the image that is drawn.
    os.rename(shot(box, 'popup_ja.png'), shot(box, 'popup_ja.PNG'))
    spelled = run(box, '--check')
    check(spelled.returncode == 1, f'a spelling is reported (exit {spelled.returncode})')
    check('popup_ja.PNG: spelled differently (the code draws popup_ja.png)' in spelled.stderr,
          'and it is named as a spelling')
    check('Rename: docs/screenshots/popup_ja.PNG -> popup_ja.png' in spelled.stderr,
          'and renaming is what it asks for')
    check('Delete' not in spelled.stderr, 'not deleting')

    try:
        shutil.copy2(shot(box, 'popup_ja.PNG'), shot(box, 'popup_ja.png'))
    except shutil.SameFileError:
        # A filesystem that folds the two names holds one file, and the rest of
        # this is about what happens when it holds both.
        both = []
    else:
        both = sorted(name for name in os.listdir(os.path.dirname(shot(box, 'popup_ja.png')))
                      if name.lower() == 'popup_ja.png')
    if len(both) < 2:
        print('  (both spellings at once: skipped, this filesystem folds them)')
    else:
        spare = run(box, '--check')
        check(spare.returncode == 1, 'the spare of two spellings is reported')
        check('popup_ja.PNG: drawn by nothing' in spare.stderr,
              'and with the drawn name beside it, it is the spare rather than a rename')
        check('Rename' not in spare.stderr, 'not renamed onto the name that is already there')

        os.rename(shot(box, 'popup_ja.png'), shot(box, 'POPUP_JA.png'))
        contested = run(box, '--check')
        check(contested.returncode == 1, 'two spellings claiming one name are reported')
        check('one of 2 files claiming the name popup_ja.png' in contested.stderr,
              'and neither is told to take the name the other would take')
        check('Rename' not in contested.stderr, 'so there is no rename to follow')
finally:
    shutil.rmtree(box)

COST_PROBE = """
import resource, subprocess, sys
unit = 1 if sys.platform == 'darwin' else 1024
run = subprocess.run([sys.executable, '-B', 'gen_screenshots.py', '--check'],
                     cwd=sys.argv[1], capture_output=True, text=True)
print(run.returncode)
print(resource.getrusage(resource.RUSAGE_CHILDREN).ru_maxrss * unit)
sys.stderr.write(run.stderr)
"""


def cost_of_checking(box):  # noqa: D401 — reads what a run cost from outside
    """(exit code, peak resident bytes, stderr) for one run, measured alone.

    RUSAGE_CHILDREN is the high-water mark across every child a process has
    reaped, so the run being measured gets a process of its own.
    """
    probe = subprocess.run([sys.executable, '-B', '-c', COST_PROBE, box],
                           capture_output=True, text=True, timeout=600)
    status, peak = probe.stdout.strip().split('\n')
    return int(status), int(peak), probe.stderr


box = sandbox()
try:
    # 64 MiB in a chunk that is all there on disk: nothing unpacks, so a
    # ceiling on unpacking says nothing about what reading it costs.
    fat = b'\0' * (64 * 1024 * 1024)
    insert_chunk(shot(box, 'popup_ja.png'), png_chunk(b'IDAT', fat))
    if resource is None:
        print('  (what a run costs: skipped, resource is posix-only)')
    else:
        status, peak, said = cost_of_checking(box)
        check(status == 1, f'a fat chunk is reported (exit {status}: {said.strip()[:70]})')
        check(peak < len(fat),
              f'and the file is read in pieces rather than held ({peak / (1 << 20):.0f} MiB '
              f'against a {len(fat) >> 20} MiB chunk)')
finally:
    shutil.rmtree(box)

box = sandbox()
try:
    # 256 MiB of zeros in 250 KB of chunk: the file says nothing about what
    # unpacking it costs, so the ceiling comes from the image this code draws.
    # A run over an untouched copy peaks near 40 MB here, and one that unpacks
    # a block at a time without a ceiling reaches about 130 MB.
    padding = 256 * 1024 * 1024
    packer = zlib.compressobj(6)
    packed = packer.compress(scanlines(shot(box, 'popup_ja.png')))
    left = padding
    while left:
        step = min(left, 1 << 20)
        packed += packer.compress(bytes(step))
        left -= step
    packed += packer.flush()
    rewrite_idat(shot(box, 'popup_ja.png'), [packed])
    if resource is None:
        print('  (the ceiling on unpacking: skipped, resource is posix-only)')
    else:
        status, peak, said = cost_of_checking(box)
        check(status == 1, f'padding packed in with the scanlines is reported (exit {status})')
        check('more to unpack after the scanlines' in said, 'and named as what it is')
        check(peak < padding // 4,
              f'and unpacking stops at the scanlines this code draws '
              f'({peak / (1 << 20):.0f} MiB against a {padding // 4 >> 20} MiB bound)')
finally:
    shutil.rmtree(box)

print('--check — what it refuses to write')

def tracked_bytes(box):
    """The committed images, by name. Files only, as --check counts them:
    the staging directory an interrupted run leaves carries the suffix too.
    """
    directory = os.path.join(box, 'docs', 'screenshots')
    out = {}
    for name in sorted(n for n in os.listdir(directory)
                       if n.lower().endswith('.png')
                       and os.path.isfile(os.path.join(directory, n))):
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
    os.mkdir(shot(box, 'tmpabc123.png'))
    mark(box, 'popup_ja.png')
    before = tracked_bytes(box)
    check('tmpabc123.png' not in before,
          'a leftover staging directory is not one of the tracked images')
    elsewhere = os.path.join(box, 'elsewhere')
    wrote = run(box, '--out', elsewhere)
    check(wrote.returncode == 0, f'--out is accepted (exit {wrote.returncode}: {wrote.stderr.strip()})')
    check(sorted(os.listdir(elsewhere)) == sorted(before), '--out writes the six where it was told')
    check(tracked_bytes(box) == before, 'and leaves the tracked directory alone')

    # The one word that decides between reading and rewriting is not matched
    # loosely: a near miss is an argument error, not a redraw. Nor is a
    # destination handed to the mode that writes nothing (in either order), a
    # second destination that would drop the first, or a place that cannot
    # become a directory — a name that is one already, a link that points
    # nowhere, or a name under a file. The last two are spelled out rather than
    # joined: os.path.join folds `..` away, and what has to reach the generator
    # is the path as written.
    afile = os.path.join(box, 'afile')
    with open(afile, 'wb'):
        pass
    broken = os.path.join(box, 'broken')
    if LINKS:
        os.symlink('nowhere', broken)
    dangling = ([['--out', broken], ['--out', os.sep.join([box, 'missing', '..', 'broken'])]]
                if LINKS else [])
    for args in ([['--chek'], ['--check', '--chek'], ['--check', '--out', elsewhere],
                  ['--out', elsewhere, '--check'], ['--out', '--chek'],
                  ['--out', elsewhere, '--out', elsewhere + '2'],
                  ['--out', afile],
                  ['--out', os.sep.join([box, 'afile', 'child'])],
                  ['--out', os.sep.join([box, 'afile', '..', 'escaped'])],
                  ['--out', os.sep.join([box, 'missing', '..', 'afile'])]] + dangling):
        refused = run(box, *args)
        check(refused.returncode == 2,
              f'{" ".join(args)} is refused (exit {refused.returncode}: {refused.stderr.strip()[:70]})')
        check('usage:' in refused.stderr, f'and {" ".join(args)} is told the shape of the command')
        check('Traceback' not in refused.stderr, f'and {" ".join(args)} says so without a traceback')
    check(tracked_bytes(box) == before, 'and no refused run wrote anything')
    check(os.path.isfile(afile), 'nor turned a file into a directory')
    if LINKS:
        # These two are answered by walking the names, before anything is asked
        # to make a directory — os.makedirs would refuse them too, but only
        # after the run had committed to writing, and with "File exists" for
        # what is a link pointing nowhere.
        for args in (['--out', broken], ['--out', os.sep.join([box, 'missing', '..', 'broken'])]):
            refused = run(box, *args)
            check('is not a directory' in refused.stderr,
                  f'{" ".join(args)} is answered by the walk: {refused.stderr.strip()[:70]}')
    check(not os.path.exists(elsewhere + '2'), 'nor made the second of two destinations')
    check(not os.path.exists(os.path.join(box, 'escaped')), 'nor wrote where a path folded to')
    check(not os.path.exists(os.path.join(box, 'missing')), 'nor made a name it was told to pass')
finally:
    shutil.rmtree(box)

box = sandbox() if LINKS else None
try:
    # `link/..` is the directory the link points into, and folding the text
    # instead writes beside the link while the check reads what it leads to.
    if box is not None:
        os.makedirs(os.path.join(box, 'actual', 'inner'))
        os.symlink(os.path.join('actual', 'inner'), os.path.join(box, 'link'))
        landed = run(box, '--out', os.sep.join([box, 'link', '..', 'landed']))
        check(landed.returncode == 0,
              f'a destination through a link is accepted ({landed.stderr.strip()[:70]})')
        landed_in = os.path.join(box, 'actual', 'landed')
        check(os.path.isdir(landed_in) and len(os.listdir(landed_in)) == 6,
              'and the six are where the link leads')
        check(not os.path.exists(os.path.join(box, 'landed')),
              'and not beside the link, where the text folds to')

        with open(os.path.join(box, 'actual', 'in-the-way'), 'wb'):
            pass
        blocked = run(box, '--out', os.sep.join([box, 'link', '..', 'in-the-way']))
        check(blocked.returncode == 2,
              f'a file on the way there is refused (exit {blocked.returncode})')
        check(os.path.isfile(os.path.join(box, 'actual', 'in-the-way')), 'and left as it was')
finally:
    if box is not None:
        shutil.rmtree(box)

print('drawing — what it will not write over')

box = sandbox() if LINKS else None
if box is None:
    print('  (writing through a link: skipped, links need a privilege here)')
try:
    if box is not None:
        # img.save follows a link and puts a PNG wherever it points, leaving
        # the link in place: the run says it wrote six images while one of them
        # went somewhere else, and every check afterwards says the same thing
        # about the link again.
        with open(os.path.join(box, 'elsewhere.bin'), 'wb') as handle:
            handle.write(b'not an image, and not this run to overwrite')
        was = open(os.path.join(box, 'elsewhere.bin'), 'rb').read()
        os.remove(shot(box, 'popup_ja.png'))
        os.symlink(os.path.join('..', '..', 'elsewhere.bin'), shot(box, 'popup_ja.png'))

        drawn = run(box)
        check(drawn.returncode == 1, f'a link under a drawn name is refused (exit {drawn.returncode})')
        check('popup_ja.png: a symbolic link' in drawn.stderr, 'and the line says what it is')
        check('Delete:' in drawn.stderr, 'and says what to do about it')
        check(open(os.path.join(box, 'elsewhere.bin'), 'rb').read() == was,
              'and what the link points at is untouched')
        check(os.path.islink(shot(box, 'popup_ja.png')), 'and the link is still a link')
        others = [name for name in os.listdir(os.path.join(box, 'docs', 'screenshots'))
                  if name != 'popup_ja.png']
        check(all(name.endswith('.png') for name in others),
              f'and nothing was left half-written beside them ({others})')

        # A link with nothing at the end of it is a link, not a name that was
        # never committed.
        os.remove(shot(box, 'popup_ja.png'))
        os.symlink('gone.png', shot(box, 'popup_ja.png'))
        dangling = run(box, '--check')
        check('popup_ja.png: a symbolic link (points at gone.png)' in dangling.stderr,
              'and a link pointing nowhere is named as a link')
finally:
    if box is not None:
        shutil.rmtree(box)

if LINKS:
    # The check above is what says so; this is what makes it true even when a
    # name turns into a link after it was looked at. write() is called here
    # with that check stubbed out, and what the link points at has to survive
    # anyway — os.replace puts the file where the name is, not where it leads.
    box = tempfile.mkdtemp()
    kept = os.path.join(box, 'elsewhere.bin')
    try:
        with open(kept, 'wb') as handle:
            handle.write(b'not an image')
        was = open(kept, 'rb').read()
        os.symlink('elsewhere.bin', os.path.join(box, 'popup_ja.png'))
        looked = gen_screenshots.not_a_plain_file
        gen_screenshots.not_a_plain_file = lambda path: None
        try:
            code = gen_screenshots.write(IMAGES, box)
        finally:
            gen_screenshots.not_a_plain_file = looked
        check(code == 0, f'writing runs with the check stubbed out (exit {code})')
        check(open(kept, 'rb').read() == was, 'and what the link pointed at is untouched')
        check(not os.path.islink(os.path.join(box, 'popup_ja.png')),
              'and the name holds a file of its own now')
        check(sorted(name for name in os.listdir(box) if name.endswith('.tmp')) == [],
              'and nothing was left beside them')
    finally:
        shutil.rmtree(box)

box = sandbox()
try:
    # Every name is written beside itself and moved onto its own name, so a
    # run that finishes leaves nothing of its own behind.
    elsewhere = os.path.join(box, 'elsewhere')
    wrote = run(box, '--out', elsewhere)
    check(wrote.returncode == 0, f'a plain run writes (exit {wrote.returncode})')
    check(sorted(os.listdir(elsewhere)) == sorted(IMAGES_DRAWN),
          f'and leaves only the six behind ({sorted(os.listdir(elsewhere))})')
finally:
    shutil.rmtree(box)

print('drawing — a directory that will not have it')

box = sandbox()
readonly = os.path.join(box, 'readonly')
try:
    # The shape of the path is fine; what is left is what the filesystem says
    # when asked to make the directory.
    os.mkdir(readonly)
    os.chmod(readonly, 0o555)
    refused = run(box, '--out', os.path.join(readonly, 'shots'))
    check(refused.returncode == 2,
          f'a destination that cannot be made is an argument error (exit {refused.returncode})')
    check('Traceback' not in refused.stderr, 'and says so without a traceback')
    check('usage:' in refused.stderr, 'and is told the shape of the command')
finally:
    os.chmod(readonly, 0o755)
    shutil.rmtree(box)

box = tempfile.mkdtemp()
try:
    # Where the directory takes the file and the save fails anyway, what was
    # written beside the name has to go: a run that stops is not a run that
    # leaves its working files in a directory of images.
    code = gen_screenshots.write({'popup_ja.png': RefusedImage()}, box)
    check(code == 2, f'a save that fails is reported (exit {code})')
    check(os.listdir(box) == [], f'and nothing is left beside the name ({os.listdir(box)})')
finally:
    shutil.rmtree(box)

box = sandbox()
readonly = os.path.join(box, 'readonly')
try:
    # This one exists, so nothing has to be made — what refuses is the file
    # written beside the name, which is the first thing this run asks of it.
    os.mkdir(readonly)
    os.chmod(readonly, 0o555)
    refused = run(box, '--out', readonly)
    check(refused.returncode == 2,
          f'a destination that will not take a file is an argument error (exit {refused.returncode})')
    check('Traceback' not in refused.stderr, 'and says so without a traceback')
    check('usage:' in refused.stderr, 'and is told the shape of the command')
    check(os.listdir(readonly) == [], 'and nothing was left in it')
finally:
    os.chmod(readonly, 0o755)
    shutil.rmtree(box)

box = sandbox()
tracked_readonly = os.path.join(box, 'docs', 'screenshots')
try:
    # The same directory as the one it draws into, where there is no argument
    # to blame: this is the run failing, not the command being wrong.
    os.chmod(tracked_readonly, 0o555)
    refused = run(box)
    check(refused.returncode == 1,
          f'the tracked directory refusing a file is exit 1 (exit {refused.returncode})')
    check('Traceback' not in refused.stderr, 'and says so without a traceback')
    check('cannot be written' in refused.stderr, 'and names what could not be written')
    check([name for name in os.listdir(tracked_readonly) if not name.endswith('.png')] == [],
          'and left nothing of its own behind')
finally:
    os.chmod(tracked_readonly, 0o755)
    shutil.rmtree(box)

box = sandbox()
tracked = os.path.join(box, 'docs', 'screenshots')
try:
    # Which files are there is half of what --check answers.
    os.chmod(tracked, 0o000)
    unreadable = run(box, '--check')
    check(unreadable.returncode == 1,
          f'a tracked directory that cannot be read is reported (exit {unreadable.returncode})')
    check('Traceback' not in unreadable.stderr, 'and says so without a traceback')
    check('docs/screenshots cannot be read' in unreadable.stderr, 'and names it')
finally:
    os.chmod(tracked, 0o755)
    shutil.rmtree(box)

print('--check — an argument that is wrong, and what else is missing')

box = sandbox()
try:
    # Reading the arguments after the import made every one of these say
    # "cannot draw here" (3) rather than "that argument is wrong" (2) — and
    # test.js skips this whole file on that same 3.
    os.mkdir(os.path.join(box, 'PIL'))
    with open(os.path.join(box, 'PIL', '__init__.py'), 'w', encoding='utf-8') as handle:
        handle.write("raise ImportError('No module named PIL')\n")
    for args in (['--chek'], ['--out'], ['--check', '--out', os.path.join(box, 'elsewhere')]):
        refused = run(box, *args)
        check(refused.returncode == 2,
              f'{" ".join(args)} without pillow is an argument error (exit {refused.returncode})')
        check('PIL' not in refused.stderr,
              f'and {" ".join(args)} is answered as an argument, not as a missing library')
    check(not os.path.exists(os.path.join(box, 'elsewhere')), 'and none of them wrote anywhere')
finally:
    shutil.rmtree(box)

box = sandbox()
try:
    # The faces resolve when the module loads, and that used to end the run the
    # same way. The positive control is right below it: with the arguments
    # right, a missing face is what there is to say.
    shutil.rmtree(os.path.join(box, 'tools'))
    refused = run(box, '--chek')
    check(refused.returncode == 2,
          f'a wrong argument without the faces is an argument error (exit {refused.returncode})')
    check('unknown argument: --chek' in refused.stderr, 'and it is named as one')
    cannot = run(box, '--check')
    check(cannot.returncode == 3, f'and --check without them cannot draw (exit {cannot.returncode})')
    check('MPLUS1p-Regular.ttf cannot be read' in cannot.stderr, 'and says which face')
finally:
    shutil.rmtree(box)

box = sandbox()
try:
    # With one of the two there, the one that is named is the one that is not:
    # the regular face is read first, so only the bold case tells them apart.
    os.remove(os.path.join(box, 'tools', 'fonts', 'MPLUS1p-Bold.ttf'))
    no_bold = run(box, '--check')
    check(no_bold.returncode == 3, f'a missing bold face cannot draw (exit {no_bold.returncode})')
    check('MPLUS1p-Bold.ttf cannot be read' in no_bold.stderr, 'and the bold face is the one named')
    check('MPLUS1p-Regular.ttf' not in no_bold.stderr, 'not the one it could read')
finally:
    shutil.rmtree(box)

print('path_parts — the separators a platform accepts')

# On Windows both \\ and / separate names; splitting on os.sep alone leaves
# `C:/tmp/afile/child` as one name, which nothing has — so the walk finds
# nothing to refuse and os.makedirs is left to fail. This is the part of it
# that cannot be run on a machine that is not Windows.
check(gen_screenshots.path_parts(ntpath.splitdrive('C:/tmp/afile/child')[1],
                                 ntpath.sep, ntpath.altsep) == ['tmp', 'afile', 'child'],
      'a Windows path written with / splits into its names')
check(gen_screenshots.path_parts(ntpath.splitdrive('C:\\tmp\\afile')[1],
                                 ntpath.sep, ntpath.altsep) == ['tmp', 'afile'],
      'and so does one written with the separator Windows prints')
check(gen_screenshots.path_parts('/tmp/afile/child', posixpath.sep, posixpath.altsep)
      == ['tmp', 'afile', 'child'], 'and a posix path splits the way it always did')

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

    A decoder handed this raises DecompressionBombError, which is not an
    OSError — a guard written for unreadable files alone lets it out of the
    loop. Reading the header here is what keeps it away from the decoder.
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
    # The size is in IHDR, which is read here: nothing is asked to make room
    # for the pixels it claims.
    check('overlay_ja.png: (200000, 200000) where the code draws (640, 400)' in bombed.stderr,
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
