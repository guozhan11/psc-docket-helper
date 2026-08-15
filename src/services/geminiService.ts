import type { AnswerFeedback, HealthSummary, Message, NewsUpdate, PublicAppConfig } from "../types";

export interface AssistantResponse {
  reply: string;
  feedbackToken: string | null;
}

export class AssistantRequestError extends Error {
  public readonly userMessage: string;

  constructor(userMessage: string, message: string) {
    super(message);
    this.name = "AssistantRequestError";
    this.userMessage = userMessage;
  }
}

export class AssistantRequestCancelledError extends Error {
  constructor() {
    super("Assistant request cancelled by the user");
    this.name = "AssistantRequestCancelledError";
  }
}

export async function getLatestPSCUpdates(): Promise<NewsUpdate[]> {
  try {
    const response = await fetch("/api/news");
    if (!response.ok) {
      throw new Error("Failed to fetch news from server API");
    }
    return await response.json();
  } catch (error) {
    console.error("Error fetching PSC updates from backend:", error);
    return [];
  }
}

export async function getPublicAppConfig(): Promise<PublicAppConfig> {
  const response = await fetch('/api/config', { headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error(`Configuration returned HTTP ${response.status}`);
  return response.json();
}

export async function getHealthSummary(): Promise<HealthSummary | null> {
  try {
    const response = await fetch('/api/health', { headers: { Accept: 'application/json' } });
    const data: unknown = await response.json();
    if (!data || typeof data !== 'object' || !("status" in data)
      || (data.status !== 'ok' && data.status !== 'degraded')) return null;
    return data as HealthSummary;
  } catch (error) {
    console.error('Health status unavailable:', error);
    return null;
  }
}

export async function chatWithDocketAssistant(
  history: Message[],
  message: string,
  clientId: string,
  turnstileToken: string | null,
  signal?: AbortSignal,
  onDelta?: (delta: string) => void
): Promise<AssistantResponse> {
  try {
    const response = await fetch("/api/chat", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "text/event-stream, application/json",
      },
      body: JSON.stringify({ history, message, clientId, turnstileToken }),
      signal,
    });

    if (!response.ok) {
      const data: unknown = await response.json().catch(() => null);
      const userMessage = data && typeof data === 'object' && 'userMessage' in data
        && typeof data.userMessage === 'string'
        ? data.userMessage
        : `The assistant returned HTTP ${response.status}. Please retry the request.`;
      throw new AssistantRequestError(
        userMessage,
        `Docket Assistant backend returned HTTP ${response.status}`
      );
    }

    if ((response.headers.get("Content-Type") ?? "").includes("text/event-stream")) {
      if (!response.body) {
        throw new AssistantRequestError(
          "The assistant returned an empty response. Please retry the request.",
          "Docket Assistant backend returned an empty stream"
        );
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let reply = "";
      let feedbackToken: string | null = null;

      const processFrame = (frame: string) => {
        const event = frame.split(/\r?\n/).find(line => line.startsWith("event:"))?.slice(6).trim();
        const dataText = frame.split(/\r?\n/)
          .filter(line => line.startsWith("data:"))
          .map(line => line.slice(5).trimStart())
          .join("\n");
        if (!dataText) return;
        const payload: unknown = JSON.parse(dataText);
        if (event === "delta" && payload && typeof payload === "object"
          && "delta" in payload && typeof payload.delta === "string") {
          reply += payload.delta;
          onDelta?.(payload.delta);
        }
        if (event === "done" && payload && typeof payload === "object"
          && "feedbackToken" in payload && typeof payload.feedbackToken === "string") {
          feedbackToken = payload.feedbackToken;
        }
        if (event === "error") {
          const userMessage = payload && typeof payload === "object" && "userMessage" in payload
            && typeof payload.userMessage === "string"
            ? payload.userMessage
            : "The assistant stream was interrupted. Please retry the request.";
          throw new AssistantRequestError(userMessage, "Docket Assistant stream returned an error");
        }
      };

      while (true) {
        const { done, value } = await reader.read();
        buffer += decoder.decode(value, { stream: !done });
        const frames = buffer.split(/\r?\n\r?\n/);
        buffer = frames.pop() ?? "";
        frames.forEach(processFrame);
        if (done) break;
      }
      if (buffer.trim()) processFrame(buffer);
      if (!reply) {
        throw new AssistantRequestError(
          "The assistant returned no text. Please retry the request.",
          "Docket Assistant stream completed without text"
        );
      }
      return { reply, feedbackToken };
    }

    const data: unknown = await response.json();
    if (!data || typeof data !== "object" || !("reply" in data) || typeof data.reply !== "string") {
      throw new AssistantRequestError(
        "The assistant returned an invalid response. Please retry the request.",
        "Docket Assistant backend returned invalid JSON"
      );
    }
    return {
      reply: data.reply,
      feedbackToken: "feedbackToken" in data && typeof data.feedbackToken === "string"
        ? data.feedbackToken
        : null
    };
  } catch (error) {
    if (signal?.aborted || (error instanceof DOMException && error.name === "AbortError")) {
      throw new AssistantRequestCancelledError();
    }
    console.error("Chat error:", error);
    if (error instanceof AssistantRequestError) throw error;
    throw new AssistantRequestError(
      "The assistant could not be reached. Check your connection and retry the request.",
      error instanceof Error ? error.message : String(error)
    );
  }
}

export async function submitAnswerFeedback(feedback: AnswerFeedback): Promise<void> {
  const response = await fetch('/api/feedback', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json'
    },
    body: JSON.stringify(feedback)
  });
  if (!response.ok) {
    throw new Error(`Feedback returned HTTP ${response.status}`);
  }
}
