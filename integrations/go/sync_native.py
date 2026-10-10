"""Keep the independently buildable cgo module on the shared native host ABI."""
from pathlib import Path
import shutil

root = Path(__file__).resolve().parent
for name in ['embed.c', 'embed.h', 'process_native.h']:
    shutil.copyfile(root.parents[1] / 'src' / name, root / name)
