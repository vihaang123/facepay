from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api import auth, face_auth, faces, health, merchant_payments, payments, profile
from app.core.config import get_settings
from app.core.errors import register_exception_handlers

settings = get_settings()

app = FastAPI(
    title="FacePay API",
    description="PCA-LDA facial authentication for simulated payments. Academic prototype.",
    version="0.5.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origin_list,
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE"],
    allow_headers=["Authorization", "Content-Type"],
)

register_exception_handlers(app)

app.include_router(health.router)
app.include_router(auth.router)
app.include_router(profile.router)
app.include_router(faces.router)
app.include_router(face_auth.router)
app.include_router(payments.router)
app.include_router(merchant_payments.router)
