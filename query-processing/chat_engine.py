import os
from typing import Any, Iterator, List

from dotenv import load_dotenv
from llama_index.core.base.llms.types import ChatMessage, MessageRole
from llama_index.core.chat_engine import ContextChatEngine
from llama_index.core.memory import ChatMemoryBuffer
from llama_index.core.retrievers import BaseRetriever
from llama_index.core.schema import NodeWithScore, QueryBundle
from llama_index.llms.openai import OpenAI

import guardrails
import registry
from hybrid_retriever import HybridRetriever

load_dotenv()

_llm = OpenAI(model="gpt-4o-mini", api_key=os.environ["OPENAI_API_KEY"])

NO_CONTEXT_MESSAGE = (
    "I couldn't find anything relevant to that in the documents assigned to me."
)

MEMORY_TOKEN_LIMIT = 3000


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

    Postgres is the conversation's source of truth: prior messages are read
    back into a throwaway memory buffer at the start of the turn and both
    sides of the exchange are written at the end. Nothing is cached between
    turns, so history survives restarts and extra worker processes.
    """
    memory = ChatMemoryBuffer.from_defaults(
        token_limit=MEMORY_TOKEN_LIMIT,
        chat_history=[
            ChatMessage(role=MessageRole(entry["role"]), content=entry["content"])
            for entry in registry.session_history(session_id)
        ],
    )
    registry.append_message(session_id, MessageRole.USER.value, message)

    reply = ""
    try:
        for token in _generate(bot, memory, message):
            reply += token
            yield token
    finally:
        # In a finally so a client that disconnects mid-stream still leaves a
        # stored answer rather than a user message with nothing beside it.
        if reply:
            registry.append_message(session_id, MessageRole.ASSISTANT.value, reply)


def _generate(
    bot: dict[str, Any], memory: ChatMemoryBuffer, message: str
) -> Iterator[str]:
    """Produce the reply tokens for one turn.

    Retrieval is done here rather than inside the chat engine because
    llama-index's synthesizer answers the literal string "Empty Response"
    when handed zero nodes - it never reaches the LLM, so the bot's system
    prompt is ignored. The two empty cases are meaningfully different and
    are handled separately below.
    """
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
    messages = [
        ChatMessage(role=MessageRole.SYSTEM, content=system_prompt),
        *memory.get_all(),
        ChatMessage(role=MessageRole.USER, content=message),
    ]

    for chunk in _llm.stream_chat(messages):
        yield chunk.delta or ""
