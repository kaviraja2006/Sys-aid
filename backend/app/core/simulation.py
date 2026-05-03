RULES = {
    "server": {"limit": 2000},
    "database": {"limit": 2500},
    "client": {"limit": 5000},
    "cloud": {"limit": 4000},
    "cache": {"limit": 3000, "boost": 0.4},
    "default": {"limit": 1000}
}

def run_simulation(nodes, load):
    results = []
    bottlenecks = []

    for node in nodes:
        name = node.get("type", "default")
        label = node.get("label", name)
        rule = RULES.get(name, {"limit": 1000})

        limit = rule.get("limit", 1000)
        boost = rule.get("boost", 0)

        effective_load = load * (1 - boost)

        overloaded = effective_load > limit

        results.append({
            "node": label,
            "type": name,
            "load": effective_load,
            "limit": limit,
            "overloaded": overloaded
        })

        if overloaded:
            bottlenecks.append({
                "node_id": node.get("id"),
                "label": label,
                "effective_load": round(effective_load, 2),
                "limit": limit,
                "overloaded": True
            })

    return {
        "results": results,
        "bottlenecks": bottlenecks,
        "system_latency_estimate_ms": len(bottlenecks) * 120,
        "overloaded": len(bottlenecks) > 0
    }
