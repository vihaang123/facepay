"""Loads and caches the active model. The database is the source of truth; the cache just avoids
decrypting and unpickling the artifact on every request."""

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.ml.pipeline import FacePipeline
from app.ml.serialization import load_model
from app.models import ModelVersion

_cache: dict[int, FacePipeline] = {}


def invalidate() -> None:
    _cache.clear()


def active_model_row(db: Session) -> ModelVersion | None:
    return db.scalar(select(ModelVersion).where(ModelVersion.status == "active"))


def load_active(db: Session) -> tuple[ModelVersion, FacePipeline] | None:
    """(row, fitted pipeline) for the active model, or None if nothing is deployed.
    Raises ModelLoadError if the artifact is unreadable."""
    row = active_model_row(db)
    if row is None:
        return None
    model = _cache.get(row.id)
    if model is None:
        model = load_model(row.artifact, row.version, row.library_versions)
        _cache.clear()
        _cache[row.id] = model
    return row, model
