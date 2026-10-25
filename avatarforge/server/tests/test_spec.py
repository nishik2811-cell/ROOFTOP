from spec import DEFAULTS, PHYSIQUES, sanitize_patch, schema_for_prompt


def test_sanitize_clamps_and_drops():
    assert sanitize_patch(
        {
            "face.jawSharpness": 1.7,
            "face.eyeSize": -2,
            "face.madeUp": 0.3,
            "hair.style": "mohawk",
            "hair.color": "red",
            "colors.primary": "#AABBCC",
            "body.height": True,
            "vibe": ["Cyberpunk", "cyberpunk", 3, " cute "],
        }
    ) == {"face.jawSharpness": 1.0, "face.eyeSize": 0.0, "colors.primary": "#aabbcc", "vibe": ["cyberpunk", "cute"]}


def test_sanitize_rejects_non_dict():
    assert sanitize_patch(["face.eyeSize", 1]) == {}
    assert sanitize_patch(None) == {}


def test_schema_lists_every_key():
    text = schema_for_prompt()
    for key in DEFAULTS:
        assert key in text


def test_physiques_use_body_keys():
    for preset in PHYSIQUES.values():
        assert all(k.startswith("body.") and k in DEFAULTS for k in preset)
