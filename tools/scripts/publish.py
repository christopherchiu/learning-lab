"""Commit files to christopherchiu/learning-lab in ONE commit via the GitHub connector.

Usage:
  python3 publish.py <repo_dir> "<commit message>" --text <relpath> [<relpath> ...] \
      [--binary <relpath>=<gumloop_storage_path> ...]

--text     paths (relative to repo_dir) read from disk and sent as inline text
--binary   binary files (mp3, png). git push is not available, so binaries go through Gumloop
           storage: first save the local file with manage_artifact save, then pass the returned
           files[0].filename (the Storage Path, e.g. custom_agent_interactions/.../audio.mp3).
"""
import argparse, json, os
from gumloop import Gumloop

REPO_URL = "https://github.com/christopherchiu/learning-lab"

ap = argparse.ArgumentParser()
ap.add_argument("repo_dir"); ap.add_argument("message")
ap.add_argument("--text", nargs="*", default=[])
ap.add_argument("--binary", nargs="*", default=[])
ap.add_argument("--repo-url", default=REPO_URL)
a = ap.parse_args()

files = []
for p in a.text:
    files.append({"path": p, "content": open(os.path.join(a.repo_dir, p), encoding="utf-8").read()})
for pair in a.binary:
    path, storage = pair.split("=", 1)
    files.append({"path": path, "file_name": storage})

client = Gumloop()
resp = client.mcp.execute("github", "create_or_update_file",
                          {"repo_url": a.repo_url, "branch": "main", "message": a.message, "files": files})
r = resp.results[0]
d = r.decoded_content or []
if r.status != "success" or (d and isinstance(d[0], dict) and "error" in d[0]):
    raise SystemExit(f"Commit failed: {r.error or d[0]}")
print(json.dumps({"committed": [f["path"] for f in files], "result": str(d[0])[:400] if d else None}))
