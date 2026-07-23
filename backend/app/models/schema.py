from pydantic import BaseModel, Field
from typing import List, Dict, Optional, Any

class GenerateRequest(BaseModel):
    prompt: str = Field(..., max_length=4000)
    current_design: Optional[Dict[str, Any]] = None
    chat_history: Optional[List[Dict[str, Any]]] = None
    documentation: Optional[str] = Field(default=None, max_length=20000)
    
    # Dynamic LLM Router Settings
    provider: Optional[str] = ""
    api_key: Optional[str] = ""
    model_name: Optional[str] = ""
    api_url: Optional[str] = ""

class Node(BaseModel):
    id: str
    type: str # database, server, client, cloud, cache, default
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

    # Dynamic LLM Router Settings
    provider: Optional[str] = ""
    api_key: Optional[str] = ""
    model_name: Optional[str] = ""
    api_url: Optional[str] = ""

class ChatSession(BaseModel):
    id: str
    title: str
    updated_at: str
    messages: List[Dict[str, Any]]
    nodes: List[Dict[str, Any]]
    edges: List[Dict[str, Any]]
