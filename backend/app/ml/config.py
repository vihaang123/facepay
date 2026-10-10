"""Tunable constants for the face pipeline.

Quality thresholds are PROVISIONAL: they were set against public benchmark images and a
few test photos, not against real webcam captures. Not recalibrated on real captures: see docs/final/evaluation-results.md.
"""

IMAGE_SIZE = 64  # stored crop is IMAGE_SIZE x IMAGE_SIZE grayscale (4096 features)

# Upload limits (checked before the image is decoded)
MAX_IMAGE_BYTES = 1_500_000
MAX_IMAGE_PIXELS = 3_000_000
DETECTION_MAX_SIDE = 640  # frames larger than this are downscaled before detection

# Detection / quality gates
MIN_FACE_PIXELS = 80  # face box width in the (possibly downscaled) frame
# Two raw detections are one face when they overlap this much (IoU), or one lies this far inside the other.
DUPLICATE_IOU = 0.3
DUPLICATE_CONTAINMENT = 0.6
# A candidate for a SECOND face needs this cascade confidence. Chosen from the grid in ml/results/detection_evidence.json
# (ORL faces in 640x480 JPEG frames, real OpenCV Haar; NOT webcam frames; see docs/final/detection-evidence.md), judged on
# 8-frame attempts with the "second face in >= 3 frames" rule: at 3.0, 1.0% of single-face attempts were wrongly rejected
# (the old rule, raw boxes and any one frame: 67.5%) while a real second person was still rejected in 97-100% of attempts.
# Stricter floors lose real second people (5.0: 90%); a floor of 0 keeps 5.5% false rejections.
SECOND_FACE_MIN_WEIGHT = 3.0
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
    "chin_down": "Lower your chin slightly",
}
# Guided enrollment (the UI walks through these in order). A subset of POSES; "smile" and "lighting" stay supported
# by the API but are not part of the guided flow. Pose labels are advisory: the server cannot verify head pose, and
# recognition does not depend on the label (it is only used to check that the samples are varied).
GUIDED_SEQUENCE = ("neutral", "turn_left", "turn_right", "chin_up", "chin_down")
GUIDED_SAMPLES_PER_POSE = 3  # 5 poses x 3 = 15 samples, above MIN_SAMPLES_PER_USER
# A new sample whose stored 64x64 crop differs from an existing sample of the same user by less than this mean
# absolute grey-level difference is refused as a duplicate (a frozen or replayed frame). Webcam noise alone is above
# this on real captures only by assumption: PROVISIONAL, not measured on real webcams.
DUPLICATE_MAX_MEAN_DIFF = 1.5
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
# Percentile of out-of-fold genuine distances used as the accept threshold. It is a trade-off knob, not a calibrated
# security level. Measured offline (ORL faces, simulated session shift; ml/results/auth_policy_v4.json and
# docs/final/recognition-policy.md): at 70 with "every frame must pass" a genuine user was accepted only 49-61% of the time
# (2 enrolled people), which is what made repeated attempts fail; at 90 with the mean-distance rule and augmented training
# 89-91%, while another enrolled person was still accepted 0 times in 100s of attempts. The price is paid by never-enrolled
# strangers (see docs/final/recognition-policy.md). NOT validated on real webcam data.
DISTANCE_THRESHOLD_PERCENTILE = 90.0
# The per-user threshold uses that user's own out-of-fold distances when there are at least this many, else the pooled ones.
MIN_USER_DISTANCES = 12

# Training-time augmentation. Enrolment samples are captured in one sitting, so they hold almost none of the variation
# between sessions (small shifts of the face box, scale, slight rotation, softer focus, side lighting). Each stored 64x64 crop
# gets AUGMENT_COPIES slightly perturbed copies at training time (nothing extra is stored; the same crops are reused), and the
# threshold is calibrated on held-out samples PLUS CALIBRATION_COPIES perturbed copies of them, so it reflects that spread.
# A copy always stays on the same side of a cross-validation split as its source sample: no leakage.
AUGMENT_COPIES = 4
CALIBRATION_COPIES = 2
AUGMENT_SEED = 20261011
AUGMENT_MAX_SHIFT = 0.035  # fraction of the crop size
AUGMENT_MAX_SCALE = 0.06
AUGMENT_MAX_ROTATION = 4.0  # degrees
AUGMENT_MAX_LIGHT_GRADIENT = 28.0  # grey levels across the crop (side lighting)
# Perturbation size of the copies used to CALIBRATE the threshold, relative to the training copies. 1.5: a margin because the
# real difference between two sessions (and between two devices) is not known and probably larger than the training copies
# show. Measured trade-off (ml/results/auth_policy_v4.json): larger = more genuine users accepted, more strangers accepted.
AUGMENT_CALIBRATION_STRENGTH = 1.5
# Bump when training or the decision rule changes. A model trained with an older recipe is retrained automatically
# from the stored samples the next time someone starts a face check (no new capture is needed).
MODEL_RECIPE = "v4-augmented-mean"
# A person whose own held-out samples are classified correctly less often than this is flagged: the model cannot reliably
# tell them from another account (2 classes: 0.5 is a coin flip). Typical cause: two accounts set up with the same face.
MIN_USER_RECALL = 0.65

# ---------------------------------------------------------------- Phase 4: authentication
# Decision policy (see app/services/auth_policy.py). The distance threshold itself is the per-model
# value stored in each face profile (Phase 3: percentile of out-of-fold genuine distances).
AUTH_MIN_CONFIDENCE = 0.5  # the predicted class must hold at least half of the classifier's vote/score
# Distance rule over the baseline frames used: the MEAN distance must be within the user's threshold (averaging cancels
# per-frame detector jitter, which genuine users have and impostors do not benefit from), and no single frame may be further
# than AUTH_FRAME_DISTANCE_CAP x the threshold. Every frame must still be classified as the user with enough confidence.
AUTH_FRAME_DISTANCE_CAP = 1.6
AUTH_SECOND_FACE_RATIO = 0.15  # stricter than enrolment: any face >= 15% of the largest one blocks payment auth

# Challenge-response liveness (app/ml/liveness.py)
CHALLENGE_TTL_SECONDS = 60
AUTH_BASELINE_FRAMES = 3  # first frames: user looks straight at the camera; used for identity (2 usable ones are required)
BASELINE_MIN_USABLE = 2  # one missed or blurred baseline frame is tolerated; every frame that is used must still match
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
# Face continuity during the turn. A turned head is often no longer a frontal face, so a short loss is expected; a face
# that is gone for long is not. The previous rule (80% of ALL frames usable, i.e. at most one lost frame) is replaced by:
MIN_USABLE_TURN_FRACTION = 0.5  # at least half of the turn frames show exactly one face
MIN_USABLE_TURN_FRAMES = 3
MAX_LOST_RUN = 2  # no more than two consecutive turn frames without exactly one face
# A second person must be seen in at least this many frames (and this fraction of the sequence) to reject the attempt.
MULTI_FACE_MIN_FRAMES = 2
MULTI_FACE_FRAME_FRACTION = 0.3
