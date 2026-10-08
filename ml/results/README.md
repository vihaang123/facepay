# Measured results (Phase 3 to 5; final Phase 7 numbers are in `final_evaluation.json` and `docs/final/evaluation-results.md`)

Every number below was produced by the scripts in `ml/experiments/` and is stored in the JSON files
beside this file. **Dataset: AT&T/ORL (40 subjects x 10 images), a public benchmark, not webcam captures from
this app.** It is not committed; pass its path with `--orl`. Re-run to reproduce:

```bash
backend/.venv/bin/python ml/experiments/feasibility.py --orl PATH/orl.npz --repeats 10 --out ml/results/feasibility.json
backend/.venv/bin/python ml/experiments/benchmark.py   --orl PATH/orl.npz --repeats 20 --out ml/results/orl_benchmark.json
```

## Closed-set identification (`orl_benchmark.json`, 5-fold stratified CV, all 400 images, 40 users)

| Pipeline | Accuracy | Macro F1 | Predict ms/sample |
|---|--:|--:|--:|
| PCA + KNN | 0.858 | 0.855 | 1.00 |
| PCA + LDA + KNN | 0.895 | 0.895 | 0.50 |
| PCA + LDA + SVM (linear) | 0.892 | 0.894 | 0.19 |

PCA setting sweep (PCA+LDA+KNN): variance 0.80 -> 0.890, 0.90 -> 0.898, 0.95 -> 0.895, 0.99 -> 0.805,
p = N-C ("fisherface") -> 0.270.  Configuration used: PCA 148 components (95.03% variance), LDA 39 components.

Class separation on the full data (in-sample, so optimistic): between/within scatter ratio 1.02 (pixels) ->
1.12 (PCA) -> 5.79 (LDA); Fisher criterion trace(Sw^-1 Sb) = 225.8.

## Open-set behaviour (30 enrolled x 6 images, 4 genuine probes each, 10 unseen impostor subjects, 20 random draws)

Accept = predicted identity equals claimed identity AND distance to the claimed centroid <= threshold, where
threshold = percentile of out-of-fold genuine distances (exactly how production computes it).

| Percentile | FRR | FAR (impostor claims random enrolled user) | FAR (impostor claims the identity the model predicts) |
|--:|--:|--:|--:|
| 50 | 0.342 | 0.002 | 0.067 |
| 60 | 0.261 | 0.009 | 0.189 |
| 70 (**used**) | 0.197 | 0.023 | 0.450 |
| 80 | 0.153 | 0.040 | 0.760 |
| 90 | 0.141 | 0.047 | 0.967 |
| 95 | 0.140 | 0.048 | 0.999 |

Reading: a closed-set PCA-LDA classifier identifies enrolled people well but is a weak open-set verifier. The
distance check removes some strangers, at a large cost in false rejections. Phase 4 must combine it with liveness
and an explicit decision policy; none of these numbers is a security claim.

## Live end-to-end smoke test (`e2e_live.py`, real HTTP API + real OpenCV detector)

5 ORL subjects x 8 photos enrolled through `/faces/samples`, trained through `/faces/train`, 2 held-out photos each
sent to `/faces/recognize`. (The server was started with MIN_SAMPLES_PER_USER lowered to 8 because ORL has only
10 images per subject.) Result of the clean run: model chose PCA+LDA+KNN (CV accuracy 0.95 vs 0.90 for PCA+KNN,
4 pose-grouped folds); held-out genuine photos: 10/10 identified as the right user but only 5/10 accepted (the other
5 were over the distance threshold); other enrolled users' photos accepted as me: 0/10; an unenrolled stranger: 0/10.
N is tiny: this shows the pieces work together, not an accuracy figure.

## Live payment flow (`e2e_payment_live.py`, Phase 5; output in `payment_e2e_live.txt`)

Real HTTP API, real PostgreSQL, real OpenCV detector, real PCA/LDA model, ORL photos (5 subjects x 8 enrolment
photos; the server was started with MIN_SAMPLES_PER_USER lowered to 8). **Head turns are simulated by sliding the
same photo sideways in the frame**, so this says nothing about real head turns on a real webcam.

* Genuine customers paying their own session (up to 4 tries each, different photo per try): 5/5 paid; tries needed
  [2, 2, 1, 1, 1]; the two earlier rejections were `DISTANCE_TOO_HIGH`. Reported confidence was 1.0 for every accepted
  attempt: that is the KNN vote fraction in a 5-person model, not a calibrated probability.
* Refused: another enrolled person's face on my account (2/2, `IDENTITY_MISMATCH`), an unenrolled stranger's face
  (2/2, `DISTANCE_TOO_HIGH`), a static photo (`LIVENESS_FAILED`/`NO_MOVEMENT`), the wrong turn direction
  (`WRONG_DIRECTION`), two faces in view (`MULTIPLE_FACES_DETECTED`).
* Authorization checks over HTTP: amount 950 -> 1 refused, another customer's use of my ticket refused, a ticket for
  session A on session B refused, reuse refused, other merchant / other customer read access 404.

N is tiny (2 impostor tries per kind). This shows the pieces work together; it is not an error-rate estimate, and the
Phase 3 open-set numbers above remain the honest picture of impostor acceptance.
