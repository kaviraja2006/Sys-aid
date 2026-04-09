from pydantic import BaseModel
from typing import List, Dict, Optional, Any

class GenerateRequest(BaseModel):
    prompt: str
    current_design: Optional[Dict[str, Any]] = None
    chat_history: Optional[List[Dict[str, Any]]] = None
    
    # Dynamic LLM Router Settings
    provider: Optional[str] = "ollama"
    api_key: Optional[str] = ""
    model_name: Optional[str] = "llama3"
    api_url: Optional[str] = ""

class Node(BaseModel):
    id: str
    type: str # e.g., API Gateway, Database, Cache, Service
    label: str
    limit: Optional[int] = None
    cache_boost: Optional[float] = 0.0

class Edge(BaseModel):
    id: str
    source: str
    target: str

class DesignGraph(BaseModel):
    nodes: List[Node]
    edges: List[Edge]
    meta: Optional[Dict[str, Any]] = None

class SimulationInput(BaseModel):
    design: DesignGraph
    users_per_sec: int

class Bottleneck(BaseModel):
    node_id: str
    label: str
    effective_load: float
    limit: int
    overloaded: bool

class SimulationOutput(BaseModel):
    bottlenecks: List[Bottleneck]
    system_latency_estimate_ms: int
    overloaded: bool

class ImproveRequest(BaseModel):
    design: DesignGraph
    simulation_output: SimulationOutput

class ChatSession(BaseModel):
    id: str
    title: str
    updated_at: str
    messages: List[Dict[str, Any]]
    nodes: List[Dict[str, Any]]
    edges: List[Dict[str, Any]]
