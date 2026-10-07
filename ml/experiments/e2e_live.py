"""Live end-to-end smoke test of the full Phase 3 flow against a RUNNING API, with real face
photos (ORL, upscaled so the real Haar detector can find them) and the real detector.

register -> login -> upload samples -> train -> recognise held-out photos.
Not a benchmark (tiny N); it proves the pieces work together over HTTP.
The server must be started with the same small minimum-samples override this script prints.
"""

import argparse
from collections import Counter
import base64
import json
import urllib.error
import urllib.request
import uuid

import cv2
import numpy as np

POSES = ["neutral", "turn_left", "turn_right", "chin_up"]


def call(base, method, path, body=None, token=None):
    req = urllib.request.Request(base + path, method=method, data=json.dumps(body).encode() if body is not None else None)
    req.add_header("Content-Type", "application/json")
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(req) as r:
            raw = r.read()
            return r.status, (json.loads(raw) if raw else None)
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"null")


def photo(im):
    big = cv2.copyMakeBorder(cv2.resize(im, None, fx=4, fy=4, interpolation=cv2.INTER_CUBIC), 60, 60, 100, 100, cv2.BORDER_REPLICATE)
    ok, buf = cv2.imencode(".jpg", big, [cv2.IMWRITE_JPEG_QUALITY, 92])
    return base64.b64encode(buf.tobytes()).decode()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--api", default="http://127.0.0.1:8000")
    ap.add_argument("--orl", required=True)
    ap.add_argument("--users", type=int, default=5)
    ap.add_argument("--train-per-user", type=int, default=8)
    a = ap.parse_args()
    d = np.load(a.orl)
    X, y = d["X"], d["y"]
    subjects = list(np.unique(y))[: a.users + 1]
    stranger, enrolled = subjects[-1], subjects[:-1]

    users = {}
    for s in enrolled:
        email = f"e2e-{uuid.uuid4().hex[:8]}@example.com"
        st, u = call(a.api, "POST", "/auth/register", {"name": f"Subject {s}", "email": email, "password": "Correct-horse-42"})
        assert st == 201, (st, u)
        st, t = call(a.api, "POST", "/auth/login", {"email": email, "password": "Correct-horse-42"})
        users[s] = {"id": u["id"], "token": t["access_token"], "images": X[y == s]}

    for s, u in users.items():
        for i, im in enumerate(u["images"][: a.train_per_user]):
            st, r = call(a.api, "POST", "/faces/samples", {"image_base64": photo(im), "pose": POSES[i % 4]}, u["token"])
            assert st == 201, (s, i, st, r)
    print(f"enrolled {len(users)} users x {a.train_per_user} samples through the real detector")

    first = next(iter(users.values()))
    st, m = call(a.api, "POST", "/faces/train", token=first["token"])
    assert st == 200, (st, m)
    print("trained:", m["version"], "| deployed:", m["classifier"], "| validation:", m["validation"])
    print("  PCA comps:", m["pca"]["n_components"], "LDA comps:", m["lda"]["n_components"])
    for k, v in m["comparison"].items():
        print(f"  {k:12s} accuracy={v['accuracy']} macro_f1={v['macro_f1']}")

    reasons = Counter()
    genuine = fa_other = fa_stranger = 0
    n_g = n_o = n_s = 0
    for s, u in users.items():
        for im in u["images"][a.train_per_user :]:
            st, r = call(a.api, "POST", "/faces/recognize", {"image_base64": photo(im)}, u["token"])
            assert st == 200, (st, r)
            n_g += 1
            genuine += r["matched"]
            reasons[r["reason"]] += 1
        other = next(o for o in users if o != s)
        for im in users[other]["images"][a.train_per_user :]:
            st, r = call(a.api, "POST", "/faces/recognize", {"image_base64": photo(im)}, u["token"])
            n_o += 1
            fa_other += r["matched"]
        for im in X[y == stranger][:2]:
            st, r = call(a.api, "POST", "/faces/recognize", {"image_base64": photo(im)}, u["token"])
            n_s += 1
            fa_stranger += r["matched"]
    print(f"genuine held-out photos accepted: {genuine}/{n_g}  outcomes: {dict(reasons)}")
    print(f"another enrolled user's photos accepted as me: {fa_other}/{n_o}")
    print(f"unenrolled stranger's photos accepted as me: {fa_stranger}/{n_s}")


if __name__ == "__main__":
    main()
