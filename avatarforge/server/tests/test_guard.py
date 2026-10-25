import pytest

import guard

MUST_BLOCK = [
    "make me Naruto",
    "I want to look like Spider-Man",
    "give me Goku's hair",
    "a Disney princess",
    "make me look like Taylor Swift",
    "make my avatar look like my ex",
    "copy a famous actor",
]
MUST_ALLOW = [
    "anime theme with spiky orange hair",
    "sharper jaw and bigger eyes",
    "cyberpunk vibe, muscular",
    "make me look like a knight",
    "a pirate outfit in red",
    "thorough changes to the nose",  # contains "thor" inside a word
    "retro shooter style",
]


@pytest.mark.parametrize("msg", MUST_BLOCK)
def test_blocks(msg):
    assert guard.builtin_check(msg)


@pytest.mark.parametrize("msg", MUST_ALLOW)
def test_allows(msg):
    assert guard.builtin_check(msg) is None


async def test_check_without_nemo(monkeypatch):
    monkeypatch.setenv("GUARDRAILS", "builtin")
    monkeypatch.setattr(guard, "_rails", None)
    monkeypatch.setattr(guard, "_rails_failed", False)
    assert await guard.check("make me Naruto")
    assert await guard.check("spiky hair") is None
    assert guard.mode() == "built-in"
