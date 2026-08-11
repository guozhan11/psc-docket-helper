export interface Message {
  role: 'user' | 'model';
  content: string;
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
  maxMessageLength: number;
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
