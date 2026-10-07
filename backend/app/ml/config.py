"""Tunable constants for the face pipeline.

Quality thresholds are PROVISIONAL: they were set against public benchmark images and a
few test photos, not against real webcam captures. Recalibrate with real captures (Phase 7).
"""

IMAGE_SIZE = 64  # stored crop is IMAGE_SIZE x IMAGE_SIZE grayscale (4096 features)

# Upload limits (checked before the image is decoded)
MAX_IMAGE_BYTES = 1_500_000
MAX_IMAGE_PIXELS = 3_000_000
DETECTION_MAX_SIDE = 640  # frames larger than this are downscaled before detection

# Detection / quality gates
MIN_FACE_PIXELS = 80  # face box width in the (possibly downscaled) frame
SECOND_FACE_RATIO = 0.4  # a second face this fraction of the largest => "multiple faces"
MIN_SHARPNESS = 40.0  # variance of the Laplacian of the 64x64 crop (real faces scored 255-1800; sigma=2 blur ~30)
BRIGHTNESS_RANGE = (35.0, 225.0)  # mean gray level of the 64x64 crop
MAX_ROLL_DEGREES = 25.0  # eye-line rotation larger than this is treated as detector noise

# Enrollment protocol: pose name -> instruction shown to the user
POSES = {
    "neutral": "Look straight at the camera with a neutral expression",
    "turn_left": "Turn your head slightly to your left",
    "turn_right": "Turn your head slightly to your right",
    "chin_up": "Raise your chin slightly",
    "smile": "Smile or change your expression",
    "lighting": "Lean slightly toward or away from the light",
}
SAMPLES_PER_POSE_TARGET = 4
MAX_SAMPLES_PER_POSE = 15
MAX_SAMPLES_PER_USER = 60

# A user takes part in training only with enough varied samples
MIN_SAMPLES_PER_USER = 12
MIN_POSES_PER_USER = 3
MIN_USERS_TO_TRAIN = 2  # LDA needs at least 2 classes (and yields C-1 components)

# Model defaults
PCA_VARIANCE = 0.95
KNN_NEIGHBORS = 3
# Percentile of out-of-fold genuine distances used as the accept threshold. ORL open-set benchmark
# (ml/results/orl_benchmark.json): p95 accepted ~every impostor that claimed the predicted identity;
# p70 gave FRR ~0.20, FAR ~0.02 (random claim) / ~0.45 (worst case). A trade-off knob, not a calibrated
# security level: recalibrate on real webcam data in Phase 7.
DISTANCE_THRESHOLD_PERCENTILE = 70.0
