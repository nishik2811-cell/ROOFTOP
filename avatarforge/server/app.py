"""AvatarForge copilot server. Run: uvicorn app:app --port 8000 (from this folder)."""
from pathlib import Path

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

import copilot
import guard
from spec import DEFAULTS

app = FastAPI(title="AvatarForge copilot")


class CopilotRequest(BaseModel):
    message: str = Field(min_length=1, max_length=500)
    avatar: dict = Field(default_factory=dict)


class CopilotResponse(BaseModel):
    blocked: bool = False
    reason: str | None = None
    patch: dict = Field(default_factory=dict)
    reply: str = ""
    mode: str = ""


@app.get("/api/health")
def health():
    return {"ok": True, "model": copilot.NIM_MODEL, "nimKey": bool(copilot.os.environ.get("NVIDIA_API_KEY")), "guardrails": guard.mode()}


@app.post("/api/copilot", response_model=CopilotResponse)
async def ask(req: CopilotRequest):
    reason = await guard.check(req.message)
    if reason:
        return CopilotResponse(blocked=True, reason=reason, reply=reason, mode="guardrails")
    # Only known keys of the avatar go to the model.
    avatar = {k: v for k, v in req.avatar.items() if k in DEFAULTS}
    patch, reply, mode = await copilot.run(req.message, avatar)
    return CopilotResponse(patch=patch, reply=reply, mode=mode)


# One-process demo: after `npm run build` in ../web, this server also serves the editor.
dist = Path(__file__).resolve().parent.parent / "web" / "dist"
if dist.exists():
    app.mount("/", StaticFiles(directory=dist, html=True), name="web")
