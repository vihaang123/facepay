import base64

import numpy as np
import pytest

from app.core import crypto
from app.core.config import get_settings
from app.ml.pipeline import FacePipeline
from app.ml.serialization import ModelLoadError, dump_model, library_versions, load_model


def test_round_trip_and_randomized_nonce():
    a, b = crypto.encrypt(b"face", "ctx"), crypto.encrypt(b"face", "ctx")
    assert a != b and b"face" not in a
    assert crypto.decrypt(a, "ctx") == b"face"


def test_wrong_context_tamper_and_garbage_are_rejected():
    blob = crypto.encrypt(b"secret", "face_sample:1:1")
    with pytest.raises(crypto.BiometricCryptoError):
        crypto.decrypt(blob, "face_sample:1:2")  # blob moved to another row
    flipped = bytearray(blob)
    flipped[-1] ^= 1
    with pytest.raises(crypto.BiometricCryptoError):
        crypto.decrypt(bytes(flipped), "face_sample:1:1")
    for bad in (b"", b"\x01short", b"\x09" + blob[1:]):
        with pytest.raises(crypto.BiometricCryptoError):
            crypto.decrypt(bad, "face_sample:1:1")


def test_wrong_key_cannot_decrypt(monkeypatch):
    blob = crypto.encrypt(b"x", "c")
    monkeypatch.setattr(get_settings(), "biometric_key", crypto.generate_key())
    with pytest.raises(crypto.BiometricCryptoError):
        crypto.decrypt(blob, "c")


@pytest.mark.parametrize("key", ["", "not base64!!", base64.b64encode(b"short").decode()])
def test_missing_or_invalid_key_fails_loudly(monkeypatch, key):
    monkeypatch.setattr(get_settings(), "biometric_key", key)
    with pytest.raises(crypto.BiometricCryptoError):
        crypto.encrypt(b"x", "c")


def test_generated_key_is_valid(monkeypatch):
    monkeypatch.setattr(get_settings(), "biometric_key", crypto.generate_key())
    assert crypto.decrypt(crypto.encrypt(b"ok", "c"), "c") == b"ok"


def _model():
    rng = np.random.default_rng(0)
    y = np.repeat(np.arange(3), 10)
    X = rng.normal(size=(30, 40)) + y[:, None]
    return FacePipeline().fit(X, y), X


def test_model_artifact_round_trip_is_encrypted_and_bound_to_version():
    m, X = _model()
    blob = dump_model(m, "v1")
    assert not blob.startswith(b"\x80")  # not a bare pickle
    again = load_model(blob, "v1", library_versions())
    assert (again.predict(X) == m.predict(X)).all()
    with pytest.raises(ModelLoadError):
        load_model(blob, "other-version", library_versions())


def test_model_load_rejects_tampering_and_library_mismatch():
    m, _ = _model()
    blob = bytearray(dump_model(m, "v1"))
    blob[20] ^= 1
    with pytest.raises(ModelLoadError):
        load_model(bytes(blob), "v1", None)
    with pytest.raises(ModelLoadError, match="retrain"):
        load_model(dump_model(m, "v1"), "v1", {"scikit-learn": "0.1.0", "numpy": "1.0.0"})
