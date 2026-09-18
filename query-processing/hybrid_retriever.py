import os

import torch
from transformers import AutoModelForSequenceClassification, AutoTokenizer

from pinecone.grpc import PineconeGRPC

from llama_index.embeddings.openai import OpenAIEmbedding
from llama_index.vector_stores.pinecone import PineconeVectorStore
from llama_index.core.vector_stores.types import (
    FilterOperator,
    MetadataFilter,
    MetadataFilters,
    VectorStoreQuery,
)
from llama_index.core import VectorStoreIndex
from llama_index.core.retrievers import BaseRetriever, QueryFusionRetriever
from llama_index.core.schema import NodeWithScore, QueryBundle
from llama_index.retrievers.bm25 import BM25Retriever

INDEX_NAME = "ezyiah-integration-index"

# Loading the cross-encoder and opening the pinecone client costs seconds, so
# they're built once and shared by every bot's retriever - only the metadata
# filter differs per bot. Built lazily so importing this module doesn't
# require the pinecone index to exist yet (ingest.py creates it on demand).
_resources = None


def _get_resources():
    global _resources
    if _resources is not None:
        return _resources

    embed_model = OpenAIEmbedding(
        api_key=os.environ["OPENAI_API_KEY"],
        model="text-embedding-3-large",
        dimensions=1024,
    )

    pc = PineconeGRPC(api_key=os.environ["PINECONE_API_KEY"])
    vector_store = PineconeVectorStore(pinecone_index=pc.Index(INDEX_NAME))
    vector_index = VectorStoreIndex.from_vector_store(
        vector_store, embed_model=embed_model
    )

    rerank_model = AutoModelForSequenceClassification.from_pretrained(
        "cross-encoder/ms-marco-TinyBERT-L2"
    )
    rerank_model.eval()
    rerank_tokenizer = AutoTokenizer.from_pretrained(
        "cross-encoder/ms-marco-TinyBERT-L2"
    )

    _resources = {
        "embed_model": embed_model,
        "vector_store": vector_store,
        "vector_index": vector_index,
        "rerank_model": rerank_model,
        "rerank_tokenizer": rerank_tokenizer,
    }
    return _resources


class HybridRetriever(BaseRetriever):
    """Vector + BM25 fusion retrieval, reranked with a cross-encoder.

    Scoped to the documents assigned to one bot. Scoping is done with a
    Pinecone metadata filter rather than a namespace so a single upload can
    feed several bots without being re-embedded for each one.
    """

    def __init__(self, document_ids: list[str], rerank_top_n: int = 3):
        res = _get_resources()
        self._embed_model = res["embed_model"]
        self._vector_store = res["vector_store"]
        self._rerank_model = res["rerank_model"]
        self._rerank_tokenizer = res["rerank_tokenizer"]
        self._rerank_top_n = rerank_top_n
        self._document_ids = document_ids

        self._filters = MetadataFilters(
            filters=[
                MetadataFilter(
                    key="document_id",
                    operator=FilterOperator.IN,
                    value=document_ids,
                )
            ]
        )
        self._vector_retriever = res["vector_index"].as_retriever(
            similarity_top_k=10, filters=self._filters
        )

        super().__init__()

    def _build_bm25_retriever(self, query_vector: list[float]) -> BM25Retriever | None:
        # corpus is small (~50-100 chunks) so we pull everything back from
        # pinecone and run BM25 over it in-memory. The same filter as the
        # vector side has to be applied here, otherwise BM25 would score
        # other bots' chunks and fusion would leak them into the results.
        all_chunks_query = VectorStoreQuery(
            query_embedding=query_vector,
            similarity_top_k=100,
            filters=self._filters,
        )
        all_chunks_results = self._vector_store.query(all_chunks_query)
        # BM25Retriever rejects an empty node list, so an assigned document
        # whose chunks aren't queryable yet would otherwise crash the turn.
        if not all_chunks_results.nodes:
            return None
        return BM25Retriever.from_defaults(
            nodes=all_chunks_results.nodes,
            similarity_top_k=10,
        )

    def _rerank(
        self, query_str: str, nodes: list[NodeWithScore]
    ) -> list[NodeWithScore]:
        if not nodes:
            return []

        chunk_texts = [node.get_content() for node in nodes]
        pairs = self._rerank_tokenizer(
            [query_str] * len(chunk_texts),
            chunk_texts,
            padding=True,
            truncation=True,
            return_tensors="pt",
        )

        with torch.no_grad():
            scores = self._rerank_model(**pairs).logits.squeeze(-1)

        reranked = sorted(
            zip(nodes, scores.tolist()), key=lambda pair: pair[1], reverse=True
        )
        return [node for node, _ in reranked[: self._rerank_top_n]]

    def _retrieve(self, query_bundle: QueryBundle) -> list[NodeWithScore]:
        # A bot with no documents assigned answers from its system prompt
        # alone - an empty $in filter would match nothing anyway.
        if not self._document_ids:
            return []

        query_str = query_bundle.query_str

        # step 1: convert query to vector (also needed for the bm25 bulk-fetch below)
        query_vector = self._embed_model.get_query_embedding(query_str)

        # step 2.1: build bm25 retriever over the current corpus
        bm25_retriever = self._build_bm25_retriever(query_vector)
        if bm25_retriever is None:
            return self._rerank(query_str, self._vector_retriever.retrieve(query_bundle))

        # step 3: fuse vector + bm25 results
        fusion_retriever = QueryFusionRetriever(
            [self._vector_retriever, bm25_retriever],
            similarity_top_k=5,
            num_queries=1,
            mode="reciprocal_rerank",
            use_async=False,
        )
        fused_results = fusion_retriever.retrieve(query_bundle)

        # step 4: rerank down to the best few chunks
        return self._rerank(query_str, fused_results)
