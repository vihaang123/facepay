# Recognition policy (v4): why a genuine owner was rejected, and what changed

Script `ml/experiments/auth_policy_v4.py`, result `ml/results/auth_policy_v4.json`. Reproduce:
`backend/.venv/bin/python ml/experiments/auth_policy_v4.py --orl PATH/orl.npz --repeats 30 --people 2,5 --out ml/results/auth_policy_v4.json`
(see `reproducibility.md` for the ORL set). The run behind this page covers 2 and 5 enrolled people; 10 was not run (cost).

## What was reported

After the detection and liveness fixes, an account owner passed "Face detected" and "Basic liveness check passed" and was
still rejected at **"Identity recognized"**, five face checks in a row, so the payment was closed ("Too many failed face checks").
**The cause on that phone is not confirmed**: I had no production logs, no stored crops and no camera. This page measures the
decision rule that was deployed, finds that it rejects a large share of genuine users on its own, and measures the change.

## What was wrong with the decision (evidence from the code and the offline measurement)

1. **The threshold was set to reject 30% of genuine samples by design.** The accept threshold was the 70th percentile of
   out-of-fold genuine distances, so by construction 30% of genuine held-out samples were further than it.
2. **Every frame had to pass.** Two frames of an attempt were each compared with that threshold, so one frame with detector
   jitter failed the whole attempt.
3. **The threshold was calibrated on the same sitting.** Enrolment samples are captured within about a minute from one
   device. The held-out distances therefore under-represent a later session (the face box sits a few pixels differently,
   slightly nearer or further, a little rotated, softer focus, light from one side). A pixel-based PCA/LDA model reacts strongly to
   such shifts, so a genuine user lands further from their profile than the threshold expected.
4. **One threshold for everyone.** A person whose captures vary more than another's was held to the other's spread.
5. **Nothing told the user why.** All identity failures were one sentence, and a pair of accounts that cannot be told apart
   (typically: both accounts set up with the same face) looked identical to a camera problem.

Offline, the previous recipe (row `A_before_v4`) accepted a genuine person in **72-79% of attempts with no shift and 34-64% under
simulated session shift**. With five attempts allowed per payment, a person whose captures sit systematically further from the
profile than the threshold expects fails them all.

## What changed

* **Augmented training** (`app/ml/augment.py`). Each stored 64x64 crop gets 4 slightly perturbed copies at training time
  (small shift, scale, rotation, a side-lighting ramp, softer focus), made in memory and deterministically; nothing extra is
  stored and no sample is changed. A copy always stays on the same side of a cross-validation split as its source sample
  (tested), and accuracy is measured on the original held-out samples only.
* **Threshold calibrated on held-out samples plus perturbed copies of them** (2 per sample, perturbed 1.5x as strongly as the
  training copies, `AUGMENT_CALIBRATION_STRENGTH`), at the **90th percentile** (was 70), **one threshold per person** from their
  own out-of-fold distances (pooled when they have fewer than 12).
* **Mean-distance rule.** The mean distance of the frames used must be within the person's threshold, and no single frame may
  be further than 1.6x the threshold. Every frame must still be classified as the claimed user with confidence >= 0.5.
* **Automatic retraining.** A model trained with an older recipe is rebuilt from the stored samples, in the background, the next
  time someone opens face setup or starts a face check (no new capture; the old model keeps working until the new one is complete;
  a failure leaves it untouched). By hand: `python -m app.cli retrain-model`, or "Prepare recognition model".
* **Two accounts that cannot be told apart are flagged.** Training records each person's out-of-fold recall; below 0.65 the
  face-setup page says the model cannot reliably tell that account from another one (typically the same face set up twice).
* **Diagnosis.** The server log line `identity user_id=... predicted_is_user=[...] confidence=[...] distance=[...] threshold=...`
  holds scores only (no images, vectors or tokens). Scores are still not shown to customers.
* **Training time.** The cross-validation now fits one PCA per fold and shares it between variants (verified identical), because
  augmentation multiplies the number of rows by 5.

Tried and dropped: smoothing the crop before PCA (sigma 1-3) changed nothing measurable (20 trials, 2 enrolled people).

## What is real and what is not (read before quoting a number)

* Real: the app's training, threshold and decision code (`app/ml/recipe.py`, `app/services/auth_policy.py`), the app's crop,
  equalisation and vectorisation.
* **Not real:** ORL photographs (public, studio quality, 112x92, 10 per person, so 6 training and 4 held-out photographs per
  enrolled person here; the app asks for 15). No face detector is involved. **No phone or webcam was used.**
* **"Session shift" is simulated**: independent horizontal and vertical scale (+-8%), shift (+-3 px), rotation (+-5 deg), a
  side-lighting ramp, blur, noise. It is a different family from the training augmentation, but the two overlap in kind, so the
  gain from augmentation here probably overstates the gain on real devices. Differences between two **devices** (a laptop webcam
  at enrolment, a phone at payment time: different lenses, distance, perspective, processing) are not simulated.
* Liveness is assumed passed; this is identity only.
* "2 different photographs" per attempt has more variation than two consecutive webcam frames (pessimistic); "2 frames of one
  capture" has less (optimistic). Real behaviour lies between.
* 95% Wilson intervals are in brackets; attempts from one trial are correlated, so they are narrower than they should be.

## Results

Rows: `A_before_v4` = no augmentation, pooled 70th percentile, every frame must pass (what was deployed). `B` = same model, mean rule.
`C` = augmented, 70th percentile. `D0` / `D` / `F` = augmented, 90th percentile, calibration copies perturbed 1.0x / 1.5x / 2.0x
(**`D` is deployed**). `E` = 95th percentile. Percentages: genuine = owner accepted; "other enrolled" = another enrolled person
claiming this account; "never enrolled" = a person the model has never seen claiming this account.

**2 enrolled people** (30 random trials; attempts per cell in the JSON)


*No simulated session shift, 2 different photographs per attempt (pessimistic)*

| Setting | Genuine accepted | Other enrolled person accepted | Never-enrolled person accepted |
|---|---|---|---|
| A_before_v4 | 72.2% (67-77) | 0.0% (0-1) | 15.9% (14-18) |
| B_mean_rule_only | 83.9% (80-87) | 0.0% (0-1) | 18.4% (17-20) |
| C_augmented_p70 | 88.6% (85-91) | 0.0% (0-1) | 12.2% (11-14) |
| D0_p90_calibration_strength_1.0 | 93.6% (91-96) | 0.0% (0-1) | 21.7% (20-24) |
| D_deployed_p90_strength_1.5 | 95.3% (93-97) | 0.0% (0-1) | 23.4% (22-25) |
| E_p95_strength_1.5 | 95.8% (93-97) | 0.0% (0-1) | 28.3% (26-30) |
| F_p90_strength_2.0 | 95.8% (93-97) | 0.0% (0-1) | 27.0% (25-29) |

*No simulated session shift, 2 frames of one capture (optimistic)*

| Setting | Genuine accepted | Other enrolled person accepted | Never-enrolled person accepted |
|---|---|---|---|
| A_before_v4 | 78.5% (75-82) | 0.0% (0-1) | 20.9% (19-23) |
| B_mean_rule_only | 82.3% (79-85) | 0.0% (0-1) | 21.7% (20-24) |
| C_augmented_p70 | 89.0% (86-91) | 0.0% (0-1) | 13.4% (12-15) |
| D0_p90_calibration_strength_1.0 | 94.0% (91-96) | 0.4% (0-2) | 25.2% (23-27) |
| D_deployed_p90_strength_1.5 | 95.8% (94-97) | 0.4% (0-2) | 27.9% (26-30) |
| E_p95_strength_1.5 | 96.7% (95-98) | 0.4% (0-2) | 33.6% (31-36) |
| F_p90_strength_2.0 | 97.3% (95-98) | 0.4% (0-2) | 32.2% (30-34) |

*With simulated session shift, 2 different photographs per attempt (pessimistic)*

| Setting | Genuine accepted | Other enrolled person accepted | Never-enrolled person accepted |
|---|---|---|---|
| A_before_v4 | 50.0% (45-55) | 0.0% (0-1) | 14.0% (12-16) |
| B_mean_rule_only | 60.8% (56-66) | 0.0% (0-1) | 17.1% (15-19) |
| C_augmented_p70 | 58.1% (53-63) | 0.0% (0-1) | 10.1% (9-12) |
| D0_p90_calibration_strength_1.0 | 73.6% (69-78) | 0.3% (0-2) | 19.9% (18-22) |
| D_deployed_p90_strength_1.5 | 81.9% (78-86) | 0.6% (0-2) | 21.7% (20-24) |
| E_p95_strength_1.5 | 86.1% (82-89) | 0.6% (0-2) | 26.6% (25-29) |
| F_p90_strength_2.0 | 86.4% (82-90) | 0.6% (0-2) | 25.4% (23-28) |

*With simulated session shift, 2 frames of one capture (optimistic)*

| Setting | Genuine accepted | Other enrolled person accepted | Never-enrolled person accepted |
|---|---|---|---|
| A_before_v4 | 64.2% (60-68) | 0.4% (0-2) | 21.3% (20-23) |
| B_mean_rule_only | 67.3% (63-71) | 0.4% (0-2) | 21.8% (20-24) |
| C_augmented_p70 | 66.9% (63-71) | 0.4% (0-2) | 13.6% (12-15) |
| D0_p90_calibration_strength_1.0 | 80.0% (76-83) | 1.0% (0-2) | 24.0% (22-26) |
| D_deployed_p90_strength_1.5 | 85.6% (82-88) | 1.5% (1-3) | 26.8% (25-29) |
| E_p95_strength_1.5 | 89.0% (86-91) | 1.9% (1-4) | 32.3% (30-35) |
| F_p90_strength_2.0 | 88.3% (85-91) | 1.9% (1-4) | 31.2% (29-33) |

**5 enrolled people** (15 random trials; attempts per cell in the JSON)


*No simulated session shift, 2 different photographs per attempt (pessimistic)*

| Setting | Genuine accepted | Other enrolled person accepted | Never-enrolled person accepted |
|---|---|---|---|
| A_before_v4 | 72.9% (69-77) | 0.0% (0-0) | 3.9% (3-5) |
| B_mean_rule_only | 82.4% (79-86) | 0.0% (0-0) | 4.9% (4-6) |
| C_augmented_p70 | 91.3% (88-94) | 0.0% (0-0) | 2.8% (2-4) |
| D0_p90_calibration_strength_1.0 | 95.3% (93-97) | 0.0% (0-0) | 5.7% (5-7) |
| D_deployed_p90_strength_1.5 | 96.2% (94-98) | 0.0% (0-0) | 7.1% (6-8) |
| E_p95_strength_1.5 | 96.2% (94-98) | 0.0% (0-0) | 8.5% (7-10) |
| F_p90_strength_2.0 | 96.2% (94-98) | 0.0% (0-0) | 8.8% (8-10) |

*No simulated session shift, 2 frames of one capture (optimistic)*

| Setting | Genuine accepted | Other enrolled person accepted | Never-enrolled person accepted |
|---|---|---|---|
| A_before_v4 | 80.2% (77-83) | 0.3% (0-1) | 6.6% (6-8) |
| B_mean_rule_only | 82.3% (79-85) | 0.3% (0-1) | 6.8% (6-8) |
| C_augmented_p70 | 90.0% (87-92) | 0.1% (0-0) | 4.1% (3-5) |
| D0_p90_calibration_strength_1.0 | 93.8% (92-95) | 0.2% (0-1) | 8.2% (7-9) |
| D_deployed_p90_strength_1.5 | 95.7% (94-97) | 0.3% (0-1) | 9.5% (8-11) |
| E_p95_strength_1.5 | 96.0% (94-97) | 0.3% (0-1) | 11.3% (10-13) |
| F_p90_strength_2.0 | 97.3% (96-98) | 0.3% (0-1) | 12.4% (11-14) |

*With simulated session shift, 2 different photographs per attempt (pessimistic)*

| Setting | Genuine accepted | Other enrolled person accepted | Never-enrolled person accepted |
|---|---|---|---|
| A_before_v4 | 33.6% (29-38) | 0.1% (0-0) | 2.4% (2-3) |
| B_mean_rule_only | 43.8% (39-48) | 0.1% (0-0) | 3.6% (3-4) |
| C_augmented_p70 | 59.3% (55-64) | 0.0% (0-0) | 2.0% (2-3) |
| D0_p90_calibration_strength_1.0 | 72.4% (68-76) | 0.1% (0-0) | 4.1% (3-5) |
| D_deployed_p90_strength_1.5 | 79.6% (76-83) | 0.1% (0-0) | 5.3% (4-6) |
| E_p95_strength_1.5 | 82.0% (78-85) | 0.1% (0-0) | 6.4% (6-8) |
| F_p90_strength_2.0 | 82.2% (78-85) | 0.1% (0-0) | 6.8% (6-8) |

*With simulated session shift, 2 frames of one capture (optimistic)*

| Setting | Genuine accepted | Other enrolled person accepted | Never-enrolled person accepted |
|---|---|---|---|
| A_before_v4 | 48.8% (45-53) | 1.2% (1-2) | 6.5% (6-8) |
| B_mean_rule_only | 52.0% (48-56) | 1.3% (1-2) | 6.9% (6-8) |
| C_augmented_p70 | 60.2% (56-64) | 0.6% (0-1) | 3.2% (3-4) |
| D0_p90_calibration_strength_1.0 | 73.0% (69-76) | 1.0% (1-1) | 7.7% (7-9) |
| D_deployed_p90_strength_1.5 | 80.3% (77-83) | 1.0% (1-1) | 8.9% (8-10) |
| E_p95_strength_1.5 | 83.2% (80-86) | 1.1% (1-2) | 11.2% (10-13) |
| F_p90_strength_2.0 | 84.7% (82-87) | 1.2% (1-2) | 11.6% (10-13) |

## What this means

* **Genuine users:** accepted far more often (2 people, no shift: 72-79% -> 95-96%; with shift: 50-64% -> 82-86%; 5 people with
  shift: 34% -> 80% in the pessimistic setting). This is the change that addresses the reported failure; it is **not** verified
  on a real phone and a systematic difference between devices can still fail.
* **Another enrolled person:** still essentially never accepted at the first decision (the classifier must name the claimed
  user), 0-0.6% without shift and **up to 1.5-1.9% under shift** with 2 people. That is a small rise from 0-0.4%.
* **A never-enrolled stranger: this got worse and is the price.** With **2 enrolled people** about **22-28%** of strangers'
  attempts were accepted (was 14-21%); with 5 people 5-12% (was 2-4%). A model of two classes has a one-dimensional LDA space, so a
  distance check there rejects strangers poorly; more enrolled people help a lot. For a two-account prototype this is a real limit.
  Setting `DISTANCE_THRESHOLD_PERCENTILE` to 70-80 or `AUGMENT_CALIBRATION_STRENGTH` to 1.0 moves along the same trade-off
  (rows `C`, `D0`) and costs genuine users.
* Not a defence against a photo, a video, a mask or a deepfake; movement liveness does not stop them.

## Files

`app/ml/augment.py`, `app/ml/recipe.py`, `app/ml/evaluation.py` (`user_thresholds`, shared PCA per fold), `app/ml/pipeline.py`
(`full_pca`, `truncated_pca`), `app/services/face_service.py` (`_fit_and_store`, `schedule_retrain`, `retrain_if_outdated`,
separation flag), `app/services/auth_policy.py` (mean rule), `app/services/face_auth_service.py` (identity log line),
`app/cli.py` (`retrain-model`), `tests/test_recognition_recipe.py`.
