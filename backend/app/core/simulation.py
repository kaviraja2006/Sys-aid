RULES = {
    "API Gateway": {"limit": 2000},
    "Database": {"limit": 2500},
    "Cache": {"boost": 0.4}
}

def run_simulation(nodes, load):
    results = []
    bottlenecks = []

    for node in nodes:
        name = node.get("type", "")
        rule = RULES.get(name, {"limit": 1000})

        limit = rule.get("limit", 1000)
        boost = rule.get("boost", 0)

        effective_load = load * (1 - boost)

        overloaded = effective_load > limit

        results.append({
            "node": name,
            "load": effective_load,
            "limit": limit,
            "overloaded": overloaded
        })

        if overloaded:
            bottlenecks.append(name)

    return {
        "results": results,
        "bottlenecks": bottlenecks,
        "latency": len(bottlenecks) * 120
    }
