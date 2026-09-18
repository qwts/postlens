"""Build a reproducible, allowlisted unpacked-extension ZIP; no keys or dev files."""
import hashlib
import json
from pathlib import Path
from zipfile import ZipFile, ZipInfo, ZIP_DEFLATED

ROOT = Path(__file__).resolve().parent.parent
FILES = ["manifest.json", "background.js", "questions.js", "content.js", "content.css",
         "options.html", "options.js", "options.css", "README.md"]
version = json.loads((ROOT / "manifest.json").read_text())["version"]
output = ROOT / "dist"
output.mkdir(exist_ok=True)
archive = output / f"postlens-{version}.zip"
with ZipFile(archive, "w", compression=ZIP_DEFLATED) as bundle:
    for name in sorted(FILES):
        info = ZipInfo(name, date_time=(2026, 1, 1, 0, 0, 0))
        info.compress_type = ZIP_DEFLATED
        info.external_attr = 0o100644 << 16
        bundle.writestr(info, (ROOT / name).read_bytes())
digest = hashlib.sha256(archive.read_bytes()).hexdigest()
(output / f"{archive.name}.sha256").write_text(f"{digest}  {archive.name}\n")
print(archive)
