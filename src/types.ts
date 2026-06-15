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
