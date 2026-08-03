from fastapi import APIRouter, Request, Response, Body, Depends
from app.core.auth import (
    verify_google_token,
    get_or_create_user,
    create_session,
    set_session_cookie,
    get_current_user,
    delete_session,
)
from app.models.db_models import User

router = APIRouter()


@router.post("/google")
async def google_login(request: Request, response: Response, body: dict = Body(...)):
    credential = body.get("credential", "")
    claims = verify_google_token(credential)
    user = await get_or_create_user(claims)
    token = await create_session(user.id)
    set_session_cookie(response, token, request)
    return {
        "id": user.id,
        "email": user.email,
        "name": user.name,
        "picture": user.picture,
    }


@router.get("/me")
async def me(user: User = Depends(get_current_user)):
    return {
        "id": user.id,
        "email": user.email,
        "name": user.name,
        "picture": user.picture,
    }


@router.post("/logout")
async def logout(request: Request, response: Response):
    await delete_session(request, response)
    return {"status": "logged_out"}
