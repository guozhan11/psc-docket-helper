import { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { 
  Search, 
  Send, 
  Newspaper, 
  MessageSquare, 
  ExternalLink, 
  ChevronRight, 
  Loader2, 
  Scale, 
  Info,
  Menu,
  X,
  Phone,
  Mail,
  MapPin,
  RotateCcw,
  Trash2,
  Plus
} from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import { cn } from './lib/utils';
import { getLatestPSCUpdates, chatWithDocketAssistant } from './services/geminiService';
import { Message, NewsUpdate, ChatSession } from './types';
import VerifiedLink, { normalizeUrl } from './components/VerifiedLink';

export default function App() {
  const [news, setNews] = useState<NewsUpdate[]>([]);
  const [loadingNews, setLoadingNews] = useState(true);
  
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

  useEffect(() => {
    if (sessions.length > 0) {
      const exists = sessions.some(s => s.id === activeSessionId);
      if (!exists) {
        setActiveSessionId(sessions[0].id);
      }
    }
  }, [sessions, activeSessionId]);

  useEffect(() => {
    try {
      localStorage.setItem('dc_psc_chat_sessions', JSON.stringify(sessions));
    } catch (e) {
      console.error("Error saving chat sessions to localStorage:", e);
    }
  }, [sessions]);

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
  
  useEffect(() => {
    async function fetchNews() {
      const updates = await getLatestPSCUpdates();
      setNews(updates);
      setLoadingNews(false);
    }
    fetchNews();
  }, []);

  const handleSendMessage = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || isTyping) return;

    const userMessage = input.trim();
    setInput('');
    
    const targetSessionId = activeSessionId;
    const isFirstUserMessage = messages.filter(m => m.role === 'user').length === 0;

    updateSessionMessages(targetSessionId, prev => [...prev, { role: 'user', content: userMessage }], isFirstUserMessage ? userMessage : undefined);
    setIsTyping(true);

    try {
      const activeSess = sessions.find(s => s.id === targetSessionId) || sessions[0];
      const currentHistory: Message[] = [...activeSess.messages, { role: 'user', content: userMessage }];
      
      const response = await chatWithDocketAssistant(currentHistory, userMessage);
      updateSessionMessages(targetSessionId, prev => [...prev, { role: 'model', content: response || "I'm sorry, I couldn't process that request." }]);
    } catch (error) {
      console.error("Chat error:", error);
      updateSessionMessages(targetSessionId, prev => [...prev, { role: 'model', content: "There was an error connecting to the assistant. Please try again." }]);
    } finally {
      setIsTyping(false);
    }
  };

  return (
    <div className="min-h-screen flex flex-col">
      {/* Navigation */}
      <nav className="sticky top-0 z-50 bg-psc-blue text-white shadow-lg">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex justify-between h-20 items-center">
            <div className="flex items-center gap-3">
              <div className="bg-white p-2 rounded-lg">
                <Scale className="w-8 h-8 text-psc-blue" />
              </div>
              <div>
                <h1 className="text-xl font-display font-bold leading-tight uppercase">AI PROTOTYPE</h1>
                <p className="text-xs text-psc-gold font-medium uppercase tracking-widest">Public Service Commission</p>
              </div>
            </div>
            
            {/* Desktop Nav */}
            <div className="hidden md:flex items-center gap-8 font-medium text-sm">
              <a href="#" className="hover:text-psc-gold transition-colors">Home</a>
              <a href="#updates" className="hover:text-psc-gold transition-colors">News & Updates</a>
              <a href="#assistant" className="hover:text-psc-gold transition-colors">Docket Assistant</a>
              <a href="https://dcpsc.org" target="_blank" rel="noopener noreferrer" className="bg-psc-gold hover:bg-psc-gold/90 text-psc-blue px-5 py-2 rounded-full font-bold transition-all shadow-md">
                Visit Official Site
              </a>
            </div>

            {/* Mobile Menu Toggle */}
            <button 
              className="md:hidden p-2"
              onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
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
                <a href="#" className="text-lg font-medium">Home</a>
                <a href="#updates" className="text-lg font-medium">News & Updates</a>
                <a href="#assistant" className="text-lg font-medium">Docket Assistant</a>
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
        <section className="relative bg-psc-blue py-20 overflow-hidden">
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
                <span className="inline-block px-4 py-1 rounded-full bg-psc-gold/20 text-psc-gold text-sm font-bold mb-6 border border-psc-gold/30">
                  Non-Official AI Assistant
                </span>
                <h2 className="text-4xl md:text-6xl text-white mb-6 leading-tight">
                  Navigate DC PSC Dockets with <span className="text-psc-gold italic">AI-Powered</span> Insights
                </h2>
                <p className="text-xl text-slate-300 mb-10 leading-relaxed">
                  This is a non-official experimental tool designed to help you easily search, summarize, and explore public utility records and regulatory filings using advanced AI-assisted navigation.
                </p>
                <div className="flex flex-wrap gap-4">
                  <a href="#assistant" className="bg-white text-psc-blue px-8 py-4 rounded-xl font-bold hover:bg-slate-100 transition-all flex items-center gap-2 shadow-xl">
                    <MessageSquare className="w-5 h-5" />
                    Ask the Docket Assistant
                  </a>
                  <a href="#updates" className="bg-transparent border-2 border-white/30 text-white px-8 py-4 rounded-xl font-bold hover:bg-white/10 transition-all flex items-center gap-2">
                    <Newspaper className="w-5 h-5" />
                    View Latest Updates
                  </a>
                </div>
              </motion.div>
            </div>
          </div>
        </section>

        {/* Latest Updates Section */}
        <section id="updates" className="py-24 bg-white">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
            <div className="flex flex-col md:flex-row md:items-end justify-between mb-12 gap-6">
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

            {loadingNews ? (
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
                    <a 
                      href={normalizeUrl(item.url)} 
                      target="_blank" 
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-2 text-psc-blue font-bold text-sm hover:gap-3 transition-all"
                    >
                      Read Full Update <ExternalLink className="w-4 h-4" />
                    </a>
                  </motion.div>
                ))}
              </div>
            )}
          </div>
        </section>

        {/* Chatbot Section */}
        <section id="assistant" className="py-24 bg-psc-light">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-12 items-start">
              {/* Info Sidebar */}
              <div className="lg:col-span-4">
                <div className="sticky top-28">
                  <div className="bg-psc-blue text-white p-8 rounded-3xl shadow-2xl mb-8">
                    <div className="bg-psc-gold/20 p-3 rounded-2xl w-fit mb-6">
                      <MessageSquare className="w-8 h-8 text-psc-gold" />
                    </div>
                    <h2 className="text-3xl mb-4">Docket Assistant</h2>
                    <p className="text-slate-300 mb-8 leading-relaxed">
                      This is a non-official experimental AI-powered assistant designed to help you search through thousands of historical dockets, find specific case numbers, and summarize complex regulatory filings.
                    </p>
                    <div className="space-y-4">
                      <div className="flex items-start gap-3">
                        <div className="mt-1 bg-psc-gold/20 p-1 rounded-full">
                          <ChevronRight className="w-4 h-4 text-psc-gold" />
                        </div>
                        <p className="text-sm text-slate-200">Search by docket number (e.g., FC 1167)</p>
                      </div>
                      <div className="flex items-start gap-3">
                        <div className="mt-1 bg-psc-gold/20 p-1 rounded-full">
                          <ChevronRight className="w-4 h-4 text-psc-gold" />
                        </div>
                        <p className="text-sm text-slate-200">Ask about recent utility rate cases</p>
                      </div>
                      <div className="flex items-start gap-3">
                        <div className="mt-1 bg-psc-gold/20 p-1 rounded-full">
                          <ChevronRight className="w-4 h-4 text-psc-gold" />
                        </div>
                        <p className="text-sm text-slate-200">Find information on renewable energy goals</p>
                      </div>
                    </div>
                  </div>
                  
                  <div className="bg-white p-6 rounded-2xl border border-slate-200 flex items-center gap-4">
                    <div className="bg-psc-light p-3 rounded-xl">
                      <Info className="w-6 h-6 text-psc-blue" />
                    </div>
                    <p className="text-xs text-slate-500 italic">
                      Note: This assistant uses AI to search public records. For official legal filings, please visit the e-Docket system.
                    </p>
                  </div>
                </div>
              </div>

              {/* Chat Interface */}
              <div className="lg:col-span-8">
                <div className="bg-white rounded-3xl shadow-xl border border-slate-200 flex h-[600px] overflow-hidden relative z-10">
                  {/* Left Chat History Pane */}
                  <div className={cn(
                    "w-64 bg-slate-900 border-r border-slate-800 flex flex-col h-full flex-shrink-0 transition-transform duration-300 md:translate-x-0 absolute md:relative z-30 md:z-auto",
                    sidebarOpen ? "translate-x-0" : "-translate-x-full md:translate-x-0"
                  )}>
                    {/* New Chat Button */}
                    <div className="p-4 border-b border-slate-800">
                      <button
                        onClick={handleNewChat}
                        className="w-full flex items-center justify-center gap-2 bg-psc-gold hover:bg-psc-gold/90 text-psc-blue font-bold py-3 px-4 rounded-xl transition-all shadow-md text-sm cursor-pointer"
                      >
                        <Plus className="w-4 h-4" />
                        New Chat
                      </button>
                    </div>

                    {/* Chat Sessions list */}
                    <div className="flex-grow overflow-y-auto p-3 space-y-1 scrollbar-thin scrollbar-thumb-slate-800">
                      {sessions.map(session => {
                        const isActive = session.id === activeSessionId;
                        return (
                          <div
                            key={session.id}
                            onClick={() => {
                              setActiveSessionId(session.id);
                              setSidebarOpen(false);
                            }}
                            className={cn(
                              "group flex items-center justify-between px-3 py-3 rounded-xl cursor-pointer transition-all border text-left",
                              isActive
                                ? "bg-white/10 text-white border-white/10 font-medium"
                                : "text-slate-400 hover:bg-white/5 hover:text-slate-200 border-transparent"
                            )}
                          >
                            <div className="flex items-center gap-2.5 overflow-hidden w-full pr-1">
                              <MessageSquare className={cn("w-4 h-4 flex-shrink-0", isActive ? "text-psc-gold" : "text-slate-500")} />
                              <span className="truncate text-xs tracking-wide">{session.title}</span>
                            </div>
                            <button
                              onClick={(e) => handleDeleteChat(session.id, e)}
                              className="text-slate-500 hover:text-rose-400 p-1 rounded-md opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0 cursor-pointer"
                              title="Delete conversation"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        );
                      })}
                    </div>
                    
                    {/* Sidebar Footer */}
                    <div className="p-4 border-t border-slate-800 bg-slate-950/40 text-[10px] text-slate-500 tracking-wider flex items-center justify-between">
                      <span>SECURE LOCAL MEMORY</span>
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
                    <div className="p-6 border-b border-slate-100 flex items-center justify-between bg-slate-50/50">
                      <div className="flex items-center gap-3">
                        {/* Mobile sidebar toggle */}
                        <button
                          onClick={() => setSidebarOpen(!sidebarOpen)}
                          className="p-2 -ml-2 rounded-lg text-slate-500 hover:bg-slate-100 md:hidden transition-colors cursor-pointer"
                          title="Conversation history"
                        >
                          <Menu className="w-5 h-5" />
                        </button>
                        <div className="w-10 h-10 rounded-full bg-psc-blue flex items-center justify-center text-white flex-shrink-0">
                          <Scale className="w-5 h-5" />
                        </div>
                        <div>
                          <h3 className="font-bold text-psc-blue text-sm md:text-base">PSC Assistant</h3>
                          <div className="flex items-center gap-1.5">
                            <div className="w-2 h-2 rounded-full bg-green-500 animate-pulse"></div>
                            <span className="text-[10px] uppercase font-bold tracking-widest text-slate-400">Online & Ready</span>
                          </div>
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
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
                    <div ref={messagesContainerRef} className="flex-grow overflow-y-auto p-6 space-y-6 bg-[url('https://www.transparenttextures.com/patterns/cubes.png')] bg-fixed">
                      {messages.map((msg, idx) => (
                        <motion.div
                          key={idx}
                          initial={{ opacity: 0, x: msg.role === 'user' ? 20 : -20 }}
                          animate={{ opacity: 1, x: 0 }}
                          className={cn(
                            "flex max-w-[85%]",
                            msg.role === 'user' ? "ml-auto flex-row-reverse" : "mr-auto"
                          )}
                        >
                          <div className={cn(
                            "w-8 h-8 rounded-full flex-shrink-0 flex items-center justify-center text-xs font-bold",
                            msg.role === 'user' ? "ml-3 bg-psc-gold text-psc-blue" : "mr-3 bg-psc-blue text-white"
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
                      {isTyping && (
                        <div className="flex mr-auto max-w-[85%]">
                          <div className="w-8 h-8 rounded-full flex-shrink-0 flex items-center justify-center bg-psc-blue text-white mr-3">
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
                    </div>

                    {/* Input Area */}
                    <form onSubmit={handleSendMessage} className="p-6 border-t border-slate-100 bg-slate-50/50">
                      <div className="relative">
                        <input
                          type="text"
                          value={input}
                          onChange={(e) => setInput(e.target.value)}
                          placeholder="Ask about a docket number or utility case..."
                          className="w-full bg-white border border-slate-200 rounded-2xl py-4 pl-6 pr-14 focus:outline-none focus:ring-2 focus:ring-psc-blue/20 focus:border-psc-blue transition-all shadow-inner"
                        />
                        <button
                          type="submit"
                          disabled={!input.trim() || isTyping}
                          className="absolute right-2 top-2 bottom-2 bg-psc-blue text-white px-4 rounded-xl hover:bg-psc-blue/90 disabled:opacity-50 disabled:cursor-not-allowed transition-all flex items-center justify-center cursor-pointer"
                        >
                          <Send className="w-5 h-5" />
                        </button>
                      </div>
                      <div className="mt-4 flex flex-wrap gap-2">
                        {['FC 1167', 'Rate Case Status', 'Renewable Energy'].map((tag) => (
                          <button
                            key={tag}
                            type="button"
                            onClick={() => setInput(tag)}
                            className="text-[10px] font-bold uppercase tracking-wider bg-white border border-slate-200 px-3 py-1.5 rounded-full text-slate-500 hover:border-psc-gold hover:text-psc-gold transition-all cursor-pointer"
                          >
                            {tag}
                          </button>
                        ))}
                      </div>
                    </form>
                  </div>
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
                <div className="bg-white p-1.5 rounded-lg">
                  <Scale className="w-6 h-6 text-psc-blue" />
                </div>
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
