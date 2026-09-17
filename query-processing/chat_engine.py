import os
from typing import Dict

from dotenv import load_dotenv
from llama_index.core.chat_engine import CondenseQuestionChatEngine
from llama_index.core.memory import ChatMemoryBuffer
from llama_index.core.query_engine import RetrieverQueryEngine
from llama_index.llms.openai import OpenAI

from hybrid_retriever import HybridRetriever

load_dotenv()

# The retriever and query engine are stateless per-query and expensive to build
# (loads the cross-encoder model, opens a pinecone client), so they're shared
# across every chat session instead of rebuilt per session.
_llm = OpenAI(model="gpt-4o-mini", api_key=os.environ["OPENAI_API_KEY"])
_retriever = HybridRetriever()
_query_engine = RetrieverQueryEngine.from_args(
    _retriever,
    llm=_llm,
    streaming=True,
)

# Only conversation memory is per-session. In-memory dict for now -
# sessions are lost on restart and don't survive multiple server processes.
_sessions: Dict[str, CondenseQuestionChatEngine] = {}


def get_chat_engine(session_id: str) -> CondenseQuestionChatEngine:
    if session_id not in _sessions:
        memory = ChatMemoryBuffer.from_defaults(token_limit=3000)
        _sessions[session_id] = CondenseQuestionChatEngine.from_defaults(
            query_engine=_query_engine,
            memory=memory,
            llm=_llm,
            verbose=True,
        )
    return _sessions[session_id]
