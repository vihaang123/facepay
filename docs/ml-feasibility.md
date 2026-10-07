# Is PCA -> LDA -> classifier appropriate for FacePay? (measured)

Data: AT&T/ORL (40 subjects x 10 images), preprocessed exactly as the app does
(square crop, 64x64, histogram equalisation, elliptical mask, z-score). 10 random draws per
cell (users C, training images per user n); test = the subject's remaining images.
Source: `ml/experiments/feasibility.py` -> `ml/results/feasibility.json`. ORL is a public
benchmark, NOT webcam captures from this app; absolute numbers will differ for real users.

## Accuracy (mean over 10 draws)

| C | n | PCA+KNN | PCA+LDA+KNN | PCA+LDA+SVM |
|--:|--:|--:|--:|--:|
| 2 | 4 | 0.975 | 0.975 | 0.967 |
| 5 | 4 | 0.917 | 0.820 | 0.823 |
| 5 | 6 | 0.935 | 0.955 | 0.960 |
| 10 | 4 | 0.875 | 0.825 | 0.825 |
| 10 | 6 | 0.923 | 0.948 | 0.948 |
| 10 | 8 | 0.935 | 0.960 | 0.960 |
| 20 | 6 | 0.858 | 0.884 | 0.884 |
| 40 | 6 | 0.790 | 0.833 | 0.831 |
| 40 | 8 | 0.851 | 0.880 | 0.871 |

(Full grid in the JSON; std is 0.02-0.10, so differences under ~0.03 are within noise.)

PCA setting sweep (C=10, n=6, PCA+LDA+KNN): 0.80 -> 0.932, 0.90 -> 0.932, 0.95 -> 0.948,
0.99 -> 0.593, "fisherface" (p = N-C) -> 0.593.

## Conclusions that shape the implementation

1. LDA helps once each user has about 6+ varied samples (+2 to +4 points over PCA+KNN, more
   users => larger gain) but HURTS at n=4 for C>=5 (5 users: 0.917 -> 0.820). So we require
   >= 12 samples across >= 3 poses per user before a user joins training.
2. LDA gives at most C-1 dimensions: with 2 users the classifier sees a single axis. 2 users is
   the hard minimum; accuracy numbers at tiny C are not meaningful evidence of anything.
3. Using the full N-C PCA dimensions (the textbook Fisherface choice) collapsed to 0.593 here:
   the smallest PCA eigenvalues are noise, and LDA amplifies them. We therefore use a
   variance target (0.95) and only use N-C as an upper cap that keeps S_w non-singular.
4. SVM is not better than KNN on this data. Both stay available; the deployed one is chosen
   by cross-validated macro-F1 on the actual enrolled users (ties go to KNN).
5. Training takes < 1 s even at C=40, so retraining the whole model on every "train" request
   is fine for a prototype.
