"""Download the CC0 Poly Haven assets used by the G2Sim worlds (see ASSETS.md).

    python fetch_assets.py <download-dir>

Each asset goes into its own sub-directory of <download-dir>. Keep that
directory outside the repo; build_world.py imports from it into Content/.
Standard library only.
"""
import hashlib
import json
import os
import sys
import urllib.request

UA = {"User-Agent": "g2sim-asset-fetch"}

# (Poly Haven id, kind, resolution)
ASSETS = [
    ("shanghai_bund", "hdri", "8k"),
]


def get_json(url):
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA)) as r:
        return json.load(r)


def download(url, dest, md5=None):
    if os.path.exists(dest) and md5 and file_md5(dest) == md5:
        return
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    tmp = dest + ".part"
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA)) as r, open(tmp, "wb") as f:
        while True:
            chunk = r.read(1 << 20)
            if not chunk:
                break
            f.write(chunk)
    if md5 and file_md5(tmp) != md5:
        os.remove(tmp)
        raise RuntimeError(f"md5 mismatch for {url}")
    os.replace(tmp, dest)


def file_md5(path):
    h = hashlib.md5()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def safe_join(root, rel):
    # Include paths come from the server: never let them leave the asset directory.
    path = os.path.normpath(os.path.join(root, rel))
    if os.path.isabs(rel) or not path.startswith(os.path.normpath(root) + os.sep):
        raise RuntimeError(f"unsafe path in file list: {rel!r}")
    return path


def main():
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    out = os.path.abspath(sys.argv[1])
    for asset_id, kind, res in ASSETS:
        files = get_json(f"https://api.polyhaven.com/files/{asset_id}")
        root = os.path.join(out, asset_id)
        if kind == "hdri":
            entry = files["hdri"][res]["hdr"]
            download(entry["url"], safe_join(root, f"{asset_id}_{res}.hdr"), entry.get("md5"))
        else:  # glTF model with its textures
            entry = files["gltf"][res]["gltf"]
            download(entry["url"], safe_join(root, f"{asset_id}_{res}.gltf"), entry.get("md5"))
            for rel, inc in entry.get("include", {}).items():
                download(inc["url"], safe_join(root, rel), inc.get("md5"))
        print("ok", asset_id)


if __name__ == "__main__":
    main()
