"""Seeds 5 other enrolled customers via the API (so a 2+-user model can be trained) and writes ORL face images for the fake camera."""
import base64, json, os, sys, uuid, urllib.request, urllib.error
import cv2, numpy as np

API = "http://localhost:8000"
PW = "Correct-horse-42"
POSES = ["neutral", "turn_left", "turn_right", "chin_up"]

def call(method, path, body=None, token=None):
    req = urllib.request.Request(API + path, method=method, data=json.dumps(body).encode() if body is not None else None,
                                 headers={"Content-Type": "application/json", **({"Authorization": f"Bearer {token}"} if token else {})})
    try:
        with urllib.request.urlopen(req) as r:
            return r.status, json.loads(r.read() or b"null")
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"null")

def big(im): return cv2.resize(im, None, fx=4, fy=4, interpolation=cv2.INTER_CUBIC)
def b64(img): return base64.b64encode(cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, 92])[1].tobytes()).decode()
def enroll_photo(im): return b64(cv2.copyMakeBorder(big(im), 60, 60, 100, 100, cv2.BORDER_REPLICATE))

d = np.load(os.environ.get("ORL_NPZ", "orl.npz")); X, y = d["X"], d["y"]
tag = uuid.uuid4().hex[:6]
for s in (1, 2, 3, 4, 5):
    st, _ = call("POST", "/auth/register", {"name": f"Subject {s}", "email": f"e2e-seed-{tag}-{s}@example.com", "password": PW}); assert st == 201
    tok = call("POST", "/auth/login", {"email": f"e2e-seed-{tag}-{s}@example.com", "password": PW})[1]["access_token"]
    for i, im in enumerate(X[y == s][:8]):
        st, r = call("POST", "/faces/samples", {"image_base64": enroll_photo(im), "pose": POSES[i % 4]}, tok); assert st == 201, r
print("seeded 5 enrolled customers")

def png(im): return "data:image/png;base64," + base64.b64encode(cv2.imencode(".png", im)[1].tobytes()).decode()
out = {"me": [png(im) for im in X[y == 0]], "stranger": [png(im) for im in X[y == 20]]}
json.dump(out, open("faces.json", "w"))
print("wrote faces.json", {k: len(v) for k, v in out.items()})
