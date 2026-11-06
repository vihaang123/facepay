# Recognition engine comparison

Engines measured: **PCA-LDA-KNN** (the app's default), **dlib ResNet** 128-d embeddings (optional, `FACE_ENGINE=embedding`,
see `backend/app/ml/embedding.py`), and **SCRFD + ArcFace** (InsightFace `buffalo_l`: `det_10g.onnx` + `w600k_r50.onnx`, run
with onnxruntime; benchmark only, NOT wired into the app).

Status: measured, **nothing adopted**. The default engine is unchanged. Changing it, or any threshold, needs an explicit decision.

## 1. Clean studio images (ORL, 40 people, 400 images)
30 enrolled people (6 images each), 4 held-out images each, plus 10 people the system has never seen. Mean of 5 random splits.

| | PCA-LDA-KNN | dlib | SCRFD + ArcFace |
|---|---|---|---|
| Identification accuracy | 89.0 % | 100.0 % | 100.0 % |
| Equal error rate | 19.9 % | 0.0 % | 0.0 % |
| Strangers accepted when real users pass 90 % | 64.6 % | 0.0 % | 0.0 % |
| Faces found | n/a (no detector in this test) | 399 / 400 | 400 / 400 |

ORL is too easy for the deep engines: both score perfectly, so **this test cannot tell dlib and ArcFace apart.**

## 2. Degraded test images (synthetic)
Enrolment on the clean photos, testing on copies made worse on purpose: brightness x0.4 to x1.3, uneven side light, blur,
noise and JPEG quality 35. This is a rough stand-in for a poor phone capture, **not real phone data**.

Threshold set so that 1 % of clean strangers would be accepted (a stranger-based operating point):

| | PCA-LDA-KNN | dlib | SCRFD + ArcFace |
|---|---|---|---|
| Face found in the degraded image | n/a | 96.7 % | 92.7 % |
| Identification accuracy (when found) | 89.7 % | 94.3 % | 100.0 % |
| Real users accepted | 52.2 % | 78.8 % | 92.7 % |
| Strangers accepted | 1.0 % | 2.5 % | 2.1 % |
| Equal error rate (best-case threshold) | 21.8 % | 9.3 % | 0.0 % |

Note: if the threshold is instead set from clean real users (90 % pass), both deep engines reject almost every degraded real
user (6 % and 2.5 % accepted) although they still tell people apart. Their distances grow when capture quality drops, so a
threshold calibrated on clean studio photos is wrong for phones. **Thresholds must be calibrated on real phone captures.**

## 3. Cost per frame (2-core cloud container, 640x480 frames made from ORL faces; single runs, order of magnitude)

| | PCA-LDA-KNN | dlib | SCRFD + ArcFace |
|---|---|---|---|
| Median time per frame (detect + features/embedding) | 54 ms | 140 ms | 340 ms |
| 95th percentile | 64 ms | 145 ms | 376 ms |
| Peak memory of a bare Python process | about 77 MB | about 129 MB | about 505 MB |
| Model files on disk | tiny (trained per deployment) | about 100 MB (in the dlib models package) | 191 MB (the two models used) |

## 4. What this means
- Accuracy ranking, in every test: ArcFace >= dlib >> PCA-LDA. PCA-LDA's weakness is strangers: it only knows the enrolled
  people, so it maps any stranger onto the nearest one.
- Speed ranking is the reverse: PCA-LDA is fastest, ArcFace slowest. **No tested engine is both the most accurate and the
  fastest.** Every engine is far inside the 120 s authorization window; the time difference matters for server cost, not for
  the person paying.
- **ArcFace does not fit the current host.** About 505 MB for the models alone is the whole of a 512 MB instance. It needs
  roughly 1-2 GB.
- **dlib is the realistic upgrade**: +52 MB, ~140 ms, already integrated and tested behind a switch.
- Licences: the InsightFace code is MIT but the `buffalo_l` pretrained models are for non-commercial research use only;
  fine for a college project, not for a commercial launch. (YOLOv8 is AGPL-3.0 and common YOLO-face weights are GPL-3.0; these
  were not tested.) dlib's licence terms should be checked before commercial use.

## 5. Limits of this evidence
- ORL is 1990s studio photos of 40 people. The degradation test is synthetic. **No real phone-camera data was evaluated**, so
  none of these numbers may be quoted as the system's real-world accuracy.
- The LFW real-world dataset could not be downloaded (host blocked). YuNet + SFace could not be downloaded either, so nothing
  is claimed about them.
- Liveness is a basic head-turn check; none of these engines protects against deepfakes or replayed video.
- Memory on the hosted instance with the database driver and a real model was not measured there.

## 6. Switching to dlib, if approved
1. Set `FACE_ENGINE=embedding` on the backend host (check memory on that host first). 2. Every customer redoes face setup once.
3. Re-tune the provisional thresholds in `app/ml/config.py` on real phone captures before claiming anything.
