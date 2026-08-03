"""
Generate-board service.
Produces a valid React Flow JSON graph from a user description.
"""
import json
import re
import asyncio
from app.core.llm import call_llm
from app.core.rag import search_knowledge_async
from typing import Optional, Dict, Any, List

# ── System prompt ─────────────────────────────────────────────────────────────
# Rules:
#  • Use double-quoted keys/values in the example — models mirror the style
#  • Be explicit: "valid JSON only", "no markdown", "no explanation"
#  • Keep it short — fewer input tokens = faster response
_SYSTEM = (
    'You are a system architecture expert designing production-grade architecture diagrams. '
    'Respond with ONLY a single valid JSON object — no markdown, no explanation, no code fences. '
    'The JSON must have exactly two keys: "nodes" and "edges". '
    'Each node: {"id":"string","type":"archNode","data":{"label":"string","description":"string","systemType":"string"}} '
    'systemType must be one of: database, server, client, cloud, cache, default. '
    'Each edge: {"id":"string","source":"nodeId","target":"nodeId","label":"string","type":"smoothstep","animated":true} '
    'Every node must be connected via at least one edge. '
    'Edge source and target must exactly match existing node ids. '
    'Rules for a clean, real architecture (violating these produces an unusable diagram): '
    '(1) Every node label and description must be specific to the system being designed — '
    'never use a generic placeholder like "Node", "Component", or "Item". '
    '(2) Never create a node that only represents a connection or relationship between two other '
    'nodes (a "join" or "link" node) — express relationships as edges only, not as extra nodes. '
    '(3) Between any two nodes, draw at most ONE edge. Do not add a reverse edge duplicating '
    'a relationship already expressed (e.g. if A -> B is drawn, do not also draw B -> A) — '
    'if the interaction is bidirectional, say so in the single edge label instead. '
    '(4) Keep the graph as small and precise as the request calls for — do not pad it with '
    'redundant or filler nodes just to look more complete. '
    '(5) Do not draw redundant parallel paths to the same destination: if a component such as a '
    'Load Balancer already fronts a downstream service, ALL upstream traffic to that service must '
    'flow only through it — never also draw a direct edge that bypasses it. '
    '(6) When a request asks you to add a new capability (e.g. AI, search, analytics, logging) to a '
    'system that has explicit privacy or end-to-end-encryption guarantees, you must pick ONE explicit, '
    'consistent privacy model for that capability and represent only that path — for example either '
    '"processing happens client-side before encryption" or "the server only ever receives already-'
    'encrypted or derived data". Never draw both a client-side and a server-side variant of the same '
    'processing step side by side without being asked to compare them, and never wire a shared raw-data '
    'path (e.g. a message queue carrying plaintext payloads) directly into a new consuming service '
    'unless the existing design already establishes that this service is authorized to see that data — '
    'doing so silently implies the server automatically receives plaintext it should never see. '
    '(7) If "existing_design" is present in the request, you are EXTENDING an existing diagram, not '
    'redesigning it: every existing node (same id, label, systemType) and every existing edge (same '
    'source, target, and meaning as its label describes) must be reproduced exactly as given, unless '
    'the user\'s request explicitly asks to change that specific node or edge. Add only the new nodes '
    'and edges needed for the request — never omit, rename, merge, or re-route a part of the diagram '
    'the request did not ask you to touch. '
    'The chat history is a running discussion where the user may add, remove, or revise '
    'components over several turns — always resolve to the LATEST decision on each point, '
    'not earlier ones that were later changed or rejected. '
    'If an "architecture_documentation" field is present in the request, it is the FINALIZED, '
    'authoritative description of the system — the diagram you produce and that documentation '
    'must describe the exact same architecture. Create exactly one node for every distinct '
    'system, service, or component explicitly named in architecture_documentation — no fewer, '
    'and do not invent extra components that are not named there. Every relationship, data flow, '
    'or communication path described in architecture_documentation must be represented by an edge, '
    'and every edge you draw must correspond to something described there — do not add relationships '
    'the documentation does not mention. Use the same names for components as the documentation uses. '
    'Output raw JSON only. First character must be "{".'
)

_REPAIR_SYSTEM = (
    'You are fixing a system architecture diagram (JSON graph of nodes/edges) so it fully matches '
    'its authoritative documentation. You will be given the current graph and a list of components '
    'named in the documentation that are missing from the graph. '
    'Respond with ONLY a single valid JSON object with the same shape as the input graph — keys '
    '"nodes" and "edges" — containing the COMPLETE graph: all original nodes/edges UNCHANGED, plus '
    'new nodes for each missing component and new edges connecting each new node into the existing '
    'graph based on how the documentation describes it relating to other components. '
    'Each node: {"id":"string","type":"archNode","data":{"label":"string","description":"string","systemType":"string"}} '
    'systemType must be one of: database, server, client, cloud, cache, default. '
    'Each edge: {"id":"string","source":"nodeId","target":"nodeId","label":"string","type":"smoothstep","animated":true} '
    'Do not remove or rename any existing node or edge. '
    'Output raw JSON only. First character must be "{".'
)

_PLACEHOLDER_LABELS = {"", "node", "component", "item", "new node", "untitled", "n/a"}


def _clean_graph(parsed: dict) -> dict:
    """
    Strip low-quality output the model sometimes produces despite the prompt:
    placeholder/empty-label nodes (often synthetic "join" nodes standing in for
    an edge) and duplicate reverse edges between the same pair of nodes.
    Runs BEFORE _ensure_connected so orphans created by this cleanup still get
    reattached.
    """
    try:
        nodes = parsed.get("nodes")
        edges = parsed.get("edges")
        if not isinstance(nodes, list):
            return parsed
        if not isinstance(edges, list):
            edges = []

        def label_of(n):
            return str(n.get("data", {}).get("label", "")).strip().lower() if isinstance(n, dict) else ""

        kept_nodes = [
            n for n in nodes
            if isinstance(n, dict) and n.get("id") and label_of(n) not in _PLACEHOLDER_LABELS
        ]
        kept_ids = {n["id"] for n in kept_nodes}

        deduped_edges = []
        seen_pairs = set()
        for e in edges:
            if not isinstance(e, dict):
                continue
            src, tgt = e.get("source"), e.get("target")
            if src not in kept_ids or tgt not in kept_ids or src == tgt:
                continue
            pair = frozenset((src, tgt))
            if pair in seen_pairs:
                continue
            seen_pairs.add(pair)
            deduped_edges.append(e)

        parsed["nodes"] = kept_nodes
        parsed["edges"] = deduped_edges
        return parsed
    except Exception:
        return parsed

def _summarise_design(design: Optional[Dict[str, Any]]) -> Optional[Dict]:
    """
    Compact but semantically complete summary of the existing diagram for the
    prompt — ids/labels/types so the model knows what already exists and,
    critically, edge labels so it knows what each existing connection *means*
    and can reproduce it deliberately instead of guessing/reinventing it.
    """
    if not design or not design.get("nodes"):
        return None
    return {
        "nodes": [
            {
                "id": n["id"],
                "label": n.get("data", {}).get("label", ""),
                "systemType": n.get("data", {}).get("systemType", ""),
            }
            for n in design["nodes"]
        ],
        "edges": [
            {
                "src": e["source"],
                "tgt": e["target"],
                "label": e.get("label", ""),
            }
            for e in design.get("edges", [])
        ],
    }


from app.core.history import trim_history as _window_recent_history, build_summary_prefix


def _extract_json(raw: str) -> str:
    """
    Extract the raw JSON string from the model response.
    Strip markdown fences and any leading/trailing text.
    """
    s = raw.strip()

    # 1. Strip markdown fences: ```json ... ``` or ``` ... ```
    fence = re.search(r"```(?:json)?\s*([\s\S]*?)```", s)
    if fence:
        s = fence.group(1).strip()
    else:
        # 2. Slice from first { to last }
        start = s.find("{")
        end = s.rfind("}") + 1
        if start >= 0 and end > start:
            s = s[start:end]

    return s


def _fix_unescaped_quotes(s: str) -> str:
    """
    Repair unescaped double-quotes inside JSON string values — a common LLM
    slip, e.g. writing "the "push" service" instead of "the \\"push\\" service".
    A literal quote is treated as string content (and escaped) unless it looks
    like an actual string terminator: followed by optional whitespace then a
    JSON structural character (, : } ]) or end of input. Left uncorrected,
    a single stray quote desyncs string-boundary tracking for every parser
    downstream, including the truncation-salvage stage.
    """
    out = []
    in_string = False
    i = 0
    n = len(s)
    while i < n:
        ch = s[i]
        if ch == "\\" and in_string:
            out.append(ch)
            if i + 1 < n:
                out.append(s[i + 1])
            i += 2
            continue
        if ch == '"':
            if not in_string:
                in_string = True
                out.append(ch)
            else:
                j = i + 1
                while j < n and s[j] in " \t\r\n":
                    j += 1
                if j >= n or s[j] in ",:}]":
                    in_string = False
                    out.append(ch)
                else:
                    out.append('\\"')
            i += 1
            continue
        out.append(ch)
        i += 1
    return "".join(out)


def _repair_json(s: str) -> str:
    """
    Apply targeted repairs to common LLM JSON failures.
    Run AFTER extraction, BEFORE json.loads().
    """
    s = _fix_unescaped_quotes(s)

    # Remove JS single-line and block comments
    s = re.sub(r"//[^\n]*", "", s)
    s = re.sub(r"/\*.*?\*/", "", s, flags=re.DOTALL)

    # Fix Python booleans and None → JSON equivalents
    s = re.sub(r"\bTrue\b", "true", s)
    s = re.sub(r"\bFalse\b", "false", s)
    s = re.sub(r"\bNone\b", "null", s)

    # Fix single-quoted keys: 'key': → "key":
    s = re.sub(r"'([^'\n]+)'(\s*:)", r'"\1"\2', s)
    # Fix single-quoted string values: : 'value' → : "value"
    s = re.sub(r"(:\s*)'([^'\n]*)'", r'\1"\2"', s)

    # Add missing commas between adjacent objects in an array:  }  {  →  },  {
    s = re.sub(r"}\s*\n(\s*){", r"},\n\1{", s)
    # Add missing commas between adjacent arrays: ]  [  → ],  [
    s = re.sub(r"]\s*\n(\s*)\[", r"],\n\1[", s)
    # Add missing commas between adjacent quoted strings on separate lines: "x"\n"y" → "x","y"
    s = re.sub(r'"\s*\n(\s*)"', r'",\n\1"', s)

    # Remove trailing commas before } or ]
    s = re.sub(r",(\s*[}\]])", r"\1", s)

    return s


def _salvage_truncated(s: str) -> Optional[str]:
    """
    Last-resort repair for output truncated mid-stream (the model ran out of
    its token budget before finishing — common for large designs sent with a
    full chat history). Walks the text tracking string/bracket state, remembers
    the last point where a complete array element had just closed, cuts there,
    and closes whatever brackets were still open. This drops only the one
    incomplete trailing element instead of failing the whole graph.
    """
    stack = []
    in_string = False
    escape = False
    last_safe_cut = None
    last_safe_stack = None

    for i, ch in enumerate(s):
        if escape:
            escape = False
            continue
        if ch == "\\" and in_string:
            escape = True
            continue
        if ch == '"':
            in_string = not in_string
            continue
        if in_string:
            continue

        if ch in "{[":
            stack.append(ch)
        elif ch in "}]":
            if stack:
                stack.pop()
            # Right after closing a bracket, if the parent is still an open
            # array, we're at a boundary between array elements — safe to cut.
            # Snapshot the stack *at this point*, not at end-of-loop: anything
            # opened after this cut (e.g. a subsequent, still-incomplete
            # element) must not be closed in the salvaged output.
            if stack and stack[-1] == "[":
                last_safe_cut = i + 1
                last_safe_stack = list(stack)

    if last_safe_cut is None:
        return None

    closers = {"{": "}", "[": "]"}
    return s[:last_safe_cut] + "".join(closers[b] for b in reversed(last_safe_stack))


def _safe_parse(raw: str) -> dict:
    """
    Multi-stage JSON parser. Tries increasingly aggressive fixes until one works.
    Raises json.JSONDecodeError only when all stages fail.
    """
    import ast

    # Stage 1: extract then parse as-is
    extracted = _extract_json(raw)
    try:
        return json.loads(extracted)
    except json.JSONDecodeError:
        pass

    # Stage 2: apply targeted repairs then parse
    repaired = _repair_json(extracted)
    try:
        return json.loads(repaired)
    except json.JSONDecodeError:
        pass

    # Stage 3: ast.literal_eval — handles single-quoted dicts, trailing commas,
    # Python-style booleans. Works even when json.loads completely fails.
    try:
        # Swap JSON booleans to Python style for ast
        ast_str = repaired.replace("true", "True").replace("false", "False").replace("null", "None")
        result = ast.literal_eval(ast_str)
        if isinstance(result, dict):
            # Round-trip through json to normalise types (True→true etc.)
            return json.loads(json.dumps(result))
    except Exception:
        pass

    # Stage 4: truncation salvage — output was cut off mid-array by the token
    # budget. Recover whatever complete nodes/edges were emitted rather than
    # failing the whole draw.
    salvaged = _salvage_truncated(repaired)
    if salvaged:
        try:
            return json.loads(salvaged)
        except json.JSONDecodeError:
            pass

    # All stages failed
    raise json.JSONDecodeError(
        f"All parsing stages failed. Raw start: {raw[:100]!r}", raw, 0
    )


def _ensure_connected(parsed: dict) -> dict:
    """
    Guarantee every node ends up connected, even if the model dropped edges
    entirely (e.g. token-budget truncation cut the "edges" array before it
    started) or ChatPanel-side validation would otherwise filter out edges
    with mismatched ids. The system prompt already asks the model for this;
    this enforces it server-side so the frontend never receives a graph that
    dagre can only lay out as a disconnected single row.

    Orphan nodes are attached to the first node (treated as the hub/root),
    producing a star/tree shape in the worst case rather than a flat queue.
    """
    try:
        nodes = parsed.get("nodes")
        edges = parsed.get("edges")
        if not isinstance(nodes, list) or not nodes:
            return parsed
        if not isinstance(edges, list):
            edges = []

        node_ids = {n["id"] for n in nodes if isinstance(n, dict) and n.get("id")}
        if len(node_ids) < 2:
            parsed["edges"] = edges
            return parsed

        # Drop edges that don't reference real nodes.
        valid_edges = [
            e for e in edges
            if isinstance(e, dict) and e.get("source") in node_ids and e.get("target") in node_ids
        ]

        connected = {e["source"] for e in valid_edges} | {e["target"] for e in valid_edges}

        root_id = nodes[0].get("id")
        for n in nodes:
            node_id = n.get("id") if isinstance(n, dict) else None
            if not node_id or node_id == root_id or node_id in connected:
                continue
            valid_edges.append({
                "id": f"auto-{node_id}",
                "source": root_id,
                "target": node_id,
                "type": "smoothstep",
                "animated": True,
            })

        parsed["edges"] = valid_edges
        return parsed
    except Exception:
        return parsed


def _merge_preserve_existing(original: Optional[Dict[str, Any]], parsed: dict) -> dict:
    """
    Safety net for incremental updates (a request against an existing
    design). The system prompt already instructs the model to reproduce
    every existing node/edge unchanged and only add what was asked for, but
    that's a request, not a guarantee — on a big regeneration (e.g. adding
    an unrelated AI/search subsystem) the model can still silently drop or
    reroute part of the original diagram it wasn't supposed to touch.

    This makes that structurally impossible: anything present in the
    original design that the model's output no longer contains is
    re-appended unchanged. Anything the model kept, changed, or added is
    left exactly as the model produced it — this only ever ADDS back
    accidentally-dropped nodes/edges, it never overrides an intentional edit.
    """
    if not original or not isinstance(original.get("nodes"), list):
        return parsed
    try:
        new_nodes = parsed.get("nodes")
        new_edges = parsed.get("edges")
        if not isinstance(new_nodes, list):
            return parsed
        if not isinstance(new_edges, list):
            new_edges = []

        new_node_ids = {n.get("id") for n in new_nodes if isinstance(n, dict)}
        for n in original["nodes"]:
            if isinstance(n, dict) and n.get("id") and n["id"] not in new_node_ids:
                new_nodes.append(n)
                new_node_ids.add(n["id"])

        new_edge_pairs = {
            (e.get("source"), e.get("target"))
            for e in new_edges if isinstance(e, dict)
        }
        for e in original.get("edges", []) or []:
            if not isinstance(e, dict):
                continue
            pair = (e.get("source"), e.get("target"))
            # Only restore if both endpoints are still present in the merged
            # graph — an endpoint the model deliberately removed shouldn't
            # get a dangling edge resurrected for it.
            if pair not in new_edge_pairs and pair[0] in new_node_ids and pair[1] in new_node_ids:
                new_edges.append(e)
                new_edge_pairs.add(pair)

        parsed["nodes"] = new_nodes
        parsed["edges"] = new_edges
        return parsed
    except Exception:
        return parsed


_DOC_COMPONENT_PATTERNS = [
    re.compile(r"\*\*([A-Z][A-Za-z0-9 /&\-]{1,40}?)\*\*"),        # **Bold Term**
    re.compile(r"^#{1,4}\s+([A-Z][A-Za-z0-9 /&\-]{1,40})\s*$", re.MULTILINE),  # ## Heading
    re.compile(r"^\s*[-*]\s+([A-Z][A-Za-z0-9 /&\-]{1,40}?)\s*[:—-]", re.MULTILINE),  # - Term: ...
]

_DOC_STOPWORDS = {
    "overview", "summary", "architecture", "introduction", "conclusion",
    "components", "design", "system", "diagram", "flow", "notes",
}


def _extract_doc_components(doc: str) -> List[str]:
    """Pull candidate component/service names out of the documentation markdown
    (bold terms, headings, bullet-leading terms) for reconciliation against the
    generated diagram. Best-effort heuristic — false negatives are fine, the
    goal is just to catch obviously-named components the model dropped."""
    if not doc:
        return []
    found = []
    seen = set()
    for pattern in _DOC_COMPONENT_PATTERNS:
        for m in pattern.finditer(doc):
            name = m.group(1).strip()
            key = name.lower()
            if not name or key in _DOC_STOPWORDS or key in seen or len(name) < 2:
                continue
            seen.add(key)
            found.append(name)
    return found


def _normalise(s: str) -> str:
    return re.sub(r"[^a-z0-9]+", "", s.lower())


def _find_missing_components(doc_components: List[str], nodes: List[dict]) -> List[str]:
    node_labels = [
        _normalise(str(n.get("data", {}).get("label", "")))
        for n in nodes if isinstance(n, dict)
    ]
    missing = []
    for comp in doc_components:
        norm = _normalise(comp)
        if not norm:
            continue
        if any(norm in nl or nl in norm for nl in node_labels if nl):
            continue
        missing.append(comp)
    return missing


async def _repair_missing_components(
    parsed: dict,
    documentation: str,
    missing: List[str],
    provider: str,
    model_name: str,
    api_key: str,
    api_url: str,
) -> dict:
    """One corrective LLM pass: add nodes/edges for components the first pass
    dropped, without touching what's already there. Falls back to the
    unmodified graph on any failure — this is a best-effort sync step, not a
    hard dependency for the draw to succeed."""
    from app.core.llm import call_llm

    repair_payload = {
        "current_graph": {"nodes": parsed.get("nodes", []), "edges": parsed.get("edges", [])},
        "architecture_documentation": documentation,
        "missing_components": missing,
    }
    try:
        raw = await call_llm(
            json.dumps(repair_payload, separators=(",", ":")),
            system_prompt=_REPAIR_SYSTEM,
            provider=provider,
            api_key=api_key,
            model_name=model_name,
            api_url=api_url,
            max_tokens=8192,
            timeout_seconds=30,
        )
        repaired = _safe_parse(raw)
        repaired = _clean_graph(repaired)
        repaired = _ensure_connected(repaired)
        if isinstance(repaired.get("nodes"), list) and len(repaired["nodes"]) >= len(parsed.get("nodes", [])):
            return repaired
    except Exception:
        pass
    return parsed


async def generate_design_stream(
    user_prompt: str,
    current_design: Optional[Dict[str, Any]] = None,
    chat_history: Optional[List[Dict[str, str]]] = None,
    req_config: Any = None,
    documentation: Optional[str] = None,
):
    from app.core.llm import call_llm_stream
    from app.core.cache import response_cache
    import hashlib

    payload: Dict[str, Any] = {"request": user_prompt}

    # Fetch context from knowledge base, but do not let vector search dominate
    # graph generation latency.
    try:
        context = await asyncio.wait_for(search_knowledge_async(user_prompt, n_results=2), timeout=1.2)
    except asyncio.TimeoutError:
        context = ""
    if context:
        payload["knowledge_base_context"] = context

    # Summarize older turns so nothing from a long discussion is lost,
    # while keeping the most recent turns verbatim for fidelity.
    summary = build_summary_prefix(chat_history)
    if summary:
        payload["earlier_discussion_summary"] = summary["content"]

    recent = _window_recent_history(chat_history)
    if recent:
        payload["history"] = recent

    summarised = _summarise_design(current_design)
    if summarised:
        payload["existing_design"] = summarised
        payload["instruction"] = (
            "Update existing design. Keep node ids. Apply changes only: reproduce every node and "
            "edge in existing_design exactly as given, and add only the new nodes/edges this request "
            "needs — do not omit, rename, or re-route anything existing_design already contains."
        )
    else:
        payload["instruction"] = "Create a new design graph."

    documentation = (documentation or "").strip()
    if documentation:
        payload["architecture_documentation"] = documentation
        payload["instruction"] = (
            "Generate the diagram strictly from architecture_documentation so both are identical. "
            + payload["instruction"]
        )

    prompt_text = json.dumps(payload, separators=(",", ":"))

    provider = req_config.provider if req_config else "ollama"
    model_name = req_config.model_name if req_config else ""
    api_key = req_config.api_key if req_config else ""
    api_url = req_config.api_url if req_config else ""

    # Custom cache key including design hash
    cache_payload = prompt_text + str(hashlib.md5(json.dumps(summarised or {}).encode()).hexdigest())
    cached = response_cache.get(cache_payload, provider, model_name)
    if cached:
        # If cached, yield it immediately as a single large chunk
        yield f"data: {cached}\n\n"
        yield "data: [DONE]\n\n"
        return

    full_response = ""
    try:
        # Use call_llm_stream with system_prompt
        stream = call_llm_stream(
            prompt=prompt_text,
            chat_history=[], # We already put history in payload
            system_prompt=_SYSTEM,
            provider=provider,
            api_key=api_key,
            model_name=model_name,
            api_url=api_url,
            max_tokens=8192,
            stop=[],
            timeout_seconds=60,
        )
        
        async for chunk in stream:
            if isinstance(chunk, str) and chunk.strip().startswith('[Error:'):
                error_text = chunk.strip()
                yield f"data: {json.dumps({ 'error': error_text })}\n\n"
                yield "data: [DONE]\n\n"
                return

            full_response += chunk
            # Wrap as SSE
            yield f"data: {json.dumps(chunk)}\n\n"

        # Try to parse/repair into strict JSON for the client.
        # If repair succeeds, send the canonical JSON as a distinct "final" event —
        # NOT a plain chunk — so the client replaces its accumulated buffer instead
        # of appending, which would concatenate raw+canonical into invalid JSON.
        try:
            parsed = _safe_parse(full_response)
            parsed = _merge_preserve_existing(current_design, parsed)
            parsed = _clean_graph(parsed)
            parsed = _ensure_connected(parsed)

            # Validate the diagram covers every component the documentation names.
            # If the model dropped any, run one corrective pass so the diagram and
            # the documentation stay in sync instead of silently diverging.
            if documentation:
                doc_components = _extract_doc_components(documentation)
                missing = _find_missing_components(doc_components, parsed.get("nodes", []))
                if missing:
                    parsed = await _repair_missing_components(
                        parsed, documentation, missing, provider, model_name, api_key, api_url
                    )

            canonical = json.dumps(parsed, ensure_ascii=False, separators=(",", ":"))
            yield f"data: {json.dumps({'final': canonical})}\n\n"
            full_response = canonical
        except Exception as e:
            # If repair fails, fall back to raw output; client may still recover.
            print(f"[design_service] _safe_parse failed: {e}\nRaw response (first 500 chars): {full_response[:500]!r}")

        # End of stream marker
        yield "data: [DONE]\n\n"

        # Save to cache after streaming is complete
        # Only cache if it looks like valid JSON
        if "{" in full_response and "}" in full_response:
            response_cache.set(cache_payload, provider, model_name, full_response)
            
    except Exception as e:
        yield f"data: {json.dumps({ 'error': str(e) })}\n\n"
        yield "data: [DONE]\n\n"
