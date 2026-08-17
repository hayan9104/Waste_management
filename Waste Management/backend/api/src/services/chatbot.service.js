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
- Emergency helplines: Sanitation Control Room 079-23227900, Fire 101, Ambulance 108, Police 100.

Keep replies short — 2 to 4 sentences, warm and practical, no markdown formatting. Stay strictly on civic sanitation and this app's features; if asked something unrelated, politely redirect back to sanitation topics. Reply in ${
  lang === 'hi' ? 'Hindi (हिन्दी)' : lang === 'gu' ? 'Gujarati (ગુજરાતી)' : 'English'
}.`;

/** Returns the model's reply, or null if Groq isn't configured / the call failed. */
export async function askGroq(message, lang = 'en') {
  if (!env.groq.apiKey) return null;

  try {
    const { data } = await axios.post(
      'https://api.groq.com/openai/v1/chat/completions',
      {
        model: env.groq.model,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT(lang) },
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

/** Single entry point the routes call: tries Groq, falls back to rules. */
export async function getChatReply(message, lang = 'en') {
  const aiReply = await askGroq(message, lang);
  if (aiReply) return { reply: aiReply, source: 'ai' };
  return { reply: ruleBasedReply(message, lang), source: 'rules' };
}
