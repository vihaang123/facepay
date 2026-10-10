"""Server log for the face pipeline.

Python drops INFO records of a logger nobody configured, so without this the diagnostic lines (`liveness ...`, `identity ...`,
`face model not ready ...`) never reached the host's log and a failed face check could not be explained afterwards. They carry
codes, counts and scores only: never images, crops, feature vectors, tokens or keys.
"""

import logging


def configure_logging() -> None:
    logger = logging.getLogger("facepay")
    if any(getattr(h, "_facepay", False) for h in logger.handlers):
        return  # already configured (the module can be imported twice under a reloader)
    handler = logging.StreamHandler()
    handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(name)s: %(message)s"))
    handler._facepay = True  # type: ignore[attr-defined]
    logger.addHandler(handler)
    logger.setLevel(logging.INFO)
