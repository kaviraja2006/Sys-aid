from app.core.simulation import run_simulation
from app.models.schema import SimulationInput

def simulate_system(req: SimulationInput):
    nodes = [node.dict() for node in req.design.nodes]
    return run_simulation(nodes, req.users_per_sec)
