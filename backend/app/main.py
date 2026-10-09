from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app.api import admin, auth, face_auth, faces, health, merchant_payments, payments, profile, security, transfers
from app.core.config import get_settings
from app.core.errors import register_exception_handlers

settings = get_settings()

app = FastAPI(
    title="FacePay API",
    description="PCA-LDA facial authentication for simulated payments. Academic prototype.",
    version="0.7.0",
    # The interactive docs list every endpoint; keep them for development only.
    docs_url=None if settings.is_production else "/docs",
    redoc_url=None if settings.is_production else "/redoc",
    openapi_url=None if settings.is_production else "/openapi.json",
)


@app.middleware("http")
async def protective_defaults(request: Request, call_next):
    """Cap request size and mark every response as non-cacheable JSON for this origin.
    Responses can contain personal and payment data, so browsers and proxies must not keep them."""
    declared = request.headers.get("content-length")
    if declared and declared.isdigit() and int(declared) > settings.max_request_bytes:
        response = JSONResponse(status_code=413, content={"detail": "Request body is too large."})
    else:
        response = await call_next(request)
    response.headers["Cache-Control"] = "no-store"
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["Referrer-Policy"] = "no-referrer"
    response.headers["X-Frame-Options"] = "DENY"
    return response

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origin_list,
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE"],
    allow_headers=["Authorization", "Content-Type", "Idempotency-Key"],
)

register_exception_handlers(app)

app.include_router(health.router)
app.include_router(auth.router)
app.include_router(profile.router)
app.include_router(faces.router)
app.include_router(face_auth.router)
app.include_router(payments.router)
app.include_router(security.router)
app.include_router(merchant_payments.router)
app.include_router(transfers.router)
app.include_router(admin.router)
