"""Pack extension for Chrome Web Store submission."""
import zipfile
import os

EXCLUDE = {
    'CLAUDE.md', '.claude', 'gen_icons.py', 'gen_screenshots.py', 'pack.py', 'test.js',
    '.webstoreignore', '.git', '__pycache__', 'background.js', 'screenshots',
}

def pack():
    root = os.path.dirname(os.path.abspath(__file__))
    import json
    with open(os.path.join(root, 'manifest.json')) as f:
        version = json.load(f)['version']
    out = f'yt-channel-volume-{version}.zip'
    with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as zf:
        for dirpath, dirnames, filenames in os.walk(root):
            # Filter out excluded directories
            dirnames[:] = [d for d in dirnames if d not in EXCLUDE]
            for f in filenames:
                if f in EXCLUDE or f.endswith('.zip'):
                    continue
                full = os.path.join(dirpath, f)
                arcname = os.path.relpath(full, root)
                zf.write(full, arcname)
                print(f'  + {arcname}')
    print(f'\n=> {out}')

if __name__ == '__main__':
    pack()
