import type { HealthSummary, Message, NewsUpdate, PublicAppConfig } from "../types";

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
  signal?: AbortSignal
): Promise<string> {
  try {
    const response = await fetch("/api/chat", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
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

    const data: unknown = await response.json();
    if (!data || typeof data !== "object" || !("reply" in data) || typeof data.reply !== "string") {
      throw new AssistantRequestError(
        "The assistant returned an invalid response. Please retry the request.",
        "Docket Assistant backend returned invalid JSON"
      );
    }
    return data.reply;
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
