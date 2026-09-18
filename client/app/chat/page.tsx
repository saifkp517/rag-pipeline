"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import {
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";
import {
  ApiError,
  getBot,
  listSessionMessages,
  listSessions,
  streamChat,
  type Bot,
  type ChatSession,
} from "@/lib/api";

interface Message {
  id: string;
  role: "user" | "bot";
  content: string;
  error?: boolean;
}

/** Remembers which conversation this browser was last in, per bot. */
const storageKey = (botId: string) => `chat-session:${botId}`;

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
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [isLoadingHistory, setIsLoadingHistory] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  // streamChat needs the current session synchronously, before a state
  // update would have landed.
  const sessionIdRef = useRef<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const selectSession = useCallback(async (id: string | null, botId: string) => {
    sessionIdRef.current = id;
    setSessionId(id);
    setMessages([]);
    setSidebarOpen(false);

    try {
      if (id) localStorage.setItem(storageKey(botId), id);
      else localStorage.removeItem(storageKey(botId));
    } catch {
      // private mode / blocked storage - the conversation still works,
      // it just won't be restored on the next visit.
    }

    if (!id) return;

    setIsLoadingHistory(true);
    try {
      const stored = await listSessionMessages(id);
      // Ignore if the user switched conversations while this was in flight.
      if (sessionIdRef.current !== id) return;
      setMessages(
        stored.map((m) => ({
          id: m.id,
          role: m.role === "user" ? "user" : "bot",
          content: m.content,
        }))
      );
    } catch {
      // A conversation that has since been deleted: fall back to a new one.
      if (sessionIdRef.current === id) selectSession(null, botId);
    } finally {
      setIsLoadingHistory(false);
    }
  }, []);

  useEffect(() => {
    if (!botSlug) return;
    let cancelled = false;

    setBot(null);
    setBotError(null);
    setSessions([]);
    setMessages([]);
    setSessionId(null);
    sessionIdRef.current = null;

    getBot(botSlug)
      .then(async (loaded) => {
        if (cancelled) return;
        setBot(loaded);

        const existing = await listSessions(loaded.id).catch(
          () => [] as ChatSession[]
        );
        if (cancelled) return;
        setSessions(existing);

        let remembered: string | null = null;
        try {
          remembered = localStorage.getItem(storageKey(loaded.id));
        } catch {
          // no stored session available
        }
        // Resume only a conversation that still exists; an expired one is
        // still openable as history, the server just won't append to it.
        const resume = existing.find((s) => s.id === remembered)?.id ?? null;
        selectSession(resume, loaded.id);
      })
      .catch((err) => {
        if (!cancelled) {
          setBotError(err instanceof ApiError ? err.message : "Bot not found.");
        }
      });

    return () => {
      cancelled = true;
    };
  }, [botSlug, selectSession]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [input]);

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
      for await (const event of streamChat(
        text,
        bot.id,
        sessionIdRef.current ?? undefined
      )) {
        if (event.type === "session") {
          if (event.sessionId !== sessionIdRef.current) {
            // The server started a new conversation - either this is the
            // first message, or the previous one passed its 24-hour window.
            // Drop the old transcript so the thread on screen matches the
            // one being stored; it stays available in the sidebar.
            sessionIdRef.current = event.sessionId;
            setSessionId(event.sessionId);
            setMessages((prev) => prev.slice(-2));
            try {
              localStorage.setItem(storageKey(bot.id), event.sessionId);
            } catch {
              // storage unavailable; session still works for this visit
            }
          }
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
      listSessions(bot.id).then(setSessions).catch(() => {});
    }
  }

  function handleComposerKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  if (!botSlug || botError) {
    return (
      <main className="flex h-dvh flex-1 flex-col items-center justify-center gap-3 bg-slate-50 px-4 text-center">
        <p className="text-sm text-slate-500">
          {botError ?? "Pick a bot to start chatting."}
        </p>
        <Link
          href="/dashboard"
          className="rounded-full bg-teal-600 px-4 py-2 text-sm font-medium text-white shadow-sm transition-colors hover:bg-teal-500"
        >
          Go to dashboard
        </Link>
      </main>
    );
  }

  const current = sessions.find((s) => s.id === sessionId);
  const isClosed = current ? !current.active : false;

  return (
    <div className="flex h-dvh w-full bg-slate-50 text-slate-900">
      {sidebarOpen && (
        <button
          aria-label="Close sidebar"
          onClick={() => setSidebarOpen(false)}
          className="fixed inset-0 z-20 bg-slate-900/40 backdrop-blur-sm md:hidden"
        />
      )}

      <aside
        className={`fixed inset-y-0 left-0 z-30 flex w-[280px] flex-shrink-0 -translate-x-full flex-col border-r border-slate-200 bg-white p-3 transition-transform duration-200 ease-out md:static md:w-[360px] md:translate-x-0 ${
          sidebarOpen ? "translate-x-0" : ""
        }`}
      >
        <Link
          href="/dashboard"
          className="mb-4 flex items-center gap-2 rounded-lg px-2 py-1.5 transition-colors hover:bg-slate-100"
        >
          <span className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-teal-500 to-violet-600 text-sm font-bold text-white">
            R
          </span>
          <span className="text-sm font-semibold tracking-tight text-slate-900">
            RAG Chat
          </span>
        </Link>

        <button
          onClick={() => bot && selectSession(null, bot.id)}
          disabled={!bot || isStreaming || sessionId === null}
          className="mb-4 flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm font-medium text-slate-700 shadow-sm transition-colors hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            className="h-4 w-4"
          >
            <path d="M12 5v14M5 12h14" />
          </svg>
          New chat
        </button>

        <nav className="mb-4 flex flex-col gap-0.5">
          <Link
            href="/dashboard"
            className="flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-900"
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="h-4 w-4 flex-shrink-0"
            >
              <rect x="3" y="3" width="7" height="9" rx="1.5" />
              <rect x="14" y="3" width="7" height="5" rx="1.5" />
              <rect x="14" y="12" width="7" height="9" rx="1.5" />
              <rect x="3" y="16" width="7" height="5" rx="1.5" />
            </svg>
            Dashboard
          </Link>
          <span className="flex items-center gap-2.5 rounded-lg bg-slate-100 px-3 py-2 text-sm font-medium text-slate-900">
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="h-4 w-4 flex-shrink-0"
            >
              <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5Z" />
            </svg>
            Chat
          </span>
        </nav>

        {bot && (
          <div className="mb-2 flex items-start gap-2.5 rounded-lg px-3 py-2">
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="mt-0.5 h-4 w-4 flex-shrink-0 text-slate-400"
            >
              <path d="M3 7v10a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-7l-2-2H5a2 2 0 0 0-2 2Z" />
            </svg>
            <div className="min-w-0">
              <p className="text-xs font-medium uppercase tracking-wide text-slate-400">
                Workspace
              </p>
              <p className="mt-1 truncate text-sm text-slate-700">{bot.name}</p>
              <p className="mt-0.5 text-xs text-slate-400">
                {bot.documents.length > 0
                  ? `${bot.documents.length} document${
                      bot.documents.length === 1 ? "" : "s"
                    } assigned`
                  : "No documents assigned"}
              </p>
            </div>
          </div>
        )}

        <p className="px-3 pb-1.5 pt-2 text-xs font-medium uppercase tracking-wide text-slate-400">
          Conversations
        </p>

        <div className="flex-1 space-y-0.5 overflow-y-auto">
          {sessions.length === 0 && (
            <p className="px-3 text-xs text-slate-400">No conversations yet.</p>
          )}
          {sessions.map((session) => (
            <button
              key={session.id}
              onClick={() => bot && selectSession(session.id, bot.id)}
              disabled={isStreaming}
              className={`flex w-full items-start gap-2.5 rounded-lg px-3 py-2 text-left transition-colors disabled:cursor-not-allowed ${
                session.id === sessionId
                  ? "bg-teal-50 text-slate-900 ring-1 ring-teal-500/30"
                  : "text-slate-500 hover:bg-slate-100 hover:text-slate-800"
              }`}
            >
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                className={`mt-0.5 h-4 w-4 flex-shrink-0 ${
                  session.id === sessionId ? "text-teal-600" : "text-slate-400"
                }`}
              >
                <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5Z" />
              </svg>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm">
                  {session.preview ?? "Empty conversation"}
                </span>
                <span className="mt-0.5 flex items-center gap-1.5 text-xs text-slate-400">
                  {formatWhen(session.last_message_at)}
                  {!session.active && (
                    <span className="rounded bg-slate-200 px-1.5 py-px text-[10px] font-medium text-slate-500">
                      closed
                    </span>
                  )}
                </span>
              </span>
            </button>
          ))}
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center gap-2 border-b border-slate-200 bg-white px-4 py-3 md:hidden">
          <button
            onClick={() => setSidebarOpen(true)}
            aria-label="Open sidebar"
            className="flex h-9 w-9 items-center justify-center rounded-lg text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700"
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              className="h-5 w-5"
            >
              <path d="M4 6h16M4 12h16M4 18h16" />
            </svg>
          </button>
          <span className="min-w-0 flex-1 truncate text-sm font-medium text-slate-700">
            {bot?.name ?? "Loading..."}
          </span>
          <Link
            href="/dashboard"
            aria-label="Back to dashboard"
            className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700"
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="h-5 w-5"
            >
              <rect x="3" y="10" width="18" height="11" rx="1.5" />
              <path d="M8 21V13h8v8M9 10V6a3 3 0 0 1 6 0v4" />
            </svg>
          </Link>
        </div>

        <div className="flex-1 overflow-y-auto">
          {messages.length === 0 && !isLoadingHistory ? (
            <div className="flex h-full flex-col items-center justify-center gap-6 px-4 pb-24 pt-16">
              <div className="flex flex-col items-center gap-3 text-center">
                <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-gradient-to-br from-teal-500 to-violet-600 text-lg font-bold text-white shadow-sm">
                  {bot ? bot.name.charAt(0).toUpperCase() : "R"}
                </div>
                <h1 className="text-2xl font-medium tracking-tight text-slate-900">
                  {bot ? `Chat with ${bot.name}` : "Loading..."}
                </h1>
                {bot && (
                  <p className="max-w-sm text-sm text-slate-500">
                    {bot.documents.length > 0
                      ? `Drawing on ${bot.documents.length} document${
                          bot.documents.length === 1 ? "" : "s"
                        }.`
                      : "No documents assigned - answers come from its prompt alone."}
                  </p>
                )}
              </div>
              <div className="w-full max-w-2xl px-4">
                <Composer
                  input={input}
                  setInput={setInput}
                  onSend={handleSend}
                  onKeyDown={handleComposerKeyDown}
                  disabled={isStreaming || !bot}
                  placeholder={bot ? `Message ${bot.name}` : "Loading bot..."}
                  textareaRef={textareaRef}
                />
              </div>
            </div>
          ) : (
            <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-6 md:px-8">
              {messages.map((message) => (
                <div
                  key={message.id}
                  className={`flex gap-3 ${
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
                      ? "Y"
                      : (bot?.name.charAt(0).toUpperCase() ?? "R")}
                  </div>
                  <div
                    className={`max-w-[75%] whitespace-pre-wrap rounded-2xl px-4 py-2.5 text-sm leading-relaxed ${
                      message.role === "user"
                        ? "bg-gradient-to-br from-teal-600 to-violet-600 text-white shadow-sm"
                        : message.error
                        ? "border border-red-200 bg-red-50 text-red-700"
                        : "border border-slate-200 bg-white text-slate-800 shadow-sm"
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
          )}
        </div>

        {messages.length > 0 || isLoadingHistory ? (
          <div className="mx-auto w-full max-w-3xl px-4 pb-6 md:px-8">
            {isClosed && (
              <p className="mb-2 rounded-lg bg-slate-100 px-3 py-2 text-xs text-slate-500">
                This conversation closed after 24 hours of inactivity. Sending a
                message starts a new one.
              </p>
            )}
            <Composer
              input={input}
              setInput={setInput}
              onSend={handleSend}
              onKeyDown={handleComposerKeyDown}
              disabled={isStreaming || !bot}
              placeholder={bot ? `Message ${bot.name}` : "Loading bot..."}
              textareaRef={textareaRef}
            />
          </div>
        ) : null}
      </div>
    </div>
  );
}

function Composer({
  input,
  setInput,
  onSend,
  onKeyDown,
  disabled,
  placeholder,
  textareaRef,
}: {
  input: string;
  setInput: (v: string) => void;
  onSend: () => void;
  onKeyDown: (e: KeyboardEvent<HTMLTextAreaElement>) => void;
  disabled: boolean;
  placeholder: string;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
}) {
  return (
    <div className="rounded-[28px] border border-slate-200 bg-white p-2.5 shadow-sm transition-shadow focus-within:border-teal-300 focus-within:ring-1 focus-within:ring-teal-200">
      <textarea
        ref={textareaRef}
        rows={1}
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={onKeyDown}
        disabled={disabled}
        placeholder={placeholder}
        className="max-h-[200px] w-full resize-none bg-transparent px-3 py-2 text-sm text-slate-900 outline-none placeholder:text-slate-400 disabled:opacity-60"
      />
      <div className="flex items-center justify-between px-1 pt-1">
        <div className="flex items-center gap-1">
          <IconButton label="Add attachment">
            <path d="M12 5v14M5 12h14" />
          </IconButton>
          <button
            type="button"
            disabled
            className="flex h-8 items-center gap-1.5 rounded-full px-3 text-xs font-medium text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-700 disabled:cursor-default"
          >
            gpt-4o-mini
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="h-3 w-3"
            >
              <path d="m6 9 6 6 6-6" />
            </svg>
          </button>
        </div>
        <div className="flex items-center gap-1">
          <IconButton label="Voice input">
            <path d="M12 2a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
            <path d="M19 10v1a7 7 0 0 1-14 0v-1M12 18v3" />
          </IconButton>
          <button
            onClick={onSend}
            disabled={disabled || !input.trim()}
            aria-label="Send message"
            className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full bg-teal-600 text-white shadow-sm transition-all hover:bg-teal-500 disabled:cursor-not-allowed disabled:bg-slate-200 disabled:text-slate-400 disabled:shadow-none"
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="h-4 w-4"
            >
              <path d="M12 19V5M5 12l7-7 7 7" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
}

function IconButton({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      disabled
      aria-label={label}
      className="flex h-8 w-8 items-center justify-center rounded-full text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700 disabled:cursor-default"
    >
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="h-4 w-4"
      >
        {children}
      </svg>
    </button>
  );
}

function formatWhen(iso: string): string {
  const date = new Date(iso);
  const isToday = new Date().toDateString() === date.toDateString();
  return isToday
    ? date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
    : date.toLocaleDateString([], { month: "short", day: "numeric" });
}

function Dot({ delay }: { delay?: string }) {
  return (
    <span
      className="h-1.5 w-1.5 animate-bounce rounded-full bg-slate-400"
      style={{ animationDelay: delay }}
    />
  );
}
