"""Turns a player's message into a patch of their avatar, using Nemotron on NVIDIA NIM."""
import json
import os
import re

import httpx

import offline
from spec import schema_for_prompt, sanitize_patch

NIM_BASE_URL = os.environ.get("NIM_BASE_URL", "https://integrate.api.nvidia.com/v1")
# Any chat model on build.nvidia.com works; check the catalogue for the current Nemotron ids.
NIM_MODEL = os.environ.get("NIM_MODEL", "nvidia/llama-3.3-nemotron-super-49b-v1.5")

SYSTEM = """/no_think
You are the AvatarForge copilot inside a game's character creator.
Turn the player's request into changes to their avatar.

Reply with ONLY a JSON object, no other text:
{{"patch": {{"<key>": <value>, ...}}, "reply": "<one short, friendly sentence saying what you changed>"}}

Keys you may set (flat keys, exactly as written):
{schema}

Rules:
- Include only keys that change.
- Relative requests change the current value: about 0.2 for a normal request, 0.1 for "a bit", 0.35 for "very".
- "sharp jaw" means face.jawSharpness goes up. Physique words (slim, athletic, muscular, stocky, curvy) set "physique".
- Colour words become hex colours. Style or theme words (cyberpunk, fantasy, cute, royal...) are added to "vibe", keeping existing tags.
- If the request asks for nothing you can change, return an empty patch and say what you can do.
"""


def _extract_json(text):
    text = re.sub(r"<think>.*?</think>", "", text, flags=re.S)
    start, end = text.find("{"), text.rfind("}")
    if start < 0 or end <= start:
        raise ValueError("no JSON object in model reply")
    return json.loads(text[start : end + 1])


async def ask_nim(message, avatar, client=None):
    """Returns (patch, reply). Raises on network or format errors."""
    key = os.environ.get("NVIDIA_API_KEY")
    if not key:
        raise RuntimeError("NVIDIA_API_KEY is not set")
    body = {
        "model": NIM_MODEL,
        "temperature": 0.2,
        "max_tokens": 600,
        "messages": [
            {"role": "system", "content": SYSTEM.format(schema=schema_for_prompt())},
            {"role": "user", "content": f"Current avatar: {json.dumps(avatar)}\n\nPlayer: {message}"},
        ],
    }
    own = client is None
    client = client or httpx.AsyncClient(timeout=25)
    try:
        r = await client.post(f"{NIM_BASE_URL}/chat/completions", json=body, headers={"Authorization": f"Bearer {key}"})
        r.raise_for_status()
        content = r.json()["choices"][0]["message"]["content"] or ""
    finally:
        if own:
            await client.aclose()
    data = _extract_json(content)
    reply = data.get("reply") if isinstance(data.get("reply"), str) else "Updated your avatar."
    return sanitize_patch(data.get("patch")), reply.strip()[:300]


async def run(message, avatar):
    """Returns (patch, reply, mode). Falls back to the offline parser if NIM fails."""
    try:
        patch, reply = await ask_nim(message, avatar)
        return patch, reply, f"nim:{NIM_MODEL}"
    except Exception as e:
        patch, reply = offline.parse(message, avatar)
        why = "no API key" if "NVIDIA_API_KEY" in str(e) else "NIM unreachable"
        return sanitize_patch(patch), reply, f"offline ({why})"
