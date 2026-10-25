from offline import parse
from spec import DEFAULTS


def test_demo_sentence():
    patch, reply = parse("make the jawline sharper, give me spiky red hair and a muscular build")
    assert patch["face.jawSharpness"] > 0.5
    assert patch["hair.style"] == "spiky"
    assert patch["hair.color"] == "#c0392b"
    assert patch["physique"] == "muscular"
    assert reply.startswith("Done")


def test_relative_to_current():
    avatar = {**DEFAULTS, "face.eyeSize": 0.7}
    patch, _ = parse("a bit bigger eyes", avatar)
    assert patch["face.eyeSize"] == 0.82
    patch, _ = parse("very small eyes", avatar)
    assert patch["face.eyeSize"] < 0.4


def test_colours_go_to_the_right_place():
    patch, _ = parse("green eyes, blue jacket, black pants, tan skin")
    assert patch["colors.eyes"] == "#27ae60"
    assert patch["colors.primary"] == "#2e6fd8"
    assert patch["colors.secondary"] == "#151515"
    assert patch["colors.skin"] == "#b07b52"


def test_vibes_and_height():
    patch, _ = parse("cyberpunk style, taller")
    assert patch["vibe"] == ["cyberpunk"]
    assert patch["body.height"] > 0.5


def test_short_hair_is_not_short_height():
    patch, _ = parse("short hair")
    assert patch == {"hair.style": "short"}


def test_nothing_understood():
    patch, reply = parse("hello there")
    assert patch == {}
    assert "Offline" in reply


def test_hair_style_with_colour_between():
    patch, _ = parse("long pink hair")
    assert patch["hair.style"] == "long"
    assert patch["hair.color"] == "#ff6fae"
    assert parse("short black hair")[0]["hair.style"] == "short"
