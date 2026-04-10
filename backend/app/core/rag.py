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
        # Check how many items are actually in the collection
        count = _collection.count()
        if count == 0:
            return ""
            
        # Don't ask for more results than we have
        actual_n = min(n_results, count)
        
        results = _collection.query(
            query_texts=[query_text],
            n_results=actual_n
        )
        
        if not results or not results.get("documents") or len(results["documents"]) == 0 or len(results["documents"][0]) == 0:
            return ""
            
        context_chunks = results["documents"][0]
        context_str = "\n\n".join([f"--- Context Chunk {i+1} ---\n{chunk}" for i, chunk in enumerate(context_chunks)])
        return context_str
    except Exception as e:
        print(f"[RAG] Error querying knowledge base: {e}")
        return ""
