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
  Square
} from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import { cn } from './lib/utils';
import { AssistantRequestCancelledError, AssistantRequestError, getHealthSummary, getLatestPSCUpdates, getPublicAppConfig, chatWithDocketAssistant } from './services/geminiService';
import { Message, NewsUpdate, ChatSession, HealthSummary, PublicAppConfig } from './types';
import VerifiedLink, { normalizeUrl } from './components/VerifiedLink';
import TurnstileWidget from './components/TurnstileWidget';

const EXAMPLE_QUESTIONS = [
  "In FC1176, what drove Pepco's 2025 O&M expense variance?",
  'Which FC1176 filings discuss bad debt or uncollectible accounts?'
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

export default function App() {
  const [news, setNews] = useState<NewsUpdate[]>([]);
  const [loadingNews, setLoadingNews] = useState(true);
  const [appConfig, setAppConfig] = useState<PublicAppConfig | null>(null);
  const [health, setHealth] = useState<HealthSummary | null>(null);
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
  const [turnstileResetSignal, setTurnstileResetSignal] = useState(0);
  
  const [sessions, setSessions] = useState<ChatSession[]>(() => {
    try {
      const saved = localStorage.getItem('dc_psc_chat_sessions');
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed) && parsed.length > 0) {
          return parsed;
        }
      }
    } catch (e) {
      console.error("Error loading chat sessions from localStorage:", e);
    }
    const defaultId = 'session_' + Date.now();
    return [
      {
        id: defaultId,
        title: "New Inquiry",
        messages: [
          { role: 'model', content: "Hello! I'm your DC PSC Docket Assistant. How can I help you find information about dockets or regulatory filings today?" }
        ],
        createdAt: Date.now()
      }
    ];
  });

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
  const [failedRequest, setFailedRequest] = useState<{ sessionId: string; message: string } | null>(null);
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
    try {
      localStorage.setItem('dc_psc_chat_sessions', JSON.stringify(sessions));
    } catch (e) {
      console.error("Error saving chat sessions to localStorage:", e);
    }
  }, [sessions, isTyping]);

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
    if (confirmClear) {
      const timer = setTimeout(() => {
        setConfirmClear(false);
      }, 3000);
      return () => clearTimeout(timer);
    }
  }, [confirmClear]);

  const activeSession = sessions.find(s => s.id === activeSessionId) || sessions[0];
  const messages = activeSession ? activeSession.messages : [];
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
    const newId = 'session_' + Date.now();
    const newSession: ChatSession = {
      id: newId,
      title: "New Inquiry",
      messages: [
        { role: 'model', content: "Hello! I'm your DC PSC Docket Assistant. How can I help you find information about dockets or regulatory filings today?" }
      ],
      createdAt: Date.now()
    };
    setSessions(prev => [newSession, ...prev]);
    setActiveSessionId(newId);
  };

  const handleDeleteChat = (idToDelete: string, e: React.MouseEvent) => {
    e.stopPropagation();
    cancelActiveRequest(idToDelete);
    shouldAutoScrollRef.current = true;
    if (sessions.length <= 1) {
      const defaultId = 'session_' + Date.now();
      setSessions([
        {
          id: defaultId,
          title: "New Inquiry",
          messages: [
            { role: 'model', content: "Hello! I'm your DC PSC Docket Assistant. How can I help you find information about dockets or regulatory filings today?" }
          ],
          createdAt: Date.now()
        }
      ]);
      setActiveSessionId(defaultId);
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
            messages: [
              { role: 'model', content: "Hello! I'm your DC PSC Docket Assistant. How can I help you find information about dockets or regulatory filings today?" }
            ]
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

  const handleMessagesScroll = () => {
    const container = messagesContainerRef.current;
    if (!container) return;

    const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
    shouldAutoScrollRef.current = distanceFromBottom <= 64;
  };

  useLayoutEffect(() => {
    if (!shouldAutoScrollRef.current) return;

    const frame = requestAnimationFrame(() => {
      const container = messagesContainerRef.current;
      if (container) {
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
      const history = appendUserMessage
        ? activeSess.messages
        : activeSess.messages.at(-1)?.role === 'model'
          ? activeSess.messages.slice(0, -1)
          : activeSess.messages;
      // `message` is sent separately; including it in history duplicated the
      // current question in the model transcript.
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
      if (!streamedContent) {
        updateSessionMessages(targetSessionId, prev => [...prev, { role: 'model', content: response || "I'm sorry, I couldn't process that request." }]);
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
      updateSessionMessages(targetSessionId, prev => [...prev, { role: 'model', content }]);
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
          <div className="max-w-[1536px] mx-auto px-4 sm:px-6 lg:px-8">
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 xl:gap-10 items-start">
              {/* Info Sidebar */}
              <div className="order-2 lg:order-1 lg:col-span-4 xl:col-span-3">
                <div className="sticky top-28 lg:flex lg:h-[calc(100dvh-7rem)] lg:min-h-[520px] lg:max-h-[760px] lg:flex-col lg:gap-4">
                  <div className="mb-8 rounded-3xl bg-psc-blue p-8 text-white shadow-2xl lg:mb-0 lg:min-h-0 lg:flex-1 lg:overflow-y-auto lg:p-6">
                    <h2 className="mb-3 text-3xl leading-tight">RAG Document Collection</h2>
                    <p className="mb-6 leading-relaxed text-slate-300">
                      Answers use searchable excerpts from public DC PSC e-Docket filings.
                    </p>
                    <div className="space-y-3">
                      <div className="flex items-start gap-3">
                        <div className="mt-1 bg-psc-gold/20 p-1 rounded-full">
                          <ChevronRight className="w-4 h-4 text-psc-gold" />
                        </div>
                        <p className="text-sm text-slate-200">153,000+ public PDFs are indexed by page.</p>
                      </div>
                      <div className="flex items-start gap-3">
                        <div className="mt-1 bg-psc-gold/20 p-1 rounded-full">
                          <ChevronRight className="w-4 h-4 text-psc-gold" />
                        </div>
                        <p className="text-sm text-slate-200">Search filing text and metadata across DC PSC cases.</p>
                      </div>
                      <div className="flex items-start gap-3">
                        <div className="mt-1 bg-psc-gold/20 p-1 rounded-full">
                          <ChevronRight className="w-4 h-4 text-psc-gold" />
                        </div>
                        <p className="text-sm text-slate-200">Answers include official links for verification.</p>
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
              </div>

              {/* Chat Interface */}
              <div id="docket-chat" className="order-1 scroll-mt-24 lg:order-2 lg:col-span-8 xl:col-span-9">
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
              </div>
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
                  <p>Conversation history is saved in this browser's local storage so it can reappear on your next visit. Clearing browser storage removes it. Changing domains does not transfer that history automatically.</p>
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
