import os
import json
import chromadb
from chromadb.utils import embedding_functions

DB_DIR = os.path.join(os.path.dirname(__file__), "..", "data", "chroma_db")
KNOWLEDGE_FILE = os.path.join(os.path.dirname(__file__), "..", "data", "knowledge.json")

# Use single global client
_chroma_client = None
_collection = None

def init_rag():
    global _chroma_client, _collection
    
    os.makedirs(os.path.dirname(DB_DIR), exist_ok=True)
    
    # Initialize Persistent Client
    _chroma_client = chromadb.PersistentClient(path=DB_DIR)
    
    # We use the default embedding function (all-MiniLM-L6-v2) 
    # it is free, offline, and lightweight.
    ef = embedding_functions.DefaultEmbeddingFunction()
    
    _collection = _chroma_client.get_or_create_collection(
        name="system_design_knowledge",
        embedding_function=ef
    )
    
    # Load knowledge base and upsert
    if os.path.exists(KNOWLEDGE_FILE):
        try:
            with open(KNOWLEDGE_FILE, "r", encoding="utf-8") as f:
                data = json.load(f)
            
            if isinstance(data, list):
                documents = []
                metadatas = []
                ids = []
                
                for idx, item in enumerate(data):
                    # We can format the chunk
                    topic = item.get("topic", "General")
                    content = item.get("content", "")
                    if content:
                        text = f"Topic: {topic}\nContent: {content}"
                        documents.append(text)
                        metadatas.append({"topic": topic})
                        ids.append(f"kb_{idx}")
                
                if documents:
                    _collection.upsert(
                        documents=documents,
                        metadatas=metadatas,
                        ids=ids
                    )
                    print(f"[RAG] Indexed {len(documents)} chunks from knowledge base.")
            else:
                print("[RAG] Warning: knowledge.json must be a JSON array of objects.")
        except Exception as e:
            print(f"[RAG] Error loading knowledge base: {e}")
    else:
        print(f"[RAG] No knowledge.json found at {KNOWLEDGE_FILE}. Skipping RAG init.")

def search_knowledge(query_text: str, n_results: int = 3) -> str:
    """Queries the vector database and returns a formatted context string."""
    if not _collection:
        return ""
        
    try:
        count = _collection.count()
        if count == 0:
            return ""
            
        actual_n = min(n_results, count)
        
        results = _collection.query(
            query_texts=[query_text],
            n_results=actual_n
        )
        
        if not results or not results.get("documents") or len(results["documents"]) == 0 or len(results["documents"][0]) == 0:
            return ""
            
        context_chunks = results["documents"][0]
        return "\n\n".join([f"--- Context {i+1} ---\n{chunk}" for i, chunk in enumerate(context_chunks)])
    except Exception as e:
        print(f"[RAG] Query error: {e}")
        return ""


async def search_knowledge_async(query_text: str, n_results: int = 3) -> str:
    """
    Async wrapper — runs the blocking ChromaDB + embedding inference in a
    thread pool so it never stalls the FastAPI event loop.
    Also caches results for 5 minutes to avoid re-embedding the same query.
    """
    import asyncio
    from app.core.cache import rag_cache

    # Check the RAG cache first — avoids sentence-transformer inference entirely
    cache_key = f"{query_text}:{n_results}"
    cached = rag_cache.get(cache_key)
    if cached is not None:
        return cached

    loop = asyncio.get_event_loop()
    result = await loop.run_in_executor(None, search_knowledge, query_text, n_results)

    # Store in RAG cache for next time
    rag_cache.set(cache_key, result)
    return result

def ingest_document(text: str, filename: str):
    """Chunks and ingests a custom document into ChromaDB."""
    if not _collection:
        return
        
    # simple chunking by paragraphs
    chunks = [c.strip() for c in text.split('\n\n') if len(c.strip()) > 50]
    if not chunks:
        return
        
    documents = []
    metadatas = []
    ids = []
    
    import uuid
    for i, chunk in enumerate(chunks):
        documents.append(chunk)
        metadatas.append({"source": filename, "type": "user_upload"})
        ids.append(str(uuid.uuid4()))
        
    _collection.upsert(documents=documents, metadatas=metadatas, ids=ids)
    print(f"[RAG] Ingested {len(documents)} chunks from {filename}")
