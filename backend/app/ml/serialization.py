"""Model artifacts: joblib bytes encrypted with AES-GCM (see app.core.crypto).

joblib/pickle can execute code on load, so an artifact is only ever loaded after it has been
authenticated by AES-GCM with the server's key and the row's own context; an attacker who can
only write to the database cannot forge one. Library versions are recorded at save time and
checked at load time, since pickled sklearn estimators are not portable across versions.
"""

import io

import joblib
import numpy as np
import sklearn

from app.core import crypto
from app.ml.pipeline import FacePipeline


class ModelLoadError(Exception):
    """The stored model cannot be used. `kind` is a safe category (never the exception text) for what went wrong:
    VERSION_MISMATCH (trained with other library versions), DECRYPT (wrong key or tampered), CORRUPT, TYPE."""

    def __init__(self, message: str, kind: str = "CORRUPT"):
        super().__init__(message)
        self.kind = kind


def library_versions() -> dict:
    return {"scikit-learn": sklearn.__version__, "numpy": np.__version__, "joblib": joblib.__version__}


def _context(version: str) -> str:
    return f"model:{version}"


def dump_model(model: FacePipeline, version: str) -> bytes:
    buf = io.BytesIO()
    joblib.dump(model, buf, compress=3)
    return crypto.encrypt(buf.getvalue(), _context(version))


def load_model(blob: bytes, version: str, saved_versions: dict | None) -> FacePipeline:
    current = library_versions()
    if saved_versions:
        # numpy/joblib patch differences are harmless; sklearn and numpy major.minor must match
        for lib in ("scikit-learn", "numpy"):
            a, b = saved_versions.get(lib, ""), current[lib]
            if a.split(".")[:2] != b.split(".")[:2]:
                raise ModelLoadError(f"model {version} was trained with {lib} {a}, running {b}; retrain required", "VERSION_MISMATCH")
    try:
        raw = crypto.decrypt(blob, _context(version))
        model = joblib.load(io.BytesIO(raw))
    except crypto.BiometricCryptoError as exc:
        raise ModelLoadError(f"model {version} cannot be decrypted: {exc}", "DECRYPT") from exc
    except Exception as exc:  # corrupt pickle etc.
        raise ModelLoadError(f"model {version} is corrupt: {exc}", "CORRUPT") from exc
    if not isinstance(model, FacePipeline):
        raise ModelLoadError(f"model {version} has an unexpected type", "TYPE")
    return model
