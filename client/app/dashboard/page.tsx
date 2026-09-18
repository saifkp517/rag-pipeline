"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ApiError,
  createBot,
  deleteBot,
  deleteDocument,
  listBots,
  listDocuments,
  updateBot,
  uploadDocument,
  type Bot,
  type DocumentSummary,
} from "@/lib/api";

interface ConfirmRequest {
  title: string;
  message: string;
  confirmLabel: string;
  onConfirm: () => void | Promise<void>;
}

export default function DashboardPage() {
  const [documents, setDocuments] = useState<DocumentSummary[]>([]);
  const [bots, setBots] = useState<Bot[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [confirmRequest, setConfirmRequest] = useState<ConfirmRequest | null>(
    null
  );

  const refresh = useCallback(async () => {
    try {
      const [docs, loadedBots] = await Promise.all([
        listDocuments(),
        listBots(),
      ]);
      setDocuments(docs);
      setBots(loadedBots);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to load data.");
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return (
    <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-10">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-slate-900">
          Bot dashboard
        </h1>
        <p className="mt-1 text-sm text-slate-500">
          Upload documents, then deploy bots that draw on different
          combinations of them.
        </p>
      </div>

      {error && <ErrorBanner message={error} />}

      <div className="mt-8 grid gap-6 lg:grid-cols-2">
        <DocumentsPanel
          documents={documents}
          onChanged={refresh}
          onError={setError}
          onConfirm={setConfirmRequest}
        />
        <BotsPanel
          bots={bots}
          documents={documents}
          onChanged={refresh}
          onError={setError}
          onConfirm={setConfirmRequest}
        />
      </div>

      {confirmRequest && (
        <ConfirmDialog
          request={confirmRequest}
          onClose={() => setConfirmRequest(null)}
        />
      )}
    </main>
  );
}

function ConfirmDialog({
  request,
  onClose,
}: {
  request: ConfirmRequest;
  onClose: () => void;
}) {
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-title"
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-sm rounded-2xl border border-slate-200 bg-white p-5 shadow-xl"
      >
        <h3
          id="confirm-title"
          className="text-sm font-semibold text-slate-900"
        >
          {request.title}
        </h3>
        <p className="mt-2 text-sm leading-relaxed text-slate-500">
          {request.message}
        </p>
        <div className="mt-5 flex justify-end gap-2">
          <button
            onClick={onClose}
            className="rounded-lg px-3 py-2 text-sm font-medium text-slate-600 transition-colors hover:bg-slate-100"
          >
            Cancel
          </button>
          <button
            autoFocus
            onClick={() => {
              request.onConfirm();
              onClose();
            }}
            className="rounded-lg bg-red-600 px-3 py-2 text-sm font-medium text-white shadow-sm transition-colors hover:bg-red-500"
          >
            {request.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

function DocumentsPanel({
  documents,
  onChanged,
  onError,
  onConfirm,
}: {
  documents: DocumentSummary[];
  onChanged: () => Promise<void>;
  onError: (message: string) => void;
  onConfirm: (request: ConfirmRequest) => void;
}) {
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  function pickFile(file: File | undefined | null) {
    if (!file) return;
    if (!file.name.toLowerCase().endsWith(".pdf")) {
      onError("Only PDF files are supported.");
      return;
    }
    setSelectedFile(file);
  }

  function clearFile() {
    setSelectedFile(null);
    if (inputRef.current) inputRef.current.value = "";
  }

  async function handleUpload() {
    if (!selectedFile) return;
    setIsUploading(true);
    try {
      await uploadDocument(selectedFile);
      clearFile();
      await onChanged();
    } catch (err) {
      onError(err instanceof ApiError ? err.message : "Upload failed.");
    } finally {
      setIsUploading(false);
    }
  }

  function handleDelete(doc: DocumentSummary) {
    onConfirm({
      title: `Delete ${doc.filename}?`,
      message:
        "Its chunks are removed from Pinecone and it is unassigned from every bot. This can't be undone.",
      confirmLabel: "Delete document",
      onConfirm: async () => {
        setDeletingId(doc.id);
        try {
          await deleteDocument(doc.id);
          await onChanged();
        } catch (err) {
          onError(err instanceof ApiError ? err.message : "Delete failed.");
        } finally {
          setDeletingId(null);
        }
      },
    });
  }

  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
      <h2 className="text-sm font-semibold text-slate-900">Documents</h2>
      <p className="mt-0.5 text-xs text-slate-500">
        Uploaded once, assignable to any number of bots.
      </p>

      <div
        onDragOver={(e) => {
          e.preventDefault();
          setIsDragging(true);
        }}
        onDragLeave={() => setIsDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setIsDragging(false);
          pickFile(e.dataTransfer.files?.[0]);
        }}
        onClick={() => inputRef.current?.click()}
        className={`mt-4 flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed px-6 py-10 text-center transition-colors ${
          isDragging
            ? "border-teal-400 bg-teal-50"
            : "border-slate-300 hover:border-teal-300 hover:bg-slate-50"
        }`}
      >
        <input
          ref={inputRef}
          type="file"
          accept=".pdf,application/pdf"
          className="hidden"
          onChange={(e) => pickFile(e.target.files?.[0])}
        />
        {selectedFile ? (
          <p className="text-sm font-medium text-slate-900">
            {selectedFile.name}
          </p>
        ) : (
          <>
            <p className="text-sm font-medium text-slate-700">
              Drop a PDF here, or{" "}
              <span className="text-teal-600">click to browse</span>
            </p>
            <p className="text-xs text-slate-400">PDF files only</p>
          </>
        )}
      </div>

      <div className="mt-3 flex items-center gap-3">
        <button
          onClick={handleUpload}
          disabled={!selectedFile || isUploading}
          className="inline-flex items-center gap-2 rounded-lg bg-teal-600 px-4 py-2 text-sm font-medium text-white shadow-sm transition-colors hover:bg-teal-500 disabled:cursor-not-allowed disabled:bg-slate-300"
        >
          {isUploading && <Spinner />}
          {isUploading ? "Ingesting..." : "Upload"}
        </button>
        {selectedFile && !isUploading && (
          <button
            onClick={clearFile}
            className="text-sm font-medium text-slate-500 hover:text-slate-700"
          >
            Clear
          </button>
        )}
      </div>

      <ul className="mt-5 divide-y divide-slate-100">
        {documents.length === 0 && (
          <li className="py-6 text-center text-sm text-slate-400">
            No documents yet.
          </li>
        )}
        {documents.map((doc) => (
          <li key={doc.id} className="flex items-center gap-3 py-3">
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium text-slate-900">
                {doc.filename}
              </p>
              <p className="text-xs text-slate-400">
                {new Date(doc.uploaded_at).toLocaleDateString()} ·{" "}
                {doc.node_count} chunk{doc.node_count === 1 ? "" : "s"}
              </p>
            </div>
            <StatusPill status={doc.status} />
            <button
              onClick={() => handleDelete(doc)}
              disabled={deletingId === doc.id}
              className="inline-flex flex-shrink-0 items-center gap-1.5 rounded-lg px-2 py-1 text-xs font-medium text-slate-400 transition-colors hover:bg-red-50 hover:text-red-600 disabled:opacity-60"
            >
              {deletingId === doc.id && <Spinner className="h-3 w-3" />}
              {deletingId === doc.id ? "Deleting..." : "Delete"}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function BotsPanel({
  bots,
  documents,
  onChanged,
  onError,
  onConfirm,
}: {
  bots: Bot[];
  documents: DocumentSummary[];
  onChanged: () => Promise<void>;
  onError: (message: string) => void;
  onConfirm: (request: ConfirmRequest) => void;
}) {
  const [name, setName] = useState("");
  const [systemPrompt, setSystemPrompt] = useState("");
  const [selectedDocs, setSelectedDocs] = useState<string[]>([]);
  const [isDeploying, setIsDeploying] = useState(false);

  function toggleDoc(id: string) {
    setSelectedDocs((prev) =>
      prev.includes(id) ? prev.filter((d) => d !== id) : [...prev, id]
    );
  }

  async function handleDeploy() {
    if (!name.trim() || !systemPrompt.trim()) return;
    setIsDeploying(true);
    try {
      await createBot({
        name: name.trim(),
        system_prompt: systemPrompt.trim(),
        document_ids: selectedDocs,
      });
      setName("");
      setSystemPrompt("");
      setSelectedDocs([]);
      await onChanged();
    } catch (err) {
      onError(err instanceof ApiError ? err.message : "Deploy failed.");
    } finally {
      setIsDeploying(false);
    }
  }

  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
      <h2 className="text-sm font-semibold text-slate-900">Bots</h2>
      <p className="mt-0.5 text-xs text-slate-500">
        Each bot gets its own system prompt and its own slice of the corpus.
      </p>

      <div className="mt-4 space-y-3 rounded-xl bg-slate-50 p-4">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Bot name"
          className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 outline-none placeholder:text-slate-400 focus:border-teal-400"
        />
        <textarea
          value={systemPrompt}
          onChange={(e) => setSystemPrompt(e.target.value)}
          placeholder="System prompt / pre-written context..."
          rows={4}
          className="w-full resize-y rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 outline-none placeholder:text-slate-400 focus:border-teal-400"
        />
        <DocumentPicker
          documents={documents}
          selected={selectedDocs}
          onToggle={toggleDoc}
        />
        <button
          onClick={handleDeploy}
          disabled={isDeploying || !name.trim() || !systemPrompt.trim()}
          className="inline-flex items-center gap-2 rounded-lg bg-violet-600 px-4 py-2 text-sm font-medium text-white shadow-sm transition-colors hover:bg-violet-500 disabled:cursor-not-allowed disabled:bg-slate-300"
        >
          {isDeploying && <Spinner />}
          {isDeploying ? "Deploying..." : "Deploy bot"}
        </button>
      </div>

      <ul className="mt-5 space-y-3">
        {bots.length === 0 && (
          <li className="py-6 text-center text-sm text-slate-400">
            No bots deployed yet.
          </li>
        )}
        {bots.map((bot) => (
          <BotCard
            key={bot.id}
            bot={bot}
            documents={documents}
            onChanged={onChanged}
            onError={onError}
            onConfirm={onConfirm}
          />
        ))}
      </ul>
    </section>
  );
}

function BotCard({
  bot,
  documents,
  onChanged,
  onError,
  onConfirm,
}: {
  bot: Bot;
  documents: DocumentSummary[];
  onChanged: () => Promise<void>;
  onError: (message: string) => void;
  onConfirm: (request: ConfirmRequest) => void;
}) {
  const [isEditing, setIsEditing] = useState(false);
  const [selected, setSelected] = useState(bot.documents.map((d) => d.id));
  const [isSaving, setIsSaving] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);

  async function handleSave() {
    setIsSaving(true);
    try {
      await updateBot(bot.id, { document_ids: selected });
      setIsEditing(false);
      await onChanged();
    } catch (err) {
      onError(err instanceof ApiError ? err.message : "Update failed.");
    } finally {
      setIsSaving(false);
    }
  }

  function handleDelete() {
    onConfirm({
      title: `Delete ${bot.name}?`,
      message:
        "The bot and its document assignments are removed. The documents themselves are kept and stay available to other bots.",
      confirmLabel: "Delete bot",
      onConfirm: async () => {
        setIsDeleting(true);
        try {
          await deleteBot(bot.id);
          await onChanged();
        } catch (err) {
          onError(err instanceof ApiError ? err.message : "Delete failed.");
          setIsDeleting(false);
        }
      },
    });
  }

  return (
    <li className="rounded-xl border border-slate-200 p-4">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-slate-900">
            {bot.name}
          </p>
          <p className="mt-0.5 line-clamp-2 text-xs text-slate-500">
            {bot.system_prompt}
          </p>
          <p className="mt-1.5 text-xs text-slate-400">
            {bot.documents.length} document
            {bot.documents.length === 1 ? "" : "s"}
          </p>
        </div>
        <Link
          href={`/chat?bot=${bot.slug}`}
          className="flex-shrink-0 rounded-lg bg-teal-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-teal-500"
        >
          Open chat
        </Link>
      </div>

      {isEditing ? (
        <div className="mt-3 space-y-3 border-t border-slate-100 pt-3">
          <DocumentPicker
            documents={documents}
            selected={selected}
            onToggle={(id) =>
              setSelected((prev) =>
                prev.includes(id)
                  ? prev.filter((d) => d !== id)
                  : [...prev, id]
              )
            }
          />
          <div className="flex items-center gap-3">
            <button
              onClick={handleSave}
              disabled={isSaving}
              className="rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-medium text-white disabled:bg-slate-300"
            >
              {isSaving ? "Saving..." : "Save"}
            </button>
            <button
              onClick={() => {
                setSelected(bot.documents.map((d) => d.id));
                setIsEditing(false);
              }}
              className="text-xs font-medium text-slate-500 hover:text-slate-700"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="mt-3 flex items-center gap-3 border-t border-slate-100 pt-3">
          <button
            onClick={() => setIsEditing(true)}
            disabled={isDeleting}
            className="text-xs font-medium text-slate-500 hover:text-slate-900 disabled:opacity-50"
          >
            Edit documents
          </button>
          <button
            onClick={handleDelete}
            disabled={isDeleting}
            className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-400 hover:text-red-600 disabled:opacity-60 disabled:hover:text-slate-400"
          >
            {isDeleting && <Spinner className="h-3 w-3" />}
            {isDeleting ? "Deleting bot..." : "Delete bot"}
          </button>
        </div>
      )}
    </li>
  );
}

function DocumentPicker({
  documents,
  selected,
  onToggle,
}: {
  documents: DocumentSummary[];
  selected: string[];
  onToggle: (id: string) => void;
}) {
  if (documents.length === 0) {
    return (
      <p className="text-xs text-slate-400">
        Upload a document to assign one.
      </p>
    );
  }

  return (
    <div className="max-h-40 space-y-1 overflow-y-auto">
      {documents.map((doc) => (
        <label
          key={doc.id}
          className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-xs text-slate-700 hover:bg-white"
        >
          <input
            type="checkbox"
            checked={selected.includes(doc.id)}
            onChange={() => onToggle(doc.id)}
            className="h-3.5 w-3.5 rounded border-slate-300 accent-violet-600"
          />
          <span className="truncate">{doc.filename}</span>
        </label>
      ))}
    </div>
  );
}

function StatusPill({ status }: { status: DocumentSummary["status"] }) {
  const styles = {
    ready: "bg-emerald-50 text-emerald-700",
    processing: "bg-amber-50 text-amber-700",
    failed: "bg-red-50 text-red-700",
  }[status];

  return (
    <span
      className={`flex-shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${styles}`}
    >
      {status}
    </span>
  );
}

function ErrorBanner({ message }: { message: string }) {
  return (
    <div className="mt-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
      {message}
    </div>
  );
}

function Spinner({ className = "h-4 w-4" }: { className?: string }) {
  return (
    <svg className={`${className} animate-spin`} viewBox="0 0 24 24" fill="none">
      <circle
        className="opacity-25"
        cx="12"
        cy="12"
        r="10"
        stroke="currentColor"
        strokeWidth="4"
      />
      <path
        className="opacity-75"
        fill="currentColor"
        d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"
      />
    </svg>
  );
}
