"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useRef, useState } from "react";
import { ApiError, getBot, streamChat, type Bot } from "@/lib/api";

interface Message {
  id: string;
  role: "user" | "bot";
  content: string;
  error?: boolean;
}

export default function ChatPage() {
  return (
    <Suspense fallback={null}>
      <ChatView />
    </Suspense>
  );
}

function ChatView() {
  const botSlug = useSearchParams().get("bot");
  const [bot, setBot] = useState<Bot | null>(null);
  const [botError, setBotError] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const sessionIdRef = useRef<string | undefined>(undefined);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!botSlug) return;
    setBot(null);
    setBotError(null);
    setMessages([]);
    sessionIdRef.current = undefined;

    getBot(botSlug)
      .then(setBot)
      .catch((err) =>
        setBotError(err instanceof ApiError ? err.message : "Bot not found.")
      );
  }, [botSlug]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  async function handleSend() {
    const text = input.trim();
    if (!text || isStreaming || !bot) return;

    setInput("");
    setMessages((prev) => [
      ...prev,
      { id: crypto.randomUUID(), role: "user", content: text },
    ]);

    const replyId = crypto.randomUUID();
    setMessages((prev) => [...prev, { id: replyId, role: "bot", content: "" }]);
    setIsStreaming(true);

    try {
      for await (const event of streamChat(text, bot.id, sessionIdRef.current)) {
        if (event.type === "session") {
          sessionIdRef.current = event.sessionId;
        } else if (event.type === "token") {
          setMessages((prev) =>
            prev.map((m) =>
              m.id === replyId ? { ...m, content: m.content + event.token } : m
            )
          );
        } else if (event.type === "done") {
          break;
        }
      }
    } catch {
      setMessages((prev) =>
        prev.map((m) =>
          m.id === replyId
            ? {
                ...m,
                content:
                  m.content || "Something went wrong while getting a response.",
                error: true,
              }
            : m
        )
      );
    } finally {
      setIsStreaming(false);
    }
  }

  if (!botSlug || botError) {
    return (
      <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col items-center justify-center gap-3 px-4 py-6 text-center">
        <p className="text-sm text-slate-500">
          {botError ?? "Pick a bot to start chatting."}
        </p>
        <Link
          href="/dashboard"
          className="rounded-lg bg-teal-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-teal-500"
        >
          Go to dashboard
        </Link>
      </main>
    );
  }

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col px-4 py-6">
      <div className="flex-1 space-y-5 overflow-y-auto pb-4">
        {messages.length === 0 && (
          <div className="flex h-full flex-col items-center justify-center gap-3 pt-16 text-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-gradient-to-br from-teal-500 to-violet-600 text-lg font-bold text-white shadow-sm">
              {bot ? bot.name.charAt(0).toUpperCase() : "R"}
            </div>
            <p className="text-sm font-medium text-slate-900">
              {bot?.name ?? "Loading..."}
            </p>
            {bot && (
              <p className="text-sm text-slate-500">
                {bot.documents.length > 0
                  ? `Drawing on ${bot.documents.length} document${
                      bot.documents.length === 1 ? "" : "s"
                    }.`
                  : "No documents assigned - answers come from its prompt alone."}
              </p>
            )}
          </div>
        )}
        {messages.map((message) => (
          <div
            key={message.id}
            className={`flex items-end gap-2 ${
              message.role === "user" ? "flex-row-reverse" : "flex-row"
            }`}
          >
            <div
              className={`flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full text-xs font-semibold ${
                message.role === "user"
                  ? "bg-slate-200 text-slate-600"
                  : "bg-gradient-to-br from-teal-500 to-violet-600 text-white"
              }`}
            >
              {message.role === "user"
                ? "You"
                : (bot?.name.charAt(0).toUpperCase() ?? "R")}
            </div>
            <div
              className={`max-w-[75%] whitespace-pre-wrap rounded-2xl px-4 py-2.5 text-sm leading-relaxed ${
                message.role === "user"
                  ? "rounded-br-sm bg-gradient-to-br from-teal-600 to-violet-600 text-white shadow-sm"
                  : message.error
                  ? "rounded-bl-sm border border-red-200 bg-red-50 text-red-700"
                  : "rounded-bl-sm border border-slate-200 bg-white text-slate-800 shadow-sm"
              }`}
            >
              {message.content || (
                <span className="inline-flex items-center gap-1 py-0.5">
                  <Dot />
                  <Dot delay="150ms" />
                  <Dot delay="300ms" />
                </span>
              )}
            </div>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>

      <div className="flex items-center gap-2 rounded-2xl border border-slate-200 bg-white p-1.5 shadow-sm">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              handleSend();
            }
          }}
          disabled={isStreaming || !bot}
          placeholder={bot ? `Message ${bot.name}...` : "Loading bot..."}
          className="flex-1 bg-transparent px-3 py-2 text-sm text-slate-900 outline-none placeholder:text-slate-400 disabled:opacity-60"
        />
        <button
          onClick={handleSend}
          disabled={isStreaming || !input.trim() || !bot}
          className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full bg-teal-600 text-white transition-colors hover:bg-teal-500 disabled:cursor-not-allowed disabled:bg-slate-300"
          aria-label="Send message"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 24 24"
            fill="currentColor"
            className="h-4 w-4 -mr-px"
          >
            <path d="M3.4 20.6 21 12 3.4 3.4 3 10l12 2-12 2z" />
          </svg>
        </button>
      </div>
    </main>
  );
}

function Dot({ delay }: { delay?: string }) {
  return (
    <span
      className="h-1.5 w-1.5 animate-bounce rounded-full bg-slate-400"
      style={{ animationDelay: delay }}
    />
  );
}
