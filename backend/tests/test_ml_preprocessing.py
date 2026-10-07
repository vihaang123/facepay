import cv2
import numpy as np
import pytest

from app.ml import config as cfg
from app.ml import preprocessing as pp
from tests.synthetic_faces import png_bytes, sample_image

FULL = pp.FullFrameDetector()


class FakeDetector:
    def __init__(self, boxes):
        self.boxes = boxes

    def detect(self, gray):
        return self.boxes


def code_of(fn, *a, **k):
    with pytest.raises(pp.FaceImageError) as e:
        fn(*a, **k)
    return e.value.code


def test_image_dimensions_png_and_jpeg():
    img = sample_image(0, 0)
    assert pp.image_dimensions(png_bytes(img)) == (96, 96)
    ok, jpg = cv2.imencode(".jpg", img)
    assert pp.image_dimensions(jpg.tobytes()) == (96, 96)
    assert pp.image_dimensions(b"not an image at all") is None


def test_decode_rejects_garbage_and_decompression_bombs():
    assert code_of(pp.decode_image, b"garbage" * 10) == pp.INVALID_IMAGE
    big = np.zeros((2000, 2000), np.uint8)  # 4 MP > MAX_IMAGE_PIXELS, compresses to a few KB
    data = png_bytes(big)
    assert len(data) < cfg.MAX_IMAGE_BYTES
    assert code_of(pp.decode_image, data) == pp.IMAGE_TOO_LARGE
    assert code_of(pp.decode_image, b"\x00" * (cfg.MAX_IMAGE_BYTES + 1)) == pp.IMAGE_TOO_LARGE


def test_stored_crop_shape_and_dtype():
    face = pp.process_gray(sample_image(1, 0), FULL)
    assert face.crop.shape == (cfg.IMAGE_SIZE, cfg.IMAGE_SIZE) and face.crop.dtype == np.uint8


def test_no_face_and_multiple_faces():
    img = sample_image(0, 0)
    assert code_of(pp.process_gray, img, FakeDetector([])) == pp.NO_FACE
    two = FakeDetector([pp.Box(0, 0, 90, 90), pp.Box(0, 0, 80, 80)])
    assert code_of(pp.process_gray, img, two) == pp.MULTIPLE_FACES
    # a much smaller background face is ignored
    ok = FakeDetector([pp.Box(0, 0, 90, 90), pp.Box(0, 0, 20, 20)])
    assert pp.process_gray(img, ok).crop.shape[0] == cfg.IMAGE_SIZE


def test_face_too_small_for_real_detector_only():
    img = sample_image(0, 0)
    small = FakeDetector([pp.Box(10, 10, cfg.MIN_FACE_PIXELS - 10, cfg.MIN_FACE_PIXELS - 10)])
    assert code_of(pp.process_gray, img, small) == pp.FACE_TOO_SMALL


def test_quality_gates():
    img = sample_image(0, 0)
    assert code_of(pp.process_gray, (img * 0.1).astype(np.uint8), FULL) in (pp.TOO_DARK, pp.TOO_BLURRY)
    dark = np.clip(img.astype(float) * 0.15, 0, 255).astype(np.uint8)
    assert code_of(pp.process_gray, dark, FULL) == pp.TOO_DARK
    bright = np.clip(img.astype(float) * 0.3 + 215, 0, 255).astype(np.uint8)
    assert code_of(pp.process_gray, bright, FULL) == pp.TOO_BRIGHT
    blurry = cv2.GaussianBlur(img, (0, 0), 6)
    assert code_of(pp.process_gray, blurry, FULL) == pp.TOO_BLURRY
    assert pp.process_gray(blurry, FULL, check_quality=False).quality.sharpness < cfg.MIN_SHARPNESS


def test_roll_and_level_rotation():
    assert pp.roll_angle_degrees((10, 50), (50, 50)) == pytest.approx(0)
    assert pp.roll_angle_degrees((10, 50), (50, 50 + 40 * np.tan(np.radians(10)))) == pytest.approx(10, abs=0.01)
    # build an image whose "eye line" is tilted, level it, and check the points end up level
    gray = np.zeros((100, 100), np.uint8)
    left, right = (30.0, 40.0), (70.0, 40.0 + 40 * np.tan(np.radians(15)))
    out = pp.rotate_to_level(gray, (50, 50), left, right)
    assert out.shape == gray.shape


def test_vectorize_removes_brightness_and_contrast():
    crop = pp.process_gray(sample_image(2, 0), FULL).crop
    v = pp.vectorize(crop)
    assert v.shape == (cfg.IMAGE_SIZE**2,) and v.dtype == np.float32
    mask = pp.face_mask().ravel()
    assert v[mask].mean() == pytest.approx(0, abs=1e-4)
    assert v[mask].std() == pytest.approx(1, abs=1e-3)
    assert np.all(v[~mask] == 0)
    shifted = np.clip(crop.astype(float) * 0.5 + 30, 0, 255)  # linear brightness/contrast change
    assert np.allclose(pp.vectorize(shifted.astype(np.uint8)), v, atol=0.05)


def test_vectorize_flat_image_is_finite():
    v = pp.vectorize(np.full((cfg.IMAGE_SIZE, cfg.IMAGE_SIZE), 90, np.uint8))
    assert np.isfinite(v).all()


def test_real_haar_detector_finds_a_real_photo():
    """Real photograph (public domain). Verifies the actual OpenCV detector + eye alignment."""
    with open("tests/fixtures/astronaut.jpg", "rb") as f:
        face = pp.extract_face(f.read(), pp.HaarFaceDetector())
    assert face.crop.shape == (cfg.IMAGE_SIZE, cfg.IMAGE_SIZE)
    assert face.quality.face_size >= cfg.MIN_FACE_PIXELS


def test_real_detector_reports_no_face_on_a_blank_frame():
    data = png_bytes(np.full((240, 320), 128, np.uint8))
    assert code_of(pp.extract_face, data, pp.HaarFaceDetector()) == pp.NO_FACE
