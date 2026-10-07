"""Open-set decision rules for authentication, compared on ORL BEFORE choosing one.

Pre-declared candidates (all thresholds come from out-of-fold genuine scores of the enrolment
data only, never from the impostors; no tuning on the test impostors):
  P0  identity + distance to claimed centroid          (the Phase 3 rule)
  P1  identity + margin ratio  d(claimed) / d(nearest other centroid)
  P2  identity on 2 frames + mean distance of the 2 frames
Pre-declared adoption rule: a candidate replaces P0 only if its FAR (impostor claims the
predicted identity) at FRR = 0.20 is lower by >= 5 absolute points at BOTH C=5 and C=30
and the gap exceeds 2 standard errors; otherwise P0 stays.
Setting: C enrolled subjects x 6 images, 4 genuine probes each, impostors = all images of the
other subjects. 2-frame attempts pair two different photos of the same person: ORL photos
differ more than consecutive webcam frames, so P2's benefit here is probably optimistic.
"""

import numpy as np

from common import load_orl, parse_args, save_json, vectors
from app.ml.evaluation import VARIANTS, make_splits
from app.ml.pipeline import FacePipeline

PCTS = (30, 40, 50, 60, 70, 80, 90, 95)


def centroid_matrix(model):
    return np.stack([model.centroids_[c] for c in model.classes_])


def scores(model, Xp, claimed):
    """(pred==claimed, d_claim, ratio) per row."""
    z = model.transform(Xp)
    C = centroid_matrix(model)
    D = np.linalg.norm(z[:, None] - C[None], axis=2)
    idx = np.array([list(model.classes_).index(c) for c in claimed])
    d = D[np.arange(len(z)), idx]
    other = np.where(np.arange(D.shape[1])[None] == idx[:, None], np.inf, D).min(axis=1)
    return model.clf_.predict(z) == claimed, d, d / other


def oof_scores(X, y, rng):
    splits, _ = make_splits(y, None)
    D, R = [], []
    for tr, te in splits:
        m = FacePipeline(**VARIANTS["pca_lda_knn"]).fit(X[tr], y[tr])
        ok, d, r = scores(m, X[te], y[te])
        D.append(d)
        R.append(r)
    return np.concatenate(D), np.concatenate(R)


def run_draw(X, y, c, seed):
    rng = np.random.default_rng(seed)
    subj = rng.permutation(np.unique(y))
    enrolled, strangers = subj[:c], subj[c:]
    tr, pr = [], []
    for s in enrolled:
        idx = rng.permutation(np.flatnonzero(y == s))
        tr += list(idx[:6])
        pr += list(idx[6:])
    tr, pr = np.array(tr), np.array(pr)
    imp = np.flatnonzero(np.isin(y, strangers))
    model = FacePipeline(**VARIANTS["pca_lda_knn"]).fit(X[tr], y[tr])
    oof_d, oof_r = oof_scores(X[tr], y[tr], rng)

    pred_claim = model.predict(X[imp])
    rand_claim = rng.choice(enrolled, size=len(imp))
    g_ok, g_d, g_r = scores(model, X[pr], y[pr])
    out = {}
    for name, claim in (("pred", pred_claim), ("rand", rand_claim)):
        out[name] = scores(model, X[imp], claim)

    # 2-frame attempts: pair photos of the same person
    def pairs(idx_list, labels):
        P = []
        for lab in np.unique(labels):
            ii = np.array(idx_list)[labels == lab]
            rng.shuffle(ii)
            P += [(ii[k], ii[k + 1]) for k in range(0, len(ii) - 1, 2)]
        return np.array(P)

    gp = pairs(pr, y[pr])
    ip = pairs(imp, y[imp])
    def two(pair_idx, claim_of):
        a = scores(model, X[pair_idx[:, 0]], claim_of(pair_idx[:, 0]))
        b = scores(model, X[pair_idx[:, 1]], claim_of(pair_idx[:, 1]))
        # impostor pair claims what the model predicts for the first frame (worst case) or random
        return a[0] & b[0], (a[1] + b[1]) / 2
    g2_ok, g2_d = two(gp, lambda i: y[i])
    oof_pairs = []
    for lab in np.unique(y[tr]):
        dd = oof_d[y[tr][np.concatenate([te for _, te in make_splits(y[tr], None)[0]])] == lab]
        rng.shuffle(dd)
        oof_pairs += list((dd[:-1:2] + dd[1::2][: len(dd[:-1:2])]) / 2)
    oof_p = np.array(oof_pairs)
    i2 = {}
    for name in ("pred", "rand"):
        first_claim = pred_claim if name == "pred" else rand_claim
        lookup = dict(zip(imp, first_claim))
        i2[name] = two(ip, lambda i: np.array([lookup[j] for j in i]))

    rows = {}
    for pct in PCTS:
        t_d, t_r, t_p = np.percentile(oof_d, pct), np.percentile(oof_r, pct), np.percentile(oof_p, pct)
        rows[pct] = {
            "P0": (1 - np.mean(g_ok & (g_d <= t_d)), *(np.mean(o[0] & (o[1] <= t_d)) for o in (out["pred"], out["rand"]))),
            "P1": (1 - np.mean(g_ok & (g_r <= t_r)), *(np.mean(o[0] & (o[2] <= t_r)) for o in (out["pred"], out["rand"]))),
            "P2": (1 - np.mean(g2_ok & (g2_d <= t_p)), *(np.mean(i2[n][0] & (i2[n][1] <= t_p)) for n in ("pred", "rand"))),
        }
    return rows


def far_at_frr(curve, target=0.20):
    """Linear interpolation of FAR at a given FRR along one policy's (FRR, FAR) points."""
    pts = sorted(curve)  # by FRR
    f = np.array([p[0] for p in pts])
    a = np.array([p[1] for p in pts])
    return float(np.interp(target, f[::-1] if f[0] > f[-1] else f, a[::-1] if f[0] > f[-1] else a))


def main():
    args = parse_args(__doc__)
    crops, y = load_orl(args.orl)
    X = vectors(crops)
    result = {}
    for c in (5, 30):
        draws = [run_draw(X, y, c, args.seed + i) for i in range(args.repeats)]
        table = {}
        for pol in ("P0", "P1", "P2"):
            table[pol] = {
                str(p): {k: round(float(np.mean([d[p][pol][j] for d in draws])), 4) for j, k in enumerate(("frr", "far_pred", "far_rand"))}
                for p in PCTS
            }
        at = {}
        for pol in ("P0", "P1", "P2"):
            per = [far_at_frr([(d[p][pol][0], d[p][pol][1]) for p in PCTS]) for d in draws]
            perr = [far_at_frr([(d[p][pol][0], d[p][pol][2]) for p in PCTS]) for d in draws]
            at[pol] = {"far_pred_at_frr20": round(float(np.mean(per)), 4), "se": round(float(np.std(per) / np.sqrt(len(per))), 4),
                       "far_rand_at_frr20": round(float(np.mean(perr)), 4)}
        result[f"C{c}"] = {"table": table, "at_frr_0.20": at}
        print(f"\n=== C={c} enrolled ({args.repeats} draws) ===")
        for pol in ("P0", "P1", "P2"):
            print(pol, "FAR(pred-claim)@FRR=.20: %.3f ± %.3f   FAR(random-claim)@FRR=.20: %.3f" % (at[pol]["far_pred_at_frr20"], at[pol]["se"], at[pol]["far_rand_at_frr20"]))
        for p in (50, 70, 90):
            print(" p%d " % p + "  ".join(f"{pol}: FRR={table[pol][str(p)]['frr']:.2f} FARp={table[pol][str(p)]['far_pred']:.2f} FARr={table[pol][str(p)]['far_rand']:.2f}" for pol in ("P0", "P1", "P2")))
    save_json({"setup": __doc__, "results": result, "draws": args.repeats}, args.out)


if __name__ == "__main__":
    main()
