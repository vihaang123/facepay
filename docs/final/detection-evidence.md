# Face-count evidence (multiple-face rejection)

Script `ml/experiments/detection_evidence.py`, result `ml/results/detection_evidence.json`. Reproduce:
`backend/.venv/bin/python ml/experiments/detection_evidence.py --orl PATH/orl.npz --out ml/results/detection_evidence.json`
(see `reproducibility.md` for the ORL set).

## Setting, stated plainly

AT&T/ORL photographs are enlarged and pasted into a smoothed random-noise 640x480 background, JPEG quality 80, then run through
the **real OpenCV Haar detector**. These are **not webcam frames**. A phone in a real room has different clutter, lighting and
motion, so absolute rates will differ; the comparison between counting rules on identical frames is the useful part. An
"attempt" is 8 frames (fresh noise, compression and placement per frame; 200 single-face attempts, 67 per second-person size).
Nothing was tuned on the test frames beyond choosing one confidence floor from the grid below.

## Why genuine users were told "more than one face"

Authentication rejected the whole attempt if ANY of its frames showed a second box at least 15% of the main face's area
(`AUTH_SECOND_FACE_RATIO`), while the live preview used 40% (`SECOND_FACE_RATIO`). Two consequences, both visible in the code and
reproduced below:

1. The preview could say a single face was in position while the authentication rule saw a second one. (Fixed: the preview now
   takes `purpose=auth` and applies the same rule.)
2. A Haar detector draws occasional spurious boxes. On frames that contain exactly one face, **12.6% of
   frames had a spurious second box that counted**, so **135/200 single-face attempts of 8 frames
   would have been rejected** under the old rule. Overlapping duplicate boxes on one face were NOT the main cause in this data
   (suppressing them changed little: 135/200); the spurious boxes were mostly elsewhere in the frame.

This is evidence for the mechanism, not a measurement of the production phone: **the cause on the user's phone is not confirmed.**
Production logs for the failing attempts were not available to me.

## What changed

* Overlapping or nested detections are one face (non-maximum suppression), applied to every consumer.
* A candidate for a SECOND face also needs cascade confidence >= `SECOND_FACE_MIN_WEIGHT` (3.0). The largest detection is always kept.
* Over an attempt, a second face rejects it only when seen in at least `max(2, ceil(0.3 n))` frames (3 of 9). A person standing in view
  is there in almost every frame; a spurious box is not. The identity frames are still individually checked for a single face.
* The security check is kept, not removed: a second person in view for a meaningful share of the attempt is still rejected.

## Single-face attempts (false rejections)

| Counting rule | Frames wrongly called "multiple faces" | Attempts wrongly rejected: any 1 frame (old rule) | second face in >= 2 frames | **>= 3 frames (deployed)** | >= 4 frames |
|---|--:|--:|--:|--:|--:|
| raw boxes (the rule that shipped) | 12.6% | 135/200 | 52/200 | 11/200 | 2/200 |
| duplicates suppressed only | 12.4% | 135/200 | 51/200 | 10/200 | 2/200 |
| **+ second face needs confidence >= 3.0 (deployed)** | 7.9% | 99/200 | 26/200 | 2/200 | 0/200 |
| ... >= 3.5 | 6.7% | 85/200 | 21/200 | 1/200 | 0/200 |
| ... >= 4.0 | 5.0% | 68/200 | 12/200 | 0/200 | 0/200 |
| ... >= 5.0 | 3.0% | 43/200 | 5/200 | 0/200 | 0/200 |

## A real second person (are they still caught?)

This table measures whether the detector reports the second person at all, so it ignores the separate size rule (a second face
smaller than 15% of the main face's area never counts; the 0.35-wide row has 12% of the area and would be ignored by that rule).

| Second person's size (width / area vs the main face) | Counting rule | Seen per frame | Attempt rejected: >= 1 frame | >= 3 frames (deployed) |
|---|---|--:|--:|--:|
| 0.35 / 0.12 | raw boxes (the rule that shipped) | 97.8% | 67/67 | 67/67 |
| 0.35 / 0.12 | + second face needs confidence >= 3.0 (deployed) | 97.4% | 67/67 | 67/67 |
| 0.35 / 0.12 | ... >= 5.0 | 90.3% | 66/67 | 66/67 |
| 0.55 / 0.3 | raw boxes (the rule that shipped) | 99.3% | 67/67 | 67/67 |
| 0.55 / 0.3 | + second face needs confidence >= 3.0 (deployed) | 97.4% | 67/67 | 67/67 |
| 0.55 / 0.3 | ... >= 5.0 | 89.2% | 65/67 | 60/67 |
| 0.9 / 0.81 | raw boxes (the rule that shipped) | 97.6% | 67/67 | 67/67 |
| 0.9 / 0.81 | + second face needs confidence >= 3.0 (deployed) | 96.8% | 66/67 | 65/67 |
| 0.9 / 0.81 | ... >= 5.0 | 90.3% | 64/67 | 63/67 |

Reading the two tables together: the old rule rejected about two thirds of genuine single-face attempts in this setting; the
deployed rule rejects about 1% while still rejecting a real second person in 97% to 100% of attempts here. **The cost is real:**
about 0 to 3 in 100 attempts with a real second person in view are not caught by this check in this setting (the per-frame
confidence floor drops some real faces), and nothing here says how a phone behaves with a person partly visible, in profile or
far away. A stricter floor catches fewer real second people (5.0 catches about 90%), a laxer one rejects more genuine users.
