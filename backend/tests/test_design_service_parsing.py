import json
import pytest

from app.services.design_service import _safe_parse, _repair_json, _extract_json


def test_safe_parse_clean_json():
    raw = '{"nodes": [{"id": "1"}], "edges": []}'
    assert _safe_parse(raw) == {"nodes": [{"id": "1"}], "edges": []}


def test_safe_parse_strips_markdown_fence():
    raw = '```json\n{"nodes": [], "edges": []}\n```'
    assert _safe_parse(raw) == {"nodes": [], "edges": []}


def test_safe_parse_strips_leading_trailing_text():
    raw = 'Here is the design:\n{"nodes": [], "edges": []}\nHope that helps!'
    assert _safe_parse(raw) == {"nodes": [], "edges": []}


def test_safe_parse_fixes_single_quoted_keys_and_values():
    raw = "{'nodes': [{'id': 'n1', 'label': 'Server'}], 'edges': []}"
    assert _safe_parse(raw) == {"nodes": [{"id": "n1", "label": "Server"}], "edges": []}


def test_safe_parse_fixes_trailing_commas():
    raw = '{"nodes": [{"id": "1"},], "edges": [],}'
    assert _safe_parse(raw) == {"nodes": [{"id": "1"}], "edges": []}


def test_safe_parse_fixes_python_literals():
    raw = "{'nodes': [], 'edges': [], 'valid': True, 'note': None}"
    assert _safe_parse(raw) == {"nodes": [], "edges": [], "valid": True, "note": None}


def test_safe_parse_fixes_missing_commas_between_objects():
    raw = '{"nodes": [\n{"id": "1"}\n{"id": "2"}\n], "edges": []}'
    assert _safe_parse(raw) == {"nodes": [{"id": "1"}, {"id": "2"}], "edges": []}


def test_safe_parse_raises_on_unrecoverable_garbage():
    with pytest.raises(json.JSONDecodeError):
        _safe_parse("not json at all, just prose")


def test_repair_json_strips_comments():
    s = '{"a": 1, // comment\n"b": 2}'
    repaired = _repair_json(s)
    assert json.loads(repaired) == {"a": 1, "b": 2}


def test_extract_json_slices_from_first_brace_to_last():
    raw = 'prefix noise {"a": 1} suffix noise'
    assert _extract_json(raw) == '{"a": 1}'
