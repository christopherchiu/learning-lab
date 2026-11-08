"""Turn a narration script into one compressed MP3 with ElevenLabs.

Usage: python3 narrate.py <narration.txt> <out.mp3> [--voice VOICE_ID] [--model MODEL_ID] [--estimate]

Splits the text at paragraph boundaries into chunks under ~4000 characters,
starts one ElevenLabs speech generation per chunk (all on one flow), waits for
them, downloads, joins them with ffmpeg and re-encodes to 64 kbps mono MP3
(small enough for phone + Apple Watch podcast downloads).
Prints a JSON line: {"out": ..., "duration_secs": ..., "chars": ..., "cost_usd": ...}
"""
import argparse, json, os, subprocess, sys, tempfile, time
import requests
from gumloop import Gumloop

DEFAULT_VOICE = "nPczCjzI2devNBz1zQrb"  # Brian - deep, resonant narrator
DEFAULT_MODEL = "eleven_multilingual_v2"
MAX_CHARS = 4000

client = Gumloop()


def unwrap(resp):
    r = resp.results[0]
    d = r.decoded_content or []
    if r.status != "success" or (d and isinstance(d[0], dict) and "error" in d[0]):
        raise RuntimeError(r.error or d[0])
    return d[0] if d else {}


def chunk(text):
    paras = [p.strip() for p in text.replace("\r", "").split("\n\n") if p.strip()]
    chunks, cur = [], ""
    for p in paras:
        while len(p) > MAX_CHARS:  # very long paragraph: split on sentences
            cut = p.rfind(". ", 0, MAX_CHARS) + 1 or MAX_CHARS
            if cur:
                chunks.append(cur); cur = ""
            chunks.append(p[:cut].strip()); p = p[cut:].strip()
        if len(cur) + len(p) + 2 > MAX_CHARS and cur:
            chunks.append(cur); cur = p
        else:
            cur = f"{cur}\n\n{p}" if cur else p
    if cur:
        chunks.append(cur)
    return chunks


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("src"); ap.add_argument("out")
    ap.add_argument("--voice", default=DEFAULT_VOICE)
    ap.add_argument("--model", default=DEFAULT_MODEL)
    ap.add_argument("--estimate", action="store_true")
    a = ap.parse_args()

    text = open(a.src).read().strip()
    parts = chunk(text)

    if a.estimate:
        est = unwrap(client.mcp.execute("elevenlabs", "creative_generate_speech", {
            "context": "Price an audio lesson before narrating it", "prompt": text[:9500],
            "model_id": a.model, "voice_id": a.voice, "generations_count": 1, "estimate_only": True}))
        print(json.dumps({"chars": len(text), "chunks": len(parts), "estimate_first_9500_chars": est.get("estimate")}))
        return

    flow_id, jobs, cost_cents = None, [], 0.0
    for i, p in enumerate(parts):
        args = {"context": f"Narrate part {i+1}/{len(parts)} of a personal audio lesson", "prompt": p,
                "model_id": a.model, "voice_id": a.voice, "generations_count": 1}
        if flow_id:
            args["flow_id"] = flow_id
        res = unwrap(client.mcp.execute("elevenlabs", "creative_generate_speech", args))
        flow_id = res["flow_id"]
        jobs.append({"session": res["session_ids"][0], "gen": res["pending"][0]["generation_id"]})

    sessions = [j["session"] for j in jobs]
    status = {}
    for _ in range(120):
        status = unwrap(client.mcp.execute("elevenlabs", "creative_get_flow_run_status", {
            "flow_id": flow_id, "session_ids": sessions, "context": "Wait for lesson narration to finish"}))
        if status.get("all_completed") or status.get("has_failures"):
            break
        time.sleep(5)
    if status.get("has_failures") or not status.get("all_completed"):
        raise RuntimeError(f"Narration did not finish cleanly: {json.dumps(status)[:800]}")

    urls = {}
    for g in status.get("generations", []):
        urls[g["id"]] = g.get("content_url")
        cost_cents += (g.get("price") or {}).get("price_cents", 0) or 0
    for m in status.get("media", []):
        urls.setdefault(m["generation_id"], m.get("url"))

    tmp = tempfile.mkdtemp()
    files = []
    for i, j in enumerate(jobs):
        url = urls.get(j["gen"])
        if not url:
            g = unwrap(client.mcp.execute("elevenlabs", "creative_get_generations", {
                "flow_id": flow_id, "generation_ids": [j["gen"]], "context": "Get narration audio URL"}))
            url = g["generations"][0]["full_res_url"]
        f = os.path.join(tmp, f"part{i:03d}.mp3")
        open(f, "wb").write(requests.get(url, timeout=120).content)
        files.append(f)

    lst = os.path.join(tmp, "list.txt")
    open(lst, "w").write("".join(f"file '{f}'\n" for f in files))
    os.makedirs(os.path.dirname(os.path.abspath(a.out)), exist_ok=True)
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", lst,
                    "-ac", "1", "-b:a", "64k", a.out], check=True)
    dur = float(subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of",
                                "default=nw=1:nk=1", a.out], capture_output=True, text=True).stdout.strip())
    print(json.dumps({"out": a.out, "duration_secs": round(dur, 1), "chars": len(text), "chunks": len(parts),
                      "cost_usd": round(cost_cents / 100, 2), "flow_id": flow_id}))


if __name__ == "__main__":
    main()
