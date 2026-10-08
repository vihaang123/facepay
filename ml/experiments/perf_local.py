"""Local, repeatable latency benchmark against a RUNNING API (single process, one machine, no network).

    backend/.venv/bin/python ml/experiments/perf_local.py --orl PATH/orl.npz --out ml/results/perf_local.json

The API must be started with MIN_SAMPLES_PER_USER lowered to 8 and relaxed rate limits (see
docs/browser-testing/README.md), because ORL has 10 photos per subject. It creates throwaway users
(perf-<tag>@example.com). Numbers are LOCAL BENCHMARKS: they say nothing about cloud latency.
"""

import argparse
import base64
import json
import statistics as st
import time
import urllib.request
import uuid
from urllib.error import HTTPError

import cv2
import numpy as np

PW = "Correct-horse-42"
POSES = ["neutral", "turn_left", "turn_right", "chin_up"]


def call(base, method, path, body=None, token=None):
    req = urllib.request.Request(base + path, method=method, data=json.dumps(body).encode() if body is not None else None,
                                 headers={"Content-Type": "application/json", **({"Authorization": f"Bearer {token}"} if token else {})})
    t = time.perf_counter()
    try:
        with urllib.request.urlopen(req) as r:
            out = r.status, json.loads(r.read() or b"null")
    except HTTPError as e:
        out = e.code, json.loads(e.read() or b"null")
    return out[0], out[1], (time.perf_counter() - t) * 1000


def summarize(ms):
    ms = sorted(ms)
    return {"n": len(ms), "median_ms": round(st.median(ms), 2), "p95_ms": round(ms[max(0, int(len(ms) * 0.95) - 1)], 2), "max_ms": round(ms[-1], 2)}


def photo(im, dx=0):
    big = cv2.resize(im, None, fx=4, fy=4, interpolation=cv2.INTER_CUBIC)
    img = cv2.copyMakeBorder(big, 60, 60, 100 + dx, 100 - dx, cv2.BORDER_REPLICATE)
    return base64.b64encode(cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, 92])[1].tobytes()).decode()


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--orl", required=True)
    ap.add_argument("--base", default="http://localhost:8000")
    ap.add_argument("--out")
    a = ap.parse_args()
    B = a.base
    d = np.load(a.orl)
    X, y = d["X"], d["y"]
    tag = uuid.uuid4().hex[:6]
    res = {"conditions": "local single-process uvicorn + local PostgreSQL, one client, sequential requests, localhost"}

    res["health"] = summarize([call(B, "GET", "/health")[2] for _ in range(200)])

    reg, login = [], []
    users = []
    for s in (20, 21, 22):
        email = f"perf-{tag}-{s}@example.com"
        st_, _, ms = call(B, "POST", "/auth/register", {"name": f"Perf {s}", "email": email, "password": PW})
        assert st_ == 201
        reg.append(ms)
        st_, r, ms = call(B, "POST", "/auth/login", {"email": email, "password": PW})
        login.append(ms)
        users.append((s, r["access_token"]))
    res["register_bcrypt"] = summarize(reg)
    res["login_bcrypt"] = summarize(login)

    up = []
    for s, tok in users:
        for i, im in enumerate(X[y == s][:8]):
            st_, r, ms = call(B, "POST", "/faces/samples", {"image_base64": photo(im), "pose": POSES[i % 4]}, tok)
            assert st_ == 201, r
            up.append(ms)
    res["face_sample_upload"] = summarize(up)
    st_, r, ms = call(B, "POST", "/faces/train", None, users[0][1])
    assert st_ in (200, 201), r
    res["train_model_3_users_24_samples_ms"] = round(ms, 1)

    s0, tok0 = users[0]
    probe = X[y == s0][9]
    rec = []
    for _ in range(30):
        st_, r, ms = call(B, "POST", "/faces/recognize", {"image_base64": photo(probe)}, tok0)
        assert st_ == 200, r
        rec.append(ms)
    res["faces_recognize_single_frame"] = summarize(rec)

    # merchant + full payment flow
    m_email = f"perf-{tag}-shop@example.com"
    call(B, "POST", "/auth/merchant/register", {"name": "Perf", "business_name": "Perf Shop", "email": m_email, "password": PW})
    mt = call(B, "POST", "/auth/merchant/login", {"email": m_email, "password": PW})[1]["access_token"]
    flow = {"create_session": [], "challenge": [], "verify_7_frames": [], "confirm": [], "customer_transactions": [], "merchant_transactions": [], "customer_summary": [], "merchant_summary": []}
    results = []
    for n in range(10):
        st_, sess, ms = call(B, "POST", "/merchant/payment-sessions", {"amount": "100.00", "order_reference": f"PERF-{n}"}, mt)
        assert st_ == 201, sess
        flow["create_session"].append(ms)
        sid = sess["session_id"]
        st_, ch, ms = call(B, "POST", f"/payments/sessions/{sid}/authenticate/start", None, tok0)
        assert st_ == 200, ch
        flow["challenge"].append(ms)
        sign = -1 if ch["instruction"].lower().find("right") >= 0 else 1
        moves = [0, 0, 0.04, 0.10, 0.16, 0.18, 0.18]
        frames = [photo(probe, int(round(sign * m * 368))) for m in moves]
        st_, ar, ms = call(B, "POST", f"/payments/sessions/{sid}/authenticate", {"challenge_id": ch["challenge_id"], "frames": frames}, tok0)
        flow["verify_7_frames"].append(ms)
        results.append(ar.get("result"))
        if ar.get("result") == "AUTHENTICATED":
            st_, rc, ms = call(B, "POST", f"/payments/sessions/{sid}/confirm", {"authorization_token": ar["authorization"]["authorization_token"]}, tok0)
            flow["confirm"].append(ms)
    for _ in range(30):
        flow["customer_transactions"].append(call(B, "GET", "/payments/transactions?limit=20", None, tok0)[2])
        flow["merchant_transactions"].append(call(B, "GET", "/merchant/transactions?limit=20", None, mt)[2])
        flow["customer_summary"].append(call(B, "GET", "/payments/summary", None, tok0)[2])
        flow["merchant_summary"].append(call(B, "GET", "/merchant/summary", None, mt)[2])
    res["payment_flow"] = {k: summarize(v) for k, v in flow.items() if v}
    res["payment_flow_auth_results"] = {r: results.count(r) for r in set(results)}
    print(json.dumps(res, indent=1))
    if a.out:
        with open(a.out, "w") as f:
            json.dump(res, f, indent=2)


if __name__ == "__main__":
    main()
