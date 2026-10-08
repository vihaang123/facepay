"""Render ml/results/final_evaluation.json to docs/final/screenshots/13-ml-evaluation.png (needs matplotlib).

    python ml/experiments/plot_results.py
"""

import json
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np

root = Path(__file__).resolve().parents[2]
d = json.loads((root / "ml/results/final_evaluation.json").read_text())
v = d["closed_set"]["variants"]
names = {"pca_knn": "PCA+KNN", "pca_lda_knn": "PCA+LDA+KNN", "pca_lda_svm": "PCA+LDA+SVM"}

fig, ax = plt.subplots(1, 3, figsize=(16, 4.8), gridspec_kw={"width_ratios": [1.1, 1, 1.1]})
w = 0.2
for i, m in enumerate(("accuracy", "macro_precision", "macro_recall", "macro_f1")):
    ax[0].bar(np.arange(3) + (i - 1.5) * w, [v[k][m] for k in names], w, label=m.replace("_", " "))
ax[0].set_xticks(range(3), names.values())
ax[0].set_ylim(0.8, 0.95)
ax[0].set_title("ORL, 5-fold CV (out-of-fold; y-axis starts at 0.80)")
ax[0].legend(fontsize=8, loc="upper left")
cm = np.array(v["pca_lda_knn"]["confusion_matrix"])
ax[1].imshow(cm, cmap="Blues")
ax[1].set_title("PCA+LDA+KNN confusion matrix (40 subjects)")
ax[1].set_xlabel("predicted subject")
ax[1].set_ylabel("true subject")
o = d["open_set"]["by_threshold_percentile"]
ps = list(o)
ax[2].plot(ps, [o[p]["false_reject_rate"][0] for p in ps], marker="o", label="genuine rejection rate")
ax[2].plot(ps, [o[p]["far_random_claim"][0] for p in ps], marker="s", label="impostor acceptance (random claim)")
ax[2].plot(ps, [o[p]["far_claims_predicted_identity"][0] for p in ps], marker="^", label="impostor acceptance (claims predicted identity)")
ax[2].axvline(ps.index("70"), color="gray", ls=":")
ax[2].set_xlabel("threshold percentile (deployed: 70)")
ax[2].set_title("Open-set, mean of 20 splits")
ax[2].legend(fontsize=7)
fig.tight_layout()
out = root / "docs/final/screenshots/13-ml-evaluation.png"
fig.savefig(out, dpi=110)
print("wrote", out)
