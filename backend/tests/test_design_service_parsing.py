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


def test_safe_parse_strips_thinking_tags():
    raw = '<think>\nBrainstorming with {"nodes": []} and details.\n</think>\n```json\n{"nodes": [{"id": "n1"}], "edges": []}\n```'
    parsed = _safe_parse(raw)
    assert len(parsed["nodes"]) == 1
    assert parsed["nodes"][0]["id"] == "n1"


def test_safe_parse_unwraps_root_key():
    raw = '{"architecture": {"nodes": [{"id": "api"}], "edges": []}}'
    parsed = _safe_parse(raw)
    assert "nodes" in parsed
    assert len(parsed["nodes"]) == 1


def test_clean_graph_normalizes_flat_nodes():
    from app.services.design_service import _clean_graph
    raw = {
        "nodes": [
            {"id": "api", "label": "API Gateway", "type": "server"},
            {"id": "db", "name": "Postgres", "type": "database"}
        ],
        "edges": [
            {"from": "api", "to": "db", "label": "SQL"}
        ]
    }
    cleaned = _clean_graph(raw)
    assert len(cleaned["nodes"]) == 2
    assert cleaned["nodes"][0]["data"]["label"] == "API Gateway"
    assert cleaned["nodes"][1]["data"]["label"] == "Postgres"
    assert len(cleaned["edges"]) == 1
    assert cleaned["edges"][0]["source"] == "api"
    assert cleaned["edges"][0]["target"] == "db"

