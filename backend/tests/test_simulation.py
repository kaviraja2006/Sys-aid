from app.core.simulation import run_simulation


def test_run_simulation_no_bottlenecks_under_limit():
    nodes = [{"id": "n1", "type": "server", "label": "S1"}]
    result = run_simulation(nodes, load=100)
    assert result["overloaded"] is False
    assert result["bottlenecks"] == []
    assert result["system_latency_estimate_ms"] == 0


def test_run_simulation_flags_overloaded_node():
    nodes = [{"id": "n1", "type": "server", "label": "S1"}]  # server limit = 2000
    result = run_simulation(nodes, load=5000)
    assert result["overloaded"] is True
    assert len(result["bottlenecks"]) == 1
    assert result["bottlenecks"][0]["node_id"] == "n1"
    assert result["system_latency_estimate_ms"] == 120


def test_run_simulation_cache_boost_reduces_effective_load():
    nodes = [{"id": "n1", "type": "cache", "label": "C1"}]  # cache limit=3000, boost=0.4
    result = run_simulation(nodes, load=4000)
    # effective_load = 4000 * (1 - 0.4) = 2400, under the 3000 limit
    assert result["results"][0]["load"] == 2400
    assert result["overloaded"] is False


def test_run_simulation_unknown_type_uses_default_rule():
    nodes = [{"id": "n1", "type": "unknown-type", "label": "X"}]
    result = run_simulation(nodes, load=1500)
    assert result["results"][0]["limit"] == 1000
    assert result["overloaded"] is True


def test_run_simulation_multiple_nodes_counts_all_bottlenecks():
    nodes = [
        {"id": "n1", "type": "server", "label": "S1"},   # limit 2000
        {"id": "n2", "type": "database", "label": "D1"},  # limit 2500
    ]
    result = run_simulation(nodes, load=10000)
    assert len(result["bottlenecks"]) == 2
    assert result["system_latency_estimate_ms"] == 240
