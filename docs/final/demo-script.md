# Demo script (about 8 minutes)

A walkthrough for a viva or demo. Everything shown is a **prototype with simulated payments**; say so at the start.
Run it on a laptop with a webcam if you can, and say which it was. Without one, use the simulated-camera run in
`docs/browser-testing/` and describe it as simulated.

**Before you start:** backend and frontend running, at least **two** customers already enrolled (the shared model needs two),
a model trained, and one merchant account. Have `docs/final/screenshots/13-ml-evaluation.png` ready as a backup slide.

| Time | What to say | Screen | Action | Concept shown |
|---|---|---|---|---|
| 0:00 | "FacePay is an academic prototype. A customer pays a merchant's bill by showing their face. The money is simulated, and the interesting part is how the face is recognised." | Landing page | Point at the prototype notice and API status | Scope and honesty about limits |
| 0:30 | "Customers and merchants are separate roles with their own sign-in." | Register customer | Register a new customer | Argon2id hashing, JWT, role separation |
| 1:00 | "To use the face, the person first sets it up. FacePay guides five head positions and captures each one by itself once the picture is good, because one pose is not enough for LDA." | Face setup | Press Start face setup; follow the prompts; show the plain feedback ("Move a little closer", "Hold still") and the progress | Auto-capture, quality gates (blur, brightness, one face), encrypted 64x64 crops; the server still decides |
| 2:00 | "Training builds one shared model: PCA, then LDA, then a classifier. It only works with at least two enrolled people." | Face setup | Show "Face setup complete" and the model status | PCA to LDA to classifier; why two users minimum |
| 2:30 | "Recognise me checks one new frame against the model." | Face setup | Press Recognise me | Identity match plus distance to your own profile |
| 3:00 | "Now the merchant creates a bill." | Merchant dashboard, Create payment | Register or sign in as a merchant, create a payment of 950.00, copy the link | Payment session; the amount lives on the server |
| 3:45 | "The customer opens the link. The amount, merchant and order are shown before anything happens." | Checkout | Sign in as the customer, open the link | Server-side amount, session binding |
| 4:15 | "Start face authentication. First a short look at the camera, then one random instruction." | Checkout, camera | Start; follow "turn your head to your left/right" | Challenge-response liveness (face-box movement), single-use 60 s challenge |
| 5:00 | "Stages pass one by one: camera, face detected, quality, identity, basic liveness, authorization. Customers see plain stage feedback and categorised errors, never scores. The numbers are in the admin ML Lab." | Result panel | Point at the stage list | Decision policy: one face, liveness passed, predicted identity equals the signed-in user, confidence and distance within limits (server side only) |
| 5:30 | "That produced a one-time ticket, valid for two minutes, tied to this customer, this merchant, this amount and this order. Now the customer reviews and confirms it. A large payment would also ask for a PIN." | Confirm payment | Review merchant and amount, press Confirm | Hashed single-use authorization, row-locked atomic confirmation |
| 6:00 | "Receipt, and the same payment shows on both sides." | Receipt, customer transactions, merchant dashboard | Open the receipt; switch to the merchant, show the paid session, revenue and transactions | History, filters, revenue summary |
| 6:45 | "What if it is the wrong person?" | Checkout (new bill) | Try with someone else's face, or a still photo; show the rejection and the remaining attempts | Identity mismatch, liveness failure, 5-failure session lockout |
| 7:15 | "Here is how well the recognition works, measured on the public ORL face set, not on webcams." | `13-ml-evaluation.png` or `evaluation-results.md` | Show the accuracy bars and the open-set curve | 5-fold CV: PCA+KNN 0.858, PCA+LDA+KNN 0.895, PCA+LDA+SVM 0.892 accuracy; LDA improves over PCA alone; threshold trade-off |
| 7:45 | "And what it cannot do." | Limitations slide | Read the three bullets below | Honest limitations |

## Machine-learning talking points (if asked)

* **PCA.** 64x64 images are 4,096 numbers; with only tens of photos per person the within-class scatter matrix is singular,
  so LDA cannot be computed directly. PCA first reduces to 148 dimensions on ORL (95% of the variance) and makes the
  scatter matrix invertible.
* **LDA.** Finds at most C minus 1 directions (39 for 40 people) that push different people apart relative to how much each
  person varies. Compared with PCA alone it raised accuracy from 0.858 to 0.895 in the same cross-validation.
* **Classifier.** KNN or a linear SVM on the LDA output; both are about the same (0.895 vs 0.892). KNN is the default tie-break.
* **Decision.** A match needs the predicted identity to be the signed-in user, enough classifier confidence, and the sample's
  distance to that user's profile centre under a stored threshold. The threshold is a trade-off knob, not a security level.
* **No pretrained embeddings.** The Haar detector only finds where the face is. Recognition is PCA, LDA and the classifier.

## Limitations to state plainly

* Accuracy numbers come from the ORL photo set (40 people, controlled conditions), not from webcams or real payment users.
* Impostor acceptance is too high for a real payment system: a stranger the model confuses with the claimed user was
  accepted about 45% of the time at the deployed threshold in the worst-case scenario we tested.
* Liveness is a basic head-movement challenge. It stops a static photo but a photo slid sideways, or a video, can pass.

## If something goes wrong live

| Problem | Say / do |
|---|---|
| Camera will not start | Check HTTPS or localhost and permission; fall back to the screenshots in `docs/final/screenshots/` |
| "Not enough users" on training | Enrol a second customer first (shared model) |
| Identity fails for the right person | That is the model's genuine-rejection rate (about 20% in the ORL test); retry in similar light, and say so |
| 429 | The rate limit working; wait a minute |

## Optional extension (about 4 minutes): UPI-style flows and the ML Lab

Say again that the money, the FacePay ID and the QR are simulated; none of it is UPI or a bank transfer.

1. **Home** (customer): FacePay ID with Copy and Share, simulated balance, Send / Request / Scan QR / My QR. Point out that
   no model numbers appear here.
2. **Send:** enter a second customer's FacePay ID -> name and masked ID only -> amount and note -> review -> face
   check -> review again -> confirm -> receipt. Show both balances changed by exactly the amount.
3. **Request:** the second customer asks for money; nothing is debited; the first customer declines one and pays one.
4. **QR:** My QR, then Scan QR from a second device (or the simulated camera) -> Send opens with the person chosen.
5. **Activity:** filters (Sent, Received, Successful, Pending), search, a detail page.
6. **Admin ML Lab** (sign in as the CLI-created admin): PCA variance, LDA separation, classifier comparison, confusion
   matrices, genuine-rejection and impostor-acceptance rates. Say which numbers are the offline ORL benchmark and which
   are live outcome counts.
