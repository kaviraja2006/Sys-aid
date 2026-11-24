"""
Generate-board service.
Produces a valid React Flow JSON graph from a user description.
"""
import json
import logging
import re
import asyncio
from app.core.llm import call_llm, resolve_effective_model, resolve_tier_timeout
from app.core.rag import search_knowledge_async
from typing import Optional, Dict, Any, List

logger = logging.getLogger(__name__)

# ── System prompt (ultra-lean schema-first prompt: ~180 tokens vs 1,250 tokens) ───
_SYSTEM = (
    "Output ONLY a single valid JSON object starting with '{'. No markdown, no fences, no explanation.\n"
    "Schema:\n"
    '{"nodes":[{"id":"str","type":"archNode","data":{"label":"str","description":"str","systemType":"database|server|client|cloud|cache|default"}}],'
    '"edges":[{"id":"str","source":"nodeId","target":"nodeId","label":"str","type":"smoothstep","animated":true}],'
    '"removed_node_ids":["str"]}\n'
    "Rules:\n"
    "1. Specific node labels only (no generic 'Node'/'Component'). No join/link nodes.\n"
    "2. Max 1 edge between any two nodes (express bidirectional flow in label). Every node must be connected.\n"
    "3. If 'existing_design' is present, preserve all existing nodes/edges unless requested to modify or remove.\n"
    "4. If requested to delete/remove a node, omit it and add its ID to 'removed_node_ids'.\n"
    "5. Output clean JSON only."
)

_REPAIR_SYSTEM = (
    "You are fixing an architecture graph JSON to match documentation.\n"
    "Output ONLY valid JSON starting with '{' with keys 'nodes' and 'edges'.\n"
    "Keep all original nodes/edges unchanged, and add missing components as new nodes connected with edges.\n"
    "Node format: {\"id\":\"str\",\"type\":\"archNode\",\"data\":{\"label\":\"str\",\"description\":\"str\",\"systemType\":\"database|server|client|cloud|cache|default\"}}.\n"
    "Edge format: {\"id\":\"str\",\"source\":\"nodeId\",\"target\":\"nodeId\",\"label\":\"str\",\"type\":\"smoothstep\",\"animated\":true}."
)

_PLACEHOLDER_LABELS = {"", "node", "component", "item", "new node", "untitled", "n/a"}


class DesignSyncUnavailable(Exception):
    """
    Raised by update_design_from_turn when the incremental design sync could
    not complete this turn (provider timeout/error, or unusable output) —
    distinct from returning None for the legitimate "nothing to draw yet"
    case. Callers (chat_service) catch this to tell the user the diagram
    wasn't updated instead of failing silently, while the chat reply itself
    is never affected either way.
    """


def _unwrap_root_graph(parsed: dict) -> dict:
    if not isinstance(parsed, dict):
        return parsed
    for wrapper in ("architecture", "data", "graph", "system", "diagram"):
        if wrapper in parsed and isinstance(parsed[wrapper], dict) and "nodes" in parsed[wrapper]:
            return parsed[wrapper]
    return parsed


def _clean_graph(parsed: dict) -> dict:
    """
    Normalize model output into ReactFlow archNode format and strip low-quality output:
    placeholder/empty-label nodes and duplicate reverse edges between the same pair of nodes.
    Supports both nested data objects and flat node formats from different LLM providers.
    """
    try:
        parsed = _unwrap_root_graph(parsed)
        raw_nodes = parsed.get("nodes")
        raw_edges = parsed.get("edges")
        if not isinstance(raw_nodes, list):
            return parsed
        if not isinstance(raw_edges, list):
            raw_edges = []

        # Normalize nodes into ReactFlow archNode structure
        normalized_nodes = []
        for i, n in enumerate(raw_nodes):
            if not isinstance(n, dict):
                continue
            nid = str(n.get("id") or f"node-{i}")
            data = n.get("data") if isinstance(n.get("data"), dict) else {}
            label = str(data.get("label") or n.get("label") or n.get("name") or n.get("title") or "").strip()
            desc = str(data.get("description") or n.get("description") or "").strip()
            stype = str(data.get("systemType") or n.get("systemType") or n.get("type") or "default").strip().lower()
            if stype not in ("database", "server", "client", "cloud", "cache", "default"):
                stype = "default"
            normalized_nodes.append({
                "id": nid,
                "type": "archNode",
                "data": {
                    "label": label or f"Component {i+1}",
                    "description": desc,
                    "systemType": stype,
                },
            })

        def label_of(n):
            return str(n.get("data", {}).get("label", "")).strip().lower()

        kept_nodes = [
            n for n in normalized_nodes
            if n.get("id") and label_of(n) not in _PLACEHOLDER_LABELS
        ]
        kept_ids = {n["id"] for n in kept_nodes}

        deduped_edges = []
        seen_pairs = set()
        for i, e in enumerate(raw_edges):
            if not isinstance(e, dict):
                continue
            src = str(e.get("source") or e.get("from") or e.get("src") or "")
            tgt = str(e.get("target") or e.get("to") or e.get("tgt") or "")
            if src not in kept_ids or tgt not in kept_ids or src == tgt:
                continue
            pair = frozenset((src, tgt))
            if pair in seen_pairs:
                continue
            seen_pairs.add(pair)
            deduped_edges.append({
                "id": str(e.get("id") or f"e-{src}-{tgt}-{i}"),
                "source": src,
                "target": tgt,
                "label": str(e.get("label") or ""),
                "type": "smoothstep",
                "animated": True,
            })

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
    Strips:
      1. Reasoning / thinking blocks (<think>...</think>, <thought>...</thought>)
      2. Conversational preambles (e.g. "We need to produce a JSON...", "Here is the JSON...", etc.)
      3. Markdown fences (```json ... ```)
      4. Any trailing commentary after the closing JSON bracket
    """
    if not raw:
        return ""
    s = str(raw).strip()

    # 1. Strip reasoning / thinking blocks from reasoning models (e.g. DeepSeek-R1, QwQ, Nemotron)
    s = re.sub(r"<(?:think|thinking|thought)>[\s\S]*?</(?:think|thinking|thought)>", "", s, flags=re.IGNORECASE).strip()

    # 2. Look for code fences that contain "nodes" or 'nodes'
    fences = re.findall(r"```(?:json)?\s*([\s\S]*?)```", s, flags=re.IGNORECASE)
    for fence in fences:
        if '"nodes"' in fence or "'nodes'" in fence:
            fence_clean = fence.strip()
            # If the fence still has commentary before the first '{', slice from '{'
            start_idx = fence_clean.find("{")
            end_idx = fence_clean.rfind("}") + 1
            if start_idx >= 0 and end_idx > start_idx:
                return fence_clean[start_idx:end_idx].strip()
            return fence_clean

    # If any other fence exists, fallback to first fence if it has '{'
    for fence in fences:
        if "{" in fence and "}" in fence:
            start_idx = fence.find("{")
            end_idx = fence.rfind("}") + 1
            if start_idx >= 0 and end_idx > start_idx:
                return fence[start_idx:end_idx].strip()

    # 3. If there is conversational preamble (e.g. "We need to produce...", "Here is the JSON..."),
    # find the position of the '{' that is followed by '"nodes"' or 'nodes'
    nodes_match = re.search(r'["\']nodes["\']\s*:', s)
    if nodes_match:
        # Walk backwards from "nodes" to locate the outermost opening '{'
        nodes_pos = nodes_match.start()
        open_pos = s.rfind("{", 0, nodes_pos)
        if open_pos >= 0:
            end_pos = s.rfind("}") + 1
            if end_pos > open_pos:
                return s[open_pos:end_pos].strip()

    # 4. Standard fallback: Slice from first '{' to last '}'
    start = s.find("{")
    end = s.rfind("}") + 1
    if start >= 0 and end > start:
        return s[start:end].strip()

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
    if not raw or not str(raw).strip():
        raise json.JSONDecodeError("Empty LLM response", "", 0)

    # Stage 1: extract then parse as-is
    extracted = _extract_json(raw)
    try:
        return _unwrap_root_graph(json.loads(extracted))
    except json.JSONDecodeError:
        pass

    # Stage 2: apply targeted repairs then parse
    repaired = _repair_json(extracted)
    try:
        return _unwrap_root_graph(json.loads(repaired))
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
            return _unwrap_root_graph(json.loads(json.dumps(result)))
    except Exception:
        pass

    # Stage 4: truncation salvage — output was cut off mid-array by the token
    # budget. Recover whatever complete nodes/edges were emitted rather than
    # failing the whole draw.
    salvaged = _salvage_truncated(repaired)
    if salvaged:
        try:
            return _unwrap_root_graph(json.loads(salvaged))
        except json.JSONDecodeError:
            pass

    # All stages failed
    raise json.JSONDecodeError(
        f"All parsing stages failed. Raw start: {str(raw)[:100]!r}", str(raw), 0
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


def _merge_preserve_existing(
    original: Optional[Dict[str, Any]], parsed: dict, removed_ids: Optional[set] = None
) -> dict:
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

    `removed_ids` (the model's own "removed_node_ids", see rule 8 in
    _SYSTEM) is the one exception: without it, this safety net was
    indistinguishable from an actual bug — asking to delete a component made
    the model correctly omit it, and this function then silently resurrected
    it because "missing from the new output" was its only signal. An id in
    removed_ids is trusted as an intentional deletion and is never restored,
    nor is any edge touching it.
    """
    if not original or not isinstance(original.get("nodes"), list):
        return parsed
    try:
        removed_ids = removed_ids or set()
        new_nodes = parsed.get("nodes")
        new_edges = parsed.get("edges")
        if not isinstance(new_nodes, list):
            return parsed
        if not isinstance(new_edges, list):
            new_edges = []

        new_node_ids = {n.get("id") for n in new_nodes if isinstance(n, dict)}
        for n in original["nodes"]:
            if (
                isinstance(n, dict) and n.get("id")
                and n["id"] not in new_node_ids
                and n["id"] not in removed_ids
            ):
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
            # graph and neither was explicitly removed this turn — an
            # endpoint the model deliberately dropped (deletion or otherwise)
            # shouldn't get a dangling edge resurrected for it.
            if (
                pair not in new_edge_pairs
                and pair[0] in new_node_ids and pair[1] in new_node_ids
                and pair[0] not in removed_ids and pair[1] not in removed_ids
            ):
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


async def update_design_from_turn(
    user_prompt: str,
    ai_response: str,
    current_design: Optional[Dict[str, Any]],
    req_config: Any = None,
) -> Optional[Dict[str, Any]]:
    """
    Keep the design graph in sync with the conversation turn-by-turn instead
    of only building it from scratch when the user clicks Draw. Sends just
    this one exchange (not the full history) against the existing graph, so
    it stays cheap and fast, and asks the model to layer in only what this
    turn adds, changes, or replaces — everything else in the existing graph
    is left untouched (enforced server-side by _merge_preserve_existing, same
    as the full draw path).

    Best-effort: returns None on any failure (bad JSON, timeout, nothing to
    draw yet) rather than raising — a chat turn must never fail because the
    background graph sync did.
    """
    summarised = _summarise_design(current_design)
    payload: Dict[str, Any] = {"request": user_prompt, "assistant_response": ai_response}
    if summarised:
        payload["existing_design"] = summarised
        payload["instruction"] = (
            "Sync design with this exchange. Keep existing nodes/edges unless explicitly changed/removed. "
            "Add new nodes/edges. If removing a node, list its ID in removed_node_ids."
        )
    else:
        payload["instruction"] = (
            "Create a design graph if concrete architecture components are described. "
            'Otherwise return {"nodes":[],"edges":[]}.'
        )

    provider = req_config.provider if req_config else "ollama"
    model_name = req_config.model_name if req_config else ""
    api_key = req_config.api_key if req_config else ""
    api_url = req_config.api_url if req_config else ""

    # A single turn's delta only ever needs a handful of nodes/edges — capped
    # small on purpose so a slow/heavy model still has a realistic chance of
    # finishing before the timeout below, instead of the same 4096-8192
    # budget the full draw uses. Scaled up automatically for a known-heavy/
    # reasoning free model (see llm.py's tiering) rather than a flat 30s that
    # such a model almost never makes.
    BASE_TIMEOUT_SECONDS = 30
    TIMEOUT_SECONDS = resolve_tier_timeout(BASE_TIMEOUT_SECONDS, provider, api_key, model_name, api_url)
    try:
        raw = await asyncio.wait_for(
            call_llm(
                json.dumps(payload, separators=(",", ":")),
                system_prompt=_SYSTEM,
                provider=provider,
                api_key=api_key,
                model_name=model_name,
                api_url=api_url,
                max_tokens=2048,
                timeout_seconds=TIMEOUT_SECONDS,
                use_cache=False,
                json_mode=True,
            ),
            timeout=TIMEOUT_SECONDS + 5,
        )
        parsed = _safe_parse(raw)
        if not isinstance(parsed.get("nodes"), list):
            return None
        if not parsed["nodes"] and not summarised:
            return None  # explicit "nothing to draw yet" — don't blank the canvas
        removed_ids = set(parsed.pop("removed_node_ids", None) or [])
        parsed = _merge_preserve_existing(current_design, parsed, removed_ids)
        parsed = _clean_graph(parsed)
        parsed = _ensure_connected(parsed)
        return parsed
    except Exception as e:
        eff_provider, eff_model = resolve_effective_model(provider, api_key, model_name, api_url)
        logger.warning(
            "Incremental design sync failed/timed out this turn [%s (%s)]: %s",
            eff_model, eff_provider, e,
        )
        raise DesignSyncUnavailable(
            f"Diagram sync skipped this turn — {eff_provider} model \"{eff_model}\" "
            "was too slow or returned an unusable response. Your reply above is "
            "unaffected; click Draw Board to try a full sync, or switch to a "
            "faster model in Settings if this keeps happening."
        ) from e


async def generate_design_stream(
    user_prompt: str,
    current_design: Optional[Dict[str, Any]] = None,
    chat_history: Optional[List[Dict[str, str]]] = None,
    req_config: Any = None,
    documentation: Optional[str] = None,
    user_id: Optional[str] = None,
):
    from app.core.cache import response_cache
    import hashlib

    payload: Dict[str, Any] = {"request": user_prompt}

    # Fetch context from knowledge base, but do not let vector search dominate
    # graph generation latency.
    try:
        context = await asyncio.wait_for(
            search_knowledge_async(user_prompt, n_results=2, user_id=user_id), timeout=1.2
        )
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
        # Wrap in the same {"final": ...} envelope the live-generation path
        # uses below. Sending the bare cached JSON object here used to make
        # the frontend's `.final` check fail, fall into its string-append
        # branch, and coerce the whole graph object to the literal text
        # "[object Object]" (see ChatPanel.jsx's SSE handler) — i.e. every
        # cache hit silently produced a broken draw.
        yield f"data: {json.dumps({'final': cached})}\n\n"
        yield "data: [DONE]\n\n"
        return

    # ── Single request/response, not token-by-token streaming ───────────────
    # A partial graph is unusable — there's nothing to show the user until
    # the JSON is 100% complete anyway — so streaming it token-by-token only
    # bought cost, not benefit: a reasoning model's long silent "thinking"
    # phase (empty content deltas) read as a frozen UI with no real timeout
    # catching it, and both ends needed their own JSON-repair engine just to
    # cope with parsing a growing, incomplete blob live. This calls the model
    # ONCE, validates the COMPLETE output before saying anything to the
    # client, and only ever sends one of exactly two outcomes: a validated
    # diagram, or a clear error. A lightweight heartbeat (elapsed seconds)
    # keeps the "Drawing architecture..." UI visibly alive while waiting.
    # 240s base — a reasoning model (e.g. NVIDIA's mistral-nemotron) generating
    # a large structured JSON graph genuinely needs more headroom than a plain
    # chat model would; 150s was cutting off requests that were still making
    # real progress, not stuck. Scaled further for a known-heavy/reasoning
    # free model (see llm.py's tiering) — the heartbeat below keeps the UI
    # visibly alive the whole time either way so this doesn't read as frozen.
    BASE_DRAW_TIMEOUT_SECONDS = 240
    DRAW_TIMEOUT_SECONDS = resolve_tier_timeout(BASE_DRAW_TIMEOUT_SECONDS, provider, api_key, model_name, api_url)
    HEARTBEAT_INTERVAL_SECONDS = 2

    llm_task = asyncio.ensure_future(call_llm(
        prompt_text,
        system_prompt=_SYSTEM,
        provider=provider,
        api_key=api_key,
        model_name=model_name,
        api_url=api_url,
        max_tokens=4096,
        timeout_seconds=DRAW_TIMEOUT_SECONDS,
        use_cache=False,  # this function keeps its own richer, design-aware cache key below
        json_mode=True,
    ))

    elapsed = 0
    raw = None
    try:
        while True:
            try:
                raw = await asyncio.wait_for(asyncio.shield(llm_task), timeout=HEARTBEAT_INTERVAL_SECONDS)
                break
            except asyncio.TimeoutError:
                elapsed += HEARTBEAT_INTERVAL_SECONDS
                # Small buffer past DRAW_TIMEOUT_SECONDS so litellm's own
                # timeout (which the task is already racing) gets first
                # chance to raise its own, more specific error; this is the
                # backstop in case it doesn't.
                if elapsed >= DRAW_TIMEOUT_SECONDS + 15:
                    llm_task.cancel()
                    # Name the model that ACTUALLY ran (post env-default/alias
                    # resolution) — the old canned "e.g. mistral-nemotron"
                    # wording named an example regardless of what really timed
                    # out, which made this message useless for telling apart
                    # "this specific model is genuinely too slow" from "the
                    # request never reached the model I think it did".
                    eff_provider, eff_model = resolve_effective_model(provider, api_key, model_name, api_url)
                    logger.warning(
                        "Draw Board timed out after %ss [requested provider=%r model=%r -> resolved %s/%s]",
                        elapsed, provider, model_name, eff_provider, eff_model,
                    )
                    # eff_model ids already carry their own vendor prefix
                    # (e.g. "nvidia/llama-3.1-nemotron-70b-instruct",
                    # "mistralai/mistral-nemotron") — joining with eff_provider
                    # via "/" would print a redundant "nvidia/nvidia/...".
                    timeout_msg = (
                        f'Generation timed out after {elapsed}s using {eff_provider} model '
                        f'"{eff_model}". This model is too slow to finish a full diagram in '
                        f'time — pick a faster one from the dropdown in Settings (the curated '
                        f'list is verified fast) rather than a custom id.'
                    )
                    yield f"data: {json.dumps({'error': timeout_msg})}\n\n"
                    yield "data: [DONE]\n\n"
                    return
                yield f"data: {json.dumps({'progress': elapsed})}\n\n"
    except Exception as e:
        logger.error("Draw Board LLM call failed [%s/%s]: %s", provider, model_name, e)
        yield f"data: {json.dumps({'error': str(e)})}\n\n"
        yield "data: [DONE]\n\n"
        return

    # Validate and repair the COMPLETE output — never something partial.
    try:
        parsed = _safe_parse(raw)
        # _safe_parse only guarantees valid JSON syntax, not the right shape —
        # a confused model can echo its own input (keys like "request"/
        # "history"/"instruction") back as a syntactically valid object with
        # no "nodes" array at all. Treating that as a successful draw would
        # send the client a graph with nothing in it and no error either.
        if not isinstance(parsed.get("nodes"), list):
            raise ValueError(
                "Model output was valid JSON but not a diagram (missing a "
                "\"nodes\" array) — it likely echoed the request instead of "
                "generating a design."
            )
        removed_ids = set(parsed.pop("removed_node_ids", None) or [])
        parsed = _merge_preserve_existing(current_design, parsed, removed_ids)
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
        response_cache.set(cache_payload, provider, model_name, canonical)
    except Exception as e:
        # No partial client-side buffer to fall back on any more (nothing was
        # streamed), so the client MUST get an explicit error here — silently
        # falling through to [DONE] would look identical to a frozen request.
        logger.warning(
            "_safe_parse failed: %s\nRaw response (first 500 chars): %r", e, (raw or "")[:500]
        )
        yield f"data: {json.dumps({'error': f'The model did not return a usable diagram: {e}'})}\n\n"

    yield "data: [DONE]\n\n"
