import { Message, NewsUpdate } from "../types";

export class AssistantRequestError extends Error {
  constructor(public readonly userMessage: string, message: string) {
    super(message);
    this.name = "AssistantRequestError";
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

export async function chatWithDocketAssistant(history: Message[], message: string): Promise<string> {
  try {
    const response = await fetch("/api/chat", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ history, message }),
    });

    if (!response.ok) {
      throw new AssistantRequestError(
        `The assistant returned HTTP ${response.status}. Please retry the request.`,
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
    console.error("Chat error:", error);
    if (error instanceof AssistantRequestError) throw error;
    throw new AssistantRequestError(
      "The assistant could not be reached. Check your connection and retry the request.",
      error instanceof Error ? error.message : String(error)
    );
  }
}
