import { useState, useRef, useEffect } from 'react';
import axios from 'axios';
import { Bot, MessageSquare, X, Send, Sparkles, User, HelpCircle, PhoneCall, Award, Trash2, Loader2 } from 'lucide-react';
import { useI18n } from '../lib/i18n';
import { BASE } from '../lib/api';

interface Message {
  id: string;
  sender: 'bot' | 'user';
  text: string;
  timestamp: string;
}

const KNOWLEDGE_BASE = {
  en: {
    welcome: 'Namaste! I am your AI Safaai Sahayak. How can I help you today with municipal sanitation, waste reporting, or reward points?',
    quickPrompts: [
      'How to file a report?',
      'Wet vs Dry waste rules',
      'How do Reward points work?',
      'Emergency helpline numbers',
    ],
  },
  hi: {
    welcome: 'नमस्ते! मैं आपका AI सफाई सहायक हूँ। आज मैं नगर निगम स्वच्छता, कचरा रिपोर्टिंग या रिवॉर्ड पॉइंट्स में आपकी क्या मदद कर सकता हूँ?',
    quickPrompts: [
      'कचरे की शिकायत कैसे दर्ज करें?',
      'गीला और सूखा कचरा नियम',
      'रिवॉर्ड पॉइंट्स कैसे मिलते हैं?',
      'आपातकालीन हेल्पलाइन नंबर',
    ],
  },
  gu: {
    welcome: 'નમસ્તે! હું તમારો AI સફાઈ સહાયક છું. નગરપાલિકા સ્વચ્છતા, કચરાની ફરિયાદ કે રિવોર્ડ પોઇન્ટ્સ અંગે હું તમારી શું મદદ કરી શકું?',
    quickPrompts: [
      'કચરાની ફરિયાદ કેવી રીતે કરવી?',
      'ભીનો અને સૂકો કચરો અલગ કરવાના નિયમો',
      'રિવોર્ડ પોઇન્ટ્સ કેવી રીતે મળે?',
      'ઇમરજન્સી હેલ્પલાઇન નંબર',
    ],
  },
};

export function Chatbot() {
  const { locale } = useI18n();
  const currentLang = locale === 'gu' || locale === 'hi' ? locale : 'en';
  const localized = KNOWLEDGE_BASE[currentLang];

  const [isOpen, setIsOpen] = useState(false);
  const [messages, setMessages] = useState<Message[]>([
    {
      id: 'welcome',
      sender: 'bot',
      text: localized.welcome,
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    },
  ]);
  const [input, setInput] = useState('');
  const [isTyping, setIsTyping] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (isOpen) {
      scrollRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages, isOpen]);

  /*
    The panel covers the whole viewport below lg, so the page behind it must
    not scroll under the finger. Desktop keeps its floating window and the page
    stays interactive, hence the width check rather than a blanket lock.
  */
  useEffect(() => {
    if (!isOpen) return;
    const fullScreen = window.matchMedia('(max-width: 1023px)').matches;
    if (!fullScreen) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, [isOpen]);

  /* Escape closes it — the same affordance as every other modal in the app. */
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setIsOpen(false);
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [isOpen]);

  async function handleSend(textToSend?: string) {
    const text = (textToSend || input).trim();
    if (!text) return;

    const userMsg: Message = {
      id: String(Date.now()),
      sender: 'user',
      text,
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    };

    setMessages((prev) => [...prev, userMsg]);
    if (!textToSend) setInput('');
    setIsTyping(true);

    try {
      const res = await axios.post(`${BASE}/api/public/chatbot`, { message: text, lang: currentLang });
      const botReply = res.data?.reply || 'I am your Safaai Sahayak. Please tap the Report tab to file a waste complaint.';

      const botMsg: Message = {
        id: String(Date.now() + 1),
        sender: 'bot',
        text: botReply,
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      };
      setMessages((prev) => [...prev, botMsg]);
    } catch {
      const fallbackReply =
        currentLang === 'gu'
          ? 'હું સફાઈ સહાયક છું. આપ નીચે Report ટેબથી કચરાની ફરિયાદ કરી શકો છો.'
          : currentLang === 'hi'
            ? 'मैं स्वच्छता सहायक हूँ। आप Report टैब से कचरे की शिकायत दर्ज कर सकते हैं।'
            : 'I am here to help. Tap the Report tab to file a waste complaint with photo proof.';

      const botMsg: Message = {
        id: String(Date.now() + 1),
        sender: 'bot',
        text: fallbackReply,
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      };
      setMessages((prev) => [...prev, botMsg]);
    } finally {
      setIsTyping(false);
    }
  }

  return (
    <>
      {/* Floating Action Trigger Button */}
      <button
        type="button"
        onClick={() => setIsOpen(true)}
        aria-label="AI Safaai Sahayak"
        className={`fixed bottom-20 right-4 z-40 flex h-14 w-14 items-center justify-center rounded-full bg-brand text-brand-ink shadow-2xl shadow-brand/40 transition hover:scale-105 active:scale-95 lg:bottom-6 lg:right-6 ${
          isOpen ? 'hidden' : 'flex'
        }`}
      >
        <Sparkles className="h-6 w-6 motion-reduce:animate-none" style={{ animation: 'bot-pop 1.8s ease-in-out infinite' }} />
        <style>{`
          @keyframes bot-pop {
            0%, 100% { transform: scale(1); }
            50% { transform: scale(1.22); }
          }
        `}</style>
      </button>

      {/* Chat panel — full screen wherever the app wears its mobile shell
          (phone and tablet, i.e. below lg), floating window on desktop. Below
          lg the bottom tab bar owns the foot of the screen, so a floating
          window there would sit on top of it. */}
      {isOpen && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="AI Safaai Sahayak"
          className="fixed inset-0 z-[70] flex flex-col overflow-hidden bg-surface
                     lg:inset-auto lg:bottom-6 lg:right-6 lg:h-[520px] lg:max-h-[80vh] lg:w-[380px]
                     lg:rounded-2xl lg:border lg:border-line lg:shadow-2xl"
        >
          {/* Chat Header — clears the notch on a full-screen phone panel. */}
          <div className="flex shrink-0 items-center justify-between gap-3 border-b border-line bg-brand px-4 py-3 pt-[calc(0.75rem+env(safe-area-inset-top))] text-brand-ink lg:pt-3">
            <div className="flex min-w-0 items-center gap-2.5">
              <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-white/20">
                <Bot className="h-5 w-5" />
              </span>
              <div className="min-w-0">
                <h3 className="truncate text-fluid-sm font-bold leading-tight">AI Safaai Sahayak</h3>
                <p className="truncate text-[11px] opacity-85">Municipal 24/7 Sanitation Assistant</p>
              </div>
            </div>
            {/* A real 40px target on its own ring — the bare icon was easy to
                miss against the green bar when the panel filled the screen. */}
            <button
              type="button"
              onClick={() => setIsOpen(false)}
              aria-label="Close chat"
              className="grid h-10 w-10 shrink-0 place-items-center rounded-full border border-white/25 bg-white/15 text-brand-ink transition hover:bg-white/30 active:scale-95"
            >
              <X className="h-5 w-5" strokeWidth={2.5} />
            </button>
          </div>

          {/* Chat Body */}
          <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4 text-fluid-xs">
            {messages.map((m) => (
              <div
                key={m.id}
                className={`flex gap-2 ${m.sender === 'user' ? 'justify-end' : 'justify-start'}`}
              >
                {m.sender === 'bot' && (
                  <span className="grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-brand/10 text-brand">
                    <Bot className="h-4 w-4" />
                  </span>
                )}
                <div
                  className={`max-w-[80%] rounded-2xl px-3.5 py-2 leading-relaxed shadow-sm whitespace-pre-line ${
                    m.sender === 'user'
                      ? 'bg-brand text-brand-ink rounded-tr-none'
                      : 'bg-elevated border border-line text-ink rounded-tl-none'
                  }`}
                >
                  <p>{m.text}</p>
                  <span
                    className={`block mt-1 text-[10px] ${
                      m.sender === 'user' ? 'text-brand-ink/70 text-right' : 'text-faint'
                    }`}
                  >
                    {m.timestamp}
                  </span>
                </div>
              </div>
            ))}

            {isTyping && (
              <div className="flex items-center gap-2 text-faint">
                <span className="grid h-7 w-7 place-items-center rounded-lg bg-brand/10 text-brand">
                  <Bot className="h-4 w-4" />
                </span>
                <span className="rounded-xl border border-line bg-elevated px-3 py-1.5 text-[11px]">
                  Sahayak is typing…
                </span>
              </div>
            )}
            <div ref={scrollRef} />
          </div>

          {/* Quick Prompts */}
          <div className="shrink-0 border-t border-line/60 bg-sunken/40 px-3 py-2">
            <p className="mb-1.5 text-[10px] font-semibold text-muted uppercase tracking-wider">Quick Suggestions</p>
            <div className="flex gap-1.5 overflow-x-auto pb-1 no-scrollbar">
              {localized.quickPrompts.map((prompt) => (
                <button
                  key={prompt}
                  type="button"
                  onClick={() => handleSend(prompt)}
                  className="shrink-0 rounded-lg border border-line bg-elevated px-2.5 py-1 text-[11px] font-medium text-ink transition hover:border-brand hover:text-brand"
                >
                  {prompt}
                </button>
              ))}
            </div>
          </div>

          {/* Chat Input */}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              handleSend();
            }}
            className="flex shrink-0 items-center gap-2 border-t border-line bg-surface p-2.5 pb-[calc(0.625rem+env(safe-area-inset-bottom))] lg:pb-2.5"
          >
            <input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Ask sanitation query or schedule…"
              className="min-w-0 flex-1 rounded-xl border border-line bg-elevated px-3 py-2.5 text-fluid-xs text-ink placeholder:text-faint focus:border-brand focus:outline-none"
            />
            <button
              type="submit"
              aria-label="Send message"
              disabled={!input.trim() || isTyping}
              className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-brand text-brand-ink transition disabled:opacity-50"
            >
              {isTyping ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
            </button>
          </form>
        </div>
      )}
    </>
  );
}
