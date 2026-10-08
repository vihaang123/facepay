# PCA-LDA Based Facial Authentication Framework for Secure Digital Payment Simulation

**FacePay — project report.** An academic prototype. Payments are simulated; no real money, UPI, bank or wallet is involved.

---

## 1. Title

PCA-LDA Based Facial Authentication Framework for Secure Digital Payment Simulation (FacePay).

## 2. Abstract

FacePay is a working prototype of paying by face. A merchant creates a payment request, a customer opens the checkout link,
looks at the camera, follows a short head-movement instruction and, if the system accepts the face, confirms a simulated
payment and receives a receipt. The face recogniser is deliberately classical: images are reduced with Principal Component
Analysis (PCA), projected with Linear Discriminant Analysis (LDA) and classified with k-nearest-neighbours or a linear
support-vector machine. No pretrained neural embedding is used. Around it sit a challenge-response liveness check, an explicit
authentication policy, single-use server-side payment authorizations, encrypted storage of face data, role-separated
customer and merchant accounts, dashboards, and an automated test suite (341 backend tests, 168 frontend tests, a 44-step
browser run). On the public ORL face set (40 subjects), 5-fold cross-validated accuracy is 0.858 for PCA+KNN, 0.895 for
PCA+LDA+KNN and 0.892 for PCA+LDA+SVM, so LDA gives a consistent improvement over PCA alone. The same experiments show the
limits plainly: at the deployed threshold about 20% of genuine attempts are rejected and an impostor who is mistaken for the
account holder is accepted about 45% of the time, and the liveness challenge is defeated by a photo that is slid sideways.
FacePay therefore demonstrates the method and a sound payment-flow structure; it is not a secure biometric payment system.

## 3. Introduction

Card and phone payments usually rely on something the customer knows (a PIN) or holds (a device). Face recognition promises
a way to pay with nothing but the customer's presence. The idea raises two separate engineering questions: how reliably can a
modest, transparent model tell enrolled people apart, and how should a payment system be built around a biometric that is
probabilistic, sensitive and spoofable? This project explores both at student scale, with the principal goal of
demonstrating PCA and LDA (the classic "Eigenfaces" and "Fisherfaces" ideas) inside a complete, honest, testable application.

## 4. Problem Statement

Design and build a facial authentication framework for a simulated digital payment system in which (a) identity is decided by a
PCA-LDA based pipeline, (b) the biometric decision is combined with a liveness signal and an explicit policy before any
payment can proceed, (c) the payment itself is protected by server-side, single-use authorization, and (d) every result
is measured and reported without exaggeration.

## 5. Objectives

1. Implement a PCA → LDA → classifier recognition pipeline and compare PCA+KNN, PCA+LDA+KNN and PCA+LDA+SVM fairly.
2. Add a liveness challenge and an authentication policy with logged, machine-readable reasons.
3. Build a simulated payment flow with merchant and customer roles whose authorization cannot be forged from the browser.
4. Protect biometric data and payment state with sound, tested engineering (encryption at rest, hashing, binding, atomicity).
5. Evaluate honestly, including where the approach is weak, and document how to reproduce every number.
6. Prepare the application for deployment without claiming a deployment that did not happen.

## 6. Existing System / Motivation

Most payments use a PIN, a one-time password, or a device biometric that stays on the phone. Commercial face payment systems
use deep neural embeddings trained on millions of faces, dedicated liveness hardware (depth, infrared) and server-side fraud
controls; those are out of reach and out of scope here. Classic PCA and LDA methods (Turk and Pentland, 1991; Belhumeur et al.,
1997) are small enough to understand end to end, which makes them suitable for teaching and for studying exactly where a
face-based decision succeeds and fails. The motivation is educational and methodological, not to compete with deployed systems.

## 7. Proposed System

FacePay has two roles. **Customers** register, enrol their face (several samples across poses), and pay merchant requests by
authenticating with their face. **Merchants** register, create payment sessions with an amount and an order reference, share the
checkout link, watch the status update, and see transactions and revenue. The backend makes every security decision; the
browser only displays results and cannot mark anything as authenticated or paid.

## 8. System Architecture

```
React + Vite + Tailwind (static, Vercel-ready)
        │  HTTPS, bearer token
FastAPI (Python 3.13)  ──  services: auth, faces, face authentication, payments
        │                    └─ ML pipeline (OpenCV detector, PCA, LDA, KNN/SVM, liveness)
PostgreSQL (SQLAlchemy 2, Alembic migrations)
```

* The ML pipeline runs inside the backend process (`backend/app/ml`); offline experiments live in `ml/experiments`.
* Migrations are the only way the schema changes (five migrations, `alembic check` reports no drift).
* Configuration is read from environment variables only; production mode refuses to start without a biometric key and a real JWT secret.
* The in-process rate limiter, model cache and training lock mean the backend is designed to run as a single instance.

## 9. Technology Stack

| Layer | Technology |
|---|---|
| Frontend | React, Vite, Tailwind CSS v4, React Router, Recharts (lazy loaded), Vitest, oxlint |
| Backend | FastAPI, Pydantic v2, SQLAlchemy 2, Alembic, PyJWT, argon2-cffi, cryptography (AES-GCM) |
| ML | OpenCV (Haar face detector only), NumPy, scikit-learn (PCA, LDA, KNN, SVM), pandas |
| Database | PostgreSQL |
| Testing | pytest (real PostgreSQL), Vitest, Playwright + axe-core, Ruff |
| Deployment (prepared, not deployed) | Vercel for the frontend, a Dockerfile for the backend, any PostgreSQL |

## 10. Database Design

Ten tables: `users` (customers; role customer/admin), `merchants`, `face_samples` (encrypted 64x64 crops), `model_versions`
(encrypted trained model, configuration, cross-validation metrics, library versions; one active row enforced by a partial
unique index), `face_profiles` (per user: encrypted LDA-space centroid and distance threshold; one active per user),
`face_auth_challenges` (single-use liveness challenges), `authentication_logs` (every decision: result, reason, confidence,
distance, liveness, challenge, model version; no images), `payment_sessions` (merchant bills and their lifecycle),
`payment_authorizations` (hashed single-use tickets) and `transactions` (simulated payments, unique `FP-` identifiers, positive
amounts, constrained statuses). Constraints (CHECK, unique, partial unique indexes) enforce invariants such as one successful
transaction per session; composite indexes serve the history queries. Deleting a user removes their biometric data and
keeps the authentication log with the user reference cleared.

## 11. Facial Recognition Pipeline

Enrolment: camera frame → Haar detector (exactly one face of sufficient size, quality gates on sharpness and brightness) →
eye-line levelling when both eyes are found → square crop with margin → 64x64 grayscale → histogram equalisation → AES-256-GCM
encrypted storage. Raw frames are never stored. Training: all eligible users' crops → elliptical mask and per-image z-score →
PCA → LDA → classifier → encrypted model and a per-user profile. Recognition and authentication repeat the same preprocessing on
new frames and project them through the stored PCA and LDA. The Haar cascade is used only to find where the face is; identity
comes only from PCA, LDA and the classifier.

## 12. Principal Component Analysis

Each 64x64 image is a vector in 4,096 dimensions. PCA finds the orthogonal directions of greatest variance and keeps the
smallest number that explains 95% of it (148 components on the 400-image ORL set). It removes redundancy and noise and, crucially,
makes the next step possible: with far fewer images than pixels the within-class scatter matrix is singular, and projecting
below N − C dimensions first makes it invertible. The choice of how many components to keep matters a great deal: keeping the
textbook maximum of N − C collapsed accuracy to 0.270 on ORL, while 80 to 95% variance all scored between 0.890 and 0.898.

## 13. Linear Discriminant Analysis

LDA finds at most C − 1 directions (39 for 40 people) that maximise the spread between people relative to the spread within
each person (Fisher's criterion). In the evaluation it increased the between-to-within scatter ratio from 1.12 (after PCA) to
5.79 and improved cross-validated accuracy from 0.858 to 0.895 (and from 0.872 to 0.895 averaged over five shuffles). LDA needs
at least two enrolled users and several varied samples per user; with too few samples it did not help in the Phase 3
feasibility tests, which is why enrolment asks for many samples across several poses.

## 14. Classifier

On the LDA output a distance-weighted k-nearest-neighbour classifier (k = 3, or the smallest class size if smaller) and a linear
SVM (C = 1) are trained. The two are statistically indistinguishable on ORL (0.895 versus 0.892). Each training run
cross-validates all variants on the enrolled data and deploys the PCA+LDA classifier with the higher macro-F1, defaulting to KNN
on a tie. The PCA+KNN baseline is evaluated for comparison and never deployed. The classifier's confidence is a vote fraction or
a score; it is not a calibrated probability.

## 15. Liveness Detection

A challenge-response check. The server issues a random, single-use, 60-second challenge, "turn your head to your left/right". The
browser captures two baseline frames looking at the camera, then several frames during the turn. The backend detects the face
in each frame and requires the face box to move at least 0.10 box widths in the requested direction, without large opposite
movement and with a stable baseline. The threshold is 7.6 times the largest measured detector jitter on static synthetic frames
(0.0131 box widths). A still image never passed in our tests; **a still image slid sideways always passed**. The challenge
therefore stops only the simplest attack and is not presentation-attack detection. It has not been tested with real head turns
on a physical webcam.

## 16. Authentication Policy

A pure, unit-tested function combines the evidence and returns `AUTHENTICATED` or `REJECTED` with a reason, evaluated in a fixed
order: account disabled, challenge invalid or expired, model unavailable, not enrolled, image problems (no face, several faces,
too small, poor quality), liveness failed, identity mismatch, low confidence, distance too high. Authentication requires that
every baseline frame is predicted as the signed-in user, with classifier confidence at least 0.5 and distance to the user's
profile centre within that profile's threshold (the 70th percentile of out-of-fold genuine distances). Any additional face in
any frame, of at least 15% of the largest face's area, rejects the attempt. Every attempt is logged without images or feature vectors.

## 17. Payment Authorization Flow

1. The merchant creates a session; the amount is stored on the server.
2. The customer opens `/checkout/<id>` (signed in); the page shows merchant, order, amount and status.
3. The customer starts authentication; the server issues a challenge only if the session is payable.
4. The customer's frames go to the server, which runs detection, PCA, LDA, classification, liveness and the policy.
5. On success the server issues a one-time authorization: 32 random bytes, only the SHA-256 hash stored, valid 120 seconds,
   bound to this customer and this session.
6. Confirm validates and consumes the ticket inside one database transaction with a row lock; the amount charged is always the
   stored one (a differing `expected_amount` is refused); a partial unique index allows one successful transaction per session.
7. A receipt is shown; both histories update.

Five counted failed face attempts end the session as failed. Expiry, cancellation and failures revoke tickets.

## 18. Security Design

Argon2id password hashes; JWTs with pinned algorithm, expiry and type; separate customer and merchant logins; every query
scoped to the caller; Pydantic schemas that forbid extra fields; parametrised SQL; per-IP and per-user rate limits; a 12 MB
request limit; `no-store`, `nosniff`, `no-referrer` and frame-denial headers; AES-256-GCM encryption of face crops, models and
profiles with the key only in the environment; no endpoint that returns biometric data; production configuration validation.
The residual risks, several of them serious, are tabulated in [`security-assessment.md`](security-assessment.md).

## 19. Frontend / UX

A responsive React single-page application for both roles: landing page with a prototype notice, registration and login,
customer dashboard with spending summary and face-setup status, a guided face-setup page (camera, pose prompts, sample quality
feedback, training, test recognition, in-page confirmation of destructive actions), checkout and authentication with progress
steps, a result panel that hides raw model numbers behind "Technical details", receipts, searchable and sortable transaction
history, and a merchant dashboard with revenue chart, status polling and cancellation. Loading, empty and error states are
written for people, and the UI never shows server error bodies. Screenshots are in
[`screenshots/`](screenshots/) (camera previews are blurred because the simulated camera shows public research faces).

## 20. Experimental Methodology

Dataset: the public ORL set (40 subjects × 10 images). Protocol: 5-fold stratified cross-validation with every score
out-of-fold; repeated over five shuffles for spread; an open-set test with 30 enrolled subjects (6 images each), 4 genuine probes
each and 10 never-seen impostor subjects over 20 random splits; liveness measured on 40 ORL faces pasted into noisy,
JPEG-compressed 640x480 frames. Metrics: accuracy, macro precision, recall and F1, confusion matrices, genuine rejection rate
and impostor acceptance rate under two attacker models. No hyper-parameter was tuned on the evaluation, and the methodology was
not changed to improve numbers. Full detail: [`evaluation-results.md`](evaluation-results.md) and [`reproducibility.md`](reproducibility.md).

## 21. Results

| Pipeline | Accuracy | Macro precision | Macro recall | Macro F1 |
|---|--:|--:|--:|--:|
| PCA + KNN | 0.8575 | 0.8814 | 0.8575 | 0.8554 |
| PCA + LDA + KNN | 0.8950 | 0.9076 | 0.8950 | 0.8952 |
| PCA + LDA + SVM | 0.8925 | 0.9058 | 0.8925 | 0.8937 |

Open-set at the deployed threshold (70th percentile): genuine rejection rate 0.197; impostor acceptance 0.023 when the impostor
claims a random enrolled user and 0.450 when the impostor claims the identity the model assigns to them. Liveness: a still image
failed 70 of 70 times, a slid still image passed 70 of 70 times. Software: 341 backend tests, 168 frontend tests and a 44-step
browser run all pass; automated accessibility checks found no axe violations on 10 pages. Local latency: a seven-frame face
authentication takes about 0.73 seconds, most of it image decoding and face detection.

## 22. Discussion

LDA does what theory predicts: it spends the information in the 148 PCA dimensions on separating people, and it helps (about
2 to 4 accuracy points) at no cost in latency. PCA+LDA+KNN and PCA+LDA+SVM are equivalent, so the simpler KNN is a reasonable
default. The two sharper findings concern authentication rather than identification. First, a closed-set classifier is a weak
verifier: the distance threshold trades genuine rejections against impostor acceptance, and no setting achieved both a low
rejection rate and a low acceptance rate of look-alikes. A payment system would need a verification-oriented model, much more
training data, or a second factor. Second, a liveness signal based only on face-box movement is cheap to satisfy; real
anti-spoofing needs depth, texture or multi-modal cues. The payment-authorization design is independent of these weaknesses:
it ensures that whatever the face check decides, the amount, ticket and state transitions are enforced by the server.

## 23. Limitations

* All recognition results are from ORL (40 people, controlled conditions), not webcams, real users, other populations or other environments.
* Impostor acceptance is high for the look-alike scenario (about 45%) and about one genuine attempt in five is rejected.
* Liveness is a basic head-movement check, defeated by a slid photo, and was not validated on real head turns.
* There is one shared model for all users, trained on demand; adding or removing a user changes it. Rate limits and caches are per process.
* No refunds, balances, payouts, idempotency keys or webhooks; payments are database rows.
* Access tokens are in `localStorage`; there is no revocation, refresh token, email verification or password reset; no Content-Security-Policy.
* Face data is encrypted with a single key without rotation.
* The system was not deployed in Phase 7 and not tested with a physical camera.
* Automated accessibility checks do not establish WCAG conformance.

## 24. Ethical / Privacy Considerations

A face is a permanent identifier; a leaked password can be changed and a leaked face cannot. The prototype keeps only small
cropped, equalised images, encrypts them, never returns them through the API, and lets users delete them. It has no consent
records, retention policy or data-protection impact assessment, and it should not be used with other people's faces without their
informed consent. Face recognition is error-prone and can perform differently for different groups; ORL is small and not
demographically diverse, so no fairness claim is possible and none is made. Any real use would need explicit consent, a
lawful basis, alternatives to face payment for those who decline or cannot use it, and independent testing. The public research
images used for development belong to their dataset's licence terms and are not redistributed here.

## 25. Deployment

The frontend is configured for Vercel (SPA rewrite, security headers, one environment variable) and the backend ships a
Dockerfile and a pinned dependency lock; the database is any PostgreSQL reached through `DATABASE_URL`. Production mode validates
secrets, disables the interactive docs and applies the single-instance guidance. **No deployment was performed**, because no
backend or database host was available; the guide marks what was verified locally and what was not:
[`deployment-guide.md`](deployment-guide.md).

## 26. Future Work

* Collect consented webcam data, evaluate on it, and recalibrate thresholds; report genuine and impostor error rates with confidence intervals.
* Replace the closed-set decision with a verification-oriented one (for example per-user one-class or margin-based scoring) and compare against modern embeddings as a clearly separated baseline.
* Stronger liveness: depth or texture cues, randomised multi-step challenges, and tests against replay and screen attacks to a recognised protocol.
* Per-user models or incremental updates instead of one shared model; key rotation and a key-management service.
* A second factor for payments, short-lived tokens with revocation, and a Content-Security-Policy.
* Shared rate limiting and a background job for expiry for multi-instance deployments; an actual hosted deployment with monitoring.
* Manual accessibility and usability testing with real users.

## 27. Conclusion

FacePay shows that a transparent PCA-LDA pipeline can identify enrolled people on a standard benchmark (about 90% out-of-fold
accuracy, with LDA clearly beating PCA alone), and that a payment flow can be structured so the server controls amounts,
tickets and state no matter what the browser claims. It also shows, with numbers, why this particular pipeline should not
guard real money: it is a weak verifier and its liveness check is easy to satisfy. The results are honest, reproducible, and
limited to the benchmark they were measured on.

## 28. References

1. M. Turk and A. Pentland, "Eigenfaces for recognition", *Journal of Cognitive Neuroscience*, 3(1), 71–86, 1991.
2. P. N. Belhumeur, J. P. Hespanha and D. J. Kriegman, "Eigenfaces vs. Fisherfaces: recognition using class specific linear projection", *IEEE Transactions on Pattern Analysis and Machine Intelligence*, 19(7), 711–720, 1997.
3. R. A. Fisher, "The use of multiple measurements in taxonomic problems", *Annals of Eugenics*, 7(2), 179–188, 1936.
4. F. S. Samaria and A. C. Harter, "Parameterisation of a stochastic model for human face identification", *Proceedings of the 2nd IEEE Workshop on Applications of Computer Vision*, 1994 (the AT&T/ORL face database).
5. P. Viola and M. Jones, "Rapid object detection using a boosted cascade of simple features", *Proceedings of CVPR*, 2001.
6. T. Cover and P. Hart, "Nearest neighbor pattern classification", *IEEE Transactions on Information Theory*, 13(1), 21–27, 1967.
7. C. Cortes and V. Vapnik, "Support-vector networks", *Machine Learning*, 20, 273–297, 1995.
8. F. Pedregosa et al., "Scikit-learn: machine learning in Python", *Journal of Machine Learning Research*, 12, 2825–2830, 2011.
9. G. Bradski, "The OpenCV library", *Dr. Dobb's Journal of Software Tools*, 2000.
10. A. Biryukov, D. Dinu, D. Khovratovich and S. Josefsson, "Argon2 Memory-Hard Function for Password Hashing and Proof-of-Work Applications", RFC 9106, 2021.
11. M. Jones, J. Bradley and N. Sakimura, "JSON Web Token (JWT)", RFC 7519, 2015.
12. M. Dworkin, "Recommendation for block cipher modes of operation: Galois/Counter Mode (GCM) and GMAC", NIST SP 800-38D, 2007.
13. ISO/IEC 30107-3, "Biometric presentation attack detection — Part 3: Testing and reporting" (cited as the kind of standard that was **not** applied).
