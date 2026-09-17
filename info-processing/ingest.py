# Combines pdf-parser.py (LlamaCloud PDF -> markdown) and
# semantic-chunking.py (markdown -> chunks -> embeddings -> Pinecone)
# into a single reusable ingestion function, so it can be called per
# uploaded file from server.py instead of run once as a script.

import os

from dotenv import load_dotenv
from llama_cloud_services import LlamaParse
from pinecone import ServerlessSpec
from pinecone.grpc import PineconeGRPC

from llama_index.core.ingestion import IngestionPipeline
from llama_index.core.node_parser import SemanticSplitterNodeParser
from llama_index.core.schema import Document
from llama_index.embeddings.openai import OpenAIEmbedding
from llama_index.vector_stores.pinecone import PineconeVectorStore

load_dotenv()

INDEX_NAME = "ezyiah-integration-index"

# Higher-level wrapper around the raw llama_cloud client - handles the
# upload + parse + poll-until-done cycle in one call.
_parser = LlamaParse(result_type="markdown")  # LLAMA_CLOUD_API_KEY env var

_embed_model = OpenAIEmbedding(
    api_key=os.environ["OPENAI_API_KEY"],
    model="text-embedding-3-large",
    dimensions=1024,
    embed_batch_size=100,
)

_pc = PineconeGRPC(api_key=os.environ["PINECONE_API_KEY"])
if not _pc.has_index(INDEX_NAME):
    _pc.create_index(
        INDEX_NAME,
        dimension=1024,
        spec=ServerlessSpec(cloud="aws", region="us-east-1"),
    )
_vector_store = PineconeVectorStore(pinecone_index=_pc.Index(INDEX_NAME))

# Same two-step pipeline as semantic-chunking.py: semantic chunking, then
# embedding. Built once at import time and reused across every upload.
_pipeline = IngestionPipeline(
    transformations=[
        SemanticSplitterNodeParser(
            buffer_size=1,
            breakpoint_percentile_threshold=95,
            embed_model=_embed_model,
        ),
        _embed_model,
    ],
    vector_store=_vector_store,
)


def parse_pdf_to_markdown(file_path: str) -> str:
    """Upload a PDF to LlamaCloud and return its parsed markdown text."""
    result = _parser.parse(file_path)
    return "\n\n".join(page.md for page in result.pages)


def ingest_pdf(file_path: str, filename: str) -> int:
    """Parse a PDF, chunk it, embed the chunks, and store them in Pinecone.

    Returns the number of chunks/nodes written.
    """
    markdown_text = parse_pdf_to_markdown(file_path)
    document = Document(text=markdown_text, metadata={"filename": filename})
    nodes = _pipeline.run(documents=[document], show_progress=True)
    return len(nodes)
