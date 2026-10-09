"""Administrator-only views of the recognition model and of authentication outcomes (the "ML Lab").

Everything returned here comes from the stored model, the stored cross-validation results of that model, the
authentication log, or the committed offline ORL evaluation file. Nothing is typed in by hand. Identities are never
returned: classes are shown as C1..Cn, and authentication outcomes are aggregate counts.
"""

import json
from datetime import UTC, datetime, timedelta
from functools import lru_cache
from pathlib import Path

import numpy as np
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.ml import registry
from app.models import AuthenticationLog, FaceProfile, FaceSample, ModelVersion, User
from app.services.face_service import _eligible_rows, _fingerprint
from app.services.security_service import REASON_CATEGORY

REFERENCE_FILE = Path(__file__).resolve().parent.parent / "ml" / "reference" / "orl_final_evaluation.json"


def overview(db: Session) -> dict:
    row = registry.active_model_row(db)
    history = db.scalars(select(ModelVersion).order_by(ModelVersion.id.desc()).limit(10)).all()
    metrics = (row.evaluation_metrics or {}) if row else {}
    stale = None
    if row is not None:
        stale = _fingerprint(_eligible_rows(db)) != row.dataset_fingerprint
    enrolled = db.scalar(select(func.count(func.distinct(FaceProfile.user_id))).where(FaceProfile.status == "active")) or 0
    return {
        "model": None
        if row is None
        else {
            "version": row.version,
            "status": row.status,
            "trained_at": row.trained_at,
            "classifier": row.classifier,
            "n_samples": row.n_samples,
            "n_classes": row.n_classes,
            "validation": metrics.get("validation"),
            "distance_threshold": metrics.get("distance_threshold"),
            "threshold_percentile": metrics.get("threshold_percentile"),
            "knn_k": metrics.get("knn_k"),
            "dataset_fingerprint": (row.dataset_fingerprint or "")[:12],
            "library_versions": row.library_versions,
            "stale": stale,
        },
        "training_status": "no_model" if row is None else ("stale" if stale else "current"),
        "dataset": {
            "enrolled_customers": enrolled,
            "stored_samples": db.scalar(select(func.count()).select_from(FaceSample)) or 0,
            "customers": db.scalar(select(func.count()).select_from(User)) or 0,
        },
        "history": [
            {"version": h.version, "status": h.status, "trained_at": h.trained_at, "classifier": h.classifier, "n_samples": h.n_samples, "n_classes": h.n_classes}
            for h in history
        ],
        "methodology": {
            "validation": "Out-of-fold cross-validation on the samples enrolled in this deployment (folds grouped by pose where possible).",
            "preprocessing": "Haar face detection, square crop, 64x64, histogram equalisation, elliptical mask, per-image z-score.",
            "pipeline": "PCA (variance target) then LDA then KNN or a linear SVM, chosen by cross-validated macro-F1.",
            "caveat": "Few users and webcam-style samples mean these numbers are noisy. They describe this prototype, not a production system.",
        },
    }


def analysis(db: Session) -> dict:
    """PCA, LDA and classifier comparison for the active model."""
    try:
        loaded = registry.load_active(db)
    except Exception:
        return {"available": False, "reason": "MODEL_UNAVAILABLE"}
    if loaded is None:
        return {"available": False, "reason": "NO_MODEL"}
    row, model = loaded
    metrics = row.evaluation_metrics or {}

    ratios = [float(v) for v in model.pca_.explained_variance_ratio_]
    cumulative = np.cumsum(ratios).tolist()
    pca = {
        "components": len(ratios),
        "explained_variance_ratio": [round(v, 6) for v in ratios],
        "cumulative_variance": [round(v, 6) for v in cumulative],
        "total_explained": round(float(cumulative[-1]), 4) if cumulative else None,
        "config": row.pca_config,
    }
    lda = None
    if row.lda_config:
        lda = {"config": row.lda_config, "explained_between_class_variance": row.lda_config.get("explained_between_class_variance", [])}

    variants = {}
    for name, v in (metrics.get("variants") or {}).items():
        variants[name] = {
            "accuracy": v.get("accuracy"),
            "macro_precision": v.get("macro_precision"),
            "macro_recall": v.get("macro_recall"),
            "macro_f1": v.get("macro_f1"),
            "predict_ms_per_sample": v.get("predict_ms_per_sample"),
            "n_evaluated": v.get("n_evaluated"),
            "confusion_matrix": v.get("confusion_matrix"),
            "classes": [f"C{i + 1}" for i in range(len(v.get("labels") or []))],  # pseudonymous: no user ids
            "deployed": name == row.classifier,
        }
    return {
        "available": True,
        "model_version": row.version,
        "pca": pca,
        "lda": lda,
        "class_separation": metrics.get("scatter"),
        "classifiers": variants,
        "deployed_classifier": row.classifier,
    }


@lru_cache
def _reference() -> dict | None:
    try:
        return json.loads(REFERENCE_FILE.read_text())
    except (OSError, ValueError):
        return None


def benchmark() -> dict:
    """The committed offline evaluation on the public AT&T/ORL set: closed-set results, open-set false reject / false
    accept rates by threshold, and the basic liveness measurement. It is NOT a measurement of this deployment's users,
    and the response says so."""
    ref = _reference()
    if ref is None:
        return {"available": False}
    open_set = ref.get("open_set", {})
    by_pct = open_set.get("by_threshold_percentile", {})
    table = [
        {
            "percentile": float(p),
            "false_reject_rate": v["false_reject_rate"][0],
            "false_reject_rate_std": v["false_reject_rate"][1],
            "far_random_claim": v["far_random_claim"][0],
            "far_random_claim_std": v["far_random_claim"][1],
            "far_predicted_identity": v["far_claims_predicted_identity"][0],
            "far_predicted_identity_std": v["far_claims_predicted_identity"][1],
        }
        for p, v in sorted(by_pct.items(), key=lambda kv: float(kv[0]))
    ]
    closed = ref.get("closed_set", {})
    liveness = ref.get("liveness", {})
    return {
        "available": True,
        "scope": "Offline benchmark on the public AT&T/ORL face set. Not measured on this deployment's customers or on real webcams.",
        "dataset": ref.get("dataset"),
        "config": ref.get("config"),
        "closed_set": {
            "protocol": closed.get("protocol"),
            "variants": {
                name: {k: v.get(k) for k in ("accuracy", "macro_precision", "macro_recall", "macro_f1", "confusion_matrix")}
                for name, v in (closed.get("variants") or {}).items()
            },
        },
        "open_set": {"setup": open_set.get("setup"), "deployed_percentile": open_set.get("deployed_percentile"), "by_threshold_percentile": table},
        "liveness": {"method": liveness.get("method"), "note": liveness.get("note")},
    }


def outcomes(db: Session, days: int) -> dict:
    """Aggregate face-authentication results from the audit log: counts only, no identities, no scores."""
    since = datetime.now(UTC) - timedelta(days=days)
    rows = db.execute(
        select(AuthenticationLog.result, AuthenticationLog.failure_reason, func.count())
        .where(AuthenticationLog.timestamp >= since)
        .group_by(AuthenticationLog.result, AuthenticationLog.failure_reason)
    ).all()
    total = sum(n for _, _, n in rows)
    ok = sum(n for r, _, n in rows if r == "SUCCESS")
    reasons: dict[str, int] = {}
    categories: dict[str, int] = {}
    for result, reason, n in rows:
        if result != "FAILED":
            continue
        reasons[reason or "UNKNOWN"] = reasons.get(reason or "UNKNOWN", 0) + n
        cat = REASON_CATEGORY.get(reason, "Other")
        categories[cat] = categories.get(cat, 0) + n
    day = func.date(func.timezone("Asia/Kolkata", AuthenticationLog.timestamp))
    per_day = db.execute(
        select(day, AuthenticationLog.result, func.count()).where(AuthenticationLog.timestamp >= since).group_by(day, AuthenticationLog.result).order_by(day)
    ).all()
    series: dict[str, dict] = {}
    for d, result, n in per_day:
        s = series.setdefault(d.isoformat(), {"date": d.isoformat(), "success": 0, "failed": 0})
        s["success" if result == "SUCCESS" else "failed"] += n
    return {
        "days": days,
        "attempts": total,
        "successful": ok,
        "failed": total - ok,
        "failure_categories": [{"category": c, "count": n} for c, n in sorted(categories.items(), key=lambda kv: -kv[1])],
        "failure_reasons": [{"reason": r, "count": n} for r, n in sorted(reasons.items(), key=lambda kv: -kv[1])],
        "per_day": list(series.values()),
        "note": "Live counts from this deployment's audit log. They are outcomes, not error rates: the log cannot tell a genuine customer from an impostor.",
    }
