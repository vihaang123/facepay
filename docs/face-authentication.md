# Face authentication + liveness (Phase 4)

Recognition (Phase 3: face → PCA → LDA → classifier) is **not** authentication. Phase 4 adds an explicit
decision: identity evidence + liveness + a policy → `AUTHENTICATED` / `REJECTED`, with a machine-readable
reason, logged in `authentication_logs`. The PCA/LDA pipeline is unchanged. No payment is processed.

> Prototype only. This is a demonstration of the methodology on a small closed-set model, **not** bank-grade
> biometric security and **not** production anti-spoofing.

## API (`/face-auth`, customer token required)

| Endpoint | Purpose |
|----------|---------|
| `POST /challenge` | Issues a single-use liveness challenge (`turn_right` / `turn_left`), valid 60 s. |
| `POST /verify` | Body: `challenge_id`, 5–10 base64 frames (first 2 are the "look at the camera" baseline). Always returns 200 with a decision for well-formed requests; 422 for malformed ones (not logged). |
| `GET /attempts?limit=` | The caller's own recent attempts only. |

Response: `result`, `reason`, `detail`, `authentication_id`, `stages` (FACE_DETECTION / LIVENESS / IDENTITY:
PASSED / FAILED / SKIPPED), `liveness`, `challenge`, `model_version`, and `identity` (`verified`, `confidence`,
`distance`, `distance_threshold`, `frames_evaluated`; `name` only on success, always the caller's own).
Images, feature vectors and other users' data are never returned. Per-user limit: `FACE_AUTH_RATE_LIMIT_PER_MINUTE` (10).

## Liveness design

Challenge–response on **lateral head movement**: the centre of the Haar face box moves, relative to its width,
by at least `LATERAL_THRESHOLD` (0.10) toward the requested side, with a stable baseline (drift ≤ 0.05), the
face present in ≥ 80 % of frames, and no large opposite movement. Challenges are DB-backed, single-use
(consumed with `SELECT … FOR UPDATE`, spent even when the attempt fails) and expire after 60 s.
Verdict details: `COMPLETED`, `TOO_FEW_FRAMES`, `FACE_LOST`, `UNSTABLE_BASELINE`, `AMBIGUOUS_MOTION`,
`WRONG_DIRECTION`, `INCOMPLETE_MOVEMENT`, `NO_MOVEMENT`.

Thresholds were set from the measured jitter of the detector on static frames (tests assert 2,000 jittered
static sequences never pass, and the threshold is ≥ 5× the measured jitter). They were **not** validated on
real webcam head turns.

### Limitations (do not claim otherwise)
- A photo or phone screen that is physically moved sideways, a replayed video that follows the challenge, a
  mask or a deepfake can pass. There is no texture, depth or screen-artifact analysis.
- Body/camera sideways movement is not distinguished from a head turn.
- Identity is judged on the baseline frames; swapping the person after the baseline is not detected.
- Challenge direction is only two-valued; blink detection is not implemented.

## Authentication policy (`app/services/auth_policy.py`, pure function `decide`)

Reasons are evaluated in order: `ACCOUNT_DISABLED`, `CHALLENGE_INVALID`, `CHALLENGE_EXPIRED`,
a model-readiness code (`ENROLLMENT_INSUFFICIENT`, `INSUFFICIENT_IDENTITIES`, `MODEL_NOT_TRAINED`,
`MODEL_NOT_FOUND`, `MODEL_STALE`, `MODEL_VERSION_INCOMPATIBLE`, `MODEL_LOAD_FAILED`, `BIOMETRIC_DECRYPTION_FAILED`; see
`ml-architecture.md`), image reasons (`FACE_NOT_DETECTED`, `MULTIPLE_FACES_DETECTED`,
`FACE_TOO_SMALL`, `POOR_IMAGE_QUALITY`, `INVALID_IMAGE`), `LIVENESS_FAILED`, `IDENTITY_MISMATCH`,
`LOW_CONFIDENCE`, `DISTANCE_TOO_HIGH`. Authenticated only if **every** baseline frame is predicted as the
logged-in user, with classifier score for that user ≥ 0.5 (`AUTH_MIN_CONFIDENCE`) and distance to the user's
stored LDA-space centroid ≤ the profile's `distance_threshold` (70th percentile of out-of-fold genuine
distances). More than one face in **any** frame rejects (`MULTIPLE_FACES_DETECTED`).
Reported confidence is the classifier score of the user's class (minimum over frames), distance the maximum.

## Logging
Each attempt writes user, SUCCESS/FAILED, confidence, distance, liveness result, `failure_reason`,
`failure_detail`, challenge, model version and timestamp. No image or vector is stored.

## Open-set limitation (not fixed)
Phase 3 measured FRR ≈ 20 %, random-claim FAR ≈ 2 % and predicted-identity FAR ≈ 45 % on ORL. We compared
alternative rules (`ml/experiments/auth_policy.py`, results in `ml/results/auth_policy.json`) against a
rule declared **before** running: a candidate would replace the Phase 3 rule only if it lowered
predicted-identity FAR at FRR = 20 % by ≥ 5 points at both C = 5 and C = 30. Measured FAR at FRR = 20 %:

| Rule | C = 5 | C = 30 |
|------|-------|--------|
| P0 identity + centroid distance (kept) | 0.431 ± 0.059 | 0.476 ± 0.044 |
| P1 margin vs. nearest other centroid | 0.408 ± 0.073 | 0.488 ± 0.046 |
| P2 two frames + mean distance | 0.470 ± 0.084 | 0.596 ± 0.062 |

No candidate qualified, so P0 stays and thresholds were not tuned to look better. Consequences: a closed-set
classifier is a weak verifier; genuine users can be rejected and should expect to retry (about 60–70 % per
attempt at the 70th-percentile threshold); with few enrolled users a stranger can pass the identity vote and
is stopped mainly by the distance gate. ORL is not webcam data, so these numbers are indicative only.


## Why "Recognition is unavailable" appears

The shared PCA -> LDA -> classifier model needs at least two people with a finished setup. With one enrolled person no
model can exist, however many samples that person captured. The face screen now asks `GET /faces/readiness` before it
opens the camera, shows which condition applies and the one action that fixes it, and sends no frames while the model
is not ready. The seven visible stages (camera, face, quality, model, liveness, identity, match) are marked only from
what actually happened.
