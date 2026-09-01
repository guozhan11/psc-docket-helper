import { useState, useEffect, useLayoutEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  Send, 
  Newspaper, 
  MessageSquare, 
  ChevronRight, 
  Loader2, 
  Info,
  Menu,
  X,
  Phone,
  Mail,
  MapPin,
  RotateCcw,
  Trash2,
  Plus,
  ShieldCheck,
  AlertTriangle,
  MessageCircle,
  PanelLeftClose,
  PanelLeftOpen,
  Square,
  ThumbsUp,
  ThumbsDown,
  Check
} from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import { cn } from './lib/utils';
import { AssistantRequestCancelledError, AssistantRequestError, getHealthSummary, getLatestPSCUpdates, getPublicAppConfig, chatWithDocketAssistant, submitAnswerFeedback } from './services/geminiService';
import { Message, NewsUpdate, ChatSession, HealthSummary, PublicAppConfig, FeedbackReason } from './types';
import VerifiedLink, { normalizeUrl } from './components/VerifiedLink';
import TurnstileWidget from './components/TurnstileWidget';

const EXAMPLE_QUESTIONS = [
  "In FC1176, what drove Pepco's 2025 O&M expense variance?",
  'Which FC1176 filings discuss bad debt or uncollectible accounts?'
];

const FEEDBACK_REASONS: Array<{ value: FeedbackReason; label: string }> = [
  { value: 'incorrect', label: 'Incorrect or misleading' },
  { value: 'missing', label: 'Missed important information' },
  { value: 'citation', label: 'Citation or source problem' },
  { value: 'unclear', label: 'Unclear or hard to use' },
  { value: 'other', label: 'Other' }
];

function LatestUpdatesSection({ news, loading }: { news: NewsUpdate[]; loading: boolean }) {
  return (
    <section id="updates" className="py-16 sm:py-20 bg-white">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex flex-col md:flex-row md:items-end justify-between mb-10 gap-6">
          <div>
            <h2 className="text-3xl md:text-4xl text-psc-blue mb-4">Latest Regulatory Updates</h2>
            <p className="text-slate-500 max-w-2xl">
              Stay informed about the latest decisions, press releases, and public notices from the Commission.
            </p>
          </div>
          <a
            href="https://dcpsc.org/Newsroom.aspx"
            target="_blank"
            rel="noopener noreferrer"
            className="text-psc-blue font-bold flex items-center gap-1 hover:underline group"
          >
            View All News <ChevronRight className="w-4 h-4 group-hover:translate-x-1 transition-transform" />
          </a>
        </div>

        {loading ? (
          <div className="flex flex-col items-center justify-center py-20 text-slate-400">
            <Loader2 className="w-12 h-12 animate-spin mb-4 text-psc-gold" />
            <p className="font-medium">Fetching latest updates from the Commission...</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-8">
            {news.map((item, idx) => (
              <motion.div
                key={idx}
                initial={{ opacity: 0, y: 20 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ delay: idx * 0.1 }}
                className="group bg-psc-light rounded-2xl p-8 border border-slate-100 hover:border-psc-gold/30 hover:shadow-xl transition-all flex flex-col h-full"
              >
                <div className="flex justify-between items-start mb-6">
                  <span className="text-xs font-bold text-psc-gold uppercase tracking-widest">{item.date}</span>
                  <div className="p-2 bg-white rounded-lg shadow-sm group-hover:bg-psc-gold group-hover:text-white transition-colors">
                    <Newspaper className="w-4 h-4" />
                  </div>
                </div>
                <h3 className="text-xl mb-4 group-hover:text-psc-blue transition-colors leading-snug">
                  {item.title}
                </h3>
                <p className="text-slate-600 mb-8 flex-grow line-clamp-4 leading-relaxed">
                  {item.summary}
                </p>
                <VerifiedLink
                  href={normalizeUrl(item.url)}
                  fallbackHref="https://dcpsc.org/Newsroom.aspx"
                  className="inline-flex items-center gap-2 text-psc-blue font-bold text-sm no-underline hover:gap-3 transition-all"
                >
                  Read Full Update
                </VerifiedLink>
              </motion.div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

const SESSIONS_STORAGE_KEY = 'dc_psc_chat_sessions';
const GREETING = "Hello! I'm your DC PSC Docket Assistant. How can I help you find information about dockets or regulatory filings today?";

/**
 * How many conversations are kept in this browser.
 *
 * localStorage has a hard per-origin quota and one answer with its source list
 * runs to several KB, so a regular user reaches it. Once setItem throws there
 * is nowhere to report it from, and the old code logged and carried on: the
 * history quietly stopped saving, and the loss only surfaced on the next
 * reload. Bounding what is kept means the write keeps succeeding.
 */
const MAX_STORED_SESSIONS = 30;

function createSession(): ChatSession {
  return {
    // Date.now() alone collides when two sessions are created in the same
    // millisecond, which duplicate-keys the list and makes both unselectable.
    id: `session_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    title: "New Inquiry",
    messages: [{ role: 'model', content: GREETING }],
    createdAt: Date.now()
  };
}

function isStoredMessage(value: unknown): value is Message {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<Message>;
  return (item.role === 'user' || item.role === 'model') && typeof item.content === 'string';
}

function isStoredSession(value: unknown): value is ChatSession {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<ChatSession>;
  return typeof item.id === 'string'
    && typeof item.title === 'string'
    && Array.isArray(item.messages)
    && item.messages.every(isStoredMessage);
}

/**
 * Stored history is validated rather than trusted. A session missing its
 * messages array threw during the first render, and because the bad value
 * lives in storage the reload threw as well: the app stayed blank until the
 * user cleared site data by hand. Anything off-shape is dropped instead.
 */
function loadStoredSessions(): ChatSession[] {
  try {
    const saved = localStorage.getItem(SESSIONS_STORAGE_KEY);
    if (saved) {
      const parsed: unknown = JSON.parse(saved);
      if (Array.isArray(parsed)) {
        const valid = parsed.filter(isStoredSession).map(session => ({
          ...session,
          createdAt: typeof session.createdAt === 'number' ? session.createdAt : Date.now()
        }));
        if (valid.length > 0) return valid.slice(0, MAX_STORED_SESSIONS);
      }
    }
  } catch (error) {
    console.error("Error loading chat sessions from localStorage:", error);
  }
  return [createSession()];
}

/**
 * Writes the history, dropping the oldest conversations until it fits, and
 * returns what was actually stored so the list on screen matches the list on
 * disk. The active conversation is never dropped.
 */
function persistSessions(sessions: ChatSession[], activeSessionId: string): ChatSession[] {
  let candidate = sessions.slice(0, MAX_STORED_SESSIONS);
  for (;;) {
    try {
      localStorage.setItem(SESSIONS_STORAGE_KEY, JSON.stringify(candidate));
      return candidate;
    } catch (error) {
      const oldest = candidate.reduce(
        (found, session, index) => session.id === activeSessionId ? found : index,
        -1
      );
      if (oldest < 0) {
        // Only the active conversation is left and it still does not fit.
        // Leave both the stored value and the list on screen alone.
        console.error("Chat history could not be saved:", error);
        return sessions;
      }
      candidate = candidate.filter((_, index) => index !== oldest);
    }
  }
}

export default function App() {
  const [news, setNews] = useState<NewsUpdate[]>([]);
  const [loadingNews, setLoadingNews] = useState(true);
  const [appConfig, setAppConfig] = useState<PublicAppConfig | null>(null);
  const [health, setHealth] = useState<HealthSummary | null>(null);
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
  const [turnstileResetSignal, setTurnstileResetSignal] = useState(0);
  const [turnstileStalled, setTurnstileStalled] = useState(false);
  
  const [sessions, setSessions] = useState<ChatSession[]>(loadStoredSessions);

  const [activeSessionId, setActiveSessionId] = useState<string>(() => {
    try {
      const savedActive = localStorage.getItem('dc_psc_active_session_id');
      if (savedActive) {
        return savedActive;
      }
    } catch (e) {
      console.error("Error loading active session id:", e);
    }
    return '';
  });

  const [input, setInput] = useState('');
  const [isTyping, setIsTyping] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [isReceivingContent, setIsReceivingContent] = useState(false);
  const [corpusPanelOpen, setCorpusPanelOpen] = useState(() => {
    try {
      return localStorage.getItem('dc_psc_corpus_panel') !== 'collapsed';
    } catch {
      return true;
    }
  });
  const [failedRequest, setFailedRequest] = useState<{ sessionId: string; message: string } | null>(null);
  const [feedbackFormToken, setFeedbackFormToken] = useState<string | null>(null);
  const [feedbackReason, setFeedbackReason] = useState<FeedbackReason>('incorrect');
  const [feedbackComment, setFeedbackComment] = useState('');
  const [feedbackSubmittingToken, setFeedbackSubmittingToken] = useState<string | null>(null);
  const [feedbackErrorToken, setFeedbackErrorToken] = useState<string | null>(null);
  const activeRequestRef = useRef<{ controller: AbortController; sessionId: string } | null>(null);
  const [clientId] = useState(() => {
    const storageKey = 'dc_psc_anonymous_client_id';
    try {
      const saved = localStorage.getItem(storageKey);
      if (saved) return saved;
      const created = crypto.randomUUID();
      localStorage.setItem(storageKey, created);
      return created;
    } catch {
      return crypto.randomUUID();
    }
  });

  useEffect(() => {
    if (sessions.length > 0) {
      const exists = sessions.some(s => s.id === activeSessionId);
      if (!exists) {
        setActiveSessionId(sessions[0].id);
      }
    }
  }, [sessions, activeSessionId]);

  useEffect(() => {
    if (isTyping) return;
    const stored = persistSessions(sessions, activeSessionId);
    if (stored.length !== sessions.length) setSessions(stored);
  }, [sessions, isTyping, activeSessionId]);

  useEffect(() => {
    if (activeSessionId) {
      try {
        localStorage.setItem('dc_psc_active_session_id', activeSessionId);
      } catch (e) {
        console.error("Error saving active session ID to localStorage:", e);
      }
    }
  }, [activeSessionId]);

  useEffect(() => {
    try {
      localStorage.setItem('dc_psc_corpus_panel', corpusPanelOpen ? 'expanded' : 'collapsed');
    } catch {
      // The preference remains available for the current visit.
    }
  }, [corpusPanelOpen]);

  // The widget renders `interaction-only`, so when challenges.cloudflare.com is
  // blocked — a privacy extension, a corporate proxy — there is nothing on
  // screen and no token, and the send button simply stays greyed out with no
  // reason given. Wait long enough that an ordinary solve never trips this,
  // then say what is wrong.
  useEffect(() => {
    if (!appConfig?.turnstileRequired || turnstileToken) {
      setTurnstileStalled(false);
      return;
    }
    const timer = setTimeout(() => setTurnstileStalled(true), 8000);
    return () => clearTimeout(timer);
  }, [appConfig?.turnstileRequired, turnstileToken]);

  useEffect(() => {
    if (confirmClear) {
      const timer = setTimeout(() => {
        setConfirmClear(false);
      }, 5000);
      return () => clearTimeout(timer);
    }
  }, [confirmClear]);

  const activeSession = sessions.find(s => s.id === activeSessionId) || sessions[0];
  const messages = activeSession?.messages ?? [];
  const hasUserMessages = messages.some(message => message.role === 'user');

  const cancelActiveRequest = (sessionId?: string) => {
    const activeRequest = activeRequestRef.current;
    if (!activeRequest || (sessionId && activeRequest.sessionId !== sessionId)) return;
    activeRequestRef.current = null;
    activeRequest.controller.abort();
    setIsTyping(false);
    setIsReceivingContent(false);
    if (appConfig?.turnstileRequired) {
      setTurnstileToken(null);
      setTurnstileResetSignal(value => value + 1);
    }
  };

  const updateSessionMessages = (sessionId: string, newMsgSelector: (prev: Message[]) => Message[], isUserFirstMsg?: string) => {
    setSessions(prevSessions => prevSessions.map(session => {
      if (session.id === sessionId) {
        const nextMessages = newMsgSelector(session.messages);
        let updatedTitle = session.title;
        if (isUserFirstMsg && session.title === "New Inquiry") {
          updatedTitle = isUserFirstMsg.length > 30 ? isUserFirstMsg.substring(0, 30) + "..." : isUserFirstMsg;
        }
        return {
          ...session,
          title: updatedTitle,
          messages: nextMessages
        };
      }
      return session;
    }));
  };

  const handleNewChat = () => {
    cancelActiveRequest();
    shouldAutoScrollRef.current = true;
    setFailedRequest(null);
    const newSession = createSession();
    setSessions(prev => [newSession, ...prev].slice(0, MAX_STORED_SESSIONS));
    setActiveSessionId(newSession.id);
  };

  const handleDeleteChat = (idToDelete: string, e: React.MouseEvent) => {
    e.stopPropagation();
    cancelActiveRequest(idToDelete);
    shouldAutoScrollRef.current = true;
    if (sessions.length <= 1) {
      const replacement = createSession();
      setSessions([replacement]);
      setActiveSessionId(replacement.id);
      return;
    }
    const nextSessions = sessions.filter(s => s.id !== idToDelete);
    setSessions(nextSessions);
    if (activeSessionId === idToDelete) {
      setActiveSessionId(nextSessions[0].id);
    }
  };

  const handleClearChat = () => {
    if (confirmClear) {
      cancelActiveRequest(activeSessionId);
      shouldAutoScrollRef.current = true;
      setFailedRequest(null);
      setSessions(prevSessions => prevSessions.map(session => {
        if (session.id === activeSessionId) {
          return {
            ...session,
            title: "New Inquiry",
            messages: [{ role: 'model', content: GREETING }]
          };
        }
        return session;
      }));
      setConfirmClear(false);
    } else {
      setConfirmClear(true);
    }
  };

  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const shouldAutoScrollRef = useRef(true);

  useEffect(() => () => activeRequestRef.current?.controller.abort(), []);

  // Following the stream to the bottom must never fight the reader. Scrolling
  // to the bottom fires a scroll event of its own, which used to be read as the
  // reader returning to the bottom and re-armed the follow — so scrolling up
  // during generation was undone by the next delta, and only a lucky race let
  // the reader escape.
  const programmaticScrollRef = useRef(false);

  const handleMessagesScroll = () => {
    const container = messagesContainerRef.current;
    if (!container) return;
    if (programmaticScrollRef.current) {
      programmaticScrollRef.current = false;
      return;
    }

    const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
    shouldAutoScrollRef.current = distanceFromBottom <= 64;
  };

  // Wheel and touch say what the reader wants directly, with no race against
  // an in-flight programmatic scroll.
  const handleMessagesWheel = (event: React.WheelEvent<HTMLDivElement>) => {
    if (event.deltaY < 0) shouldAutoScrollRef.current = false;
  };

  const touchStartYRef = useRef(0);
  const handleMessagesTouchStart = (event: React.TouchEvent<HTMLDivElement>) => {
    touchStartYRef.current = event.touches[0]?.clientY ?? 0;
  };
  const handleMessagesTouchMove = (event: React.TouchEvent<HTMLDivElement>) => {
    const y = event.touches[0]?.clientY ?? 0;
    if (y > touchStartYRef.current + 8) shouldAutoScrollRef.current = false;
  };

  useLayoutEffect(() => {
    if (!shouldAutoScrollRef.current) return;

    const frame = requestAnimationFrame(() => {
      const container = messagesContainerRef.current;
      if (container && shouldAutoScrollRef.current) {
        programmaticScrollRef.current = true;
        container.scrollTop = container.scrollHeight;
      }
    });

    return () => cancelAnimationFrame(frame);
  }, [activeSessionId, messages, isTyping]);

  useLayoutEffect(() => {
    const textarea = inputRef.current;
    if (!textarea) return;

    textarea.style.height = 'auto';
    textarea.style.height = `${Math.min(textarea.scrollHeight, 160)}px`;
    textarea.style.overflowY = textarea.scrollHeight > 160 ? 'auto' : 'hidden';
  }, [input]);
  
  useEffect(() => {
    async function loadPublicData() {
      const [updates, config, healthSummary] = await Promise.all([
        getLatestPSCUpdates(),
        getPublicAppConfig().catch(() => null),
        getHealthSummary()
      ]);
      setNews(updates);
      setAppConfig(config);
      setHealth(healthSummary);
      setLoadingNews(false);
    }
    void loadPublicData();
  }, []);

  const runAssistantRequest = async (targetSessionId: string, userMessage: string, appendUserMessage: boolean) => {
    shouldAutoScrollRef.current = true;
    setFailedRequest(null);
    setIsTyping(true);
    setIsReceivingContent(false);
    const requestController = new AbortController();
    activeRequestRef.current = { controller: requestController, sessionId: targetSessionId };
    let streamedContent = '';

    if (!appendUserMessage) {
      updateSessionMessages(targetSessionId, prev =>
        prev.at(-1)?.role === 'model' ? prev.slice(0, -1) : prev
      );
    }

    try {
      const activeSess = sessions.find(s => s.id === targetSessionId) || sessions[0];
      // `message` is sent separately; including it in history duplicated the
      // current question in the model transcript. On a first attempt this
      // holds on its own, because `sessions` here predates the user message
      // just appended. A retry replays a question already in the transcript,
      // so its turn — the failed answer and the question itself — has to come
      // off explicitly.
      // Failure notices are rendered in the assistant's place but were never
      // said by it. Replaying them made the model apologise for errors it had
      // not made, so they are dropped from what goes back upstream.
      const priorMessages = (activeSess?.messages ?? []).filter(item => !item.isError);
      const withoutFailedTurn = (): Message[] => {
        const withoutAnswer = priorMessages.at(-1)?.role === 'model'
          ? priorMessages.slice(0, -1)
          : priorMessages;
        return withoutAnswer.at(-1)?.role === 'user' && withoutAnswer.at(-1)?.content === userMessage
          ? withoutAnswer.slice(0, -1)
          : withoutAnswer;
      };
      const history = appendUserMessage ? priorMessages : withoutFailedTurn();
      const currentHistory: Message[] = history.slice(-10);
      const response = await chatWithDocketAssistant(
        currentHistory,
        userMessage,
        clientId,
        turnstileToken,
        requestController.signal,
        delta => {
          streamedContent += delta;
          setIsReceivingContent(true);
          updateSessionMessages(targetSessionId, prev => {
            if (prev.at(-1)?.role === 'model') {
              return [...prev.slice(0, -1), { role: 'model', content: streamedContent }];
            }
            return [...prev, { role: 'model', content: streamedContent }];
          });
        }
      );
      if (streamedContent) {
        updateSessionMessages(targetSessionId, prev => prev.at(-1)?.role === 'model'
          ? [...prev.slice(0, -1), { ...prev.at(-1)!, feedbackToken: response.feedbackToken ?? undefined }]
          : prev
        );
      } else {
        updateSessionMessages(targetSessionId, prev => [...prev, {
          role: 'model',
          content: response.reply || "I'm sorry, I couldn't process that request.",
          feedbackToken: response.feedbackToken ?? undefined
        }]);
      }
      // The backend answered, but with a stand-in for an answer it could not
      // produce. It arrives as an ordinary reply, so without this the turn
      // looked finished and retyping the question was the only way forward.
      if (response.degraded) {
        setFailedRequest({ sessionId: targetSessionId, message: userMessage });
      }
    } catch (error) {
      if (error instanceof AssistantRequestCancelledError) return;
      console.error("Chat error:", error);
      if (streamedContent) {
        updateSessionMessages(targetSessionId, prev =>
          prev.at(-1)?.role === 'model' ? prev.slice(0, -1) : prev
        );
      }
      const content = error instanceof AssistantRequestError
        ? error.userMessage
        : "The assistant could not be reached. Please retry the request.";
      updateSessionMessages(targetSessionId, prev => [...prev, { role: 'model', content, isError: true }]);
      setFailedRequest({ sessionId: targetSessionId, message: userMessage });
    } finally {
      if (activeRequestRef.current?.controller === requestController) {
        activeRequestRef.current = null;
        setIsTyping(false);
        setIsReceivingContent(false);
        if (appConfig?.turnstileRequired) {
          setTurnstileToken(null);
          setTurnstileResetSignal(value => value + 1);
        }
      }
    }
  };

  const handleSendMessage = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!appConfig || !input.trim() || isTyping || (appConfig.turnstileRequired && !turnstileToken)) return;
    const userMessage = input.trim();
    setInput('');
    const targetSessionId = activeSessionId;
    const isFirstUserMessage = messages.filter(m => m.role === 'user').length === 0;
    updateSessionMessages(targetSessionId, prev => [...prev, { role: 'user', content: userMessage }], isFirstUserMessage ? userMessage : undefined);
    await runAssistantRequest(targetSessionId, userMessage, true);
  };

  const handleRetryRequest = async () => {
    if (!failedRequest || isTyping) return;
    if (appConfig?.turnstileRequired && !turnstileToken) return;
    await runAssistantRequest(failedRequest.sessionId, failedRequest.message, false);
  };

  const handleStopGenerating = () => {
    cancelActiveRequest();
  };

  const recordFeedback = async (
    messageIndex: number,
    message: Message,
    rating: 'up' | 'down'
  ) => {
    if (!message.feedbackToken || feedbackSubmittingToken) return;
    const question = messages.slice(0, messageIndex).reverse().find(item => item.role === 'user')?.content;
    setFeedbackSubmittingToken(message.feedbackToken);
    setFeedbackErrorToken(null);
    try {
      await submitAnswerFeedback({
        token: message.feedbackToken,
        rating,
        reason: rating === 'down' ? feedbackReason : undefined,
        comment: rating === 'down' ? feedbackComment : undefined,
        question: rating === 'down' ? question?.slice(0, 1500) : undefined,
        answerExcerpt: rating === 'down' ? message.content.slice(0, 2500) : undefined
      });
      updateSessionMessages(activeSessionId, previous => previous.map((item, index) =>
        index === messageIndex ? { ...item, feedbackRating: rating } : item
      ));
      setFeedbackFormToken(null);
      setFeedbackComment('');
    } catch (error) {
      console.error('Feedback submission failed:', error);
      setFeedbackErrorToken(message.feedbackToken);
    } finally {
      setFeedbackSubmittingToken(null);
    }
  };

  return (
    <div className="min-h-screen flex flex-col">
      {/* Navigation */}
      <nav className="sticky top-0 z-50 bg-psc-blue text-white shadow-lg">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex justify-between h-20 items-center">
            <div className="flex items-center gap-3">
              <img src="/favicon.svg" alt="" aria-hidden="true" className="h-12 w-12 flex-shrink-0" />
              <div>
                <div className="flex items-center gap-2">
                  <h1 className="font-display text-lg font-extrabold leading-tight tracking-[-0.03em] sm:text-xl">AI Docket Assistant</h1>
                  <span className="rounded-full border border-psc-gold/50 bg-psc-gold/20 px-2 py-0.5 text-[10px] font-bold tracking-widest text-psc-gold">BETA</span>
                </div>
                <p className="font-sans text-[11px] font-semibold uppercase tracking-[0.14em] text-psc-gold sm:text-xs">Public Service Commission</p>
              </div>
            </div>
            
            {/* Desktop Nav */}
            <div className="hidden md:flex items-center gap-8 font-medium text-sm">
              <a href="#" className="hover:text-psc-gold transition-colors">Home</a>
              <a href="#docket-chat" className="hover:text-psc-gold transition-colors">Docket Assistant</a>
              <a href="#updates" className="hover:text-psc-gold transition-colors">News & Updates</a>
              <a href="#privacy" className="hover:text-psc-gold transition-colors">Privacy</a>
              <a href="https://dcpsc.org" target="_blank" rel="noopener noreferrer" className="bg-psc-gold hover:bg-psc-gold/90 text-psc-blue px-5 py-2 rounded-full font-bold transition-all shadow-md">
                Visit Official Site
              </a>
            </div>

            {/* Mobile Menu Toggle */}
            <button 
              className="md:hidden p-2"
              onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
              aria-label={mobileMenuOpen ? "Close navigation menu" : "Open navigation menu"}
            >
              {mobileMenuOpen ? <X /> : <Menu />}
            </button>
          </div>
        </div>
        
        {/* Mobile Nav */}
        <AnimatePresence>
          {mobileMenuOpen && (
            <motion.div 
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              className="md:hidden bg-psc-blue border-t border-white/10 overflow-hidden"
            >
              <div className="px-4 py-6 flex flex-col gap-4">
                <a href="#" onClick={() => setMobileMenuOpen(false)} className="text-lg font-medium">Home</a>
                <a href="#docket-chat" onClick={() => setMobileMenuOpen(false)} className="text-lg font-medium">Docket Assistant</a>
                <a href="#updates" onClick={() => setMobileMenuOpen(false)} className="text-lg font-medium">News & Updates</a>
                <a href="#privacy" onClick={() => setMobileMenuOpen(false)} className="text-lg font-medium">Privacy</a>
                <a href="https://dcpsc.org" target="_blank" rel="noopener noreferrer" className="bg-psc-gold text-psc-blue w-full py-3 rounded-xl font-bold text-center">
                  Visit Official Site
                </a>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </nav>

      <main className="flex-grow">
        {/* Hero Section */}
        <section className="relative overflow-hidden bg-psc-blue py-12 sm:py-16 lg:py-20">
          <div className="absolute inset-0 opacity-10">
            <div className="absolute top-0 left-0 w-full h-full bg-[radial-gradient(circle_at_center,_var(--tw-gradient-stops))] from-white via-transparent to-transparent"></div>
          </div>
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 relative z-10">
            <div className="max-w-3xl">
              <motion.div
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.6 }}
              >
                <span className="mb-4 inline-block rounded-full border border-psc-gold/30 bg-psc-gold/20 px-4 py-1 text-xs font-bold text-psc-gold sm:mb-6 sm:text-sm">
                  Non-Official AI Assistant
                </span>
                <h2 className="mb-4 text-3xl leading-tight text-white sm:mb-6 sm:text-5xl md:text-6xl">
                  Navigate DC PSC Dockets with <span className="text-psc-gold italic">AI-Powered</span> Insights
                </h2>
                <p className="mb-7 text-base leading-relaxed text-slate-300 sm:mb-10 sm:text-lg lg:text-xl">
                  This is a non-official experimental tool designed to help you easily search, summarize, and explore public utility records and regulatory filings using advanced AI-assisted navigation.
                </p>
                <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:gap-4">
                  <a href="#docket-chat" className="flex items-center justify-center gap-2 rounded-xl bg-white px-6 py-3.5 font-bold text-psc-blue shadow-xl transition-all hover:bg-slate-100 sm:px-8 sm:py-4">
                    <MessageSquare className="w-5 h-5" />
                    Ask the Docket Assistant
                  </a>
                  <a href="#updates" className="flex items-center justify-center gap-2 rounded-xl border-2 border-white/30 bg-transparent px-6 py-3.5 font-bold text-white transition-all hover:bg-white/10 sm:px-8 sm:py-4">
                    <Newspaper className="w-5 h-5" />
                    View Latest Updates
                  </a>
                </div>
              </motion.div>
            </div>
          </div>
        </section>

        {/* Chatbot Section */}
        <section id="assistant" className="scroll-mt-20 py-8 bg-psc-light">
          <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 xl:gap-10 items-start">
              {/* Info Sidebar */}
              {corpusPanelOpen && <motion.div
                layout
                initial={{ opacity: 0, x: -16 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -16 }}
                className="order-2 lg:order-1 lg:col-span-4 xl:col-span-3"
              >
                <div className="sticky top-28 lg:flex lg:h-[calc(100dvh-7rem)] lg:min-h-[520px] lg:max-h-[760px] lg:flex-col lg:gap-4">
                  <div className="relative mb-8 rounded-3xl bg-psc-blue p-8 text-white shadow-2xl lg:mb-0 lg:min-h-0 lg:flex-1 lg:overflow-y-auto lg:p-6">
                    <button
                      type="button"
                      onClick={() => setCorpusPanelOpen(false)}
                      className="absolute right-4 top-4 flex h-9 w-9 items-center justify-center rounded-xl border border-white/15 bg-white/10 text-slate-200 transition-colors hover:bg-white/20 hover:text-white"
                      aria-label="Collapse RAG document collection panel"
                      title="Collapse corpus information"
                    >
                      <PanelLeftClose className="h-4 w-4" />
                    </button>
                    <div className="flex h-full flex-col justify-center">
                      <h2 className="mb-3 pr-8 text-3xl leading-tight 2xl:text-4xl">RAG Document Collection</h2>
                      <p className="text-sm leading-relaxed text-slate-300">
                        Answers are grounded in searchable excerpts from public DC PSC e-Docket filings.
                      </p>

                      <div className="my-5 border-y border-white/15 py-4">
                        <p className="font-display text-2xl font-bold leading-none text-white 2xl:text-3xl">153K+</p>
                        <p className="mt-2 text-sm leading-relaxed text-slate-300">Public PDFs indexed as page-level text</p>
                      </div>

                      <div className="space-y-3">
                      <div className="flex items-start gap-3">
                        <div className="mt-1 bg-psc-gold/20 p-1 rounded-full">
                          <ChevronRight className="w-4 h-4 text-psc-gold" />
                        </div>
                        <p className="text-sm leading-relaxed text-slate-200">Search filing text and metadata across DC PSC cases.</p>
                      </div>
                      <div className="flex items-start gap-3">
                        <div className="mt-1 bg-psc-gold/20 p-1 rounded-full">
                          <ChevronRight className="w-4 h-4 text-psc-gold" />
                        </div>
                        <p className="text-sm leading-relaxed text-slate-200">Open official filing links to verify each answer.</p>
                      </div>
                      </div>
                    </div>
                  </div>
                  
                  <div className="flex flex-shrink-0 items-center gap-3 rounded-2xl border border-slate-200 bg-white p-5 lg:p-4">
                    <div className="rounded-xl bg-psc-light p-2.5">
                      <Info className="h-5 w-5 text-psc-blue" />
                    </div>
                    <p className="text-xs text-slate-500 italic">
                      Note: This assistant uses AI to search public records. For official legal filings, please visit the e-Docket system.
                    </p>
                  </div>
                </div>
              </motion.div>}

              {/* Chat Interface */}
              <motion.div
                layout
                id="docket-chat"
                className={cn(
                  "order-1 scroll-mt-24 lg:order-2",
                  corpusPanelOpen ? "lg:col-span-8 xl:col-span-9" : "lg:col-span-12"
                )}
              >
                <div className="bg-white rounded-3xl shadow-xl border border-slate-200 flex h-[calc(100dvh-7rem)] min-h-[520px] max-h-[760px] overflow-hidden relative z-10">
                  {/* Left Chat History Pane */}
                  <div className={cn(
                    "absolute z-30 flex h-full w-[calc(100%-2.5rem)] max-w-80 flex-shrink-0 flex-col border-r border-slate-800 bg-slate-900 transition-transform duration-300 md:relative md:z-auto md:w-64 md:translate-x-0",
                    sidebarOpen ? "translate-x-0" : "-translate-x-full md:translate-x-0"
                  )}>
                    {/* New Chat Button */}
                    <div className="flex gap-2 border-b border-slate-800 p-4">
                      <button
                        onClick={handleNewChat}
                        className="flex flex-1 cursor-pointer items-center justify-center gap-2 rounded-xl bg-psc-gold px-4 py-3 text-sm font-bold text-psc-blue shadow-md transition-all hover:bg-psc-gold/90"
                      >
                        <Plus className="w-4 h-4" />
                        New Chat
                      </button>
                      <button
                        type="button"
                        onClick={() => setSidebarOpen(false)}
                        className="flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-xl text-slate-400 transition-colors hover:bg-white/10 hover:text-white md:hidden"
                        aria-label="Close conversation history"
                        title="Close conversation history"
                      >
                        <X className="h-5 w-5" />
                      </button>
                    </div>

                    {/* Chat Sessions list */}
                    <div className="flex-grow overflow-y-auto p-3 space-y-1 scrollbar-thin scrollbar-thumb-slate-800">
                      {sessions.map(session => {
                        const isActive = session.id === activeSessionId;
                        return (
                          <div
                            key={session.id}
                            className={cn(
                              "group flex items-center rounded-xl border transition-all",
                              isActive
                                ? "bg-white/10 text-white border-white/10 font-medium"
                                : "text-slate-400 hover:bg-white/5 hover:text-slate-200 border-transparent"
                            )}
                          >
                            <button
                              type="button"
                              onClick={() => {
                                if (session.id !== activeSessionId) cancelActiveRequest();
                                shouldAutoScrollRef.current = true;
                                setActiveSessionId(session.id);
                                setSidebarOpen(false);
                              }}
                              className="flex min-w-0 flex-1 items-center gap-2.5 overflow-hidden px-3 py-3 text-left"
                              aria-current={isActive ? "page" : undefined}
                            >
                              <MessageSquare className={cn("h-4 w-4 flex-shrink-0", isActive ? "text-psc-gold" : "text-slate-500")} />
                              <span className="truncate text-xs tracking-wide">{session.title}</span>
                            </button>
                            <button
                              onClick={(e) => handleDeleteChat(session.id, e)}
                              className="mr-1 flex h-9 w-9 flex-shrink-0 cursor-pointer items-center justify-center rounded-lg text-slate-400 transition-colors hover:bg-rose-500/10 hover:text-rose-400 md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100"
                              aria-label={`Delete conversation: ${session.title}`}
                              title="Delete conversation"
                            >
                              <Trash2 className="h-4 w-4" />
                            </button>
                          </div>
                        );
                      })}
                    </div>
                    
                    {/* Sidebar Footer */}
                    <div className="p-4 border-t border-slate-800 bg-slate-950/40 text-[10px] text-slate-500 tracking-wider flex items-center justify-between">
                      <span>CHATS SAVED ON THIS DEVICE</span>
                      <span className="w-1.5 h-1.5 rounded-full bg-emerald-500"></span>
                    </div>
                  </div>

                  {/* Overlay for mobile sidebar */}
                  {sidebarOpen && (
                    <div 
                      className="absolute inset-0 bg-black/50 z-20 md:hidden"
                      onClick={() => setSidebarOpen(false)}
                    />
                  )}

                  {/* Right Chat Pane */}
                  <div className="flex-grow flex flex-col h-full overflow-hidden bg-white">
                    {/* Chat Header */}
                    <div className="flex items-center justify-between border-b border-slate-100 bg-slate-50/50 p-4 sm:p-6">
                      <div className="flex items-center gap-3">
                        {/* Mobile sidebar toggle */}
                        <button
                          onClick={() => setSidebarOpen(!sidebarOpen)}
                          className="p-2 -ml-2 rounded-lg text-slate-500 hover:bg-slate-100 md:hidden transition-colors cursor-pointer"
                          title="Conversation history"
                        >
                          <Menu className="w-5 h-5" />
                        </button>
                        <img src="/favicon.svg" alt="" aria-hidden="true" className="h-10 w-10 flex-shrink-0" />
                        <div>
                          <div className="flex items-center gap-2">
                            <h3 className="font-display text-sm font-bold text-psc-blue md:text-base">PSC Assistant</h3>
                            <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[9px] font-bold tracking-widest text-amber-800">BETA</span>
                          </div>
                          <div className="flex items-center gap-1.5">
                            <div className={cn(
                              "w-2 h-2 rounded-full",
                              health?.status === 'ok' ? "bg-green-500" : "bg-amber-500"
                            )}></div>
                            <span className="text-[10px] uppercase font-bold tracking-widest text-slate-400">
                              {health?.status === 'ok' ? 'Corpus current' : health ? 'Limited status' : 'Checking status'}
                              {health?.fullTextCoverage?.searchablePercent != null
                                ? ` · ${health.fullTextCoverage.searchablePercent}% searchable`
                                : ''}
                            </span>
                          </div>
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        {!corpusPanelOpen && (
                          <button
                            type="button"
                            onClick={() => setCorpusPanelOpen(true)}
                            className="flex items-center gap-1.5 rounded-lg px-2.5 py-2 text-xs font-semibold text-slate-500 transition-colors hover:bg-psc-blue/5 hover:text-psc-blue"
                            aria-label="Expand RAG document collection panel"
                            title="Show corpus information"
                          >
                            <PanelLeftOpen className="h-4 w-4" />
                            <span className="hidden sm:inline">Corpus info</span>
                          </button>
                        )}
                        <a
                          href="mailto:gz163@georgetown.edu?subject=PSC%20Docket%20Helper%20feedback"
                          className="p-2 rounded-lg text-slate-400 hover:text-psc-blue hover:bg-psc-blue/5 transition-colors"
                          aria-label="Report an issue"
                          title="Report an issue"
                        >
                          <MessageCircle className="h-4 w-4" />
                        </a>
                        <button 
                          onClick={handleClearChat}
                          className={cn(
                            "flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-bold transition-all duration-300 cursor-pointer",
                            confirmClear 
                              ? "bg-rose-500 text-white shadow-sm ring-2 ring-rose-300 ring-offset-1" 
                              : "text-slate-400 hover:text-rose-500 hover:bg-rose-50"
                          )}
                          title="Reset active chat"
                        >
                          <RotateCcw className="w-4 h-4 animate-spin-hover" />
                          {confirmClear ? <span>Confirm Clear</span> : <span className="hidden sm:inline">Reset Chat</span>}
                        </button>
                      </div>
                    </div>

                    {/* Messages Area */}
                    <div
                      ref={messagesContainerRef}
                      data-testid="messages-container"
                      onScroll={handleMessagesScroll}
                      onWheel={handleMessagesWheel}
                      onTouchStart={handleMessagesTouchStart}
                      onTouchMove={handleMessagesTouchMove}
                      className="flex-grow space-y-4 overflow-y-auto bg-[url('https://www.transparenttextures.com/patterns/cubes.png')] bg-fixed p-3 sm:space-y-6 sm:p-6"
                    >
                      {messages.map((msg, idx) => (
                        <motion.div
                          key={idx}
                          initial={{ opacity: 0, x: msg.role === 'user' ? 20 : -20 }}
                          animate={{ opacity: 1, x: 0 }}
                          className={cn(
                            "flex max-w-[95%] sm:max-w-[85%]",
                            msg.role === 'user' ? "ml-auto flex-row-reverse" : "mr-auto"
                          )}
                        >
                          <div className={cn(
                            "flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full text-xs font-bold sm:h-8 sm:w-8",
                            msg.role === 'user' ? "ml-2 bg-psc-gold text-psc-blue sm:ml-3" : "mr-2 bg-psc-blue text-white sm:mr-3"
                          )}>
                            {msg.role === 'user' ? 'U' : 'A'}
                          </div>
                          <div className={cn(
                            "p-4 rounded-2xl shadow-sm",
                            msg.role === 'user' 
                              ? "bg-psc-blue text-white rounded-tr-none" 
                              : "bg-slate-100 text-slate-800 rounded-tl-none"
                          )}>
                            <div className="markdown-body text-sm">
                              <ReactMarkdown
                                components={{
                                  a: ({ href, children }) => (
                                    <VerifiedLink href={href || ''}>
                                      {children}
                                    </VerifiedLink>
                                  )
                                }}
                              >
                                {msg.content}
                              </ReactMarkdown>
                            </div>
                            {msg.role === 'model' && msg.feedbackToken && appConfig?.feedbackEnabled && (
                              <div className="mt-3 border-t border-slate-200 pt-3">
                                <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
                                  <span>Was this answer useful?</span>
                                  <button
                                    type="button"
                                    onClick={() => void recordFeedback(idx, msg, 'up')}
                                    disabled={feedbackSubmittingToken === msg.feedbackToken}
                                    aria-label="Mark this answer as useful"
                                    aria-pressed={msg.feedbackRating === 'up'}
                                    className={cn(
                                      "rounded-lg border p-1.5 transition-colors",
                                      msg.feedbackRating === 'up'
                                        ? "border-emerald-300 bg-emerald-50 text-emerald-700"
                                        : "border-slate-200 bg-white text-slate-500 hover:border-emerald-300 hover:text-emerald-700"
                                    )}
                                  >
                                    <ThumbsUp className="h-3.5 w-3.5" />
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => {
                                      setFeedbackFormToken(msg.feedbackToken ?? null);
                                      setFeedbackReason('incorrect');
                                      setFeedbackComment('');
                                      setFeedbackErrorToken(null);
                                    }}
                                    disabled={feedbackSubmittingToken === msg.feedbackToken}
                                    aria-label="Report a problem with this answer"
                                    aria-pressed={msg.feedbackRating === 'down'}
                                    className={cn(
                                      "rounded-lg border p-1.5 transition-colors",
                                      msg.feedbackRating === 'down'
                                        ? "border-rose-300 bg-rose-50 text-rose-700"
                                        : "border-slate-200 bg-white text-slate-500 hover:border-rose-300 hover:text-rose-700"
                                    )}
                                  >
                                    <ThumbsDown className="h-3.5 w-3.5" />
                                  </button>
                                  {msg.feedbackRating && feedbackFormToken !== msg.feedbackToken && (
                                    <span className="inline-flex items-center gap-1 text-emerald-700">
                                      <Check className="h-3.5 w-3.5" /> Feedback recorded
                                    </span>
                                  )}
                                </div>

                                {feedbackFormToken === msg.feedbackToken && (
                                  <div className="mt-3 space-y-3 rounded-xl border border-slate-200 bg-white p-3">
                                    <label className="block text-xs font-semibold text-slate-700">
                                      What went wrong?
                                      <select
                                        value={feedbackReason}
                                        onChange={event => setFeedbackReason(event.target.value as FeedbackReason)}
                                        className="mt-1.5 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs text-slate-700"
                                      >
                                        {FEEDBACK_REASONS.map(reason => (
                                          <option key={reason.value} value={reason.value}>{reason.label}</option>
                                        ))}
                                      </select>
                                    </label>
                                    <label className="block text-xs font-semibold text-slate-700">
                                      Details (optional)
                                      <textarea
                                        value={feedbackComment}
                                        onChange={event => setFeedbackComment(event.target.value.slice(0, 1000))}
                                        rows={3}
                                        placeholder="Tell us what you expected or which part needs attention."
                                        className="mt-1.5 w-full resize-y rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs text-slate-700"
                                      />
                                    </label>
                                    <p className="text-[11px] leading-relaxed text-slate-500">
                                      Submitting sends this question, an answer excerpt, your selected reason, and your comment to the site maintainer. Do not include confidential information.
                                    </p>
                                    {feedbackErrorToken === msg.feedbackToken && (
                                      <p className="text-xs font-medium text-rose-600">Feedback could not be sent. Please try again.</p>
                                    )}
                                    <div className="flex justify-end gap-2">
                                      <button
                                        type="button"
                                        onClick={() => setFeedbackFormToken(null)}
                                        className="rounded-lg px-3 py-2 text-xs font-semibold text-slate-500 hover:bg-slate-100"
                                      >
                                        Cancel
                                      </button>
                                      <button
                                        type="button"
                                        onClick={() => void recordFeedback(idx, msg, 'down')}
                                        disabled={feedbackSubmittingToken === msg.feedbackToken}
                                        className="rounded-lg bg-psc-blue px-3 py-2 text-xs font-bold text-white hover:bg-psc-blue/90 disabled:opacity-50"
                                      >
                                        {feedbackSubmittingToken === msg.feedbackToken ? 'Sending…' : 'Submit feedback'}
                                      </button>
                                    </div>
                                  </div>
                                )}
                              </div>
                            )}
                          </div>
                        </motion.div>
                      ))}
                      {!hasUserMessages && (
                        <div className="ml-9 max-w-2xl rounded-2xl border border-psc-blue/10 bg-white/90 p-4 shadow-sm sm:ml-11">
                          <p className="mb-3 text-xs font-bold uppercase tracking-widest text-slate-400">Try an example</p>
                          <div className="grid gap-2">
                            {EXAMPLE_QUESTIONS.map(question => (
                              <button
                                key={question}
                                type="button"
                                onClick={() => {
                                  setInput(question);
                                  inputRef.current?.focus();
                                }}
                                className="rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-left text-xs font-semibold text-slate-600 transition-colors hover:border-psc-gold hover:text-psc-blue"
                              >
                                {question}
                              </button>
                            ))}
                          </div>
                        </div>
                      )}
                      {isTyping && !isReceivingContent && (
                        <div className="mr-auto flex max-w-[95%] sm:max-w-[85%]">
                          <div className="mr-2 flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full bg-psc-blue text-white sm:mr-3 sm:h-8 sm:w-8">
                            A
                          </div>
                          <div className="bg-slate-100 p-4 rounded-2xl rounded-tl-none shadow-sm">
                            <div className="flex gap-1">
                              <div className="w-2 h-2 bg-slate-400 rounded-full animate-bounce"></div>
                              <div className="w-2 h-2 bg-slate-400 rounded-full animate-bounce [animation-delay:0.2s]"></div>
                              <div className="w-2 h-2 bg-slate-400 rounded-full animate-bounce [animation-delay:0.4s]"></div>
                            </div>
                          </div>
                        </div>
                      )}
                      {failedRequest?.sessionId === activeSessionId && !isTyping && (
                        <div className="flex mr-auto pl-11">
                          <button
                            type="button"
                            onClick={handleRetryRequest}
                            disabled={Boolean(appConfig?.turnstileRequired && !turnstileToken)}
                            className="inline-flex items-center gap-2 rounded-xl border border-psc-blue/20 bg-white px-4 py-2 text-sm font-semibold text-psc-blue shadow-sm transition-colors hover:bg-psc-blue/5"
                          >
                            <RotateCcw className="h-4 w-4" />
                            Retry request
                          </button>
                        </div>
                      )}
                    </div>

                    {/* Input Area */}
                    <form onSubmit={handleSendMessage} className="border-t border-slate-100 bg-slate-50/50 p-3 sm:p-5">
                      <div className="relative">
                        <textarea
                          ref={inputRef}
                          rows={1}
                          value={input}
                          onChange={(e) => setInput(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                              e.preventDefault();
                              e.currentTarget.form?.requestSubmit();
                            }
                          }}
                          placeholder="Ask about a docket number or utility case..."
                          aria-label="Message PSC Assistant"
                          maxLength={appConfig?.maxMessageLength ?? 5000}
                          className="block w-full min-h-[64px] max-h-40 resize-none bg-white border border-slate-200 rounded-2xl py-3.5 pl-4 pr-20 leading-6 focus:outline-none focus:ring-2 focus:ring-psc-blue/20 focus:border-psc-blue transition-[border-color,box-shadow] shadow-inner sm:min-h-[72px] sm:py-4 sm:pl-5"
                        />
                        <button
                          type={isTyping ? "button" : "submit"}
                          onClick={isTyping ? handleStopGenerating : undefined}
                          disabled={isTyping ? false : !appConfig || !input.trim() || Boolean(appConfig.turnstileRequired && !turnstileToken)}
                          aria-label={isTyping ? "Stop generating" : "Send message"}
                          title={isTyping ? "Stop generating" : "Send message"}
                          className={cn(
                            "absolute right-3 bottom-3 w-12 h-12 text-white rounded-xl disabled:opacity-50 disabled:cursor-not-allowed transition-all flex items-center justify-center cursor-pointer",
                            isTyping
                              ? "bg-slate-700 hover:bg-rose-600"
                              : "bg-psc-blue hover:bg-psc-blue/90"
                          )}
                        >
                          {isTyping
                            ? <Square className="w-4 h-4 fill-current" />
                            : <Send className="w-5 h-5" />}
                        </button>
                      </div>
                      {appConfig?.turnstileRequired && appConfig.turnstileSiteKey ? (
                        <div className="mt-2">
                          <TurnstileWidget
                            siteKey={appConfig.turnstileSiteKey}
                            resetSignal={turnstileResetSignal}
                            onToken={setTurnstileToken}
                          />
                          {turnstileStalled && (
                            <div className="mt-2 flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
                              <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" />
                              <span>
                                Security verification has not finished, so sending is paused. It usually clears on its own in a moment.
                                If it does not, an ad blocker, privacy extension, or network filter is likely blocking
                                <span className="whitespace-nowrap"> challenges.cloudflare.com</span> — allow it for this site and reload.
                              </span>
                            </div>
                          )}
                        </div>
                      ) : appConfig?.turnstileRequired ? (
                        <div className="mt-3 flex items-center gap-2 rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
                          <AlertTriangle className="h-4 w-4 flex-shrink-0" />
                          Security verification is temporarily unavailable. Chat submissions are paused.
                        </div>
                      ) : null}
                      <p className="mt-2 text-[10px] leading-relaxed text-slate-500 sm:text-[11px]">
                        Public-record research only. Verify answers against linked filings; do not submit confidential or personal information.
                      </p>
                    </form>
                  </div>
                </div>
              </motion.div>
            </div>
          </div>
        </section>

        <LatestUpdatesSection news={news} loading={loadingNews} />

        <section id="privacy" className="border-t border-slate-200 bg-white py-16">
          <div className="mx-auto max-w-5xl px-4 sm:px-6 lg:px-8">
            <div className="rounded-3xl border border-slate-200 bg-slate-50 p-8 shadow-sm">
              <div className="mb-5 flex items-center gap-3">
                <div className="rounded-xl bg-psc-blue p-2.5 text-white">
                  <ShieldCheck className="h-5 w-5" />
                </div>
                <div>
                  <p className="text-xs font-bold uppercase tracking-widest text-psc-gold">Privacy & responsible use</p>
                  <h2 className="text-2xl text-psc-blue">What happens to your questions</h2>
                </div>
              </div>
              <div className="grid gap-5 text-sm leading-relaxed text-slate-600 md:grid-cols-2">
                <div>
                  <h3 className="mb-2 text-base text-slate-900">Stored on this device</h3>
                  <p>Conversation history is saved in this browser's local storage so it can reappear on your next visit. The {MAX_STORED_SESSIONS} most recent conversations are kept; older ones are discarded to stay within the browser's storage limit. Clearing browser storage removes it. Changing domains does not transfer that history automatically.</p>
                </div>
                <div>
                  <h3 className="mb-2 text-base text-slate-900">Sent for answer generation</h3>
                  <p>Your question, up to ten recent chat messages, and relevant public filing excerpts may be sent to OpenAI through Cloudflare AI Gateway to generate an answer.</p>
                </div>
                <div>
                  <h3 className="mb-2 text-base text-slate-900">Information you should not submit</h3>
                  <p>Do not enter confidential, privileged, personal, proprietary, or non-public regulatory information. This service is intended only for research involving public records.</p>
                </div>
                <div>
                  <h3 className="mb-2 text-base text-slate-900">No official or legal reliance</h3>
                  <p>This independent beta is not affiliated with DC PSC and does not provide legal advice. AI summaries and cross-case results may be incomplete; verify important claims in the linked official filing.</p>
                </div>
              </div>
            </div>
          </div>
        </section>
      </main>

      {/* Footer */}
      <footer className="bg-slate-900 text-white pt-20 pb-10">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-12 mb-20">
            <div className="col-span-1 lg:col-span-1">
              <div className="flex items-center gap-3 mb-8">
                <img src="/favicon.svg" alt="" aria-hidden="true" className="h-9 w-9 flex-shrink-0" />
                <h2 className="text-xl font-display font-bold">AI Assistant</h2>
              </div>
              <p className="text-slate-400 text-sm leading-relaxed mb-8">
                An independent AI-powered tool designed to help you navigate Public Service Commission information and dockets more efficiently.
              </p>
              <div className="flex gap-4">
                <a href="https://twitter.com/dcpsc" target="_blank" rel="noopener noreferrer" className="w-10 h-10 rounded-full bg-white/5 flex items-center justify-center hover:bg-psc-gold hover:text-psc-blue transition-all">
                  <span className="sr-only">Twitter</span>
                  <svg className="w-5 h-5 fill-current" viewBox="0 0 24 24"><path d="M23.953 4.57a10 10 0 01-2.825.775 4.958 4.958 0 002.163-2.723c-.951.555-2.005.959-3.127 1.184a4.92 4.92 0 00-8.384 4.482C7.69 8.095 4.067 6.13 1.64 3.162a4.822 4.822 0 00-.666 2.475c0 1.71.87 3.213 2.188 4.096a4.904 4.904 0 01-2.228-.616v.06a4.923 4.923 0 003.946 4.84 4.996 4.996 0 01-2.212.085 4.936 4.936 0 004.604 3.417 9.867 9.867 0 01-6.102 2.105c-.39 0-.779-.023-1.17-.067a13.995 13.995 0 007.557 2.209c9.053 0 13.998-7.496 13.998-13.985 0-.21 0-.42-.015-.63A9.935 9.935 0 0024 4.59z"/></svg>
                </a>
                <a href="https://www.facebook.com/DCPSC/" target="_blank" rel="noopener noreferrer" className="w-10 h-10 rounded-full bg-white/5 flex items-center justify-center hover:bg-psc-gold hover:text-psc-blue transition-all">
                  <span className="sr-only">Facebook</span>
                  <svg className="w-5 h-5 fill-current" viewBox="0 0 24 24"><path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z"/></svg>
                </a>
                <a href="https://www.linkedin.com/company/public-service-commission-of-the-district-of-columbia" target="_blank" rel="noopener noreferrer" className="w-10 h-10 rounded-full bg-white/5 flex items-center justify-center hover:bg-psc-gold hover:text-psc-blue transition-all">
                  <span className="sr-only">LinkedIn</span>
                  <svg className="w-5 h-5 fill-current" viewBox="0 0 24 24"><path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433c-1.144 0-2.063-.926-2.063-2.065 0-1.138.92-2.063 2.063-2.063 1.14 0 2.064.925 2.064 2.063 0 1.139-.925 2.065-2.064 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z"/></svg>
                </a>
              </div>
            </div>

            <div>
              <h4 className="text-psc-gold text-sm font-bold uppercase tracking-widest mb-8">Quick Links</h4>
              <ul className="space-y-4 text-slate-400 text-sm">
                <li><a href="https://dcpsc.org/About-PSC.aspx" target="_blank" rel="noopener noreferrer" className="hover:text-white transition-colors">About the Commission</a></li>
                <li><a href="https://edocket.dcpsc.org/" target="_blank" rel="noopener noreferrer" className="hover:text-white transition-colors">e-Docket System</a></li>
                <li><a href="#privacy" className="hover:text-white transition-colors">Privacy & Responsible Use</a></li>
                <li><a href="mailto:gz163@georgetown.edu?subject=PSC%20Docket%20Helper%20feedback" className="hover:text-white transition-colors">Report an Issue</a></li>
              </ul>
            </div>

            <div>
              <h4 className="text-psc-gold text-sm font-bold uppercase tracking-widest mb-8">Contact</h4>
              <ul className="space-y-4 text-slate-400 text-sm">
                <li className="font-medium text-slate-300">Nora Zhan</li>
                <li><a href="mailto:gz163@georgetown.edu" className="hover:text-white transition-colors">gz163@georgetown.edu</a></li>
                <li>Georgetown University</li>
              </ul>
            </div>
          </div>
          
          <div className="pt-10 border-t border-white/10 flex flex-col gap-8 text-slate-500 text-xs">
            <div className="bg-white/5 p-6 rounded-2xl border border-white/10 max-w-4xl">
              <p className="text-psc-gold font-bold mb-2 uppercase tracking-widest text-[10px]">Non-Official AI Assistant Disclosure</p>
              <p className="leading-relaxed text-slate-400">
                This platform is an independent AI-powered information navigation tool and is <strong className="text-slate-300">not</strong> an official portal or representative of the Public Service Commission of the District of Columbia. 
                While we aim to provide helpful summaries of public records, all AI-generated content should be verified against official filings. 
                For legal or official regulatory purposes, please consult the <a href="https://dcpsc.org" target="_blank" rel="noopener noreferrer" className="text-psc-gold hover:underline">official DC PSC website</a> and e-Docket system directly.
              </p>
            </div>
          </div>
        </div>
      </footer>
    </div>
  );
}
