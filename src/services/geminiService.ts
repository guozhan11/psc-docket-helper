import { Message, NewsUpdate } from "../types";

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
      throw new Error("Failed to obtain response from Docket Assistant backend");
    }

    const data = await response.json();
    return data.reply;
  } catch (error) {
    console.error("Chat error:", error);
    throw error;
  }
}
