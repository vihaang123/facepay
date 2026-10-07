import numpy as np
import pytest
from sklearn.model_selection import train_test_split

from app.ml.analysis import fisher_criterion, scatter_analysis
from app.ml.evaluation import compare_and_select, genuine_threshold, make_splits
from app.ml.pipeline import FacePipeline, InsufficientDataError, choose_pca_dimension


def blobs(c=4, n=12, d=80, sep=1.0, seed=0):
    rng = np.random.default_rng(seed)
    centers = rng.normal(size=(c, d)) * sep
    y = np.repeat(np.arange(c), n)
    return centers[y] + rng.normal(size=(c * n, d)), y


def test_pca_dimension_is_capped_at_n_minus_c_and_floored_for_lda():
    X, y = blobs(c=4, n=5)  # N=20, C=4 -> cap 16
    assert choose_pca_dimension(X, y, "fisherface", True).n_used == 16
    assert choose_pca_dimension(X, y, 500, True).n_used == 16
    ch = choose_pca_dimension(X, y, 1, True)  # too small for 3 discriminants -> raised to C-1
    assert ch.n_used == 3 and ch.floored
    assert choose_pca_dimension(X, y, 1, False).n_used == 1
    v = choose_pca_dimension(X, y, 0.9, True)
    assert 1 <= v.n_used <= 16 and v.n_for_variance is not None


def test_lda_has_c_minus_1_components_and_classifier_sees_only_lda_output():
    X, y = blobs(c=5)
    m = FacePipeline(classifier="knn").fit(X, y)
    assert m.lda_.n_components == 4
    assert m.transform(X).shape == (len(y), 4)
    # The classifier was trained on the 4-dim LDA output, not on pixels or PCA scores:
    assert m.clf_._fit_X.shape[1] == 4
    svm = FacePipeline(classifier="svm").fit(X, y)
    assert svm.clf_.support_vectors_.shape[1] == 4


def test_pca_only_baseline_has_no_lda():
    X, y = blobs()
    m = FacePipeline(use_lda=False).fit(X, y)
    assert m.lda_ is None and m.transform(X).shape[1] == m.pca_.n_components_
    assert m.describe()["lda"] is None


def test_pca_matches_reference_svd_projection():
    X, y = blobs(c=3, n=10)
    m = FacePipeline(pca_components=5).fit(X, y)
    Xc = X - X.mean(axis=0)
    _, _, vt = np.linalg.svd(Xc, full_matrices=False)
    ref = Xc @ vt[:5].T
    got = m.pca_.transform(X)
    assert np.allclose(np.abs(got), np.abs(ref), atol=1e-6)  # equal up to component sign


def test_lda_maximizes_fisher_criterion_like_the_reference_eigenproblem():
    """Compare against the textbook generalized eigenproblem S_b w = lambda S_w w in PCA space."""
    from scipy.linalg import eigh

    X, y = blobs(c=4, n=15, sep=0.7)
    m = FacePipeline(pca_components="fisherface").fit(X, y)
    Z = m.pca_.transform(X)
    d, mu = Z.shape[1], Z.mean(axis=0)
    sw, sb = np.zeros((d, d)), np.zeros((d, d))
    for c in np.unique(y):
        zc = Z[y == c]
        mc = zc.mean(axis=0)
        sw += (zc - mc).T @ (zc - mc)
        sb += len(zc) * np.outer(mc - mu, mc - mu)
    top = np.sort(eigh(sb, sw, eigvals_only=True))[::-1][:3].sum()
    j_lda = scatter_analysis(m, X, y)["lda_space"]["fisher_criterion"]
    assert j_lda == pytest.approx(top, rel=1e-3)
    # and a random 3-d projection of the same space is never better
    rng = np.random.default_rng(1)
    for _ in range(20):
        W = np.linalg.qr(rng.normal(size=(d, 3)))[0]
        assert fisher_criterion(Z @ W, y) <= j_lda + 1e-6


def test_lda_reduces_within_class_relative_to_between_class():
    X, y = blobs(c=4, n=15, sep=0.5)
    m = FacePipeline().fit(X, y)
    a = scatter_analysis(m, X, y)
    assert a["lda_space"]["between_over_within"] > a["pca_space"]["between_over_within"]
    assert a["lda_space"]["dim"] == 3


def test_requires_two_classes():
    X, _ = blobs(c=2)
    with pytest.raises(InsufficientDataError):
        FacePipeline().fit(X, np.zeros(len(X), int))


def test_predictions_and_scores():
    X, y = blobs(c=4, sep=2.0)
    Xtr, Xte, ytr, yte = train_test_split(X, y, stratify=y, random_state=0)
    for clf in ("knn", "svm"):
        m = FacePipeline(classifier=clf).fit(Xtr, ytr)
        assert (m.predict(Xte) == yte).mean() > 0.9
        p = m.predict_proba(Xte)
        assert p.shape == (len(yte), 4) and np.allclose(p.sum(axis=1), 1) and (p >= 0).all()


def test_two_class_svm_scores_work():
    X, y = blobs(c=2, sep=2.0)
    m = FacePipeline(classifier="svm").fit(X, y)
    p = m.predict_proba(X)
    assert p.shape == (len(y), 2) and np.allclose(p.sum(axis=1), 1)
    assert (m.predict(X) == y).mean() > 0.9


def test_fit_is_deterministic():
    X, y = blobs()
    a = FacePipeline().fit(X, y).transform(X)
    b = FacePipeline().fit(X, y).transform(X)
    assert np.allclose(a, b)


def test_lda_beats_pca_when_signal_is_in_low_variance_directions():
    """Identity differences live in a few low-variance axes; large shared nuisance variance
    dominates the PCA axes. Fisher's criterion should still find the identity axes."""
    rng = np.random.default_rng(3)
    c, n, d = 6, 14, 60
    y = np.repeat(np.arange(c), n)
    X = rng.normal(size=(c * n, d)) * 0.3
    X[:, :20] += rng.normal(size=(c * n, 20)) * 4.0  # high-variance nuisance (like lighting)
    centers = rng.normal(size=(c, 10)) * 1.5
    X[:, 20:30] += centers[y]  # low-variance identity signal
    Xtr, Xte, ytr, yte = train_test_split(X, y, stratify=y, test_size=0.4, random_state=0)
    pca = FacePipeline(use_lda=False, pca_components=8).fit(Xtr, ytr)
    lda = FacePipeline(use_lda=True, pca_components=0.99).fit(Xtr, ytr)
    assert (lda.predict(Xte) == yte).mean() > (pca.predict(Xte) == yte).mean()


def test_splits_use_pose_groups_and_keep_two_classes_in_every_train_fold():
    X, y = blobs(c=3, n=12)
    groups = np.tile(np.repeat(["a", "b", "c"], 4), 3)
    splits, scheme = make_splits(y, groups)
    assert scheme.startswith("group_kfold")
    for tr, te in splits:
        assert len(np.unique(y[tr])) >= 2
        assert not set(groups[tr]) & set(groups[te])  # poses held out together
    _, scheme2 = make_splits(y, None)
    assert scheme2.startswith("stratified")
    with pytest.raises(InsufficientDataError):
        make_splits(np.zeros(10, int), None)


def test_compare_and_select_reports_all_variants_with_real_out_of_fold_numbers():
    X, y = blobs(c=3, n=12, sep=1.5)
    groups = np.tile(np.repeat(["a", "b", "c"], 4), 3)
    results, chosen, scheme = compare_and_select(X, y, groups)
    assert set(results) == {"pca_knn", "pca_lda_knn", "pca_lda_svm"}
    assert chosen in ("knn", "svm")
    for r in results.values():
        assert 0 <= r["accuracy"] <= 1 and r["n_evaluated"] == len(y)
        assert np.array(r["confusion_matrix"]).sum() == len(y)
        assert len(r["_genuine_distances"]) == len(y)
    assert genuine_threshold(results["pca_lda_knn"]["_genuine_distances"]) > 0
