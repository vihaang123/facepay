import base64
import binascii

from pydantic import BaseModel, ConfigDict, Field, field_validator


class LookupRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    # A few still frames from the rear camera, taken a moment apart. No liveness is involved: finding someone pays nothing.
    frames: list[str] = Field(min_length=2, max_length=5)

    @field_validator("frames")
    @classmethod
    def _frames_are_base64(cls, frames: list[str]) -> list[str]:
        for f in frames:
            if not 16 <= len(f) <= 1_000_000:
                raise ValueError("Each frame must be between 16 and 1,000,000 base64 characters")
            s = f.partition(",")[2] if f.startswith("data:") else f
            try:
                base64.b64decode(s, validate=True)
            except (binascii.Error, ValueError):
                raise ValueError("Frames must be valid base64") from None
        return frames


class FoundPerson(BaseModel):
    display_name: str
    masked_id: str  # the FacePay ID with the middle hidden


class LookupOut(BaseModel):
    matched: bool
    reason: str  # MATCH | NO_MATCH | SELF | CAMERA_* (the view was not usable)
    message: str | None
    lookup_token: str | None
    expires_in_seconds: int | None
    person: FoundPerson | None


class LookupToggle(BaseModel):
    model_config = ConfigDict(extra="forbid")

    enabled: bool
