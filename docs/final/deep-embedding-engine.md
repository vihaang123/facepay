# Deep face embeddings: the second recognition engine

Added after find-by-face (migration `0010`). FacePay can now recognise faces in two ways, chosen with one setting:

| `FACE_ENGINE` | What decides "who is this" | Needs training | People needed |
|---|---|---|---|
| `pca_lda` (default) | PCA, then LDA, then KNN, trained on everyone enrolled (the original pipeline) | Yes, again whenever someone joins | At least 2 |
| `embedding` | A pretrained deep network (dlib ResNet) turns a face into 128 numbers; a person is compared by distance to their own reference | No | 1 |

The default is unchanged, so deploying this code alone changes nothing. PCA-LDA stays in the project as the baseline the
embedding engine is compared with.

## Why it is better

* **No retraining.** A new customer is ready the moment their setup is complete: their reference is the mean of their own
  enrolment embeddings. With PCA-LDA the whole model is retrained and re-validated for every new person, and LDA can only
  produce (people - 1) directions, so it does not scale.
* **It rejects strangers.** PCA-LDA is closed-set: it always names the closest enrolled person. A distance to a person's own
  reference, with a strict threshold, lets "none of the above" be an answer.
* **Much more accurate on the same photos** (see below), and it scales by comparing vectors, not by refitting.

## Measured, same photos, same splits (20 random splits; 30 enrolled (6 reference photos), 10 held-out strangers)

| | Identification accuracy | Equal error rate | Strangers accepted when 90% of genuine pass |
|---|---|---|---|
| PCA-LDA-KNN | 88.7% | 20.4% | 61.1% |
| Deep embeddings | 100.0% | 0.0% | 0.0% |

Reproduce: `backend/.venv/bin/python ml/experiments/embedding_benchmark.py --orl orl.npz --out ml/results/embedding_calibration.json`.
Full numbers and the threshold sweep are in `ml/results/embedding_calibration.json`.

**Read these numbers carefully.** ORL is a small, easy, studio-style set of grayscale faces. It is good for comparing two
methods on equal terms and for choosing cautious thresholds. It says nothing certain about phone cameras, colour, varied light,
glasses, beards, ageing, or twins. The PCA-LDA stranger figure uses a simplified distance rule, not the production decision
policy; the comparison is fair as a method comparison, not as a production false-accept rate.

## How it is wired in

* `app/ml/embedding.py`: the embedder (dlib HOG face finder, 5-point alignment, ResNet; the weights come from the
  `face_recognition_models` package, nothing is downloaded at run time) plus distance and the reference. Anything with an
  `embed()` method can replace it.
* **Enrolment** (`face_service.add_sample`): the existing quality gates still run. In embedding mode the sample also stores its
  embedding, AES-GCM encrypted (`face_samples.embedding_encrypted`, migration `0010`). When setup is complete the customer's
  reference (the mean embedding) is stored in their encrypted face profile. The app's setup flow is unchanged.
* **Payments** (`face_auth_service.authenticate`): the same challenge, liveness and decision policy as before. Only the identity
  evidence changes: each baseline frame's distance to the customer's own reference. The mean must be within **0.42**, no frame
  beyond 1.25 times that. The closeness score shown is `1 - distance / (2 x threshold)`; it is not a probability.
* **Find by face** (`face_lookup_service`): the nearest enrolled customer wins only if every frame agrees, the mean distance is
  within **0.40**, and the runner-up is at least **0.05** further away. The search covers every enrolled customer, opted in or
  not, so a face that belongs to someone who has not opted in can never be reported as someone else. Eligibility is checked
  after, with the same generic "no match".
* An authorization records the engine version (`dlib-resnet-v1`). If the engine is switched between the face check and
  confirmation, the authorization is refused.

## Thresholds and why they are strict

The library's usual cut-off (0.6) was tuned on large colour photo sets. On these small grayscale faces it accepted about 70% of
strangers. At 0.42 a genuine photo passed 99.5% of the time and no stranger or
other enrolled person passed in any run. **The constants are provisional** (`EMBED_*` in `app/ml/config.py`) and must be
re-measured on real phone captures first.

## Switching on

1. Deploy this version (the default engine keeps working). Render runs `alembic upgrade head`, which adds the nullable column.
2. Set `FACE_ENGINE=embedding` in Render and restart. The image installs `dlib-bin` and `face_recognition_models`.
3. **Every customer repeats face setup once.** Samples taken before the switch have no embedding and are not counted, so the app
   shows setup as unfinished until they recapture. Switching back to `pca_lda` is safe: the old samples are still there, though a
   customer who set up under embeddings has no PCA-LDA profile and must run the training step once (the setup screen offers it).
4. Watch memory on a small instance: the network adds roughly 100-150 MB while loaded.

## Known limits

* Accuracy on real phones is unmeasured. Thresholds are provisional.
* Two accounts with the same face confuse find-by-face by design (no clear winner means "no match"); the second account should not exist.
* Liveness is still the basic head-turn check. A video replay or a deepfake is the main open risk for real money; stronger
  presentation-attack detection is the next step.
* 1:N search compares against every reference in the database on each scan. That is fine for hundreds of customers; a vector index
  (for example pgvector) is the next step for more, together with narrowing the search to nearby opted-in customers.
* The admin ML page still describes the PCA-LDA model only.
