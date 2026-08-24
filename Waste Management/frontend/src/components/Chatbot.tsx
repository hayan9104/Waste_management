import { useState, useRef, useEffect } from 'react';
import axios from 'axios';
import { Bot, MessageSquare, X, Send, Sparkles, User, HelpCircle, PhoneCall, Award, Trash2, Loader2, ClipboardPlus, ClipboardList, Siren } from 'lucide-react';
import { useI18n } from '../lib/i18n';
import { BASE } from '../lib/api';
import { ComplaintBookingModal } from './ComplaintBookingModal';
import { DriverAssistantSheet } from './DriverAssistantSheet';

interface Message {
  id: string;
  sender: 'bot' | 'user';
  text: string;
  timestamp: string;
  /** Renders the "Add details & book" call to action under this reply. */
  action?: 'book';
  /** Driver portal: which action sheet this reply offers to open. */
  driverAction?: DriverAction;
}

/**
 * Whether a turn is about filing a report, in any of the three languages.
 *
 * Matched against the user's own words as well as the reply: the assistant
 * paraphrases, and an answer that never happens to use the word "report" would
 * otherwise lose the button on exactly the turn that earned it. Cheap keyword
 * matching rather than another model call — a false positive costs one ignored
 * button, and the user can always type again.
 */
const BOOKING_HINTS = [
  'report', 'complaint', 'complain', 'file a', 'garbage', 'waste', 'dump', 'bin', 'rubbish', 'trash',
  'शिकायत', 'रिपोर्ट', 'कचरा', 'कूड़ा', 'दर्ज',
  'ફરિયાદ', 'રિપોર્ટ', 'કચરો', 'નોંધ',
];

function wantsBooking(userText: string, botText: string) {
  const hay = `${userText} ${botText}`.toLowerCase();
  return BOOKING_HINTS.some((k) => hay.includes(k));
}

/**
 * The driver's assistant is the same widget with a different job.
 *
 * A driver's questions are about the work in front of them, and every answer
 * should end in an action they can take one tap away — so the quick prompts,
 * the welcome line and the buttons under each reply are all different from the
 * citizen's. Detected from the URL rather than from the stored token, because
 * a phone that has logged into two portals holds both tokens at once.
 */
const DRIVER_KB: Record<'en' | 'hi' | 'gu', { welcome: string; quickPrompts: string[] }> = {
  en: {
    welcome:
      'Namaste! I am your in-cab Sahayak. I can help with your shift, today\'s stops, closing a task with its proof photo, logging fuel, or raising an SOS.',
    quickPrompts: ['Show my stops', 'How do I close a stop?', 'Log a fuel fill-up', 'My truck broke down'],
  },
  hi: {
    welcome:
      'नमस्ते! मैं आपका इन-कैब सहायक हूँ। शिफ्ट, आज के स्टॉप, फोटो सबूत के साथ टास्क पूरा करने, ईंधन दर्ज करने या SOS में मदद कर सकता हूँ।',
    quickPrompts: ['मेरे स्टॉप दिखाओ', 'स्टॉप कैसे बंद करें?', 'ईंधन दर्ज करें', 'गाड़ी खराब हो गई'],
  },
  gu: {
    welcome:
      'નમસ્તે! હું તમારો ઇન-કેબ સહાયક છું. શિફ્ટ, આજના સ્ટોપ, ફોટો પુરાવા સાથે ટાસ્ક પૂરું કરવા, ઇંધણ નોંધવા કે SOS માં મદદ કરી શકું છું.',
    quickPrompts: ['મારા સ્ટોપ બતાવો', 'સ્ટોપ કેવી રીતે બંધ કરું?', 'ડીઝલ નોંધો', 'ગાડી બગડી ગઈ'],
  },
};

type DriverAction = 'stops' | 'complete' | 'fuel' | 'sos' | 'summary' | 'menu';

/** Maps a turn to the driver sheet it should open, or null for plain chat. */
function driverActionFor(userText: string, botText: string): DriverAction | null {
  const hay = `${userText} ${botText}`.toLowerCase();
  // Order matters: SOS outranks everything, because a breakdown message that
  // also mentions "fuel" must not open the fuel form.
  // "broke down" / "broken down" are what a driver actually types; matching only
  // the single word "breakdown" sent a real breakdown to the generic menu.
  // Punctures and tyre blowouts are the other common wording.
  if (
    /sos|accident|emergency help|unsafe|breakdown|brok(e|en) down|break down|puncture|tyre|tire burst|blowout|दुर्घटना|खराब|पंचर|आपात|અકસ્માત|બગડ|પંક્ચર/.test(
      hay
    )
  )
    return 'sos';
  if (/shift|duty|clock in|clock out|शिफ्ट|ड्यूटी|શિફ્ટ|ડ્યુટી/.test(hay)) return 'menu';
  if (/fuel|diesel|petrol|odometer|ईंधन|डीजल|ડીઝલ|ઇંધણ/.test(hay)) return 'fuel';
  if (/proof|photo|complete|collected|close (a |the )?stop|फोटो|सबूत|ફોટો|પુરાવો/.test(hay)) return 'complete';
  if (/stop|task|route|work|today|स्टॉप|काम|रूट|સ્ટોપ|કામ|રૂટ/.test(hay)) return 'stops';
  if (/summary|how much|so far|सारांश|સારાંશ/.test(hay)) return 'summary';
  return null;
}

const DRIVER_CTA: Record<DriverAction, Record<'en' | 'hi' | 'gu', string>> = {
  stops: { en: "Show today's stops", hi: 'आज के स्टॉप देखें', gu: 'આજના સ્ટોપ જુઓ' },
  complete: { en: 'Close a stop with photo', hi: 'फोटो के साथ स्टॉप बंद करें', gu: 'ફોટો સાથે સ્ટોપ બંધ કરો' },
  fuel: { en: 'Log a fuel fill-up', hi: 'ईंधन दर्ज करें', gu: 'ડીઝલ નોંધો' },
  sos: { en: 'Open SOS', hi: 'SOS खोलें', gu: 'SOS ખોલો' },
  summary: { en: 'See your day so far', hi: 'आज का सारांश', gu: 'આજનો સારાંશ' },
  menu: { en: 'Open driver actions', hi: 'ड्राइवर विकल्प खोलें', gu: 'ડ્રાઇવર વિકલ્પો ખોલો' },
};

const BOOK_CTA: Record<'en' | 'hi' | 'gu', string> = {
  en: 'Add details & book complaint',
  hi: 'विवरण भरें और शिकायत दर्ज करें',
  gu: 'વિગતો ભરો અને ફરિયાદ નોંધાવો',
};

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
  const [booking, setBooking] = useState(false);
  const [driverSheet, setDriverSheet] = useState<DriverAction | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Re-read on every render rather than once: the widget is mounted above the
  // router and survives navigation between portals.
  const isDriver = typeof window !== 'undefined' && window.location.pathname.startsWith('/driver');
  const kb = isDriver ? DRIVER_KB[currentLang] : localized;

  useEffect(() => {
    if (isOpen) {
      scrollRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages, isOpen]);

  // Keep the opening line honest about which assistant this is — the citizen
  // welcome on a driver's handset promises the wrong things.
  useEffect(() => {
    setMessages((prev) =>
      prev.length === 1 && prev[0].id === 'welcome' ? [{ ...prev[0], text: kb.welcome }] : prev
    );
  }, [kb.welcome]);

  /*
    Below lg the panel fills the viewport, so the page behind it must not
    scroll under the finger — only the message list (its own overflow-y-auto)
    should move. Desktop keeps the floating window and the page stays
    interactive, hence the width check rather than a blanket lock.
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
      const res = await axios.post(`${BASE}/api/public/chatbot`, {
        message: text,
        lang: currentLang,
        audience: isDriver ? 'driver' : 'citizen',
      });
      const botReply = res.data?.reply || 'I am your Safaai Sahayak. Please tap the Report tab to file a waste complaint.';

      const botMsg: Message = {
        id: String(Date.now() + 1),
        sender: 'bot',
        text: botReply,
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        action: !isDriver && wantsBooking(text, botReply) ? 'book' : undefined,
        driverAction: isDriver ? driverActionFor(text, botReply) ?? undefined : undefined,
      };
      setMessages((prev) => [...prev, botMsg]);
    } catch {
      /**
       * The network already failed the driver once; sending them off to hunt
       * for a tab would fail them twice. Both fallbacks now point at the
       * button directly below rather than at navigation.
       */
      const fallbackReply = isDriver
        ? currentLang === 'gu'
          ? 'નેટવર્ક મળતું નથી. નીચેના બટનથી તમારા સ્ટોપ, ડીઝલ કે SOS સીધા ખોલી શકો છો.'
          : currentLang === 'hi'
            ? 'नेटवर्क नहीं मिल रहा। नीचे दिए बटन से अपने स्टॉप, ईंधन या SOS सीधे खोल सकते हैं।'
            : 'I could not reach the network. You can still open your stops, fuel log or SOS from the button below.'
        : currentLang === 'gu'
          ? 'હું સફાઈ સહાયક છું. નીચેના બટનથી સીધી ફરિયાદ નોંધાવી શકો છો.'
          : currentLang === 'hi'
            ? 'मैं स्वच्छता सहायक हूँ। नीचे दिए बटन से सीधे शिकायत दर्ज कर सकते हैं।'
            : 'I am here to help. You can file a waste complaint right here using the button below.';

      const botMsg: Message = {
        id: String(Date.now() + 1),
        sender: 'bot',
        text: fallbackReply,
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        action: isDriver ? undefined : 'book',
        driverAction: isDriver ? driverActionFor(text, '') ?? 'menu' : undefined,
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

      {/* Chat panel — full screen wherever the mobile shell applies (phone and
          tablet, i.e. below lg, matching the bottom tab bar's own breakpoint),
          floating window on desktop. Only the message list scrolls; the
          header, quick prompts and input stay fixed in place. */}
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
                <p className="truncate text-[11px] opacity-85">
                  {isDriver ? 'In-cab driver assistant' : 'Municipal 24/7 Sanitation Assistant'}
                </p>
              </div>
            </div>
            {/* Drivers get a permanent way into their actions, so nothing
                depends on the assistant having guessed the right intent. */}
            {isDriver && (
              <button
                type="button"
                onClick={() => setDriverSheet('menu')}
                aria-label="Driver actions"
                title="Driver actions"
                className="grid h-10 w-10 shrink-0 place-items-center rounded-full border border-white/25 bg-white/15 text-brand-ink transition hover:bg-white/30 active:scale-95"
              >
                <ClipboardList className="h-5 w-5" />
              </button>
            )}
            {/* A real 40px target on its own ring — easy to miss as a bare
                icon against the green bar once the panel fills the screen. */}
            <button
              type="button"
              onClick={() => setIsOpen(false)}
              aria-label="Close chat"
              className="grid h-10 w-10 shrink-0 place-items-center rounded-full border border-white/25 bg-white/15 text-brand-ink transition hover:bg-white/30 active:scale-95"
            >
              <X className="h-5 w-5" strokeWidth={2.5} />
            </button>
          </div>

          {/* Chat Body — the only thing that scrolls. */}
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

                  {m.driverAction && (
                    <button
                      type="button"
                      onClick={() => setDriverSheet(m.driverAction!)}
                      className={`mt-2 flex w-full min-h-touch items-center justify-center gap-1.5 rounded-xl px-3 py-2 text-[12px] font-semibold transition active:scale-[0.98] ${
                        m.driverAction === 'sos'
                          ? 'bg-danger text-white hover:brightness-110'
                          : 'bg-brand text-brand-ink hover:brightness-110'
                      }`}
                    >
                      {m.driverAction === 'sos' ? <Siren className="h-3.5 w-3.5" /> : <ClipboardList className="h-3.5 w-3.5" />}
                      {DRIVER_CTA[m.driverAction][currentLang]}
                    </button>
                  )}

                  {m.action === 'book' && (
                    <button
                      type="button"
                      onClick={() => setBooking(true)}
                      className="mt-2 flex w-full min-h-touch items-center justify-center gap-1.5 rounded-xl bg-brand px-3 py-2 text-[12px] font-semibold text-brand-ink transition hover:brightness-110 active:scale-[0.98]"
                    >
                      <ClipboardPlus className="h-3.5 w-3.5" />
                      {BOOK_CTA[currentLang]}
                    </button>
                  )}

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
              {kb.quickPrompts.map((prompt) => (
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

      {/* Booking sheet. Rendered as a sibling of the chat panel, not inside it,
          so on desktop it is not clipped by the 380px floating window. */}
      <DriverAssistantSheet
        open={driverSheet !== null}
        initialMode={driverSheet ?? 'menu'}
        onClose={() => setDriverSheet(null)}
        onEvent={(text) =>
          // Echo what actually happened back into the thread, so the chat is
          // the driver's own log of the shift.
          setMessages((prev) => [
            ...prev,
            {
              id: String(Date.now() + 3),
              sender: 'bot',
              text,
              timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
            },
          ])
        }
      />

      <ComplaintBookingModal
        open={booking}
        onClose={() => setBooking(false)}
        onBooked={(code) => {
          // Echo the ticket back into the conversation so the chat itself is
          // the record of what was filed.
          setMessages((prev) => [
            ...prev,
            {
              id: String(Date.now() + 2),
              sender: 'bot',
              text:
                currentLang === 'gu'
                  ? `તમારી ફરિયાદ નોંધાઈ ગઈ છે. ટિકિટ નંબર: ${code}. તમે "My Reports" માંથી સ્થિતિ જોઈ શકો છો.`
                  : currentLang === 'hi'
                    ? `आपकी शिकायत दर्ज हो गई है। टिकट नंबर: ${code}. आप "My Reports" में स्थिति देख सकते हैं।`
                    : `Your complaint is filed. Ticket number: ${code}. You can follow its status under My Reports.`,
              timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
            },
          ]);
        }}
      />
    </>
  );
}
