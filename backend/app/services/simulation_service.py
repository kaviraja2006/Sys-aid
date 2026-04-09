from app.core.simulation import run_simulation

def simulate_system(data):
    nodes = data.get("nodes", [])
    load = data.get("load", 1000)

    return run_simulation(nodes, load)
