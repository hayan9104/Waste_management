import axios from 'axios';
import env from '../config/env.js';

/**
 * AI Safaai Sahayak — Groq-backed when GROQ_API_KEY is configured, with a
 * deterministic keyword-matched reply as the fallback (no key set, Groq is
 * down, or the request errors). The widget is shown on every page, logged in
 * or not, so this never assumes a citizen session.
 */

const SYSTEM_PROMPT = (lang) => `You are "AI Safaai Sahayak", the friendly civic assistant built into Safaai Sarathi — a municipal waste management app for Gandhinagar, Gujarat, India.

You help residents with:
- Filing a waste complaint: tap the "+" Report tab, take a live photo, the app's AI detects the category automatically, submit with GPS location.
- Wet vs dry waste: Green bin = wet/biodegradable (food scraps, peels). Blue bin = dry/recyclable (plastic, paper, glass, metal).
- Green Credits: 50 credits per verified complaint, redeemable for tax rebates and bus passes in the Rewards tab.
- Live tracking: once a driver accepts a complaint, the collection truck can be tracked in real time on the map.
- Emergency helplines: GMC Sanitation Helpline 079-23227900, Fire 101, Ambulance 108, Police 100.

Keep replies short — 2 to 4 sentences, warm and practical, no markdown formatting. Stay strictly on civic sanitation and this app's features; if asked something unrelated, politely redirect back to sanitation topics. Reply in ${
  lang === 'hi' ? 'Hindi (हिन्दी)' : lang === 'gu' ? 'Gujarati (ગુજરાતી)' : 'English'
}.`;

/**
 * The driver's assistant is a different job from the citizen's.
 *
 * A driver is on the road, usually one-handed, and every question they ask is
 * about work in front of them right now — not about how the app works. So this
 * prompt is instructional and short, and it never tells them to "go to a tab":
 * the assistant panel carries buttons that perform each action directly, so
 * pointing at navigation would be worse than useless.
 */
const DRIVER_PROMPT = (lang) => `You are "AI Safaai Sahayak", the in-cab assistant for a municipal waste-collection driver in Gandhinagar, Gujarat, India, inside the Safaai Sarathi app.

The driver can do all of this from the buttons in this assistant panel, so never tell them to navigate to another tab or screen:
- Start and end their shift (the shift clock is what their supervisor sees).
- See today's assigned stops and start a stop when they arrive.
- Mark a stop collected. A photo of the cleared site is MANDATORY — the app will refuse to close the task without one, because the citizen and the ward officer both see that photo as proof.
- Log a diesel fill-up (litres, cost, odometer reading).
- Raise an SOS if there is a breakdown, accident, medical emergency or any unsafe situation. This pages the ward officer immediately.

CRITICAL: you cannot perform any of these actions yourself and you must never claim to have done one. Do not say an SOS was raised, a shift was started, a stop was closed or fuel was logged. Only the driver pressing the button does that, and it then confirms on screen. Say what to press, in the imperative — never report an outcome. A driver told "SOS has been sent" who then does not press the button is a driver waiting for help that was never called.

Practical rules to reinforce when relevant: emergency stops (dead animal, medical waste, sewage, burning waste) come first and run on a 30-minute clock. Never leave a site without the proof photo. Report a vehicle fault rather than driving on.

Keep replies very short — 1 to 3 sentences, plain and direct, no markdown. If asked something unrelated to the job, redirect briefly. Reply in ${
  lang === 'hi' ? 'Hindi (हिन्दी)' : lang === 'gu' ? 'Gujarati (ગુજરાતી)' : 'English'
}.`;

/** Returns the model's reply, or null if Groq isn't configured / the call failed. */
export async function askGroq(message, lang = 'en', audience = 'citizen') {
  if (!env.groq.apiKey) return null;

  try {
    const { data } = await axios.post(
      'https://api.groq.com/openai/v1/chat/completions',
      {
        model: env.groq.model,
        messages: [
          { role: 'system', content: (audience === 'driver' ? DRIVER_PROMPT : SYSTEM_PROMPT)(lang) },
          { role: 'user', content: message },
        ],
        temperature: 0.4,
        max_tokens: 400,
        // gpt-oss models reason before answering; "low" keeps that brief so the
        // real reply isn't cut off by max_tokens before it's written.
        reasoning_effort: 'low',
      },
      {
        headers: { Authorization: `Bearer ${env.groq.apiKey}`, 'Content-Type': 'application/json' },
        timeout: 15_000,
      }
    );
    const content = data?.choices?.[0]?.message?.content?.trim();
    return content || null;
  } catch (err) {
    console.warn('[chatbot] Groq call failed, falling back to rule-based reply:', err.message);
    return null;
  }
}

/** Deterministic fallback — always answers something, never an error to the user. */
export function ruleBasedReply(message, lang = 'en') {
  const query = message.toLowerCase();

  if (query.includes('report') || query.includes('complaint') || query.includes('शिकायत') || query.includes('ફરિયાદ')) {
    return lang === 'gu'
      ? 'ફરિયાદ કરવા માટે નીચે "Report" બટન દબાવો, કચરાનો લાઈવ ફોટો પાડો, અમારું AI ઓટોમેટિક કેટેગરી ઓળખી લેશે અને લાઈવ GPS સાથે સબમિટ કરો!'
      : lang === 'hi'
        ? 'शिकायत दर्ज करने के लिए नीचे "Report" टैब पर जाएँ, कचरे की फोटो लें, हमारा AI अपने आप श्रेणी पहचान लेगा और GPS के साथ सबमिट कर दें!'
        : 'To report waste, tap the "+" (Report) tab at the bottom, take a live photo of the waste, verify the AI-detected category, and submit with your GPS location!';
  }
  if (query.includes('wet') || query.includes('dry') || query.includes('गीला') || query.includes('सूखा') || query.includes('ભીનો') || query.includes('સૂકો')) {
    return lang === 'gu'
      ? 'લીલી કચરાપેટી: ભીનો કચરો (રસોડાનો કચરો, શાકભાજી, ફળોની છાલ).\nભૂરી કચરાપેટી: સૂકો કચરો (પ્લાસ્ટિક, કાગળ, કાચ, ધાતુ).'
      : lang === 'hi'
        ? 'हरा कूड़ेदान: गीला कचरा (रसोई का कचरा, फल, सब्जियां).\nनीला कूड़ेदान: सूखा कचरा (प्लास्टिक, कागज, कांच, धातु).'
        : 'Green Bin: Wet/Biodegradable waste (food scraps, vegetable peels).\nBlue Bin: Dry/Recyclable waste (plastic, paper, glass, metal).';
  }
  if (query.includes('reward') || query.includes('point') || query.includes('credit') || query.includes('રિવોર્ડ') || query.includes('पॉइंट')) {
    return lang === 'gu'
      ? 'દરેક વેરિફાઈડ ફરિયાદ પર 50 ગ્રીન ક્રેડિટ્સ મળે છે, જેને "Rewards" ટેબમાં વાઉચર માટે વાપરી શકાય છે.'
      : lang === 'hi'
        ? 'प्रत्येक मान्य रिपोर्ट पर 50 ग्रीन क्रेडिट्स मिलते हैं जिन्हें "Rewards" टैब में रिडीम कर सकते हैं.'
        : 'You earn 50 Green Credits per verified complaint, redeemable for tax rebates and bus passes in the Rewards tab.';
  }
  if (query.includes('help') || query.includes('phone') || query.includes('number') || query.includes('हेल्पलाइन') || query.includes('નંબર')) {
    return 'Sanitation Control Room: 079-23227900 | Fire: 101 | Ambulance: 108 | Police: 100. Open the Helpline Directory tab for all zonal contacts.';
  }

  return lang === 'gu'
    ? 'હું સ્વચ્છતા સહાયક છું. આપ કચરાની ફરિયાદ કરી શકો છો, કલેક્શન વાન લાઈવ ટ્રેક કરી શકો છો અથવા 079-23227900 પર સંપર્ક કરી શકો છો.'
    : lang === 'hi'
      ? 'मैं स्वच्छता सहायक हूँ। आप कचरे की शिकायत दर्ज कर सकते हैं, वैन ट्रैक कर सकते हैं या 079-23227900 पर संपर्क कर सकते हैं।'
      : "I'm here to help with waste management and city sanitation. You can file a complaint with photo proof in the Report tab, track collection trucks in real-time, or call the 24/7 Helpline at 079-23227900.";
}

/**
 * Deterministic fallback for the driver, mirroring ruleBasedReply.
 *
 * Kept separate rather than bolted onto the citizen matcher: "photo" means
 * "attach evidence of the waste" to a citizen and "prove you cleared the site"
 * to a driver, and one keyword table answering both would get one of them
 * wrong.
 */
export function driverRuleReply(message, lang = 'en') {
  const q = message.toLowerCase();

  const pick = (en, hi, gu) => (lang === 'gu' ? gu : lang === 'hi' ? hi : en);

  if (/shift|duty|clock|शिफ्ट|ड्यूटी|શિફ્ટ|ડ્યુટી/.test(q)) {
    return pick(
      'Use the Shift button below to clock in or out. Your ward officer sees who is on duty from that clock, so start it when you begin and end it when you finish.',
      'नीचे Shift बटन से ड्यूटी शुरू या बंद करें। आपका वार्ड अफसर इसी से देखता है कि कौन ड्यूटी पर है।',
      'નીચે Shift બટનથી ડ્યુટી શરૂ કે બંધ કરો. તમારા વોર્ડ અધિકારી આ ક્લોકથી જ જુએ છે કે કોણ ડ્યુટી પર છે.'
    );
  }
  if (/photo|proof|complete|collect|फोटो|सबूत|પુરાવો|ફોટો/.test(q)) {
    return pick(
      'A photo of the cleared site is required to close a stop — the app will not accept it without one. Tap "Complete a stop" below, pick the task and take the photo there.',
      'स्टॉप बंद करने के लिए साफ जगह की फोटो अनिवार्य है। नीचे "Complete a stop" दबाएँ, टास्क चुनें और वहीं फोटो लें।',
      'સ્ટોપ બંધ કરવા સાફ કરેલી જગ્યાનો ફોટો ફરજિયાત છે. નીચે "Complete a stop" દબાવો, ટાસ્ક પસંદ કરો અને ત્યાં જ ફોટો લો.'
    );
  }
  if (/fuel|diesel|petrol|odometer|ईंधन|डीजल|ડીઝલ|ઇંધણ/.test(q)) {
    return pick(
      'Tap "Log fuel" below and enter litres, cost and the odometer reading. That feeds the ward fuel and expenditure report.',
      'नीचे "Log fuel" दबाएँ और लीटर, कीमत तथा ओडोमीटर रीडिंग भरें।',
      'નીચે "Log fuel" દબાવો અને લિટર, કિંમત અને ઓડોમીટર રીડિંગ ભરો.'
    );
  }
  if (/sos|help|accident|breakdown|emergency|मदद|दुर्घटना|आपात|મદદ|અકસ્માત/.test(q)) {
    return pick(
      'For a breakdown, accident or any unsafe situation use the SOS button below — it pages your ward officer with your location immediately.',
      'गाड़ी खराब, दुर्घटना या असुरक्षित स्थिति में नीचे SOS दबाएँ — यह आपके स्थान के साथ वार्ड अफसर को तुरंत सूचित करता है।',
      'ગાડી બગડે, અકસ્માત કે અસુરક્ષિત સ્થિતિમાં નીચે SOS દબાવો — તે તમારા સ્થાન સાથે વોર્ડ અધિકારીને તરત જાણ કરે છે.'
    );
  }
  if (/route|stop|task|work|रूट|स्टॉप|काम|રૂટ|સ્ટોપ|કામ/.test(q)) {
    return pick(
      'Tap "My stops" below to see today\'s assigned work. Emergency stops are listed first and run on a 30-minute clock.',
      'आज का काम देखने के लिए नीचे "My stops" दबाएँ। इमरजेंसी स्टॉप सबसे ऊपर होते हैं और 30 मिनट की समयसीमा पर चलते हैं।',
      'આજનું કામ જોવા નીચે "My stops" દબાવો. ઇમરજન્સી સ્ટોપ સૌથી ઉપર હોય છે અને 30 મિનિટની સમયમર્યાદા પર ચાલે છે.'
    );
  }

  return pick(
    'I can help with your shift, today\'s stops, closing a task with its proof photo, logging fuel, or raising an SOS. Use the buttons below.',
    'मैं आपकी शिफ्ट, आज के स्टॉप, फोटो सबूत के साथ टास्क पूरा करने, ईंधन दर्ज करने या SOS में मदद कर सकता हूँ। नीचे बटन इस्तेमाल करें।',
    'હું તમારી શિફ્ટ, આજના સ્ટોપ, ફોટો પુરાવા સાથે ટાસ્ક પૂરું કરવા, ઇંધણ નોંધવા કે SOS માં મદદ કરી શકું છું. નીચેના બટન વાપરો.'
  );
}

/** Single entry point the routes call: tries Groq, falls back to rules. */
export async function getChatReply(message, lang = 'en', audience = 'citizen') {
  const aiReply = await askGroq(message, lang, audience);
  if (aiReply) return { reply: aiReply, source: 'ai' };
  const fallback = audience === 'driver' ? driverRuleReply(message, lang) : ruleBasedReply(message, lang);
  return { reply: fallback, source: 'rules' };
}
