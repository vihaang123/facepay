"""Live end-to-end run of the Phase 5 payment flow against a RUNNING API: real HTTP, real PostgreSQL, real
OpenCV face detector, real PCA/LDA model, real ORL face photos (a public benchmark, not webcam footage).

Head turns are SIMULATED by sliding the same photo sideways inside the frame, so this exercises the whole pipeline
but says nothing about real head turns on a real webcam. N is tiny: it shows the pieces work together over HTTP,
it is not an accuracy figure. Start the server first with the small-sample override (see e2e_live.py).
"""

import argparse
import base64
import json
import time
import urllib.error
import urllib.request
import uuid
from collections import Counter

import cv2
import numpy as np

POSES = ["neutral", "turn_left", "turn_right", "chin_up"]
PW = "Correct-horse-42"
PAD = 200  # total horizontal padding, so every frame has the same size


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


def big(im):
    return cv2.resize(im, None, fx=4, fy=4, interpolation=cv2.INTER_CUBIC)


def jpg_b64(img):
    ok, buf = cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, 92])
    return base64.b64encode(buf.tobytes()).decode()


def enroll_photo(im):
    return jpg_b64(cv2.copyMakeBorder(big(im), 60, 60, 100, 100, cv2.BORDER_REPLICATE))


def frame(im, left):
    return jpg_b64(cv2.copyMakeBorder(big(im), 60, 60, left, PAD - left, cv2.BORDER_REPLICATE))


def two_faces(im, other):
    return jpg_b64(cv2.copyMakeBorder(np.hstack([big(im), big(other)]), 60, 60, 60, 60, cv2.BORDER_REPLICATE))


def turn_frames(im, challenge, toward=True, still=False):
    """2 baseline frames + 6 frames sliding toward the requested side (image-left for turn_right)."""
    sign = -1 if challenge == "turn_right" else 1
    if not toward:
        sign = -sign
    base = 150 if sign < 0 else 50
    shifts = [0, 0] + ([0] * 6 if still else [15, 40, 65, 80, 80, 80])
    return [frame(im, base + sign * s) for s in shifts]


def call_paced(api, method, path, body=None, token=None):
    """The API allows 10 face-authentication requests per user per minute; wait out a 429 instead of failing."""
    for _ in range(3):
        st, r = call(api, method, path, body, token)
        if st != 429:
            return st, r
        time.sleep(62)
    return st, r


def authenticate(api, tok, sid, im, *, toward=True, still=False, other=None):
    st, ch = call_paced(api, "POST", f"/payments/sessions/{sid}/authenticate/start", token=tok)
    assert st == 200, (st, ch)
    if other is not None:
        frames = [two_faces(im, other)] * 8
    else:
        frames = turn_frames(im, ch["challenge"], toward, still)
    st, r = call_paced(api, "POST", f"/payments/sessions/{sid}/authenticate", {"challenge_id": ch["challenge_id"], "frames": frames}, tok)
    return st, r


def new_session(api, mtok, amount="950.00", ref="SG-LIVE"):
    st, s = call(api, "POST", "/merchant/payment-sessions", {"amount": amount, "order_reference": ref}, mtok)
    assert st == 201, (st, s)
    return s["session_id"]


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
    api = a.api

    # ---- accounts
    tag = uuid.uuid4().hex[:6]
    st, m = call(api, "POST", "/auth/merchant/register", {"name": "Owner", "business_name": "LiveShop", "email": f"e2e-m-{tag}@example.com", "password": PW})
    assert st == 201, (st, m)
    mtok = call(api, "POST", "/auth/merchant/login", {"email": f"e2e-m-{tag}@example.com", "password": PW})[1]["access_token"]
    st, m2 = call(api, "POST", "/auth/merchant/register", {"name": "Other", "business_name": "OtherShop", "email": f"e2e-o-{tag}@example.com", "password": PW})
    m2tok = call(api, "POST", "/auth/merchant/login", {"email": f"e2e-o-{tag}@example.com", "password": PW})[1]["access_token"]
    users = {}
    for s in enrolled:
        email = f"e2e-{tag}-{s}@example.com"
        st, u = call(api, "POST", "/auth/register", {"name": f"Subject {s}", "email": email, "password": PW})
        assert st == 201, (st, u)
        users[s] = {"tok": call(api, "POST", "/auth/login", {"email": email, "password": PW})[1]["access_token"], "imgs": X[y == s]}
    for s, u in users.items():
        for i, im in enumerate(u["imgs"][: a.train_per_user]):
            st, r = call(api, "POST", "/faces/samples", {"image_base64": enroll_photo(im), "pose": POSES[i % 4]}, u["tok"])
            assert st == 201, (s, i, st, r)
    st, model = call(api, "POST", "/faces/train", token=next(iter(users.values()))["tok"])
    assert st == 200, (st, model)
    print(f"{len(users)} subjects x {a.train_per_user} photos enrolled and trained: {model['classifier']} ({model['version']})")

    # ---- 1. genuine payments: each subject pays their own session, retrying with a different photo if rejected
    print("\n== 1. genuine customer pays (up to 4 tries, each try a different photo of the same person)")
    paid, tries_needed, reasons, confs = 0, [], Counter(), []
    receipts = {}
    for s, u in users.items():
        sid = new_session(api, mtok, "950.00", f"LIVE-{s}")
        ok = False
        photos = list(u["imgs"][a.train_per_user :]) + list(u["imgs"][: a.train_per_user])
        for n, im in enumerate(photos[:4], 1):
            st, r = authenticate(api, u["tok"], sid, im)
            assert st == 200, (st, r)
            if r["result"] == "AUTHENTICATED":
                confs.append(r["identity"]["confidence"])
                st, rec = call(api, "POST", f"/payments/sessions/{sid}/confirm",
                               {"authorization_token": r["authorization"]["authorization_token"], "expected_amount": "950.00"}, u["tok"])
                assert st == 200, (st, rec)
                receipts[s] = rec
                ok = True
                tries_needed.append(n)
                break
            reasons[f"{r['reason']}/{r['detail']}"] += 1
        paid += ok
        time.sleep(0.2)
    print(f"   paid: {paid}/{len(users)}; tries needed per paying subject: {tries_needed}; rejections before success/failure: {dict(reasons)}")
    if confs:
        print(f"   confidence reported for accepted attempts: {[round(c, 3) for c in confs]}")

    # ---- 2. things that must be refused
    print("\n== 2. attempts that must be refused (real detector + real model)")
    s0, s1 = enrolled[0], enrolled[1]
    u0, u1 = users[s0], users[s1]
    outcome = Counter()

    def attempt(label, tok, im, **kw):
        sid = new_session(api, mtok, "100.00", "LIVE-NEG")
        st, r = authenticate(api, tok, sid, im, **kw)
        assert st == 200, (label, st, r)
        outcome[(label, r["result"], r["reason"], r["detail"])] += 1
        return r

    for im in u1["imgs"][a.train_per_user :]:
        attempt("another enrolled person's face on my account", u0["tok"], im)
    for im in X[y == stranger][:2]:
        attempt("unenrolled stranger's face on my account", u0["tok"], im)
    attempt("no head movement (static photo)", u0["tok"], u0["imgs"][a.train_per_user], still=True)
    attempt("turned the wrong way", u0["tok"], u0["imgs"][a.train_per_user], toward=False)
    attempt("two faces in view", u0["tok"], u0["imgs"][a.train_per_user], other=u1["imgs"][a.train_per_user])
    for (label, res, reason, detail), n in outcome.items():
        print(f"   {label}: {res} {reason or ''} {detail or ''} x{n}")

    # ---- 3. authorization security over real HTTP
    print("\n== 3. authorization security")
    sid = new_session(api, mtok, "950.00", "LIVE-SEC")
    r = None
    for im in list(u0["imgs"][a.train_per_user :]) + list(u0["imgs"][: a.train_per_user]):
        st, r = authenticate(api, u0["tok"], sid, im)
        if r["result"] == "AUTHENTICATED":
            break
    assert r["result"] == "AUTHENTICATED", r
    ticket = r["authorization"]["authorization_token"]
    checks = {}
    st, _ = call(api, "POST", f"/payments/sessions/{sid}/confirm", {"authorization_token": ticket, "expected_amount": "1.00"}, u0["tok"])
    checks["amount 950 -> 1 refused (409)"] = st == 409
    st, _ = call(api, "POST", f"/payments/sessions/{sid}/confirm", {"authorization_token": ticket}, u1["tok"])
    checks["another customer using my ticket refused (403)"] = st == 403
    sid2 = new_session(api, mtok, "5.00", "LIVE-OTHER-SESSION")
    st, _ = call(api, "POST", f"/payments/sessions/{sid2}/confirm", {"authorization_token": ticket}, u0["tok"])
    checks["ticket for session A on session B refused (403)"] = st == 403
    st, rec = call(api, "POST", f"/payments/sessions/{sid}/confirm", {"authorization_token": ticket, "expected_amount": "950.00"}, u0["tok"])
    checks["rightful owner pays once (200, FACE_PAY, 950.00)"] = st == 200 and rec["payment_method"] == "FACE_PAY" and rec["amount"] == "950.00"
    st, _ = call(api, "POST", f"/payments/sessions/{sid}/confirm", {"authorization_token": ticket}, u0["tok"])
    checks["ticket reused refused (409)"] = st == 409
    st = call(api, "GET", f"/merchant/payment-sessions/{sid}", token=m2tok)[0]
    checks["other merchant cannot read my session (404)"] = st == 404
    st, _ = call(api, "GET", f"/payments/transactions/{rec['transaction_id']}", token=u1["tok"])
    checks["other customer cannot read my receipt (404)"] = st == 404
    for k, v in checks.items():
        print(f"   {'PASS' if v else 'FAIL'}  {k}")

    # ---- 4. dashboards
    print("\n== 4. dashboards")
    st, sm = call(api, "GET", "/merchant/summary", token=mtok)
    print(f"   merchant: revenue {sm['total_revenue']}, transactions {sm['transactions']}, successful {sm['successful_payments']}, "
          f"failed {sm['failed_payments']}, open sessions {sm['open_sessions']}")
    st, hist = call(api, "GET", "/payments/transactions", token=u0["tok"])
    print(f"   customer {s0}: {len(hist)} transaction(s): {[(h['transaction_id'], h['amount']) for h in hist]}")
    st, mt = call(api, "GET", "/merchant/transactions?limit=100", token=mtok)
    print(f"   merchant sees {len(mt)} transactions; all FACE_PAY/SUCCESS: {all(t['payment_method'] == 'FACE_PAY' and t['status'] == 'SUCCESS' for t in mt)}")
    assert all(checks.values()), "a security check failed"


if __name__ == "__main__":
    main()
