"use client";

import { useRef, useState } from "react";
import { ApiError, uploadDocument, type UploadResponse } from "@/lib/api";

interface UploadedFile extends UploadResponse {
  id: string;
}

export default function UploadPage() {
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [uploaded, setUploaded] = useState<UploadedFile[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);

  function pickFile(file: File | undefined | null) {
    if (!file) return;
    setError(null);
    if (!file.name.toLowerCase().endsWith(".pdf")) {
      setError("Only PDF files are supported.");
      return;
    }
    setSelectedFile(file);
  }

  async function handleUpload() {
    if (!selectedFile) return;
    setIsUploading(true);
    setError(null);
    try {
      const result = await uploadDocument(selectedFile);
      setUploaded((prev) => [
        { ...result, id: crypto.randomUUID() },
        ...prev,
      ]);
      setSelectedFile(null);
      if (inputRef.current) inputRef.current.value = "";
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Upload failed.");
    } finally {
      setIsUploading(false);
    }
  }

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-6 px-4 py-10">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-slate-900">
          Upload a document
        </h1>
        <p className="mt-1 text-sm text-slate-500">
          Add a PDF to your knowledge base so you can chat with it.
        </p>
      </div>

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
        className={`flex cursor-pointer flex-col items-center justify-center gap-3 rounded-2xl border-2 border-dashed px-6 py-16 text-center transition-colors ${
          isDragging
            ? "border-teal-400 bg-teal-50"
            : "border-slate-300 bg-white hover:border-teal-300 hover:bg-slate-50"
        }`}
      >
        <input
          ref={inputRef}
          type="file"
          accept=".pdf,application/pdf"
          className="hidden"
          onChange={(e) => pickFile(e.target.files?.[0])}
        />
        <div
          className={`flex h-12 w-12 items-center justify-center rounded-full ${
            isDragging ? "bg-teal-100 text-teal-700" : "bg-slate-100 text-slate-500"
          }`}
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.75}
            strokeLinecap="round"
            strokeLinejoin="round"
            className="h-6 w-6"
          >
            <path d="M12 16V4M12 4l-4 4M12 4l4 4" />
            <path d="M4 16v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />
          </svg>
        </div>
        {selectedFile ? (
          <p className="text-sm font-medium text-slate-900">
            {selectedFile.name}
          </p>
        ) : (
          <>
            <p className="text-sm font-medium text-slate-700">
              Drag and drop a PDF here, or{" "}
              <span className="text-teal-600">click to browse</span>
            </p>
            <p className="text-xs text-slate-400">PDF files only</p>
          </>
        )}
      </div>

      <div className="flex items-center gap-3">
        <button
          onClick={handleUpload}
          disabled={!selectedFile || isUploading}
          className="inline-flex items-center gap-2 rounded-lg bg-teal-600 px-4 py-2 text-sm font-medium text-white shadow-sm transition-colors hover:bg-teal-500 disabled:cursor-not-allowed disabled:bg-slate-300"
        >
          {isUploading && (
            <svg
              className="h-4 w-4 animate-spin"
              viewBox="0 0 24 24"
              fill="none"
            >
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
          )}
          {isUploading ? "Uploading..." : "Upload"}
        </button>
        {selectedFile && !isUploading && (
          <button
            onClick={() => {
              setSelectedFile(null);
              if (inputRef.current) inputRef.current.value = "";
            }}
            className="text-sm font-medium text-slate-500 hover:text-slate-700"
          >
            Clear
          </button>
        )}
      </div>

      {error && (
        <div className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            className="mt-0.5 h-4 w-4 flex-shrink-0"
          >
            <circle cx="12" cy="12" r="9" />
            <path strokeLinecap="round" d="M12 8v5M12 16h.01" />
          </svg>
          {error}
        </div>
      )}

      {uploaded.length > 0 && (
        <div className="mt-4">
          <h2 className="text-sm font-semibold text-slate-700">
            Uploaded this session
          </h2>
          <ul className="mt-2 divide-y divide-slate-200 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
            {uploaded.map((file) => (
              <li
                key={file.id}
                className="flex items-center gap-3 px-4 py-3 text-sm"
              >
                <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg bg-emerald-50 text-emerald-600">
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={2}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    className="h-4 w-4"
                  >
                    <path d="M20 6 9 17l-5-5" />
                  </svg>
                </div>
                <span className="flex-1 truncate font-medium text-slate-900">
                  {file.filename}
                </span>
                <span className="flex-shrink-0 rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-600">
                  {file.nodes_created} node
                  {file.nodes_created === 1 ? "" : "s"}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </main>
  );
}
