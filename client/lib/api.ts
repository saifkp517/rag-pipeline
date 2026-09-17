export const API_URL =
  process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

export interface UploadResponse {
  filename: string;
  nodes_created: number;
}

export class ApiError extends Error {}

export async function uploadDocument(file: File): Promise<UploadResponse> {
  const formData = new FormData();
  formData.append("file", file);

  const res = await fetch(`${API_URL}/documents/upload`, {
    method: "POST",
    body: formData,
  });

  if (!res.ok) {
    let detail = `Upload failed (${res.status})`;
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

export type ChatStreamEvent =
  | { type: "session"; sessionId: string }
  | { type: "token"; token: string }
  | { type: "done" };

export async function* streamChat(
  message: string,
  sessionId: string | undefined,
  signal?: AbortSignal
): AsyncGenerator<ChatStreamEvent> {
  const res = await fetch(`${API_URL}/chat/stream`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      message,
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
