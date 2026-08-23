"""Where gen_screenshots writes, and what it reports. Run: python3 test-screenshots.py"""
import os
import shutil
import tempfile

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

print(f'\n{passed} passed, {failed} failed')
raise SystemExit(1 if failed else 0)
