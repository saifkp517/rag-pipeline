import os
from typing import Any, Dict, Iterator, List, Tuple

from dotenv import load_dotenv
from llama_index.core.base.llms.types import ChatMessage, MessageRole
from llama_index.core.chat_engine import ContextChatEngine
from llama_index.core.memory import ChatMemoryBuffer
from llama_index.core.retrievers import BaseRetriever
from llama_index.core.schema import NodeWithScore, QueryBundle
from llama_index.llms.openai import OpenAI

import guardrails
from hybrid_retriever import HybridRetriever

load_dotenv()

_llm = OpenAI(model="gpt-4o-mini", api_key=os.environ["OPENAI_API_KEY"])

NO_CONTEXT_MESSAGE = (
    "I couldn't find anything relevant to that in the documents assigned to me."
)

# Only conversation memory is per-session. In-memory dict for now -
# sessions are lost on restart and don't survive multiple server processes.
_memories: Dict[Tuple[str, str], ChatMemoryBuffer] = {}


class _PrefetchedRetriever(BaseRetriever):
    """Serves nodes that were already retrieved.

    Retrieval happens before the chat engine is built so the no-results case
    can be handled explicitly, and this avoids paying for it a second time.
    """

    def __init__(self, nodes: List[NodeWithScore]):
        self._nodes = nodes
        super().__init__()

    def _retrieve(self, query_bundle: QueryBundle) -> List[NodeWithScore]:
        return self._nodes


def stream_turn(bot: dict[str, Any], session_id: str, message: str) -> Iterator[str]:
    """Run one chat turn for a bot, yielding response tokens.

    Retrieval is done here rather than inside the chat engine because
    llama-index's synthesizer answers the literal string "Empty Response"
    when handed zero nodes - it never reaches the LLM, so the bot's system
    prompt is ignored. The two empty cases are meaningfully different and
    are handled separately below.
    """
    key = (bot["id"], session_id)
    if key not in _memories:
        _memories[key] = ChatMemoryBuffer.from_defaults(token_limit=3000)
    memory = _memories[key]

    rules = guardrails.normalize(bot.get("guardrails"))
    system_prompt = bot["system_prompt"] + guardrails.system_prompt_suffix(rules)
    document_ids = [doc["id"] for doc in bot["documents"]]

    # No documents assigned: answer from the system prompt alone, which is
    # what makes a prompt testable before any context is attached.
    if not document_ids:
        yield from _stream_without_context(memory, system_prompt, message)
        return

    nodes = HybridRetriever(document_ids).retrieve(message)
    if not nodes:
        memory.put(ChatMessage(role=MessageRole.USER, content=message))
        memory.put(ChatMessage(role=MessageRole.ASSISTANT, content=NO_CONTEXT_MESSAGE))
        yield NO_CONTEXT_MESSAGE
        return

    engine = ContextChatEngine.from_defaults(
        retriever=_PrefetchedRetriever(nodes),
        llm=_llm,
        memory=memory,
        system_prompt=system_prompt,
    )
    yield from engine.stream_chat(message).response_gen


def _stream_without_context(
    memory: ChatMemoryBuffer, system_prompt: str, message: str
) -> Iterator[str]:
    memory.put(ChatMessage(role=MessageRole.USER, content=message))
    messages = [
        ChatMessage(role=MessageRole.SYSTEM, content=system_prompt),
        *memory.get_all(),
    ]

    reply = ""
    for chunk in _llm.stream_chat(messages):
        delta = chunk.delta or ""
        reply += delta
        yield delta

    memory.put(ChatMessage(role=MessageRole.ASSISTANT, content=reply))


def forget_bot(bot_id: str) -> None:
    for key in [key for key in _memories if key[0] == bot_id]:
        del _memories[key]
