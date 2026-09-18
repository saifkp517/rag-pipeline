import json
import os
import sys
import tempfile
from contextlib import asynccontextmanager

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from starlette.concurrency import run_in_threadpool

import guardrails
import registry
from chat_engine import stream_turn

# ingest.py lives in the sibling info-processing/ directory, not a
# separate installed package, so it has to be added to the import path.
sys.path.append(os.path.join(os.path.dirname(__file__), "..", "info-processing"))
from ingest import delete_vectors, ingest_pdf  # noqa: E402


@asynccontextmanager
async def lifespan(app: FastAPI):
    registry.init_schema()
    yield


app = FastAPI(lifespan=lifespan)

# Allows the Next.js frontend to call this API from the browser. Without
# this, browsers block the request at the CORS preflight (OPTIONS) step
# before it ever reaches an endpoint. Defaults to local dev; set
# ALLOWED_ORIGINS (comma-separated) in production to the deployed
# frontend's origin(s), e.g. https://myapp.vercel.app.
allowed_origins = os.environ.get("ALLOWED_ORIGINS", "http://localhost:3000").split(",")
app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins,
    allow_methods=["*"],
    allow_headers=["*"],
)


class ChatRequest(BaseModel):
    message: str
    bot_id: str
    session_id: str | None = None


class BotCreateRequest(BaseModel):
    name: str
    system_prompt: str
    document_ids: list[str] = []
    guardrails: dict | None = None


class BotUpdateRequest(BaseModel):
    name: str | None = None
    system_prompt: str | None = None
    document_ids: list[str] | None = None
    guardrails: dict | None = None


@app.post("/chat/stream")
async def chat_stream(req: ChatRequest):
    bot = registry.get_bot(req.bot_id)
    if bot is None:
        raise HTTPException(status_code=404, detail="Bot not found")

    # Continues the caller's conversation if it is still inside the 24-hour
    # window, otherwise starts a new one and leaves the old one in place.
    # The client learns which it got from the session event below.
    session_id = registry.resolve_session(bot["id"], req.session_id)
    refusal = guardrails.check_message(
        guardrails.normalize(bot["guardrails"]), req.message
    )

    def event_generator():
        yield f"event: session\ndata: {json.dumps({'session_id': session_id})}\n\n"

        if refusal:
            # Stored like any other turn so a blocked message is visible in
            # the transcript rather than silently missing from it.
            registry.append_message(session_id, "user", req.message)
            registry.append_message(session_id, "assistant", refusal)
            yield f"data: {json.dumps({'token': refusal})}\n\n"
            yield "event: done\ndata: {}\n\n"
            return

        # NOTE: stream_turn is blocking/sync under the hood (embedding calls,
        # pinecone calls, cross-encoder inference, LLM generation), and this
        # generator runs on the asyncio event loop, so a slow turn will block
        # other concurrent requests. Fine for a single-user dev setup; move
        # this to a threadpool before serving multiple concurrent users.
        for token in stream_turn(bot, session_id, req.message):
            yield f"data: {json.dumps({'token': token})}\n\n"

        yield "event: done\ndata: {}\n\n"

    return StreamingResponse(event_generator(), media_type="text/event-stream")


@app.get("/documents")
async def get_documents():
    return registry.list_documents()


@app.post("/documents/upload")
async def upload_document(file: UploadFile = File(...)):
    if not (file.filename or "").lower().endswith(".pdf"):
        raise HTTPException(status_code=400, detail="Only PDF files are supported")

    with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as tmp:
        tmp.write(await file.read())
        tmp_path = tmp.name

    document_id = registry.create_document(file.filename)
    try:
        # Must run off the event loop: LlamaParse.parse() is a sync wrapper
        # that calls asyncio.run() internally, which fails when a loop is
        # already running in this thread. It also keeps the (slow) parse and
        # embed from blocking every other request.
        vector_ids = await run_in_threadpool(
            ingest_pdf, tmp_path, file.filename, document_id
        )
    except Exception:
        registry.mark_document_failed(document_id)
        raise
    finally:
        os.remove(tmp_path)

    registry.mark_document_ready(document_id, vector_ids)
    return {
        "id": document_id,
        "filename": file.filename,
        "nodes_created": len(vector_ids),
    }


@app.delete("/documents/{document_id}")
async def remove_document(document_id: str):
    vector_ids = registry.delete_document(document_id)
    if vector_ids is None:
        raise HTTPException(status_code=404, detail="Document not found")

    # Pinecone serverless can't delete by metadata filter, so the IDs the
    # registry recorded at ingestion time are what make this possible.
    delete_vectors(vector_ids)
    return {"id": document_id, "vectors_deleted": len(vector_ids)}


@app.get("/bots")
async def get_bots():
    return registry.list_bots()


@app.post("/bots")
async def create_bot(req: BotCreateRequest):
    return registry.create_bot(
        req.name,
        req.system_prompt,
        guardrails.normalize(req.guardrails),
        req.document_ids,
    )


@app.get("/bots/{bot_id}")
async def read_bot(bot_id: str):
    bot = registry.get_bot(bot_id)
    if bot is None:
        raise HTTPException(status_code=404, detail="Bot not found")
    return bot


@app.patch("/bots/{bot_id}")
async def patch_bot(bot_id: str, req: BotUpdateRequest):
    bot = registry.update_bot(
        bot_id,
        req.name,
        req.system_prompt,
        guardrails.normalize(req.guardrails) if req.guardrails is not None else None,
        req.document_ids,
    )
    if bot is None:
        raise HTTPException(status_code=404, detail="Bot not found")
    return bot


@app.delete("/bots/{bot_id}")
async def remove_bot(bot_id: str):
    # Document assignments, conversations and their messages all cascade
    # from this row. The documents themselves are shared with other bots and
    # stay in the registry and in Pinecone.
    if not registry.delete_bot(bot_id):
        raise HTTPException(status_code=404, detail="Bot not found")
    return {"id": bot_id}


@app.get("/bots/{bot_id}/sessions")
async def get_bot_sessions(bot_id: str):
    bot = registry.get_bot(bot_id)
    if bot is None:
        raise HTTPException(status_code=404, detail="Bot not found")
    return registry.list_sessions(bot["id"])


@app.get("/sessions/{session_id}/messages")
async def get_session_messages(session_id: str):
    messages = registry.list_messages(session_id)
    if messages is None:
        raise HTTPException(status_code=404, detail="Conversation not found")
    return messages


@app.delete("/sessions/{session_id}")
async def remove_session(session_id: str):
    if not registry.delete_session(session_id):
        raise HTTPException(status_code=404, detail="Conversation not found")
    return {"id": session_id}
