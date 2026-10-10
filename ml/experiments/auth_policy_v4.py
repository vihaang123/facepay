"""Recognition policy before and after the v4 recipe, through the code that runs in production.

    backend/.venv/bin/python ml/experiments/auth_policy_v4.py --orl PATH/orl.npz --repeats 30 --out ml/results/auth_policy_v4.json

Why this exists: after the detection and liveness fixes a genuine account owner passed both and was still rejected at
identity recognition, five attempts in a row. This measures how often that happens under the OLD recipe, and what the NEW
recipe changes in both directions: genuine users accepted, and impostors accepted.

What is real: app.ml.recipe.train_recognizer (cross-validation, classifier choice, augmented training, thresholds),
app.ml.recipe.frame_identity and app.services.auth_policy.decide, exactly as the service calls them; the app's crop,
histogram equalisation and vectorisation.

What is NOT real (read before quoting any number):
  * ORL has 10 photographs per person, so each enrolled person has 6 training and 4 held-out photographs (the app asks
    for 15 samples); these are public, studio-quality, 112x92 images, not phone selfies.
  * No face detector is involved (ORL images are already face crops), so detector box jitter is only simulated.
  * "Session shift" is SIMULATED on the held-out photographs: independent horizontal and vertical scale (+-8%), shift
    (+-3 px), rotation (+-5 deg), a side-lighting ramp, blur and noise. It is a different family from the training
    augmentation (which uses one isotropic scale, no anisotropy, no noise), but the two overlap in kind, so the gain from
    augmentation on this table is probably larger than the gain on real devices. Real cross-device shift (a laptop
    webcam at enrolment, a phone at payment time; different lenses, distances and software processing) is NOT simulated.
  * Liveness is assumed passed. This measures identity recognition only.
  * An attempt uses 2 frames, as the app does (BASELINE_MIN_USABLE). "different photos" = 2 different held-out photos
    (pessimistic: more variation than two consecutive webcam frames). "one capture" = 2 frames of ONE photo with small
    per-frame jitter (optimistic: what two consecutive frames of a still person look like).

Populations: genuine (held-out photos of enrolled person A claiming A), impostor_enrolled (another enrolled person B
claiming A) and impostor_unknown (people who were never enrolled claiming A). Held-out photos are never used for training
or for calibrating the threshold.
"""

import math

import cv2
import numpy as np

from common import parse_args, save_json
from app.ml import config as cfg
from app.ml.evaluation import user_thresholds
from app.ml.preprocessing import crop_to_stored
from app.ml.recipe import frame_identity, train_recognizer
from app.services import auth_policy as policy


def wilson(k, n, z=1.96):
    if n == 0:
        return [None, None]
    p = k / n
    d = 1 + z * z / n
    c = (p + z * z / (2 * n)) / d
    h = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return [round(max(0, c - h), 4), round(min(1, c + h), 4)]


def session_shift(im, rng):
    """A later capture of the same face: different box placement, scale, tilt, lighting side, focus and noise."""
    h, w = im.shape
    sx, sy = 1 + rng.uniform(-0.08, 0.08), 1 + rng.uniform(-0.08, 0.08)
    m = cv2.getRotationMatrix2D((w / 2, h / 2), rng.uniform(-5, 5), 1.0)
    m[:, 2] += (rng.uniform(-3, 3), rng.uniform(-3, 3))
    m[0, :2] *= sx
    m[1, :2] *= sy
    out = cv2.warpAffine(im, m, (w, h), borderMode=cv2.BORDER_REPLICATE).astype(np.float32)
    theta = rng.uniform(0, 2 * np.pi)
    ax = np.linspace(-1, 1, w, dtype=np.float32)[None, :]
    ay = np.linspace(-1, 1, h, dtype=np.float32)[:, None]
    out += (np.cos(theta) * ax + np.sin(theta) * ay) * rng.uniform(0, 35)
    out += rng.normal(0, 3, out.shape)
    out = np.clip(out, 0, 255).astype(np.uint8)
    if rng.random() < 0.5:
        out = cv2.GaussianBlur(out, (0, 0), rng.uniform(0.4, 1.0))
    return out


def jitter(im, rng):
    """Frame-to-frame change inside one capture: sub-pixel to one-pixel box wobble and sensor noise."""
    h, w = im.shape
    m = np.float32([[1, 0, rng.uniform(-1, 1)], [0, 1, rng.uniform(-1, 1)]])
    out = cv2.warpAffine(im, m, (w, h), borderMode=cv2.BORDER_REPLICATE).astype(np.float32) + rng.normal(0, 2, im.shape)
    return np.clip(out, 0, 255).astype(np.uint8)


def crop(im):
    return crop_to_stored(im[10:102, :])[0]


def legacy_rule(frames, threshold):
    """The decision rule before v4: every frame classified as the user, confidence >= 0.5, and EVERY distance within the threshold."""
    return all(f.predicted_is_user and f.confidence >= cfg.AUTH_MIN_CONFIDENCE and f.distance <= threshold for f in frames)


def v4_rule(frames, threshold):
    return policy.decide(policy.Evidence(liveness_passed=True, frames=tuple(frames), distance_threshold=threshold)).authenticated


def attempts(images, rng, shift, mode):
    """Lists of 2 images (frames) per attempt from a set of photographs of one person."""
    out = []
    if mode == "different_photos":
        for i in range(len(images)):
            for j in range(i + 1, len(images)):
                a, b = images[i], images[j]
                out.append([session_shift(a, rng) if shift else a, session_shift(b, rng) if shift else b])
    else:
        for im in images:
            for _ in range(2):
                base = session_shift(im, rng) if shift else im
                out.append([jitter(base, rng), jitter(base, rng)])
    return out


ARMS = {
    # name: (training config, percentile, rule). Training configs: "legacy" = no augmentation, pooled threshold;
    # "s10" / "s15" / "s20" = augmented training with the calibration copies perturbed 1.0x / 1.5x / 2.0x as strongly as training copies.
    "A_before_v4": ("legacy", 70.0, "legacy"),
    "B_mean_rule_only": ("legacy", 70.0, "v4"),
    "C_augmented_p70": ("s15", 70.0, "v4"),
    "D0_p90_calibration_strength_1.0": ("s10", 90.0, "v4"),
    "D_deployed_p90_strength_1.5": ("s15", 90.0, "v4"),
    "E_p95_strength_1.5": ("s15", 95.0, "v4"),
    "F_p90_strength_2.0": ("s20", 90.0, "v4"),
}
STRENGTH = {"s10": 1.0, "s15": 1.5, "s20": 2.0}


def run(IM, Y, C, trials, seed, ntrain):
    rng = np.random.default_rng(seed)
    subjects = np.unique(Y)
    tally = {}

    def add(key, ok):
        t = tally.setdefault(key, [0, 0])
        t[0] += int(ok)
        t[1] += 1

    for _ in range(trials):
        pick = rng.permutation(subjects)
        enrolled, unknown = pick[:C], pick[C : C + 10]
        tr_im, tr_y, held = [], [], {}
        for s in enrolled:
            idx = rng.permutation(np.where(Y == s)[0])
            tr_im += [IM[i] for i in idx[:ntrain]]
            tr_y += [int(s)] * ntrain
            held[int(s)] = [IM[i] for i in idx[ntrain:]]
        crops = np.stack([crop(i) for i in tr_im])
        y = np.array(tr_y)
        legacy = train_recognizer(crops, y, None, copies=0, calibration_copies=0, percentile=70.0, per_user=False)
        trained = {"legacy": legacy}
        for name, strength in STRENGTH.items():
            cfg.AUGMENT_CALIBRATION_STRENGTH = strength
            trained[name] = train_recognizer(crops, y, None)
        unk_sets = [[IM[i] for i in rng.permutation(np.where(Y == u)[0])[:6]] for u in unknown]
        for shift in (False, True):
            for mode in ("different_photos", "one_capture"):
                pops = {}
                for a in held:
                    pops[("genuine", a)] = attempts(held[a], rng, shift, mode)
                    pops[("impostor_enrolled", a)] = [t for b in held if b != a for t in attempts(held[b], rng, shift, mode)]
                    pops[("impostor_unknown", a)] = [t for u in unk_sets for t in attempts(u, rng, shift, mode)[:3]]
                for arm, (cfgname, pct, rule) in ARMS.items():
                    tr = trained[cfgname]
                    d = tr.results[f"pca_lda_{tr.chosen}"]
                    pooled, per = user_thresholds(d["_genuine_distances"], d["_genuine_labels"], pct)
                    if cfgname == "legacy":
                        per = {u: pooled for u in per}
                    for (pop, a), atts in pops.items():
                        centroid = tr.model.centroids_[a]
                        for frames_img in atts:
                            ids = [frame_identity(tr.model, a, centroid, crop(f)) for f in frames_img]
                            ok = legacy_rule(ids, per[a]) if rule == "legacy" else v4_rule(ids, per[a])
                            add((("shift" if shift else "no_shift"), mode, arm, pop), ok)
    return tally


def summarise(tally):
    out = {}
    for (cond, mode, arm, pop), (k, n) in sorted(tally.items()):
        out.setdefault(cond, {}).setdefault(mode, {}).setdefault(arm, {})[pop] = {"accepted": k, "attempts": n, "rate": round(k / n, 4), "ci95": wilson(k, n)}
    return out


def main():
    args = parse_args("Recognition policy before/after v4", extra=lambda p: p.add_argument("--people", default="2,5,10"))
    d = np.load(args.orl)
    IM, Y = d["X"], d["y"]
    deployed_strength = cfg.AUGMENT_CALIBRATION_STRENGTH
    assert deployed_strength == STRENGTH["s15"], "the deployed arm must use the deployed calibration strength"
    people = [int(c) for c in args.people.split(",")]
    result = {"setting": __doc__, "arms": {k: {"training": v[0], "percentile": v[1], "rule": v[2]} for k, v in ARMS.items()}, "by_enrolled_people": {}}
    for C, ntrain in [(c, 6) for c in people]:
        trials = max(6, args.repeats if C == 2 else args.repeats // 2 if C == 5 else args.repeats // 4)
        t = run(IM, Y, C, trials, args.seed + C, ntrain)
        result["by_enrolled_people"][str(C)] = {"trials": trials, "train_photos_per_person": ntrain, "results": summarise(t)}
        for cond in ("no_shift", "shift"):
            for mode in ("different_photos", "one_capture"):
                for arm in ARMS:
                    r = {p: result["by_enrolled_people"][str(C)]["results"][cond][mode][arm][p]["rate"] for p in ("genuine", "impostor_enrolled", "impostor_unknown")}
                    print(f"C={C} {cond:8s} {mode:16s} {arm:18s} genuine {r['genuine']:.3f}  other-enrolled {r['impostor_enrolled']:.3f}  never-enrolled {r['impostor_unknown']:.3f}", flush=True)
    save_json(result, args.out)


if __name__ == "__main__":
    main()
