import json
import os
import sys
import tempfile
import uuid

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from chat_engine import get_chat_engine

# ingest.py lives in the sibling info-processing/ directory, not a
# separate installed package, so it has to be added to the import path.
sys.path.append(os.path.join(os.path.dirname(__file__), "..", "info-processing"))
from ingest import ingest_pdf  # noqa: E402

app = FastAPI()

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
    session_id: str | None = None


@app.post("/chat/stream")
async def chat_stream(req: ChatRequest):
    session_id = req.session_id or str(uuid.uuid4())
    chat_engine = get_chat_engine(session_id)

    def event_generator():
        yield f"event: session\ndata: {json.dumps({'session_id': session_id})}\n\n"

        # NOTE: stream_chat + response_gen are blocking/sync under the hood
        # (embedding calls, pinecone calls, cross-encoder inference, LLM
        # generation), and this generator runs on the asyncio event loop,
        # so a slow turn will block other concurrent requests. Fine for a
        # single-user dev setup; move this to a threadpool before serving
        # multiple concurrent users.
        streaming_response = chat_engine.stream_chat(req.message)
        for token in streaming_response.response_gen:
            yield f"data: {json.dumps({'token': token})}\n\n"

        yield "event: done\ndata: {}\n\n"

    return StreamingResponse(event_generator(), media_type="text/event-stream")


@app.post("/documents/upload")
async def upload_document(file: UploadFile = File(...)):
    if not (file.filename or "").lower().endswith(".pdf"):
        raise HTTPException(status_code=400, detail="Only PDF files are supported")

    # NOTE: ingest_pdf is blocking (LlamaCloud parse, embedding calls,
    # pinecone upsert) and runs on the asyncio event loop, same caveat as
    # chat_stream above. Fine for single-user dev; move to a threadpool
    # before serving concurrent uploads.
    with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as tmp:
        tmp.write(await file.read())
        tmp_path = tmp.name

    try:
        node_count = ingest_pdf(tmp_path, file.filename)
    finally:
        os.remove(tmp_path)

    return {"filename": file.filename, "nodes_created": node_count}
