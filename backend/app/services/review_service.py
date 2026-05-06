"""
Architecture Review Service — using LLM to score and suggest improvements.
"""
import json
from app.core.llm import call_llm
from typing import Optional, Dict, Any, List

_SYSTEM = """You are a senior software architect expert at technical review. 
You will be given an architecture design and must provide a structured JSON score report.
Score on 1-10 scale (1=poor, 5=average, 10=excellent) for each dimension.
Provide 3 specific, actionable improvement suggestions.
Always respond with ONLY valid JSON - no markdown, no explanation, no code fences.
First character must be "{"."""

async def review_architecture(
    nodes: List[Dict[str, Any]],
    edges: List[Dict[str, Any]],
    provider: str = "ollama",
    api_key: str = "",
    model_name: str = "",
    api_url: str = "",
):
    """
    Review an architecture and return scores + suggestions.
    
    Returns:
    {
      "scores": {
        "scalability": int (1-10),
        "security": int (1-10),
        "reliability": int (1-10),
        "cost_efficiency": int (1-10),
        "complexity": int (1-10)
      },
      "suggestions": [str, str, str],
      "overall_feedback": str
    }
    """
    
    # Summarize design (compress for token count)
    design_summary = {
        "nodes": [
            {
                "id": n.get("id"),
                "label": n.get("data", {}).get("label"),
                "type": n.get("data", {}).get("systemType", "default")
            }
            for n in nodes
        ],
        "edges": [
            {
                "source": e.get("source"),
                "target": e.get("target"),
                "label": e.get("label", "")
            }
            for e in edges
        ]
    }
    
    prompt = f"""Review this software architecture design:

{json.dumps(design_summary, indent=2)}

Provide scores (1-10 each) for:
- Scalability: Can handle growth?
- Security: How well protected?
- Reliability: Fault tolerance?
- Cost efficiency: Resource optimization?
- Complexity: Maintainability?

Also provide 3 specific improvement suggestions.

Return only this JSON structure (no other text):
{{
  "scores": {{
    "scalability": <1-10>,
    "security": <1-10>,
    "reliability": <1-10>,
    "cost_efficiency": <1-10>,
    "complexity": <1-10>
  }},
  "suggestions": ["suggestion 1", "suggestion 2", "suggestion 3"],
  "overall_feedback": "brief overall assessment"
}}"""

    response_text = await call_llm(
        prompt=prompt,
        system_prompt=_SYSTEM,
        provider=provider,
        api_key=api_key,
        model_name=model_name,
        api_url=api_url,
        max_tokens=800,
    )
    
    # Parse the JSON response
    try:
        # Try to extract JSON from response (in case there's any extra text)
        start = response_text.find('{')
        end = response_text.rfind('}') + 1
        if start >= 0 and end > start:
            json_str = response_text[start:end]
        else:
            json_str = response_text
        
        result = json.loads(json_str)
        return result
    except json.JSONDecodeError as e:
        # Fallback if parsing fails
        return {
            "scores": {
                "scalability": 5,
                "security": 5,
                "reliability": 5,
                "cost_efficiency": 5,
                "complexity": 5
            },
            "suggestions": [
                "Review error - unable to parse response",
                "Please try again or check logs",
                "Architecture appears valid"
            ],
            "overall_feedback": f"Review failed: {str(e)}"
        }
