import httpx
import pytest
from fastapi.testclient import TestClient

import app as app_module
import copilot


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setenv("GUARDRAILS", "builtin")
    return TestClient(app_module.app)


def test_blocked_request(client):
    r = client.post("/api/copilot", json={"message": "make me Naruto", "avatar": {}})
    body = r.json()
    assert r.status_code == 200
    assert body["blocked"] is True
    assert body["patch"] == {}


def test_offline_without_key(client, monkeypatch):
    monkeypatch.delenv("NVIDIA_API_KEY", raising=False)
    body = client.post("/api/copilot", json={"message": "spiky hair", "avatar": {}}).json()
    assert body["patch"] == {"hair.style": "spiky"}
    assert body["mode"].startswith("offline")


def test_rejects_empty_message(client):
    assert client.post("/api/copilot", json={"message": "", "avatar": {}}).status_code == 422


def _fake_nim(content):
    def handler(request: httpx.Request):
        assert request.headers["authorization"] == "Bearer test-key"
        return httpx.Response(200, json={"choices": [{"message": {"content": content}}]})

    return handler


async def test_nim_reply_is_validated(monkeypatch):
    monkeypatch.setenv("NVIDIA_API_KEY", "test-key")
    content = '<think>hmm</think>Sure! {"patch": {"face.jawSharpness": 1.4, "hair.style": "spiky", "evil": 1, "hair.color": "#FF0000"}, "reply": "Sharper jaw and spiky red hair."}'
    async with httpx.AsyncClient(transport=httpx.MockTransport(_fake_nim(content))) as c:
        patch, reply = await copilot.ask_nim("sharper jaw, spiky red hair", {}, client=c)
    assert patch == {"face.jawSharpness": 1.0, "hair.style": "spiky", "hair.color": "#ff0000"}
    assert reply == "Sharper jaw and spiky red hair."


async def test_unreadable_nim_reply_falls_back(monkeypatch):
    monkeypatch.setenv("NVIDIA_API_KEY", "test-key")

    async def broken(*a, **k):
        raise ValueError("no JSON object in model reply")

    monkeypatch.setattr(copilot, "ask_nim", broken)
    patch, reply, mode = await copilot.run("bigger eyes", {})
    assert patch["face.eyeSize"] > 0.5
    assert mode == "offline (NIM unreachable)"
