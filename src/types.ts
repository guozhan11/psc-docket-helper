export interface Message {
  role: 'user' | 'model';
  content: string;
  feedbackToken?: string;
  feedbackRating?: 'up' | 'down';
  /**
   * A client-side failure notice rendered in the assistant's place. It is not
   * something the assistant said, so it is kept out of the history sent back
   * on later turns.
   */
  isError?: boolean;
}

export interface NewsUpdate {
  title: string;
  date: string;
  summary: string;
  url: string;
}

export interface ChatSession {
  id: string;
  title: string;
  messages: Message[];
  createdAt: number;
}

export interface PublicAppConfig {
  turnstileRequired: boolean;
  turnstileSiteKey: string | null;
  feedbackEnabled: boolean;
  maxMessageLength: number;
}

export type FeedbackReason = 'incorrect' | 'missing' | 'unclear' | 'citation' | 'other';

export interface AnswerFeedback {
  token: string;
  rating: 'up' | 'down';
  reason?: FeedbackReason;
  comment?: string;
  question?: string;
  answerExcerpt?: string;
}

export interface HealthSummary {
  status: 'ok' | 'degraded';
  issues: string[];
  fullTextCoverage?: {
    searchablePercent: number | null;
    indexedDocuments: number;
    publicPdfRecords: number;
    stateAvailable: boolean;
  };
  metadataCoverage?: {
    updatedAt?: string | null;
  };
}
