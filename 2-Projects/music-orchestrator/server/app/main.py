"""FastAPI 入口"""

import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.config import config
from app.routes import admin, stream, tools

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    # 启动时按配置初始化 Source（惰性也可，这里显式触发一次）
    from app.sources import get_enabled_sources

    srcs = get_enabled_sources()
    logger.info(f"Enabled sources: {[s.name for s in srcs]}")
    yield
    logger.info("Shutting down music-orchestrator")


app = FastAPI(title="music-orchestrator", version="0.1.0", lifespan=lifespan)

# 个人自用服务，宽松 CORS 可接受
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(tools.router)
app.include_router(stream.router)
app.include_router(admin.router)


@app.get("/health")
async def health():
    return {"status": "ok"}
