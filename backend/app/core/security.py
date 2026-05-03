import os
from fastapi import Security, HTTPException, status
from fastapi.security.api_key import APIKeyHeader

API_KEY = os.getenv("BACKEND_API_KEY")
API_KEY_NAME = "X-API-Key"

api_key_header = APIKeyHeader(name=API_KEY_NAME, auto_error=False)

async def get_api_key(api_key_header: str = Security(api_key_header)):
    if not API_KEY:
        # If no key is configured in backend, allow all (or reject all, depending on security stance)
        # We will allow all if not configured to prevent breaking local dev without .env
        return None
        
    if api_key_header == API_KEY:
        return api_key_header
        
    raise HTTPException(
        status_code=status.HTTP_403_FORBIDDEN, detail="Could not validate credentials"
    )
