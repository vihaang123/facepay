# ML architecture (Phase 3)

## Pipelines

Enrollment: webcam frame -> detect face -> level eyes + square crop -> 64x64 grayscale, histogram equalised ->
encrypted `face_samples` -> (train) elliptical mask + z-score -> **PCA -> LDA -> classifier** -> encrypted model + per-user face profile.

Recognition: new frame -> same preprocessing -> **PCA -> LDA** (-> classifier prediction, distance to the caller's
profile centroid) -> `{matched, reason, confidence, distance_to_you}`.  Liveness and the payment decision come in later phases.

PCA and LDA are both load-bearing: the classifier is fitted only on LDA output (at most C-1 dimensions), so removing
either stage changes every prediction. No pretrained embedding model is used. The Haar cascade is used only to find
where the face is.

## Why PCA before LDA, and the limits (measured, see `docs/ml-feasibility.md`)

* 4096 pixels vs tens of samples per user: the within-class scatter S_w has rank <= N-C, so plain LDA is undefined.
  PCA first (<= N-C dims) makes S_w invertible; LDA then yields <= C-1 discriminants.
* LDA needs >= 2 users (hard error otherwise). With 2 users the classifier sees one number per sample.
* LDA helped once users had ~6+ varied samples and hurt with 4; so a user needs >= 12 samples over >= 3 poses.
* The textbook choice p = N-C collapsed accuracy (0.27 on ORL 40 users, 0.59 on 10 users); we use a 95% variance
  target and only cap at N-C.
* The same model is trained for everyone: adding or deleting a user changes the model, so deleting your data retires
  the deployed model (others must retrain).

## Preprocessing (`app/ml/preprocessing.py`)

Size/pixel caps checked from the image header before decoding; grayscale; OpenCV Haar frontal-face detector (one face,
>= 80 px, second face < 40% of the largest); eye-line levelling when both eyes are found and roll <= 25 deg; square
crop with 8% margin; 64x64 INTER_AREA; histogram equalisation (this is what is stored). Quality gates on the crop:
sharpness (variance of Laplacian) >= 40, mean brightness 35-225. Thresholds are provisional (calibrated against ORL
degradations and one photograph, not webcams). For the model: elliptical mask + per-image z-score (removes global
brightness/contrast).

## PCA / LDA / classifiers (`app/ml/pipeline.py`)

PCA: full SVD, n = smallest count reaching 95% explained variance, capped at N-C, raised to C-1 if needed so LDA can
produce C-1 components. LDA: scikit-learn SVD solver, C-1 components. Classifiers on the LDA space: KNN (k = min(3,
smallest class), distance-weighted) and linear SVM (C=1, softmax of decision values as score). Baseline PCA+KNN is
evaluated for comparison, never deployed. Per training run all three are cross-validated (GroupKFold by pose when every
user has >= 2 poses, else stratified) and the better of KNN/SVM by macro-F1 is deployed (tie -> KNN).
"Confidence" is the classifier score, **not** a calibrated probability.

## Persistence and privacy

| Table | Contents |
|---|---|
| `face_samples` | AES-256-GCM encrypted 64x64 crop (+pose, sharpness, brightness). Raw frames are never stored. |
| `model_versions` | version, PCA/LDA config, classifier, CV metrics + scatter analysis (JSONB), encrypted joblib artifact, n_samples/n_classes, dataset fingerprint, library versions, status (one `active` row enforced by a partial unique index) |
| `face_profiles` | per user: encrypted LDA-space centroid + distance threshold, tied to a model version (one active per user, enforced) |

Key: `BIOMETRIC_KEY` (32 random bytes, base64) from the environment; blobs bind to their row/version as AES-GCM AAD.
No rotation or KMS (prototype). A model artifact is unpickled only after it authenticates under the key, and only if
scikit-learn/numpy major.minor match. No endpoint returns an image, crop, or feature vector, and responses never name
another user.

## API (all require a customer token)

| Method | Path | Purpose |
|---|---|---|
| GET | `/faces/enrollment` | pose instructions, per-pose counts, eligibility |
| POST | `/faces/samples` | `{image_base64, pose}` -> quality report + updated counts |
| DELETE | `/faces/samples` | delete my samples/profile (retires a model that included me) |
| POST | `/faces/train` | train on all eligible users; returns summary + CV comparison |
| GET | `/faces/model` | active model summary (`includes_you`, `stale`) |
| POST | `/faces/recognize` | `{image_base64}` -> `{matched, reason, confidence, distance_to_you, ...}` |

Errors are `{detail: {code, message}}` with codes such as NO_FACE, MULTIPLE_FACES, FACE_TOO_SMALL, TOO_BLURRY, TOO_DARK,
TOO_BRIGHT, INVALID_IMAGE, UNKNOWN_POSE, POSE_LIMIT, SAMPLE_LIMIT, NOT_ENOUGH_SAMPLES, NOT_ENOUGH_USERS, TRAINING_BUSY,
TRAINING_FAILED, RATE_LIMITED, and the model-readiness codes below.

### Model readiness (`GET /faces/readiness`, `face_service.inspect_model`)

One function decides whether recognition can run for a customer, and every path (challenge, recognize, authenticate,
payment) uses it, so a technical problem is never reported as "identity mismatch". Checked in order:

| Code | Meaning | Next action |
|---|---|---|
| `ENROLLMENT_INSUFFICIENT` | the customer has fewer than 12 usable samples or fewer than 3 poses (unusable captures are never stored, so they never count), or is not in the model | ENROLL |
| `INSUFFICIENT_IDENTITIES` | fewer than 2 people have a finished setup, so PCA/LDA cannot be fitted (LDA needs >= 2 classes) | WAIT_FOR_SECOND_PERSON |
| `MODEL_NOT_TRAINED` / `MODEL_NOT_FOUND` | no active model / profiles without a model | TRAIN |
| `MODEL_STALE` | the customer's samples are not in the active model | TRAIN |
| `MODEL_VERSION_INCOMPATIBLE`, `MODEL_LOAD_FAILED` | stored model cannot be deserialized | TRAIN |
| `BIOMETRIC_DECRYPTION_FAILED` | key mismatch; retraining will not help | CONTACT_ADMIN |

A database error is raised as a server error, not mapped to a model code. Training is all-or-nothing: a fit failure
(`TRAINING_FAILED`) or a persistence failure rolls back and leaves the previous model in place. Server logs
(`facepay.face`) carry the code and exception type only, never images, vectors, keys or tokens. Model problems do not
count toward the failed-attempt lockout. A model that is older than the customer's latest samples but still contains
them is reported as `stale` but does not block, because each profile is bound to its model version.

## Known limitations

See the final Phase 3 report and `ml/results/README.md`: ORL is not webcam data; the distance threshold is a weak open-set
check; any customer can trigger training that includes everyone's samples (prototype); in-process model cache and
training lock are single-instance; no liveness (Phase 4).
