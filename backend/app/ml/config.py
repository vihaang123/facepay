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

# ---------------------------------------------------------------- Phase 4: authentication
# Decision policy (see app/services/auth_policy.py). The distance threshold itself is the per-model
# value stored in each face profile (Phase 3: percentile of out-of-fold genuine distances).
AUTH_MIN_CONFIDENCE = 0.5  # the predicted class must hold at least half of the classifier's vote/score
AUTH_SECOND_FACE_RATIO = 0.15  # stricter than enrolment: any face >= 15% of the largest one blocks payment auth

# Challenge-response liveness (app/ml/liveness.py)
CHALLENGE_TTL_SECONDS = 60
AUTH_BASELINE_FRAMES = 2  # first frames: user looks straight at the camera; used for identity
AUTH_MIN_FRAMES = 5
AUTH_MAX_FRAMES = 10
CHALLENGES = {
    "turn_right": "Slowly turn your head to your right",
    "turn_left": "Slowly turn your head to your left",
}
# Required lateral movement of the detected face box, as a fraction of the baseline box width.
# Measured detector jitter on real faces (ORL pasted into 640x480 frames, noise + JPEG): p99 0.012,
# max 0.018. 0.10 is >5x that maximum; a ~15 degree head turn moves the face roughly 0.15 box widths
# (geometry estimate, NOT validated on real webcam turns).
LATERAL_THRESHOLD = 0.10
BASELINE_MAX_DRIFT = 0.05  # the two baseline frames must agree within this (user is not already moving)
MIN_USABLE_FRAME_FRACTION = 0.8  # frames with exactly one face; losing the face for long fails the challenge
