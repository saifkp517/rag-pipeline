import os

import torch
from transformers import AutoModelForSequenceClassification, AutoTokenizer

from pinecone.grpc import PineconeGRPC

from llama_index.embeddings.openai import OpenAIEmbedding
from llama_index.vector_stores.pinecone import PineconeVectorStore
from llama_index.core.vector_stores.types import VectorStoreQuery
from llama_index.core import VectorStoreIndex
from llama_index.core.retrievers import BaseRetriever, QueryFusionRetriever
from llama_index.core.schema import NodeWithScore, QueryBundle
from llama_index.retrievers.bm25 import BM25Retriever


class HybridRetriever(BaseRetriever):
    """Vector + BM25 fusion retrieval, reranked with a cross-encoder.

    This is the retrieval pipeline from reranker.py (steps 1-4), generalized
    to run against any query string instead of a single hardcoded sample_query,
    so it can be reused for every turn of a chat conversation.
    """

    def __init__(
        self,
        pinecone_index_name: str = "ezyiah-integration-index",
        rerank_top_n: int = 3,
    ):
        self._embed_model = OpenAIEmbedding(
            api_key=os.environ["OPENAI_API_KEY"],
            model="text-embedding-3-large",
            dimensions=1024,
        )

        pc = PineconeGRPC(api_key=os.environ["PINECONE_API_KEY"])
        pinecone_index = pc.Index(pinecone_index_name)
        self._vector_store = PineconeVectorStore(pinecone_index=pinecone_index)

        vector_index = VectorStoreIndex.from_vector_store(
            self._vector_store, embed_model=self._embed_model
        )
        self._vector_retriever = vector_index.as_retriever(similarity_top_k=10)

        self._rerank_model = AutoModelForSequenceClassification.from_pretrained(
            "cross-encoder/ms-marco-TinyBERT-L2"
        )
        self._rerank_tokenizer = AutoTokenizer.from_pretrained(
            "cross-encoder/ms-marco-TinyBERT-L2"
        )
        self._rerank_model.eval()
        self._rerank_top_n = rerank_top_n

        super().__init__()

    def _build_bm25_retriever(self, query_vector: list[float]) -> BM25Retriever:
        # corpus is small (~50-100 chunks) so we pull everything back from
        # pinecone and run BM25 over it in-memory
        all_chunks_query = VectorStoreQuery(
            query_embedding=query_vector, similarity_top_k=100
        )
        all_chunks_results = self._vector_store.query(all_chunks_query)
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
        query_str = query_bundle.query_str

        # step 1: convert query to vector (also needed for the bm25 bulk-fetch below)
        query_vector = self._embed_model.get_query_embedding(query_str)

        # step 2.1: build bm25 retriever over the current corpus
        bm25_retriever = self._build_bm25_retriever(query_vector)

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
