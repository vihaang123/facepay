# Evaluation results

Every number in this file was produced by a script in this repository and is stored in a JSON/text file beside it. Nothing
was estimated by hand. **All recognition results come from the public AT&T/ORL face set, not from webcams or from payment
users, and ORL is small, controlled and frontal.** Read the numbers as a test of the PCA+LDA method on a benchmark, not as
a prediction of how FacePay behaves in the wild. Experiments were not tuned to improve metrics; the methodology is the
Phase 3 one, unchanged.

How to regenerate: [`reproducibility.md`](reproducibility.md). Main result file: `ml/results/final_evaluation.json`
(script `ml/experiments/final_evaluation.py`, ORL protocol from `ml/experiments/benchmark.py`).

## 1. Experimental conditions (keep these in mind for every table)

| Label | Meaning |
|---|---|
| **Training** | Scores on the same images the model was fitted on (resubstitution). Shown only to expose over-fitting. |
| **Validation (out-of-fold)** | 5-fold stratified cross-validation over all 400 ORL images, 40 subjects, 10 images each (about 8 train / 2 test per subject per fold, shuffle seed 0). Every image is predicted by a model that never saw it. This is the headline number. |
| **Open-set** | 30 subjects enrolled (6 images each), 4 other images of each as genuine probes, 10 never-enrolled subjects as impostors; 20 random subject splits (seeds 0 to 19). |
| **Simulated-browser / live smoke** | The real API, database and detector driven by ORL photos, with head turns simulated by sliding the photo sideways. Tiny samples; demonstrates that the parts work together. |
| **Physical webcam** | Not done. No claim is made about real webcams. |

There is no separate held-out test set beyond the cross-validation folds: with 10 images per subject, a fixed 3-way split
would leave too few images. The cross-validation scores are therefore validation scores used once, with no hyper-parameter
search on them (the 95% variance setting and k=3 were fixed before this evaluation).

## 2. Closed-set identification (validation, out-of-fold)

Preprocessing is the one the app uses: centre square crop, 64x64, histogram equalisation, elliptical mask, per-image z-score.
Macro averages are over the 40 subjects.

| Pipeline | Accuracy | Macro precision | Macro recall | Macro F1 | Errors (of 400) | Training accuracy |
|---|--:|--:|--:|--:|--:|--:|
| PCA + KNN (baseline, not deployed) | 0.8575 | 0.8814 | 0.8575 | 0.8554 | 57 | 1.000 |
| PCA + LDA + KNN (k=3) | 0.8950 | 0.9076 | 0.8950 | 0.8952 | 42 | 1.000 |
| PCA + LDA + SVM (linear, C=1) | 0.8925 | 0.9058 | 0.8925 | 0.8937 | 43 | 1.000 |

Training accuracy of 1.000 against 0.86 to 0.90 out-of-fold shows the models fit the training images perfectly and
generalise less well; the out-of-fold figure is the one to quote.

Spread across five different shuffles of the same 5-fold protocol (seeds 0 to 4; mean ± standard deviation):

| Pipeline | Accuracy | Macro F1 |
|---|--:|--:|
| PCA + KNN | 0.8715 ± 0.0087 | 0.8693 ± 0.0088 |
| PCA + LDA + KNN | 0.8950 ± 0.0022 | 0.8948 ± 0.0023 |
| PCA + LDA + SVM | 0.8930 ± 0.0019 | 0.8934 ± 0.0022 |

Reading: LDA on top of PCA helps by roughly 2 to 4 accuracy points over PCA alone, consistently across shuffles. KNN and the
linear SVM are indistinguishable (difference 0.002 to 0.003, within shuffle noise); the app trains both and deploys the one
with the higher cross-validated macro-F1 on the data it has, defaulting to KNN on a tie. The seed-0 row is the Phase 3
protocol and reproduces the Phase 3 numbers exactly (also in a clean virtual environment built from
`backend/requirements-lock.txt`, with identical confusion matrices).

Confusion matrices (40x40, rows are true subjects) are in `ml/results/final_evaluation.json`
(`closed_set.variants.<name>.confusion_matrix`) and drawn for PCA+LDA+KNN in
[`screenshots/13-ml-evaluation.png`](screenshots/13-ml-evaluation.png). Errors are spread thinly: PCA+LDA+KNN gets 16
subjects completely right, and its worst subjects have 3 to 4 of their 10 images mislabelled. No one subject dominates.

## 3. Dimensionality

| | Value |
|---|--:|
| Original dimension (64 x 64 pixels) | 4,096 |
| PCA components kept (smallest number reaching 95% variance; cap N − C = 360) | 148 |
| Variance retained by PCA | 0.9503 |
| LDA components (C − 1 for 40 subjects) | 39 |
| Training samples / classes in the full fit | 400 / 40 |

**Why PCA comes before LDA.** LDA needs the within-class scatter matrix S_w to be invertible. With 4,096 features and only
10 images per person, S_w has rank at most N − C = 360, far below 4,096, so S_w is singular and LDA cannot be computed
directly. Projecting with PCA to fewer than N − C dimensions first makes S_w full rank; LDA then finds at most C − 1
directions that separate the people (the "Fisherfaces" recipe of Belhumeur et al., 1997). PCA also removes noise
directions. How many PCA components to keep matters (Phase 3 sweep on PCA+LDA+KNN, same CV):

| PCA setting | Accuracy |
|---|--:|
| 80% variance | 0.890 |
| 90% variance | 0.898 |
| **95% variance (used)** | 0.895 |
| 99% variance | 0.805 |
| N − C components (textbook Fisherface) | 0.270 |

Keeping too many components lets LDA fit noise, so the textbook N − C choice collapses to 0.270 here; this is why the app uses
a variance target and only uses N − C as a cap. The choice among 80 to 95% is within noise; 95% was fixed in Phase 3 and
not re-picked from these numbers.

Class separation on the full data (in-sample, hence optimistic), as the ratio of between-class to within-class scatter
trace: 1.02 in pixel space, 1.12 after PCA, 5.79 after LDA.

## 4. Open-set behaviour (authentication-style decisions)

A claim is accepted only if the classifier predicts the claimed identity **and** the sample's distance to that user's centroid
in LDA space is at most a threshold. The threshold is a percentile of the out-of-fold genuine distances (computed the same
way as in production). The deployed percentile is 70.

Terms: **genuine rejection rate** = share of genuine probes rejected (what a biometric paper would call false rejection
rate, FRR). **Impostor acceptance rate** = share of impostor attempts accepted. We report it for two attacker models and do
not call it a general FAR, because an impostor attempt rate depends on the attack scenario, and our sample (10 impostor
subjects, 20 splits) is small.

Mean ± standard deviation over 20 random splits:

| Threshold percentile | Genuine rejection rate | Impostor acceptance, claims a random enrolled user | Impostor acceptance, claims the identity the model assigns to them |
|--:|--:|--:|--:|
| 50 | 0.342 ± 0.040 | 0.002 ± 0.005 | 0.067 ± 0.062 |
| 60 | 0.261 ± 0.033 | 0.009 ± 0.010 | 0.189 ± 0.101 |
| **70 (deployed)** | **0.197 ± 0.033** | **0.023 ± 0.012** | **0.450 ± 0.155** |
| 80 | 0.153 ± 0.028 | 0.040 ± 0.015 | 0.760 ± 0.149 |
| 90 | 0.141 ± 0.025 | 0.047 ± 0.015 | 0.967 ± 0.058 |
| 95 | 0.140 ± 0.025 | 0.048 ± 0.015 | 0.999 ± 0.003 |

Reading, plainly:

* At the deployed threshold about **one genuine probe in five is rejected**, so a real user should expect to retry.
* A stranger who simply claims a random enrolled identity is accepted about 2% of the time.
* A stranger who is lucky enough to be classified as the account holder is accepted **about 45% of the time**. That is the
  scenario that matters for a payment system, and it is not acceptable for real use. Raising the threshold percentile lowers
  genuine rejections but lets in nearly every such stranger (0.97 at p90).
* The model is closed-set: it was built to say *which of the enrolled people this is*, not to say *this is nobody I know*.
  Distance gating helps only partly. Phase 4 compared two alternative decision rules against a rule declared in advance;
  neither qualified, so the original rule was kept (see `docs/face-authentication.md`, `ml/results/auth_policy.json`).

## 5. Liveness challenge

Measured by `ml/experiments/final_evaluation.py` (`liveness` section of the JSON). Setup: 40 ORL faces pasted at 200 px
width into 640x480 frames, Gaussian noise (σ = 4 grey levels) and JPEG quality 80 applied to every frame, OpenCV Haar
detector, 9 frames per face. 330 of 360 frames had exactly one detected face; 35 of the 40 faces had a complete nine-frame
sequence and were evaluated. (The slid-photo test uses the same synthetic frames in the app's 7-frame form: two baseline frames, then five frames moving 0.04, 0.10, 0.16, 0.18 and 0.18 box widths toward the requested side.)

| Quantity | Value |
|---|--:|
| What the challenge detects | the detected face box moving sideways, in the **requested** direction (turn left or turn right, chosen at random), by at least 0.10 box widths, without a large opposite move |
| Measured detector jitter on a static image, median / p99 / maximum (box widths) | 0.0025 / 0.0121 / 0.0131 |
| Selected movement threshold | 0.10 box widths (7.6 times the largest measured jitter) |
| Baseline stability limit | 0.05 box widths |
| Static image, 35 sequences x 2 directions | **0 of 70 passed** |
| The same flat image slid sideways during the turn phase, 35 sequences x 2 directions | **70 of 70 passed** |

Attack types **tested**: a perfectly still image (rejected) and a still image translated sideways (accepted, i.e. the challenge
is defeated). Also covered by unit and API tests: wrong direction, no face, lost face, unstable baseline, second face,
reused or expired challenge, wrong user.

Attack types **not tested**: replayed video of the person following the instruction, 3D masks, screens held at an angle,
deepfakes or injected camera streams, real head turns on a real webcam, different lighting or cameras. No presentation
attack detection standard (such as ISO/IEC 30107-3) was applied.

This is a basic challenge-response signal that stops the laziest attack, a still photo held up to the camera. It is **not** a
complete presentation-attack-detection system, and the slid-photo result above shows why. The threshold was derived from
detector jitter on synthetic frames and a geometric estimate of a head turn; it has not been validated on real head turns.

## 6. Simulated-browser and live smoke tests (tiny samples, not error rates)

| Run | What happened |
|---|---|
| Phase 3 live API test (`ml/results/README.md`) | 5 subjects x 8 photos enrolled; 10 held-out genuine photos: 10/10 identified correctly, 5/10 accepted (the rest over the distance threshold); other enrolled users accepted as me 0/10; an unenrolled stranger 0/10. |
| Phase 5 live payment flow (`ml/results/payment_e2e_live.txt`) | Genuine customers paid 5/5 (tries needed [2, 2, 1, 1, 1]; two rejections were `DISTANCE_TOO_HIGH`). Refused: another enrolled person's face (2/2), an unenrolled stranger (2/2), a still photo, the wrong turn direction, two faces in view. |
| Phase 7 local benchmark, 10 payments | 10/10 genuine authentications accepted with an ORL photo slid sideways as the head turn (`ml/results/perf_local.json`, `payment_flow_auth_results`). |
| Phase 7 browser run (simulated camera) | Genuine person accepted and paid; a stranger's photo rejected with the payment left unpaid; a non-moving photo failed liveness with a clear message. |

All of these use a simulated camera showing ORL photos. They show the pipeline is wired together correctly. They say
nothing about physical webcams.

## 7. Browser testing

Driver `docs/browser-testing/run.mjs` (Playwright, headless Chromium) against the production build, the real API and
PostgreSQL, with a simulated camera. Final Phase 7 run:

| Result | Value |
|---|--:|
| Steps passed | **44 of 44** |
| Viewports | desktop 1280x800, tablet 768x1024, mobile 390x844 (no horizontal scrolling on checked pages) |
| Covered | registration (both roles), face setup, merchant payment creation and monitoring, checkout, authentication, liveness, confirmation, receipt, histories, filters, rejection paths, camera denied, backend failure states (network, 500, 429), 401 handling, route guards, mobile menu, full mobile payment |

## 8. Accessibility testing (automated only)

axe-core (WCAG 2.0/2.1 level A and AA rule sets) was run on 10 pages: landing, new customer dashboard, face setup, merchant
payment session, checkout, confirm payment, receipt, customer dashboard with data, customer transactions, merchant
dashboard. **axe reported no violations on any of them.** Automated tools find only a fraction of accessibility problems.
No manual screen-reader audit or full keyboard audit was done, and **WCAG conformance is not claimed**. One keyboard
check passed (first Tab stop is a real control with a visible focus ring).

## 9. Backend and frontend tests

| Suite | Result |
|---|---|
| Backend `pytest` (real PostgreSQL, 341 tests) | **341 passed**, in the development environment and again in a clean Python 3.13 virtual environment built from `backend/requirements-lock.txt` |
| Ruff (`F`, `E9`, `B` rules) on `app`, `tests`, `alembic` and `ml/experiments` | no findings |
| Alembic | `upgrade head` on an empty database, then `alembic check`: no drift |
| Frontend `vitest` | **168 passed** (7 files) |
| Frontend lint (`oxlint`) | clean |
| Frontend production build | succeeds; main bundle 344 kB (105 kB gzip), lazy revenue-chart chunk 359 kB (104 kB gzip), CSS 24 kB |

## 10. Local performance (benchmarks, not cloud numbers)

`ml/experiments/perf_local.py`, results in `ml/results/perf_local.json`. One machine with 2 CPU cores, single uvicorn
process, local PostgreSQL, one sequential client over localhost. **These are local benchmarks; they say nothing about latency
on a hosted service.**

| Operation | n | Median | p95 |
|---|--:|--:|--:|
| `GET /health` (includes a database round trip) | 200 | 2.9 ms | 3.6 ms |
| Register / login (Argon2id) | 3 each | about 143 ms | n/a |
| Upload one face sample (detect, quality check, crop, encrypt, store) | 24 | 113 ms | 133 ms |
| Train the shared model (3 users, 24 samples) | 1 | 2.6 s | n/a |
| `POST /faces/recognize`, one frame | 30 | 128 ms | 145 ms |
| Create a payment session | 10 | 19 ms | 22 ms |
| Start a face challenge | 10 | 18 ms | 21 ms |
| **Face authentication, 7 frames (detection on every frame, PCA, LDA, classifier, liveness, policy, log)** | 10 | **729 ms** | 751 ms |
| Confirm payment | 10 | 20 ms | 23 ms |
| Customer transactions list (limit 20) | 30 | 7.8 ms | 9.8 ms |
| Merchant transactions list (limit 20) | 30 | 6.6 ms | 8.6 ms |
| Customer / merchant summary | 30 each | 6.3 / 14.0 ms | 7.8 / 16.3 ms |

The model itself (PCA, LDA and classifier on one sample) takes about 0.3 to 1 ms in the cross-validation timings; almost all
of the authentication time is image decoding and Haar face detection on each frame.

**Database query behaviour.** An automated test (`test_list_endpoints_use_a_constant_number_of_queries`) counts the SQL
statements for the four list/summary endpoints with 1 and with 6 transactions and asserts they are equal, so there is no N+1
pattern. Measured counts: 2, 2, 2 and 9 statements (the merchant summary runs several aggregate queries; the number does not
grow with data). Composite indexes exist for the merchant and customer history queries.

**Frontend bundle:** 344 kB main JavaScript (105 kB gzipped); the revenue chart library is loaded lazily only on the merchant
dashboard.

## 11. What these results do not show

* Accuracy, impostor acceptance or latency for real webcams, real users, other populations, lighting, pose or ageing.
* Resistance to any presentation attack beyond a still image.
* Behaviour at more than a few dozen enrolled users, or hosted performance.
