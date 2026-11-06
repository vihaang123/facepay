# Recognition engine comparison: PCA-LDA-KNN vs dlib ResNet embeddings

Status: measured, **not adopted**. The default engine is still PCA-LDA-KNN. `FACE_ENGINE=embedding` selects the deep engine
(see `backend/app/ml/embedding.py`). Changing the default or any threshold needs an explicit decision.

## What was measured

| | PCA-LDA-KNN (default) | dlib ResNet 128-d embedding (optional) |
|---|---|---|
| Identification accuracy (30 enrolled people, 6 images each, 4 held-out images each) | 89.0 % | 100.0 % |
| Equal error rate, strangers vs enrolled | 19.9 % | 0.0 % |
| Strangers accepted when genuine users pass 90 % of the time | 64.6 % | 0.0 % |
| Per-frame cost on a 640x480 frame (detect + features/embedding), median | 54 ms | 140 ms |
| Per-frame cost, 95th percentile | 64 ms | 145 ms |
| Extra memory in the process | baseline (about 77 MB peak) | about +52 MB (about 129 MB peak) |

- Accuracy figures: ORL face database (40 people, 400 studio images), 5 random splits of 30 enrolled and 10 stranger identities,
  mean over splits. Script: `bench.py` in the scratch folder used for this work. dlib found a face in 399 of 400 ORL images.
- Latency and memory: 40 frames made by scaling ORL faces to about 300 px wide on a 640x480 canvas, on a 2-core cloud container,
  one process, one frame at a time. Single-run timings on shared hardware: treat them as order of magnitude.

## What this does and does not show

- The accuracy gap on strangers is large and consistent with how the two methods work: PCA-LDA learns a projection from only
  the enrolled people, so a stranger is simply mapped to the nearest enrolled person; embeddings are trained on a large
  external face set and measure identity directly.
- ORL is a studio dataset (frontal, controlled light, 1990s cameras). It says little about phone selfies, glasses, beards,
  lighting changes, or deliberate impersonation. **No real-user or phone-camera evaluation has been run**, so absolute numbers
  here must not be quoted as the system's real-world accuracy. ORL results are kept separate from any future phone captures.
- The deep engine is **slower** (about 2.6x per frame) and uses more memory. Both are far inside the 120 s authorization window
  and a human cannot perceive the difference between 54 ms and 140 ms, but "faster" is not what it offers; "more accurate" is.
- Neither engine is a defence against deepfakes or replayed video. Liveness is a basic head-turn check.

## Not evaluated

- YuNet + SFace (OpenCV Zoo) and SCRFD + ArcFace (InsightFace `buffalo_l`): the model files could not be downloaded in the build
  environment (the host is blocked), so nothing is claimed about them. `buffalo_l` also ships under a non-commercial research
  licence; YOLOv8 is AGPL-3.0 and the common YOLO-face weights are GPL-3.0. Any of these needs a licence decision before use.
- Memory on the hosted 512 MB instance with the database driver loaded and a real model: must be measured there before
  switching, since the figure above is for a bare Python process.

## Switching, if approved

1. Set `FACE_ENGINE=embedding` on the backend host. 2. Every customer re-does face setup once (templates are different).
3. Thresholds in `app/ml/config.py` are provisional and must be re-tuned on real phone captures before any claim is made.
