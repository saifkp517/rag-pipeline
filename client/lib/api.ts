export const API_URL =
  process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

export interface UploadResponse {
  id: string;
  filename: string;
  nodes_created: number;
}

export interface DocumentSummary {
  id: string;
  filename: string;
  uploaded_at: string;
  node_count: number;
  status: "processing" | "ready" | "failed";
}

export interface Bot {
  id: string;
  slug: string;
  name: string;
  system_prompt: string;
  guardrails: Record<string, unknown>;
  created_at: string;
  documents: DocumentSummary[];
}

export class ApiError extends Error {}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, init);

  if (!res.ok) {
    let detail = `Request failed (${res.status})`;
    try {
      const body = await res.json();
      if (body?.detail) detail = body.detail;
    } catch {
      // ignore JSON parse failures, fall back to default message
    }
    throw new ApiError(detail);
  }

  return res.json();
}

export function uploadDocument(file: File): Promise<UploadResponse> {
  const formData = new FormData();
  formData.append("file", file);
  return request<UploadResponse>("/documents/upload", {
    method: "POST",
    body: formData,
  });
}

export function listDocuments(): Promise<DocumentSummary[]> {
  return request<DocumentSummary[]>("/documents");
}

export function deleteDocument(id: string): Promise<unknown> {
  return request(`/documents/${id}`, { method: "DELETE" });
}

export function listBots(): Promise<Bot[]> {
  return request<Bot[]>("/bots");
}

export function getBot(idOrSlug: string): Promise<Bot> {
  return request<Bot>(`/bots/${idOrSlug}`);
}

export function createBot(input: {
  name: string;
  system_prompt: string;
  document_ids: string[];
}): Promise<Bot> {
  return request<Bot>("/bots", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
}

export function updateBot(
  id: string,
  input: {
    name?: string;
    system_prompt?: string;
    document_ids?: string[];
  }
): Promise<Bot> {
  return request<Bot>(`/bots/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
}

export function deleteBot(id: string): Promise<unknown> {
  return request(`/bots/${id}`, { method: "DELETE" });
}

export type ChatStreamEvent =
  | { type: "session"; sessionId: string }
  | { type: "token"; token: string }
  | { type: "done" };

export async function* streamChat(
  message: string,
  botId: string,
  sessionId: string | undefined,
  signal?: AbortSignal
): AsyncGenerator<ChatStreamEvent> {
  const res = await fetch(`${API_URL}/chat/stream`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      message,
      bot_id: botId,
      ...(sessionId ? { session_id: sessionId } : {}),
    }),
    signal,
  });

  if (!res.ok || !res.body) {
    let detail = `Chat request failed (${res.status})`;
    try {
      const body = await res.json();
      if (body?.detail) detail = body.detail;
    } catch {
      // ignore JSON parse failures, fall back to default message
    }
    throw new ApiError(detail);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const frames = buffer.split("\n\n");
    buffer = frames.pop() ?? "";

    for (const frame of frames) {
      const event = parseSseFrame(frame);
      if (event) yield event;
    }
  }

  if (buffer.trim()) {
    const event = parseSseFrame(buffer);
    if (event) yield event;
  }
}

function parseSseFrame(frame: string): ChatStreamEvent | null {
  let eventName = "message";
  const dataLines: string[] = [];

  for (const line of frame.split("\n")) {
    if (line.startsWith("event:")) {
      eventName = line.slice(6).trim();
    } else if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trim());
    }
  }

  if (dataLines.length === 0) return null;

  const dataStr = dataLines.join("\n");
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(dataStr);
  } catch {
    return null;
  }

  switch (eventName) {
    case "session":
      if (typeof data.session_id === "string") {
        return { type: "session", sessionId: data.session_id };
      }
      return null;
    case "done":
      return { type: "done" };
    case "message":
      if (typeof data.token === "string") {
        return { type: "token", token: data.token };
      }
      return null;
    default:
      return null;
  }
}
