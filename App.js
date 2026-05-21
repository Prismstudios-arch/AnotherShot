import { useState, useEffect, useRef, Component } from "react";

// ─────────────────────────────────────────────────────────────────────────────
// DESIGN TOKENS
// ─────────────────────────────────────────────────────────────────────────────
const T = {
  // Backgrounds — layered depth system
  bg:        "#07070A",
  surface:   "#0C0C11",
  card:      "#101015",
  elevated:  "#161620",

  // Borders — very subtle, refined
  border:    "#18182A",
  borderMd:  "#22223A",

  // Orange — Hermès-inspired, confident not harsh
  orange:    "#FF4D00",
  orangeHi:  "#FF6B20",
  orangeFog: "rgba(255,77,0,0.09)",
  orangeGlow:"rgba(255,77,0,0.20)",
  orangeRim: "rgba(255,77,0,0.28)",

  // Teal — secondary, cool counterpoint
  teal:      "#00B5A0",
  tealFog:   "rgba(0,181,160,0.09)",
  tealRim:   "rgba(0,181,160,0.22)",

  // Text — warm hierarchy
  hi:   "#EBE7DF",
  mid:  "#68688A",
  lo:   "#2E2E48",

  // Medals
  gold:   "#C2A030",
  silver: "#7D8FA6",
  bronze: "#9B6247",
};

// ─────────────────────────────────────────────────────────────────────────────
// MONETIZATION CONFIG
// Single source of truth for all monetization rules. Tweak here, not in screens.
// ─────────────────────────────────────────────────────────────────────────────
const MONEY = {
  DAILY_FREE_SHOTS:   5,    // Free tier daily allowance (resets at midnight local)
  AD_REWARD_SHOTS:    3,    // Shots granted per rewarded ad
  AD_DAILY_CAP:       3,    // Max ads a user can watch per day
  AD_SIMULATION_MS:   2000, // Fake ad duration; swap for real AdMob later
  // Fallback display prices — shown only if RC offerings haven't loaded yet
  // (e.g. first launch with no network). Real prices come from RC at runtime.
  FALLBACK_PRICE_MONTHLY: "£3.99",
  FALLBACK_PRICE_YEARLY:  "£31.99",
  FALLBACK_YEARLY_PER_MO: "£2.67",
  YEARLY_SAVINGS_PCT: 33,
  STORAGE_KEY:        "anothershot:economy:v1",
};

// ─────────────────────────────────────────────────────────────────────────────
// REVENUECAT CONFIG
//
// RevenueCat is Apple's recommended way to handle iOS subscriptions (it wraps
// StoreKit) and the same SDK handles Android (Play Billing). Web-based payment
// processors are not used here — Apple rejects apps that use them for digital
// subscriptions. This integration uses native IAP only.
//
// SETUP (one-time):
//   1. Create a RevenueCat project at app.revenuecat.com
//   2. Connect your App Store Connect + Google Play apps
//   3. Create the entitlement "premium" in RC
//   4. Create an Offering "default" with two packages:
//      - identifier "$rc_monthly" → monthly product
//      - identifier "$rc_annual"  → yearly product
//   5. Paste your iOS + Android public API keys below
//
// INSTALL (Expo):
//   npx expo install react-native-purchases react-native-purchases-ui
//
// At app boot the configure() call wires this up. The hook below subscribes
// to customerInfo updates so entitlement state stays in sync.
// ─────────────────────────────────────────────────────────────────────────────
const RC = {
  IOS_API_KEY:     "test_FrVBkafQlmLctUKjDQKXjoNJPcP",
  ANDROID_API_KEY: "test_FrVBkafQlmLctUKjDQKXjoNJPcP",
  ENTITLEMENT_ID:  "premium",
  OFFERING_ID:     "default",
  PKG_MONTHLY:     "$rc_monthly",
  PKG_ANNUAL:      "$rc_annual",
};

// ─────────────────────────────────────────────────────────────────────────────
// PURCHASES SERVICE — thin abstraction over react-native-purchases
//
// Goals:
//   - On native (iOS/Android): use real SDK
//   - On web preview / dev: gracefully degrade so the UI still renders.
//     Web returns synthetic offerings + a "simulated purchase" toggle so the
//     paywall flow remains testable without a device.
//
// Every method is async and never throws — errors are logged and the caller
// gets a `{ success: false, error }` shape so screens never crash on RC issues.
// ─────────────────────────────────────────────────────────────────────────────
let Purchases = null;       // will hold the real SDK module on native
let PurchasesUI = null;     // for the optional RevenueCatUI paywall / customer center
let RCAvailable = false;    // true after successful configure() on a real device

try {
  // Dynamic require so the web bundle doesn't choke when the package is missing.
  // On Expo/React Native, this resolves to the real native module.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  Purchases = require("react-native-purchases").default;
  try {
    // RevenueCatUI is optional — only needed if you want their pre-built
    // Customer Center (subscription management) UI.
    PurchasesUI = require("react-native-purchases-ui").default;
  } catch { /* UI lib not installed — fall back to manual UI */ }
} catch {
  // Web / preview — leave Purchases null, RCAvailable stays false.
}

// Detect platform — only relevant on native, but kept safe for web.
const getPlatform = () => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { Platform } = require("react-native");
    return Platform.OS; // "ios" | "android" | "web"
  } catch {
    return "web";
  }
};

// Initialize the SDK once at app boot. Safe to call multiple times.
const configurePurchases = async () => {
  if (!Purchases) return false;
  try {
    const platform = getPlatform();
    const apiKey = platform === "ios" ? RC.IOS_API_KEY : RC.ANDROID_API_KEY;
    // Optional: set log level for development
    // await Purchases.setLogLevel(Purchases.LOG_LEVEL.DEBUG);
    await Purchases.configure({ apiKey });
    RCAvailable = true;
    return true;
  } catch (err) {
    console.warn("[RC] configure failed:", err);
    return false;
  }
};

// Read the current offering. Returns a normalized `{ monthly, annual }` shape
// the UI can render regardless of whether we're on RC or the web fallback.
const fetchOfferings = async () => {
  if (RCAvailable && Purchases) {
    try {
      const offerings = await Purchases.getOfferings();
      const current = offerings?.current;
      if (!current) return null;
      // RC packages expose product.priceString (already localized) which is
      // exactly what the paywall should display — never hardcode currency.
      const monthly = current.availablePackages?.find(p => p.identifier === RC.PKG_MONTHLY);
      const annual  = current.availablePackages?.find(p => p.identifier === RC.PKG_ANNUAL);
      return {
        monthly: monthly ? {
          pkg: monthly,
          priceString: monthly.product.priceString,
          pricePerMonth: monthly.product.priceString,
        } : null,
        annual: annual ? {
          pkg: annual,
          priceString: annual.product.priceString,
          // Compute per-month from annual price; RC doesn't expose this directly
          pricePerMonth: annual.product.pricePerMonthString
            || annual.product.priceString,
        } : null,
      };
    } catch (err) {
      console.warn("[RC] getOfferings failed:", err);
      return null;
    }
  }
  // Web fallback — synthetic offering with fallback prices
  return {
    monthly: { pkg: { identifier: "fallback_monthly" },
               priceString: MONEY.FALLBACK_PRICE_MONTHLY,
               pricePerMonth: MONEY.FALLBACK_PRICE_MONTHLY },
    annual:  { pkg: { identifier: "fallback_annual" },
               priceString: MONEY.FALLBACK_PRICE_YEARLY,
               pricePerMonth: MONEY.FALLBACK_YEARLY_PER_MO },
  };
};

// Actually trigger a purchase. Returns { success, isPremium, error }.
// On iOS this presents the native Apple payment sheet; on Android the
// Play Billing flow. Either way RC handles receipt validation server-side.
const purchasePackage = async (pkg) => {
  if (RCAvailable && Purchases) {
    try {
      const { customerInfo } = await Purchases.purchasePackage(pkg);
      const isPremium = !!customerInfo?.entitlements?.active?.[RC.ENTITLEMENT_ID];
      return { success: true, isPremium };
    } catch (err) {
      // RC throws on cancellation too — check userCancelled to distinguish
      if (err.userCancelled) return { success: false, cancelled: true };
      console.warn("[RC] purchase failed:", err);
      return { success: false, error: err.message || "Purchase failed" };
    }
  }
  // Web fallback — simulate success (for design preview / testing)
  return { success: true, isPremium: true, simulated: true };
};

// Restore previous purchases — required by Apple. User must always have
// a way to restore subscriptions they bought on another device or after reinstall.
const restorePurchases = async () => {
  if (RCAvailable && Purchases) {
    try {
      const customerInfo = await Purchases.restorePurchases();
      const isPremium = !!customerInfo?.entitlements?.active?.[RC.ENTITLEMENT_ID];
      return { success: true, isPremium };
    } catch (err) {
      console.warn("[RC] restore failed:", err);
      return { success: false, error: err.message || "Restore failed" };
    }
  }
  return { success: true, isPremium: false, simulated: true };
};

// Get current entitlement state once (used at mount). The hook below also
// listens for live updates via addCustomerInfoUpdateListener.
const getEntitlementStatus = async () => {
  if (RCAvailable && Purchases) {
    try {
      const customerInfo = await Purchases.getCustomerInfo();
      return !!customerInfo?.entitlements?.active?.[RC.ENTITLEMENT_ID];
    } catch (err) {
      console.warn("[RC] getCustomerInfo failed:", err);
      return false;
    }
  }
  return null; // Web: defer to locally stored isPremium
};

// Present RevenueCat's hosted Customer Center (subscription management UI).
// Required by App Store for manage-subscription functionality. Falls back to
// opening the platform's subscription settings if RC UI isn't installed.
const presentCustomerCenter = async () => {
  if (PurchasesUI) {
    try {
      await PurchasesUI.presentCustomerCenter();
      return { success: true };
    } catch (err) {
      console.warn("[RC] customer center failed:", err);
    }
  }
  // Fallback — open native subscription management
  if (Purchases) {
    try {
      await Purchases.showManageSubscriptions();
      return { success: true };
    } catch {}
  }
  return { success: false };
};

// ─────────────────────────────────────────────────────────────────────────────
// DAILY PROMPTS — 42 hand-crafted observation prompts on a rotation
//
// Each day's prompt is deterministic per date, so all users get the same
// prompt on the same day (important for fair leaderboard comparisons later).
// Mix of sensory, emotional, philosophical, and visual prompts to keep the
// daily ritual feeling fresh over weeks of use.
// ─────────────────────────────────────────────────────────────────────────────
const PROMPTS = [
  // Observation
  { text: "Capture something you saw today that most people walked past without noticing.", tags: ["observation","detail","everyday"] },
  { text: "Describe a texture you touched today and the memory it triggered.",                tags: ["sensory","memory","detail"] },
  { text: "Notice one piece of light in your day — where it landed and what it transformed.", tags: ["light","attention","detail"] },
  { text: "What did the weather actually feel like today? Not the forecast — the feeling.",   tags: ["sensory","weather","mood"] },
  { text: "Name one sound that defined your morning, and why it stayed with you.",            tags: ["sound","morning","memory"] },
  { text: "Capture an object near you right now in three lines. Make it strange again.",      tags: ["object","attention","minimal"] },
  { text: "What did you almost miss today? Look back and write it down.",                     tags: ["attention","retrospect"] },
  { text: "Describe the colour of your mood today — invent the name if you must.",            tags: ["mood","colour","invention"] },

  // Memory & time
  { text: "A small moment from this week that has already started fading. Write it down before it goes.", tags: ["memory","fleeting"] },
  { text: "What did 11am look like today? Be specific.",                                       tags: ["time","place","specific"] },
  { text: "Describe a smell that took you somewhere else this week.",                          tags: ["smell","memory","transport"] },
  { text: "What's one thing your past self would be surprised you noticed today?",             tags: ["self","growth","attention"] },
  { text: "A song lyric that landed differently this week, and why.",                          tags: ["music","change","interpretation"] },

  // People & interaction
  { text: "Describe a stranger you saw today using only three details.",                       tags: ["people","strangers","minimal"] },
  { text: "What did someone say today that you're still turning over?",                        tags: ["conversation","dwelling"] },
  { text: "Capture a small kindness you witnessed (or gave).",                                 tags: ["kindness","observation"] },
  { text: "A conversation you almost had today.",                                              tags: ["people","unsaid","possibility"] },
  { text: "Describe someone you love using one ordinary gesture they make.",                   tags: ["love","gesture","specific"] },

  // Place
  { text: "Pick one corner of one room. Write it with the attention of a stranger.",           tags: ["place","attention","strange"] },
  { text: "Describe the part of your home that feels most yours.",                             tags: ["place","self","home"] },
  { text: "What does your street sound like at this exact hour?",                              tags: ["place","sound","specific"] },
  { text: "Find something man-made being slowly reclaimed by nature near you.",                tags: ["nature","decay","observation"] },
  { text: "A place you walk through without seeing. Look today.",                              tags: ["place","attention","ritual"] },

  // Feeling & inner
  { text: "Name the emotion you're feeling right now using something that isn't a feeling word.", tags: ["emotion","metaphor","precision"] },
  { text: "What did your body know today that your mind hadn't caught up to yet?",             tags: ["body","intuition","awareness"] },
  { text: "Describe a small worry as if it were weather.",                                     tags: ["worry","metaphor","scale"] },
  { text: "What gave you energy today, and what took it?",                                     tags: ["energy","balance","day"] },
  { text: "A tiny relief you felt today.",                                                     tags: ["relief","small","feeling"] },
  { text: "Describe a fear in physical detail, no metaphors.",                                 tags: ["fear","physical","direct"] },

  // Curiosity & craft
  { text: "What's a question you don't have an answer to today?",                              tags: ["question","unknown","open"] },
  { text: "Describe how you do one small daily task — like it's a craft.",                     tags: ["ritual","craft","everyday"] },
  { text: "An ordinary tool you used today. What it does that you take for granted.",          tags: ["object","tool","gratitude"] },
  { text: "A small skill you're getting better at. How can you tell?",                         tags: ["growth","skill","evidence"] },
  { text: "What did you make today, no matter how small?",                                     tags: ["creation","day","craft"] },

  // Visual / scene
  { text: "A scene you'd photograph if you weren't holding a phone. Describe it.",             tags: ["visual","scene","attention"] },
  { text: "Describe the most beautiful thing in your line of sight right now.",                tags: ["beauty","present","place"] },
  { text: "An unposed moment from today.",                                                     tags: ["moment","real","captured"] },
  { text: "Light at the end of the day where you are. Describe what it does.",                 tags: ["light","evening","place"] },

  // Reflection
  { text: "What did you eat today, and what was it about?",                                    tags: ["food","meaning","day"] },
  { text: "A piece of advice you didn't take, and what happened instead.",                     tags: ["choice","outcome","wisdom"] },
  { text: "Describe today using only the sounds you remember from it.",                        tags: ["sound","memory","sensory"] },
  { text: "What surprised you today — even slightly?",                                         tags: ["surprise","attention","day"] },
];

// Deterministic prompt-for-day. Same date key → same prompt for every user.
// Uses a simple hash so the rotation doesn't follow the array order cleanly
// (avoids the obvious "Monday is always prompt #1" pattern).
const promptForDate = (dateKey) => {
  let hash = 0;
  for (let i = 0; i < dateKey.length; i++) {
    hash = ((hash << 5) - hash + dateKey.charCodeAt(i)) | 0;
  }
  const idx = Math.abs(hash) % PROMPTS.length;
  return PROMPTS[idx];
};

// ─────────────────────────────────────────────────────────────────────────────
// GEMINI AI SCORING
//
// Calls Gemini's REST API to score a text submission against today's prompt.
// Returns { score: 60-98, feedback: string, breakdown: [{label, note}] }.
//
// The API key is loaded from environment (Expo: process.env.EXPO_PUBLIC_GEMINI_API_KEY,
// CRA / Vite: corresponding public env name). If unavailable or the call fails,
// falls back to a deterministic heuristic scorer so the app stays usable offline
// and during development.
//
// Same pattern as AllerSafe: direct fetch, no SDK, structured JSON response.
// ─────────────────────────────────────────────────────────────────────────────
const GEMINI = {
  // Read at runtime so the bundler can inline the env var
  API_KEY:
    (typeof process !== "undefined" && process.env && (
      process.env.EXPO_PUBLIC_GEMINI_API_KEY ||
      process.env.REACT_APP_GEMINI_API_KEY ||
      process.env.VITE_GEMINI_API_KEY ||
      process.env.GEMINI_API_KEY
    )) || "",
  MODEL: "gemini-2.0-flash",
  ENDPOINT: (model, key) =>
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`,
};

// Build the system prompt — kept concise so the model focuses on the four
// dimensions we care about and returns predictable JSON.
const buildScoringPrompt = (todayPrompt, userText) => `
You are the creative coach behind ANOTHERSHOT, a daily creative habit app.

Today's prompt was:
"${todayPrompt}"

A user submitted this response:
"""
${userText.slice(0, 1200)}
"""

Score the submission on a scale of 60–98 (the floor is 60 so users still feel
encouraged; 98 is reserved for truly exceptional work; an average attempt sits
around 75; off-topic or low-effort attempts should score 60–66).

Evaluate four dimensions equally:
- relevance:  How well it engages with today's specific prompt
- specificity: Concrete sensory detail vs vague generalities
- originality: A perspective or angle that feels fresh
- craft:      Word choice, rhythm, and economy

Penalize:
- Off-topic or generic submissions (score 60–68)
- Lazy single-word or filler responses (score 60–64)
- Cliché phrasing (knock 4–6 points)

Reward:
- Concrete, specific imagery
- Surprising angles or honest emotion
- Restraint — saying more with less

Return ONLY valid JSON, no markdown fences, with this exact shape:

{
  "score": <number 60-98>,
  "feedback": "<one warm, specific 1-2 sentence pull-quote about what worked, in quotes as if a coach said it>",
  "breakdown": [
    { "label": "What worked",     "note": "<one specific observation, 6-14 words>" },
    { "label": "What to sharpen", "note": "<one specific craft suggestion, 6-14 words>" },
    { "label": "Try next time",   "note": "<one forward-looking nudge, 6-14 words>" }
  ]
}
`.trim();

// Fallback heuristic — used when no API key or the API call fails.
// Returns a believable score band based on length + simple quality signals.
// Deterministic for the same input (no Math.random) so identical text gets
// identical fallback scoring.
const heuristicScore = (todayPrompt, userText) => {
  const text = (userText || "").trim();
  const chars = text.length;
  if (chars === 0) {
    return {
      score: 60,
      feedback: "We couldn't quite read this one. Try again with a few more words.",
      breakdown: [
        { label: "What worked",     note: "You showed up — that's the streak." },
        { label: "What to sharpen", note: "Give yourself a sentence or two next time." },
        { label: "Try next time",   note: "Aim for one concrete sensory detail." },
      ],
      source: "heuristic",
    };
  }

  // Base scoring: length tier (rewards reasonable effort, plateaus around 200 chars)
  let score = 60;
  if (chars >= 20)  score = 68;
  if (chars >= 60)  score = 74;
  if (chars >= 120) score = 80;
  if (chars >= 200) score = 84;

  // Bonus: contains specific sensory words
  const lower = text.toLowerCase();
  const sensoryWords = ["smell","sound","taste","feel","touch","light","colour","color","cold","warm","loud","quiet","soft","rough","sweet","bitter"];
  const sensoryHits = sensoryWords.filter(w => lower.includes(w)).length;
  score += Math.min(6, sensoryHits * 2);

  // Bonus: punctuation variety (suggests crafted writing)
  if (text.includes("—") || text.includes(":") || text.includes(";")) score += 2;

  // Penalty: looks like filler / one-word
  if (chars < 15 || /^(idk|nothing|nada|lol|test|asdf|hello|hi|yo)\b/i.test(text)) score = 60;

  // Tiny deterministic jitter from text content so identical input ≠ all 80s
  let jitter = 0;
  for (let i = 0; i < text.length; i++) jitter = (jitter + text.charCodeAt(i)) % 5;
  score = Math.min(95, Math.max(60, score + jitter - 2));

  // Build feedback that reflects the score band
  const isStrong = score >= 80;
  const isWeak   = score <= 68;
  const feedback = isStrong
    ? "There's a real eye in this. The specific detail does the work."
    : isWeak
    ? "There's a start here. Push for one concrete image and you'll find the shot."
    : "Solid attempt with a clear voice. Sharpen one image and it'll really land.";
  const breakdown = isStrong ? [
    { label: "What worked",     note: "Concrete detail, restrained pacing." },
    { label: "What to sharpen", note: "Push the emotional beat a touch further." },
    { label: "Try next time",   note: "Try ending on the image, not the explanation." },
  ] : isWeak ? [
    { label: "What worked",     note: "You showed up and submitted." },
    { label: "What to sharpen", note: "Lean into one sense — sight, sound, smell." },
    { label: "Try next time",   note: "Write the first true sentence that comes." },
  ] : [
    { label: "What worked",     note: "Clear voice with a personal angle." },
    { label: "What to sharpen", note: "Trade abstract words for specific images." },
    { label: "Try next time",   note: "End on the strongest detail you wrote." },
  ];
  return { score, feedback, breakdown, source: "heuristic" };
};

// Main scoring function — tries Gemini first, falls back to heuristic.
const scoreSubmission = async (todayPrompt, userText) => {
  // No API key configured — heuristic only
  if (!GEMINI.API_KEY) {
    return heuristicScore(todayPrompt, userText);
  }

  try {
    const response = await fetch(GEMINI.ENDPOINT(GEMINI.MODEL, GEMINI.API_KEY), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: buildScoringPrompt(todayPrompt, userText) }] }],
        generationConfig: {
          temperature: 0.7,
          responseMimeType: "application/json",
        },
      }),
    });

    if (!response.ok) throw new Error(`Gemini ${response.status}`);
    const data = await response.json();
    const raw = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!raw) throw new Error("Empty response");

    const parsed = JSON.parse(raw);
    // Clamp the score to the 60–98 contract even if the model drifts
    const score = Math.max(60, Math.min(98, Math.round(parsed.score)));
    return {
      score,
      feedback: parsed.feedback || "Thoughtful work.",
      breakdown: Array.isArray(parsed.breakdown) ? parsed.breakdown.slice(0, 3) : [],
      source: "gemini",
    };
  } catch (err) {
    console.warn("[Gemini] scoring failed, using heuristic:", err.message);
    return heuristicScore(todayPrompt, userText);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// SAFE STORAGE
// Cross-platform wrapper. Uses localStorage on web; swap with AsyncStorage
// for React Native by replacing the four methods below — the rest of the
// app doesn't need to change. All values are stringified JSON.
// ─────────────────────────────────────────────────────────────────────────────
const storage = {
  get: (key) => {
    try {
      if (typeof window === "undefined" || !window.localStorage) return null;
      const raw = window.localStorage.getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch { return null; }
  },
  set: (key, value) => {
    try {
      if (typeof window === "undefined" || !window.localStorage) return;
      window.localStorage.setItem(key, JSON.stringify(value));
    } catch {}
  },
};

// Today's date as YYYY-MM-DD in local time — used as the daily-reset key.
const todayKey = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
};

// Compute streak length from an array of date strings.
// A streak is consecutive days with ≥1 shot, ending today or yesterday.
// (We allow yesterday so the streak shows correctly before user takes today's shot.)
const computeStreak = (datesSet) => {
  if (!datesSet || datesSet.size === 0) return 0;
  let streak = 0;
  const cursor = new Date();
  // If today isn't shot, start counting from yesterday (grace period)
  const todayStr = todayKey();
  if (!datesSet.has(todayStr)) cursor.setDate(cursor.getDate() - 1);
  // Walk backwards counting consecutive days
  for (let i = 0; i < 365; i++) {
    const key = `${cursor.getFullYear()}-${String(cursor.getMonth()+1).padStart(2,"0")}-${String(cursor.getDate()).padStart(2,"0")}`;
    if (datesSet.has(key)) {
      streak++;
      cursor.setDate(cursor.getDate() - 1);
    } else {
      break;
    }
  }
  return streak;
};

// ─────────────────────────────────────────────────────────────────────────────
// useShotEconomy — central hook for all monetization + streak state
//
// State shape (persisted):
//   {
//     date:        "YYYY-MM-DD",  // today; resets daily counters when changed
//     shotsUsed:   0..∞,          // shots consumed today
//     bonusShots:  0..∞,          // bonus shots earned today (from ads)
//     adsWatched:  0..AD_DAILY_CAP,
//     isPremium:   boolean,       // true after successful upgrade
//     shotDates:   string[],      // every date a shot was taken (for streak)
//     personalBest: number,       // longest streak ever achieved
//   }
//
// Derived helpers exposed:
//   shotsLeft, canTakeShot, canWatchAd, streak, personalBest,
//   consumeShot, grantAdReward, setPremium
// ─────────────────────────────────────────────────────────────────────────────
const useShotEconomy = () => {
  const [state, setState] = useState(() => {
    const saved = storage.get(MONEY.STORAGE_KEY);
    const today = todayKey();
    const base = {
      date:         today,
      shotsUsed:    0,
      bonusShots:   0,
      adsWatched:   0,
      isPremium:    false,
      shotDates:    [],
      personalBest: 0,
      bestScore:    0,        // highest score ever achieved
      weekScores:   [],       // [{ date, score }] for last ~14 days
    };
    if (!saved) return base;
    // Date rollover — reset daily counters, preserve durable fields
    if (saved.date !== today) {
      return {
        ...base,
        isPremium:    saved.isPremium    ?? false,
        shotDates:    Array.isArray(saved.shotDates) ? saved.shotDates : [],
        personalBest: typeof saved.personalBest === "number" ? saved.personalBest : 0,
        bestScore:    typeof saved.bestScore === "number" ? saved.bestScore : 0,
        weekScores:   Array.isArray(saved.weekScores) ? saved.weekScores : [],
      };
    }
    // Same day — return saved with safe defaults
    return {
      ...base,
      ...saved,
      shotDates:    Array.isArray(saved.shotDates) ? saved.shotDates : [],
      personalBest: typeof saved.personalBest === "number" ? saved.personalBest : 0,
      bestScore:    typeof saved.bestScore === "number" ? saved.bestScore : 0,
      weekScores:   Array.isArray(saved.weekScores) ? saved.weekScores : [],
    };
  });

  // Persist every change
  useEffect(() => {
    storage.set(MONEY.STORAGE_KEY, state);
  }, [state]);

  // Check for date rollover when the tab becomes visible again (SSR-safe)
  useEffect(() => {
    if (typeof document === "undefined") return;
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      const today = todayKey();
      setState(prev => prev.date !== today
        ? { ...prev, date: today, shotsUsed: 0, bonusShots: 0, adsWatched: 0 }
        : prev
      );
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, []);

  // ── Derived values ──
  const totalAllowed = MONEY.DAILY_FREE_SHOTS + state.bonusShots;
  const shotsLeft    = state.isPremium ? Infinity : Math.max(0, totalAllowed - state.shotsUsed);
  const canTakeShot  = state.isPremium || shotsLeft > 0;
  const canWatchAd   = !state.isPremium && state.adsWatched < MONEY.AD_DAILY_CAP;

  // Streak is computed from history, not stored — single source of truth
  const datesSet = new Set(state.shotDates);
  const streak   = computeStreak(datesSet);

  // ── Actions ──
  const consumeShot = () => setState(p => {
    const today = todayKey();
    // Add today to shot history if not already present (first shot of the day)
    const shotDates = p.shotDates.includes(today)
      ? p.shotDates
      : [...p.shotDates, today];
    // Recompute streak with today included, update personal best if needed
    const newStreak = computeStreak(new Set(shotDates));
    return {
      ...p,
      shotsUsed: p.shotsUsed + 1,
      shotDates,
      personalBest: Math.max(p.personalBest, newStreak),
    };
  });

  const grantAdReward = () => setState(p => ({
    ...p,
    bonusShots: p.bonusShots + MONEY.AD_REWARD_SHOTS,
    adsWatched: p.adsWatched + 1,
  }));

  const setPremium = (isPremium) => setState(p => ({ ...p, isPremium }));

  // Record a score after AI/heuristic scoring completes.
  // Updates bestScore if exceeded and appends to weekScores (capped at 14 entries).
  const recordScore = (score) => setState(p => {
    const today = todayKey();
    const entry = { date: today, score };
    const weekScores = [...p.weekScores, entry].slice(-14);
    return {
      ...p,
      bestScore: Math.max(p.bestScore, score),
      weekScores,
    };
  });

  // Derived: best score in the last 7 days (for the leaderboard / Result UI)
  const sevenDaysAgo = (() => {
    const d = new Date();
    d.setDate(d.getDate() - 7);
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
  })();
  const weekBestScore = state.weekScores
    .filter(s => s.date >= sevenDaysAgo)
    .reduce((max, s) => Math.max(max, s.score), 0);

  return {
    // raw
    shotsUsed:    state.shotsUsed,
    bonusShots:   state.bonusShots,
    adsWatched:   state.adsWatched,
    isPremium:    state.isPremium,
    shotDates:    state.shotDates,
    personalBest: state.personalBest,
    bestScore:    state.bestScore,
    weekScores:   state.weekScores,
    // derived
    totalAllowed, shotsLeft, canTakeShot, canWatchAd, streak, weekBestScore,
    // actions
    consumeShot, grantAdReward, setPremium, recordScore,
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// usePurchases — React hook that owns the RevenueCat lifecycle
//
// Responsibilities:
//   1. Configure RC once at app mount
//   2. Fetch the current offering (prices + packages)
//   3. Subscribe to customerInfo updates so entitlement stays live
//   4. Expose: { isPremium, offerings, purchase, restore, manageSubscription }
//
// `onEntitlementChange(isPremium)` is called whenever RC reports a change —
// the App wires this to economy.setPremium so the shot economy stays in sync.
// ─────────────────────────────────────────────────────────────────────────────
const usePurchases = (onEntitlementChange) => {
  const [ready, setReady]         = useState(false);
  const [offerings, setOfferings] = useState(null);
  const [isPremium, setIsPremium] = useState(null); // null = unknown yet
  const [purchasing, setPurchasing] = useState(false);

  // Boot the SDK + load offerings + check current entitlement
  useEffect(() => {
    let cancelled = false;
    (async () => {
      await configurePurchases();
      if (cancelled) return;

      // Initial entitlement check
      const premium = await getEntitlementStatus();
      if (cancelled) return;
      if (premium !== null) {
        setIsPremium(premium);
        onEntitlementChange?.(premium);
      }

      // Load offering
      const off = await fetchOfferings();
      if (cancelled) return;
      setOfferings(off);
      setReady(true);
    })();
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Live entitlement updates from RC (e.g. when subscription renews,
  // is refunded, or is restored on another device)
  useEffect(() => {
    if (!RCAvailable || !Purchases) return;
    const listener = (customerInfo) => {
      const premium = !!customerInfo?.entitlements?.active?.[RC.ENTITLEMENT_ID];
      setIsPremium(premium);
      onEntitlementChange?.(premium);
    };
    Purchases.addCustomerInfoUpdateListener(listener);
    return () => {
      try { Purchases.removeCustomerInfoUpdateListener(listener); } catch {}
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Buy a package — returns the result so screens can show success/error states
  const purchase = async (pkg) => {
    if (purchasing) return { success: false, busy: true };
    setPurchasing(true);
    const result = await purchasePackage(pkg);
    setPurchasing(false);
    if (result.success && result.isPremium) {
      setIsPremium(true);
      onEntitlementChange?.(true);
    }
    return result;
  };

  // Restore — required by Apple
  const restore = async () => {
    const result = await restorePurchases();
    if (result.success) {
      setIsPremium(result.isPremium);
      onEntitlementChange?.(result.isPremium);
    }
    return result;
  };

  return {
    ready,                  // true after SDK + offerings have loaded
    offerings,              // { monthly, annual } or null
    isPremium,              // boolean (null while loading on native)
    purchasing,             // true during an active purchase flow
    purchase,
    restore,
    manageSubscription: presentCustomerCenter,
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// FONT + GLOBAL CSS INJECTION
// ─────────────────────────────────────────────────────────────────────────────
const FONT_URL =
  "https://fonts.googleapis.com/css2?family=Syne:wght@600;700;800&family=Instrument+Sans:ital,wght@0,400;0,500;0,600;1,400&display=swap";

const GLOBAL_CSS = `
  *, *::before, *::after { box-sizing:border-box; -webkit-tap-highlight-color:transparent; margin:0; padding:0; }
  ::-webkit-scrollbar { display:none; }
  body { background: #07070A; }

  @keyframes up   { from{opacity:0;transform:translateY(20px)} to{opacity:1;transform:translateY(0)} }
  @keyframes in   { from{opacity:0} to{opacity:1} }
  @keyframes pop  { from{opacity:0;transform:scale(0.90)} to{opacity:1;transform:scale(1)} }
  @keyframes numIn{ from{opacity:0;transform:translateY(14px) scale(0.8)} to{opacity:1;transform:translateY(0) scale(1)} }
  @keyframes pulse{ 0%,100%{box-shadow:0 0 0 0 rgba(255,77,0,0.4)} 55%{box-shadow:0 0 0 18px rgba(255,77,0,0)} }
  @keyframes streakPop { 0%{transform:scale(1)} 50%{transform:scale(1.04)} 100%{transform:scale(1)} }

  /* ── Reward-loop animations ── */
  @keyframes thump {
    0%   { opacity:0; transform:scale(0.4); }
    55%  { opacity:1; transform:scale(1.22); }
    78%  { transform:scale(0.94); }
    100% { transform:scale(1); }
  }
  @keyframes ringPulse {
    0%   { opacity:0; transform:scale(0.9); }
    40%  { opacity:1; }
    100% { opacity:0; transform:scale(1.35); }
  }
  @keyframes celebPop {
    0%   { opacity:0; transform:scale(0.4) translateY(28px) rotate(-8deg); }
    55%  { opacity:1; transform:scale(1.18) translateY(-3px) rotate(3deg); }
    100% { opacity:1; transform:scale(1) translateY(0) rotate(0); }
  }
  @keyframes riseFloat {
    0%   { opacity:0; transform:translateY(20px); }
    20%  { opacity:1; }
    80%  { opacity:1; transform:translateY(-26px); }
    100% { opacity:0; transform:translateY(-44px); }
  }
  @keyframes shimmer {
    0%   { background-position: 200% center; }
    100% { background-position: -200% center; }
  }
  @keyframes breathe {
    0%, 100% { transform:scale(1); }
    50%      { transform:scale(1.018); }
  }
  @keyframes flashFade {
    0%   { opacity:0; }
    8%   { opacity:1; }
    100% { opacity:0; }
  }
  @keyframes spinSlow { from{transform:rotate(0)} to{transform:rotate(360deg)} }

  .hov { transition:background 0.18s ease, border-color 0.18s ease; }
  .hov:hover { background:#13131C !important; }

  .fab:active { transform:translateY(-5px) scale(0.94) !important; }
  .navbtn:active { transform:scale(0.88); }

  /* Mega CTA — animated gradient sweep + breathing */
  .megaBtn {
    background: linear-gradient(110deg,
      #FF6B20 0%,
      #FF4D00 28%,
      rgba(255,200,150,0.45) 50%,
      #FF4D00 72%,
      #FF6B20 100%
    );
    background-size: 240% 100%;
    animation: shimmer 3.2s linear infinite, breathe 2.8s ease-in-out infinite;
  }
  .megaBtn:active {
    animation-play-state: paused;
    transform: scale(0.975) translateY(2px) !important;
  }

  textarea::placeholder { color: #2E2E48; }
  textarea { caret-color: #FF4D00; }
`;

const setupGlobals = () => {
  if (!document.getElementById("as-font")) {
    const l = document.createElement("link");
    l.id = "as-font"; l.rel = "stylesheet"; l.href = FONT_URL;
    document.head.appendChild(l);
  }
  if (!document.getElementById("as-css")) {
    const s = document.createElement("style");
    s.id = "as-css"; s.textContent = GLOBAL_CSS;
    document.head.appendChild(s);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// PRIMITIVES
// ─────────────────────────────────────────────────────────────────────────────

const Label = ({ children, color = T.lo, style = {} }) => (
  <div style={{
    fontFamily:"'Instrument Sans',sans-serif", fontSize:10, fontWeight:600,
    letterSpacing:"0.10em", textTransform:"uppercase", color, ...style,
  }}>{children}</div>
);

const Tag = ({ children, accent = "orange" }) => {
  const isO = accent === "orange";
  return (
    <span style={{
      display:"inline-flex", alignItems:"center", gap:5,
      padding:"3px 9px", borderRadius:99,
      background: isO ? T.orangeFog : T.tealFog,
      border:`1px solid ${isO ? T.orangeRim : T.tealRim}`,
      color: isO ? T.orange : T.teal,
      fontFamily:"'Instrument Sans',sans-serif", fontSize:10,
      fontWeight:600, letterSpacing:"0.07em", textTransform:"uppercase",
    }}>{children}</span>
  );
};

const Card = ({ children, style = {}, onClick, hover = true }) => (
  <div onClick={onClick} className={hover ? "hov" : ""}
    style={{
      background:T.card, border:`1px solid ${T.border}`,
      borderRadius:18, padding:"18px 20px",
      cursor:onClick ? "pointer" : "default",
      ...style,
    }}>{children}</div>
);

const GlowCard = ({ children, style = {}, strong = false }) => (
  <div style={{
    background: `linear-gradient(${T.card},${T.card}) padding-box,
                 linear-gradient(145deg,
                   ${strong ? "rgba(255,77,0,0.32)" : "rgba(255,77,0,0.18)"} 0%,
                   rgba(255,77,0,0.04) 55%,
                   transparent 100%
                 ) border-box`,
    border:"1px solid transparent",
    borderRadius:22, padding:"22px 22px",
    ...style,
  }}>{children}</div>
);

const Divider = ({ style = {} }) => (
  <div style={{ height:1, background:T.border, ...style }}/>
);

const BackBtn = ({ onClick }) => (
  <button onClick={onClick} className="navbtn" style={{
    width:38, height:38, borderRadius:12, flexShrink:0,
    background:T.surface, border:`1px solid ${T.border}`,
    display:"flex", alignItems:"center", justifyContent:"center",
    cursor:"pointer", color:T.mid, transition:"color 0.15s",
  }}>
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
      <path d="M19 12H5M12 19l-7-7 7-7"/>
    </svg>
  </button>
);

const PrimaryBtn = ({ children, onClick, disabled = false, large = false, style = {} }) => {
  const [pressed, setPressed] = useState(false);
  return (
    <button
      onClick={disabled ? undefined : onClick}
      onPointerDown={() => setPressed(true)}
      onPointerUp={() => setPressed(false)}
      onPointerLeave={() => setPressed(false)}
      style={{
        display:"flex", alignItems:"center", justifyContent:"center",
        gap:9, width:"100%",
        padding: large ? "20px 28px" : "17px 28px",
        borderRadius: large ? 18 : 16,
        border:"none", cursor: disabled ? "not-allowed" : "pointer",
        fontFamily:"'Syne',sans-serif",
        fontSize: large ? 17 : 16, fontWeight:700, letterSpacing:"0.01em",
        color:"#fff",
        opacity: disabled ? 0.38 : 1,
        background: pressed
          ? `linear-gradient(150deg, ${T.orange} 0%, #D83400 100%)`
          : `linear-gradient(150deg, ${T.orangeHi} 0%, ${T.orange} 55%, #E53A00 100%)`,
        boxShadow: disabled ? "none" : pressed
          ? "0 2px 10px rgba(255,77,0,0.28)"
          : "0 8px 26px rgba(255,77,0,0.32), 0 2px 6px rgba(255,77,0,0.18), inset 0 1px 0 rgba(255,255,255,0.11)",
        transform: pressed ? "scale(0.968) translateY(1px)" : "scale(1)",
        transition:"transform 0.1s cubic-bezier(0.34,1.56,0.64,1), box-shadow 0.18s ease, background 0.12s ease",
        ...style,
      }}
    >{children}</button>
  );
};

const Arrow = ({ opacity = 0.5, size = 14 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
    stroke={`rgba(255,255,255,${opacity})`} strokeWidth="2.4" strokeLinecap="round">
    <path d="M5 12h14M12 5l7 7-7 7"/>
  </svg>
);

// Secondary CTA — used for "Watch Ad for +3 shots" everywhere it appears.
// Visually distinct from PrimaryBtn: outlined, teal-tinted, play icon.
const WatchAdButton = ({ onClick, disabled = false, compact = false, style = {} }) => (
  <button
    onClick={disabled ? undefined : onClick}
    disabled={disabled}
    style={{
      width:"100%", border:`1px solid ${disabled ? T.border : T.tealRim}`,
      background: disabled ? T.surface : T.tealFog,
      borderRadius:14, padding: compact ? "12px 16px" : "14px 18px",
      cursor: disabled ? "not-allowed" : "pointer",
      display:"flex", alignItems:"center", justifyContent:"center", gap:9,
      transition:`all 0.18s ${EXPO}`,
      opacity: disabled ? 0.5 : 1,
      ...style,
    }}
    onPointerDown={e => !disabled && (e.currentTarget.style.transform = "scale(0.97)")}
    onPointerUp={e => (e.currentTarget.style.transform = "scale(1)")}
    onPointerLeave={e => (e.currentTarget.style.transform = "scale(1)")}
  >
    <div style={{
      width:20, height:20, borderRadius:"50%",
      background: disabled ? T.border : T.teal,
      display:"flex", alignItems:"center", justifyContent:"center",
      flexShrink:0,
    }}>
      <svg width="9" height="9" viewBox="0 0 24 24" fill={disabled ? T.lo : "#000"}>
        <polygon points="6 4 20 12 6 20 6 4"/>
      </svg>
    </div>
    <span style={{
      fontFamily:"'Syne',sans-serif", fontSize: compact ? 13 : 14, fontWeight:700,
      color: disabled ? T.lo : T.teal, letterSpacing:"0.01em",
    }}>
      {disabled ? "Daily ad limit reached" : `Watch Ad for +${MONEY.AD_REWARD_SHOTS} Shots`}
    </span>
  </button>
);

// Compact shots-left indicator — shown in headers and inline contexts.
const ShotsIndicator = ({ shotsLeft, isPremium, style = {} }) => {
  if (isPremium) return (
    <div style={{
      display:"inline-flex", alignItems:"center", gap:5,
      padding:"4px 10px", borderRadius:99,
      background:`linear-gradient(135deg, rgba(194,160,48,0.15), rgba(194,160,48,0.04))`,
      border:`1px solid rgba(194,160,48,0.30)`,
      fontFamily:"'Instrument Sans',sans-serif", fontSize:10, fontWeight:700,
      color:T.gold, letterSpacing:"0.10em", textTransform:"uppercase",
      ...style,
    }}>
      <span style={{ fontSize:10 }}>✦</span> Pro · Unlimited
    </div>
  );
  const low = shotsLeft <= 1;
  const color = low ? "#E05050" : T.orange;
  return (
    <div style={{
      display:"inline-flex", alignItems:"center", gap:6,
      padding:"4px 10px", borderRadius:99,
      background: low ? "rgba(224,80,80,0.10)" : T.orangeFog,
      border:`1px solid ${low ? "rgba(224,80,80,0.28)" : T.orangeRim}`,
      ...style,
    }}>
      {/* Mini pill bar showing remaining */}
      <div style={{ display:"flex", gap:2 }}>
        {Array.from({ length: Math.min(shotsLeft, 5) }).map((_, i) => (
          <div key={i} style={{
            width:3, height:9, borderRadius:1,
            background: color,
            boxShadow:`0 0 3px ${color}`,
          }}/>
        ))}
      </div>
      <span style={{
        fontFamily:"'Instrument Sans',sans-serif", fontSize:10, fontWeight:700,
        color, letterSpacing:"0.08em", textTransform:"uppercase",
      }}>
        {shotsLeft} left
      </span>
    </div>
  );
};

// Mini static score ring — for compact list contexts (history cards, etc.)
const MiniRing = ({ score, size = 40 }) => {
  const R    = (size / 2) - 3.5;
  const CIRC = 2 * Math.PI * R;
  const offset = CIRC * (1 - score / 100);
  const color  = score >= 85 ? T.teal : score >= 70 ? T.orange : T.mid;
  return (
    <div style={{ position:"relative", width:size, height:size, flexShrink:0 }}>
      <svg width={size} height={size} style={{ transform:"rotate(-90deg)" }}>
        <circle cx={size/2} cy={size/2} r={R} fill="none"
          stroke={T.border} strokeWidth="2.5"/>
        <circle cx={size/2} cy={size/2} r={R} fill="none"
          stroke={color} strokeWidth="2.5" strokeLinecap="round"
          strokeDasharray={CIRC} strokeDashoffset={offset}
          style={{ filter:`drop-shadow(0 0 2px ${color})` }}/>
      </svg>
      <div style={{
        position:"absolute", inset:0,
        display:"flex", alignItems:"center", justifyContent:"center",
        fontFamily:"'Syne',sans-serif", fontWeight:800,
        fontSize: size <= 36 ? 11 : 13, color,
      }}>{score}</div>
    </div>
  );
};

// expo-out: fast start, gentle settle
const EXPO = "cubic-bezier(0.16,1,0.3,1)";
const useStagger = () => {
  const [ready, setReady] = useState(false);
  useEffect(() => { const id = setTimeout(() => setReady(true), 30); return () => clearTimeout(id); }, []);
  return (delay) => ready
    ? { animation:`up 0.52s ${EXPO} ${delay}s both` }
    : { opacity:0 };
};

// ─────────────────────────────────────────────────────────────────────────────
// HOME SCREEN
// ─────────────────────────────────────────────────────────────────────────────
const HomeScreen = ({ onNav, economy }) => {
  const s = useStagger();
  const { shotsLeft, isPremium, canWatchAd, totalAllowed, streak, personalBest, shotDates } = economy;
  // Streak data — derived from real shot history (persisted)
  const STREAK = streak;
  // Personal best is max(historical PB, current streak) so the bar always makes sense
  const PB = Math.max(personalBest, streak, 1);
  // Days needed to beat (or match) PB. Always at least 1 to give the user a goal.
  const DAYS_TO_PB = streak >= personalBest && streak > 0 ? 1 : Math.max(1, PB - STREAK + 1);
  const STRIP_DAYS = 21; // visual streak-proof strip length

  // Build 21 cells from real shot history. Each cell = one calendar day,
  // rightmost = today. inStreak = user actually took a shot on that day.
  const datesSet = new Set(shotDates);
  const strip = Array.from({ length: STRIP_DAYS }, (_, i) => {
    const d = new Date();
    d.setDate(d.getDate() - (STRIP_DAYS - 1 - i));
    const key = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
    return {
      inStreak: datesSet.has(key),
      isToday:  i === STRIP_DAYS - 1,
    };
  });

  // Today's intention — small inspirational line under the CTA
  const intention = "Notice what's quiet today.";

  return (
    <div style={{ padding:"0 20px 24px" }}>

      {/* ── Wordmark header ── */}
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center",
        paddingTop:22, marginBottom:24, ...s(0) }}>
        <div>
          <div style={{
            fontFamily:"'Syne',sans-serif", fontWeight:800, fontSize:11,
            letterSpacing:"0.24em", color:T.orange, textTransform:"uppercase",
          }}>ANOTHERSHOT</div>
          <div style={{
            fontFamily:"'Instrument Sans',sans-serif", fontSize:11,
            color:T.lo, letterSpacing:"0.04em", marginTop:2,
          }}>Daily Creative Score</div>
        </div>

        {/* Right-side controls: Upgrade/Pro pill + Settings gear */}
        <div style={{ display:"flex", alignItems:"center", gap:8 }}>
          {/* Upgrade pill — turns into Pro badge if user is premium */}
          {isPremium ? (
            <div style={{
              display:"inline-flex", alignItems:"center", gap:6,
              padding:"7px 12px", borderRadius:11,
              background:`linear-gradient(135deg, rgba(194,160,48,0.18), rgba(194,160,48,0.05))`,
              border:`1px solid rgba(194,160,48,0.35)`,
            }}>
              <span style={{ fontSize:11, color:T.gold }}>✦</span>
              <span style={{
                fontFamily:"'Syne',sans-serif", fontSize:11, fontWeight:700,
                color:T.gold, letterSpacing:"0.06em", textTransform:"uppercase",
              }}>Pro</span>
            </div>
          ) : (
            <button onClick={() => onNav("paywall")} aria-label="Upgrade to Pro" style={{
              display:"inline-flex", alignItems:"center", gap:6,
              padding:"7px 12px", borderRadius:11,
              background:T.orangeFog, border:`1px solid ${T.orangeRim}`,
              cursor:"pointer", transition:`transform 0.15s ${EXPO}`,
            }}
            onPointerDown={e => e.currentTarget.style.transform = "scale(0.95)"}
            onPointerUp={e => e.currentTarget.style.transform = "scale(1)"}
            onPointerLeave={e => e.currentTarget.style.transform = "scale(1)"}>
              <span style={{ fontSize:10, color:T.orange }}>✦</span>
              <span style={{
                fontFamily:"'Syne',sans-serif", fontSize:11, fontWeight:700,
                color:T.orange, letterSpacing:"0.04em",
              }}>Upgrade</span>
            </button>
          )}

          {/* Settings gear */}
          <button
            onClick={() => onNav("settings")}
            aria-label="Settings"
            className="navbtn"
            style={{
              width:36, height:36, borderRadius:11, flexShrink:0,
              background:T.surface, border:`1px solid ${T.border}`,
              display:"flex", alignItems:"center", justifyContent:"center",
              cursor:"pointer", color:T.mid,
              transition:`color 0.15s ease, transform 0.15s ${EXPO}`,
            }}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none"
              stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="3"/>
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/>
            </svg>
          </button>
        </div>
      </div>

      {/* ── Streak Hero ── */}
      <GlowCard strong style={{ marginBottom:12, position:"relative", overflow:"hidden", ...s(0.05) }}>

        {/* Atmospheric radial */}
        <div style={{
          position:"absolute", top:-70, right:-70, width:240, height:240,
          background:"radial-gradient(circle, rgba(255,77,0,0.10) 0%, transparent 68%)",
          pointerEvents:"none",
        }}/>

        {/* Top row — status pill + social proof */}
        <div style={{ display:"flex", justifyContent:"space-between",
          alignItems:"center", marginBottom:22 }}>
          <div style={{
            display:"inline-flex", alignItems:"center", gap:6,
            padding:"5px 11px 5px 8px", borderRadius:99,
            background:T.orangeFog, border:`1px solid ${T.orangeRim}`,
          }}>
            <span style={{
              fontSize:13, lineHeight:1, display:"inline-block",
              animation:"streakPop 2.2s ease-in-out infinite",
            }}>🔥</span>
            <span style={{
              fontFamily:"'Instrument Sans',sans-serif", fontSize:10, fontWeight:700,
              color:T.orange, letterSpacing:"0.10em", textTransform:"uppercase",
            }}>{STREAK === 0 ? "Start Today" : STREAK >= 7 ? "On Fire" : "Building"}</span>
          </div>
          <div style={{
            display:"inline-flex", alignItems:"center", gap:5,
            fontFamily:"'Instrument Sans',sans-serif", fontSize:10, fontWeight:600,
            color:T.mid, letterSpacing:"0.06em", textTransform:"uppercase",
          }}>
            <span style={{
              width:5, height:5, borderRadius:"50%", background:T.teal,
              boxShadow:`0 0 6px ${T.teal}`,
            }}/>
            {STREAK === 0 ? "Welcome" : "Top 8% of users"}
          </div>
        </div>

        {/* Streak number — gradient text + stacked label */}
        <div style={{ display:"flex", alignItems:"flex-end", gap:14, marginBottom:6 }}>
          <div style={{
            fontFamily:"'Syne',sans-serif", fontWeight:800, fontSize:96,
            lineHeight:0.86, letterSpacing:"-0.05em",
            background:`linear-gradient(180deg, #FFFFFF 0%, #C9C4BA 100%)`,
            WebkitBackgroundClip:"text",
            WebkitTextFillColor:"transparent",
            backgroundClip:"text",
            animation:"streakPop 4s ease-in-out infinite",
          }}>{STREAK}</div>
          <div style={{ paddingBottom:10, display:"flex", flexDirection:"column", gap:3 }}>
            <div style={{
              fontFamily:"'Syne',sans-serif", fontSize:14, fontWeight:700,
              color:T.hi, letterSpacing:"0.02em", lineHeight:1,
            }}>day</div>
            <div style={{
              fontFamily:"'Syne',sans-serif", fontSize:14, fontWeight:700,
              color:T.orange, letterSpacing:"0.02em", lineHeight:1,
            }}>streak</div>
          </div>
        </div>

        {/* Milestone progress — creates motivational tension */}
        <div style={{ marginBottom:22 }}>
          <div style={{
            display:"flex", justifyContent:"space-between",
            alignItems:"baseline", marginBottom:7,
          }}>
            <div style={{
              fontFamily:"'Instrument Sans',sans-serif", fontSize:12, color:T.mid,
            }}>
              {STREAK === 0
                ? <><span style={{ color:T.orange, fontWeight:600 }}>Take your first shot</span> to start a streak</>
                : STREAK >= personalBest && personalBest > 0
                  ? <><span style={{ color:T.teal, fontWeight:600 }}>New record!</span> Keep going.</>
                  : <><span style={{ color:T.orange, fontWeight:600 }}>{DAYS_TO_PB} more</span> to beat your record</>
              }
            </div>
            <div style={{
              fontFamily:"'Syne',sans-serif", fontSize:11, fontWeight:700, color:T.lo,
              letterSpacing:"0.04em",
            }}>{personalBest > 0 ? `${personalBest}d` : "—"}</div>
          </div>
          <div style={{
            height:3, background:T.border, borderRadius:99, overflow:"hidden",
            position:"relative",
          }}>
            <div style={{
              height:"100%",
              width:`${(STREAK / PB) * 100}%`,
              background:`linear-gradient(90deg, ${T.orangeHi}, ${T.orange})`,
              boxShadow:`0 0 8px rgba(255,77,0,0.5)`,
              borderRadius:99,
              transition:`width 1s ${EXPO}`,
            }}/>
          </div>
        </div>

        {/* 21-day proof strip — visual evidence of the streak */}
        <div style={{ marginBottom:24 }}>
          <div style={{
            display:"flex", justifyContent:"space-between",
            alignItems:"center", marginBottom:8,
          }}>
            <div style={{
              fontFamily:"'Instrument Sans',sans-serif", fontSize:10,
              color:T.lo, letterSpacing:"0.10em", textTransform:"uppercase",
            }}>Last 21 days</div>
            <div style={{
              fontFamily:"'Instrument Sans',sans-serif", fontSize:10,
              color:T.lo, letterSpacing:"0.04em",
            }}>← past · today →</div>
          </div>
          <div style={{ display:"flex", gap:3 }}>
            {strip.map((c, i) => {
              // Today is "earned" only if user has actually taken a shot today
              const todayEarned = c.isToday && c.inStreak;
              const todayPending = c.isToday && !c.inStreak;
              return (
                <div key={i} style={{
                  flex:1, aspectRatio:"1 / 1.1", borderRadius:3,
                  background: todayEarned
                    ? `linear-gradient(135deg, ${T.orangeHi}, ${T.orange})`
                    : c.inStreak
                      ? "rgba(255,77,0,0.50)"
                      : T.border,
                  boxShadow: todayEarned
                    ? `0 0 10px rgba(255,77,0,0.7), inset 0 0 0 1px rgba(255,255,255,0.18)`
                    : c.inStreak
                      ? "inset 0 0 0 1px rgba(255,77,0,0.08)"
                      : "none",
                  border: todayPending ? `1px dashed ${T.orangeRim}` : "none",
                  animation: `up 0.4s ${EXPO} ${0.3 + i * 0.018}s both`,
                }}/>
              );
            })}
          </div>
        </div>

        {/* MEGA CTA — routes to outOfShots if user is out, paywall flow handled there */}
        <button
          onClick={() => onNav(economy.canTakeShot ? "shot" : "outOfShots")}
          className="megaBtn"
          style={{
            width:"100%", border:"none", cursor:"pointer", padding:0,
            borderRadius:18, position:"relative", overflow:"hidden",
            boxShadow:"0 10px 30px rgba(255,77,0,0.36), 0 3px 10px rgba(255,77,0,0.18), inset 0 1px 0 rgba(255,255,255,0.14)",
            transition:`transform 0.15s ${EXPO}`,
          }}
        >
          <div style={{
            padding:"18px 22px", display:"flex", alignItems:"center",
            justifyContent:"center", gap:11, position:"relative", zIndex:2,
          }}>
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none"
              stroke="rgba(255,255,255,0.92)" strokeWidth="2" strokeLinecap="round">
              <circle cx="12" cy="12" r="9"/>
              <circle cx="12" cy="12" r="3"/>
            </svg>
            <span style={{
              fontFamily:"'Syne',sans-serif", fontWeight:800, fontSize:17,
              color:"#fff", letterSpacing:"0.005em",
              textShadow:"0 1px 4px rgba(0,0,0,0.22)",
            }}>Take Today's Shot</span>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
              stroke="rgba(255,255,255,0.65)" strokeWidth="2.5" strokeLinecap="round">
              <path d="M5 12h14M12 5l7 7-7 7"/>
            </svg>
          </div>
        </button>

        {/* Shots remaining indicator — sits under the CTA */}
        <div style={{
          display:"flex", justifyContent:"center", marginTop:12,
        }}>
          <ShotsIndicator shotsLeft={shotsLeft} isPremium={isPremium}/>
        </div>

        {/* Today's intention — small inspirational line */}
        <div style={{
          textAlign:"center", marginTop:12,
          display:"flex", alignItems:"center", justifyContent:"center", gap:8,
        }}>
          <div style={{ width:18, height:1, background:T.border }}/>
          <div style={{
            fontFamily:"'Instrument Sans',sans-serif", fontSize:12,
            color:T.mid, fontStyle:"italic", letterSpacing:"0.005em",
          }}>{intention}</div>
          <div style={{ width:18, height:1, background:T.border }}/>
        </div>
        <div style={{
          textAlign:"center", marginTop:5,
          fontFamily:"'Instrument Sans',sans-serif", fontSize:10, color:T.lo,
          letterSpacing:"0.06em", textTransform:"uppercase",
        }}>60-second challenge</div>
      </GlowCard>

      {/* Watch Ad row — only shown to non-premium users, hidden if limit reached */}
      {!isPremium && (
        <div style={{ marginBottom:10, ...s(0.12) }}>
          <WatchAdButton
            onClick={() => onNav("ad")}
            disabled={!canWatchAd}
            compact
          />
        </div>
      )}

      {/* ── Stats with mini visualizations ── */}
      <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10, marginBottom:10, ...s(0.13) }}>

        {/* Shots today — dash progress, wired to economy */}
        <Card style={{ padding:"16px 18px" }}>
          <div style={{ display:"flex", gap:4, marginBottom:14, height:4 }}>
            {Array.from({ length: Math.max(5, economy.totalAllowed) }).map((_, i) => {
              const used = i < economy.shotsUsed;
              return (
                <div key={i} style={{
                  flex:1, height:"100%", borderRadius:99,
                  background: used
                    ? `linear-gradient(90deg, ${T.teal}, #00C9B3)`
                    : T.border,
                  boxShadow: used ? `0 0 5px rgba(0,181,160,0.45)` : "none",
                }}/>
              );
            })}
          </div>
          <div style={{ display:"flex", alignItems:"baseline", gap:3 }}>
            <div style={{
              fontFamily:"'Syne',sans-serif", fontSize:38, fontWeight:800,
              color:T.hi, lineHeight:1, letterSpacing:"-0.03em",
            }}>{economy.shotsUsed}</div>
            <div style={{
              fontFamily:"'Syne',sans-serif", fontSize:18, fontWeight:700,
              color:T.lo, lineHeight:1,
            }}>/{isPremium ? "∞" : economy.totalAllowed}</div>
          </div>
          <div style={{
            fontFamily:"'Instrument Sans',sans-serif", fontSize:12,
            fontWeight:600, color:T.teal, marginTop:6,
          }}>Shots today</div>
          <div style={{ fontFamily:"'Instrument Sans',sans-serif", fontSize:10, color:T.lo, marginTop:2 }}>
            {isPremium
              ? "unlimited access"
              : shotsLeft === 0
                ? "out of shots"
                : `${shotsLeft} more available`}
          </div>
        </Card>

        {/* Best this week — sparkline driven by real recent scores */}
        <Card style={{ padding:"16px 18px" }}>
          <div style={{ height:18, marginBottom:8, position:"relative" }}>
            <svg width="100%" height="18" viewBox="0 0 80 18" preserveAspectRatio="none"
              style={{ position:"absolute", inset:0 }}>
              <defs>
                <linearGradient id="sparkFill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%"   stopColor="rgba(255,77,0,0.28)"/>
                  <stop offset="100%" stopColor="rgba(255,77,0,0)"/>
                </linearGradient>
              </defs>
              {(() => {
                // Build sparkline from last 7 scores (or fewer for new users)
                const recent = (economy.weekScores || []).slice(-7);
                if (recent.length === 0) return null;
                // Map scores to SVG coords. y inverted (lower = higher score).
                const xs = recent.map((_, i) => recent.length === 1 ? 40 : (i / (recent.length - 1)) * 80);
                const ys = recent.map(s => 16 - ((s.score - 55) / 45) * 14);
                const pts = xs.map((x, i) => `${x},${ys[i]}`).join(" ");
                const path = `M0,18 L${pts.replace(/ /g, " L")} L80,18 Z`;
                return (
                  <>
                    <path d={path} fill="url(#sparkFill)"/>
                    <polyline points={pts}
                      fill="none" stroke={T.orange} strokeWidth="1.4"
                      strokeLinecap="round" strokeLinejoin="round"
                      style={{ filter:`drop-shadow(0 0 2px ${T.orange})` }}
                    />
                    <circle cx={xs[xs.length-1]} cy={ys[ys.length-1]} r="1.8" fill={T.orange}
                      style={{ filter:`drop-shadow(0 0 3px ${T.orange})` }}/>
                  </>
                );
              })()}
            </svg>
          </div>
          <div style={{
            fontFamily:"'Syne',sans-serif", fontSize:38, fontWeight:800,
            color:T.hi, lineHeight:1, letterSpacing:"-0.03em",
          }}>{economy.weekBestScore || "—"}</div>
          <div style={{
            fontFamily:"'Instrument Sans',sans-serif", fontSize:12,
            fontWeight:600, color:T.orange, marginTop:6,
          }}>Best this week</div>
          <div style={{
            fontFamily:"'Instrument Sans',sans-serif", fontSize:10, color:T.lo, marginTop:2,
          }}>
            {economy.bestScore > economy.weekBestScore
              ? <>All-time: <span style={{ color:T.teal, fontWeight:600 }}>{economy.bestScore}</span></>
              : economy.weekScores.length === 0
                ? "Take a shot to start tracking"
                : "Your best so far"}
          </div>
        </Card>
      </div>

      {/* ── Nav cards with custom SVG icons ── */}
      <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10, ...s(0.18) }}>

        <Card onClick={() => onNav("leaderboard")} style={{ padding:"16px 18px" }}>
          <div style={{
            width:34, height:34, borderRadius:10,
            background:T.orangeFog, border:`1px solid ${T.orangeRim}`,
            display:"flex", alignItems:"center", justifyContent:"center",
            marginBottom:12,
          }}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none"
              stroke={T.orange} strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
              <rect x="18" y="3"  width="4" height="18" rx="1"/>
              <rect x="10" y="8"  width="4" height="13" rx="1"/>
              <rect x="2"  y="13" width="4" height="8"  rx="1"/>
            </svg>
          </div>
          <div style={{
            fontFamily:"'Syne',sans-serif", fontSize:14, fontWeight:700,
            color:T.hi, marginBottom:3,
          }}>Leaderboard</div>
          <div style={{
            fontFamily:"'Instrument Sans',sans-serif", fontSize:11,
            color:T.lo, marginBottom:14,
          }}>You're <span style={{ color:T.orange, fontWeight:600 }}>#4</span> today</div>
          <div style={{
            display:"flex", alignItems:"center", gap:4,
            fontFamily:"'Instrument Sans',sans-serif", fontSize:11,
            fontWeight:600, color:T.orange,
          }}>
            View
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none"
              stroke="currentColor" strokeWidth="2.6" strokeLinecap="round">
              <path d="M5 12h14M12 5l7 7-7 7"/>
            </svg>
          </div>
        </Card>

        <Card onClick={() => onNav("history")} style={{ padding:"16px 18px" }}>
          <div style={{
            width:34, height:34, borderRadius:10,
            background:T.tealFog, border:`1px solid ${T.tealRim}`,
            display:"flex", alignItems:"center", justifyContent:"center",
            marginBottom:12,
          }}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none"
              stroke={T.teal} strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="9"/>
              <polyline points="12,7 12,12 15.5,14"/>
            </svg>
          </div>
          <div style={{
            fontFamily:"'Syne',sans-serif", fontSize:14, fontWeight:700,
            color:T.hi, marginBottom:3,
          }}>History</div>
          <div style={{
            fontFamily:"'Instrument Sans',sans-serif", fontSize:11,
            color:T.lo, marginBottom:14,
          }}><span style={{ color:T.teal, fontWeight:600 }}>14 shots</span> logged</div>
          <div style={{
            display:"flex", alignItems:"center", gap:4,
            fontFamily:"'Instrument Sans',sans-serif", fontSize:11,
            fontWeight:600, color:T.orange,
          }}>
            View
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none"
              stroke="currentColor" strokeWidth="2.6" strokeLinecap="round">
              <path d="M5 12h14M12 5l7 7-7 7"/>
            </svg>
          </div>
        </Card>
      </div>
    </div>
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// SHOT SCREEN
// ─────────────────────────────────────────────────────────────────────────────
const ShotScreen = ({ onNav, economy, submitShot }) => {
  const s = useStagger();
  const [mode, setMode] = useState("text");
  const [text, setText] = useState("");
  const [focused, setFocused] = useState(false);
  // Tracks whether photo/voice has "content" (simulated capture for demo).
  // In production: replace with real camera/recorder result.
  const [photoCaptured, setPhotoCaptured] = useState(false);
  const [voiceCaptured, setVoiceCaptured] = useState(false);
  const chars = text.length;

  // Autofocus textarea when text mode is selected — removes a tap and signals
  // "this is where you go" the moment the screen lands.
  const textareaRef = useRef(null);
  useEffect(() => {
    if (mode === "text" && textareaRef.current) {
      // Delay slightly to let entry animation settle before keyboard pops
      const id = setTimeout(() => textareaRef.current?.focus(), 280);
      return () => clearTimeout(id);
    }
  }, [mode]);

  // Ready logic — submission requires actual content in the chosen mode
  const ready =
    (mode === "text"  && chars >= 1) ||
    (mode === "photo" && photoCaptured) ||
    (mode === "voice" && voiceCaptured);

  // Progress signal for text mode — aim is 80–300 chars, but ANY chars allow submit
  const textTier = chars === 0 ? 0 : chars < 30 ? 1 : chars < 80 ? 2 : chars <= 300 ? 3 : 4;
  const tierLabel = ["Start writing…", "Keep going", "Almost there", "Looking good", "Wrap it up"][textTier];
  const tierColor = textTier === 0 ? T.lo : textTier >= 3 ? T.teal : T.orange;

  // Today's prompt — same for every user on the same day (deterministic)
  const promptObj = promptForDate(todayKey());
  const PROMPT = promptObj.text;
  const PROMPT_TAGS = promptObj.tags;
  const MODES  = [
    { id:"photo", icon:"📸", label:"Photo" },
    { id:"voice", icon:"🎙",  label:"Voice" },
    { id:"text",  icon:"✍️",  label:"Text" },
  ];

  // Submit handler — async because text mode needs real AI scoring.
  // Photo/voice paths submit immediately with a simulated score (Gemini Vision
  // / audio scoring would go here in a future revision).
  const handleSubmit = () => {
    if (!ready) return;
    const content = mode === "text" ? text.trim() : "";
    submitShot({ mode, prompt: PROMPT, text: content });
  };

  return (
    <div style={{ padding:"0 20px 24px" }}>

      <div style={{ display:"flex", alignItems:"center", gap:12,
        paddingTop:22, marginBottom:24, ...s(0) }}>
        <BackBtn onClick={() => onNav("home")}/>
        <div style={{ flex:1 }}>
          <div style={{ fontFamily:"'Syne',sans-serif", fontWeight:700, fontSize:16, color:T.hi }}>
            New Shot
          </div>
          <div style={{ fontFamily:"'Instrument Sans',sans-serif", fontSize:11, color:T.lo, marginTop:1 }}>
            {economy.isPremium
              ? `Shot ${economy.shotsUsed + 1} · Unlimited`
              : `Shot ${economy.shotsUsed + 1} of ${economy.totalAllowed} today`}
          </div>
        </div>
        <Tag>60s</Tag>
      </div>

      {/* Prompt */}
      <div style={{
        background:`linear-gradient(${T.card},${T.card}) padding-box,
                    linear-gradient(145deg, rgba(255,77,0,0.26) 0%, rgba(255,77,0,0.04) 60%) border-box`,
        border:"1px solid transparent",
        borderRadius:20, padding:"22px 22px",
        marginBottom:14, position:"relative", overflow:"hidden",
        ...s(0.07),
      }}>
        <div style={{
          position:"absolute", top:-55, right:-55, width:190, height:190,
          background:"radial-gradient(circle, rgba(255,77,0,0.08) 0%, transparent 65%)",
          pointerEvents:"none",
        }}/>
        <Label color={T.orange} style={{ marginBottom:12 }}>Today's Prompt</Label>
        <div style={{
          fontFamily:"'Syne',sans-serif", fontSize:17, fontWeight:700,
          color:T.hi, lineHeight:1.48, letterSpacing:"-0.012em", marginBottom:16,
        }}>{PROMPT}</div>
        <div style={{ display:"flex", gap:6, flexWrap:"wrap" }}>
          {PROMPT_TAGS.map(t => (
            <span key={t} style={{
              fontFamily:"'Instrument Sans',sans-serif", fontSize:10, color:T.lo,
              background:T.surface, border:`1px solid ${T.border}`,
              borderRadius:99, padding:"3px 9px", letterSpacing:"0.04em",
            }}>#{t}</span>
          ))}
        </div>
      </div>

      {/* Mode toggle */}
      <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:8, marginBottom:14, ...s(0.13) }}>
        {MODES.map(({ id, icon, label }) => {
          const active = mode === id;
          return (
            <button key={id} onClick={() => setMode(id)} style={{
              background: active
                ? `linear-gradient(${T.card},${T.card}) padding-box,
                   linear-gradient(145deg, rgba(255,77,0,0.30) 0%, rgba(255,77,0,0.05) 100%) border-box`
                : T.card,
              border:`1px solid ${active ? "transparent" : T.border}`,
              borderRadius:16, padding:"14px 8px", cursor:"pointer",
              transform: active ? "scale(1.025)" : "scale(1)",
              transition:`all 0.22s ${EXPO}`,
              textAlign:"center",
            }}>
              <div style={{ fontSize:20, marginBottom:5 }}>{icon}</div>
              <div style={{
                fontFamily:"'Syne',sans-serif", fontSize:12, fontWeight:700,
                color: active ? T.orange : T.mid,
                transition:"color 0.18s",
              }}>{label}</div>
            </button>
          );
        })}
      </div>

      {/* Input */}
      {mode === "text" && (
        <div style={{
          background: focused
            ? `linear-gradient(${T.card},${T.card}) padding-box,
               linear-gradient(140deg, ${T.orangeRim} 0%, rgba(255,77,0,0.04) 100%) border-box`
            : T.card,
          border:`1px solid ${focused ? "transparent" : T.border}`,
          borderRadius:16, overflow:"hidden", marginBottom:16,
          transition:`background 0.25s ease, border-color 0.2s ease`,
          boxShadow: focused ? `0 0 0 4px rgba(255,77,0,0.06)` : "none",
          ...s(0.17),
        }}>
          <textarea
            ref={textareaRef}
            value={text}
            onChange={e => setText(e.target.value)}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            placeholder="Start writing… describe what you saw, what you felt. Be specific."
            aria-label="Your shot text"
            maxLength={500}
            style={{
              width:"100%", minHeight:150, background:"transparent",
              border:"none", outline:"none", resize:"none",
              fontFamily:"'Instrument Sans',sans-serif", fontSize:15,
              lineHeight:1.7, color:T.hi, padding:"18px 20px",
            }}
          />

          {/* Progress strip — visual feedback that responds to length */}
          <div style={{
            height:2, background:T.border, position:"relative",
          }}>
            <div style={{
              position:"absolute", inset:0, width: `${Math.min(100, (chars / 200) * 100)}%`,
              background: textTier === 0
                ? "transparent"
                : `linear-gradient(90deg, ${T.orange}, ${textTier >= 3 ? T.teal : T.orangeHi})`,
              boxShadow: textTier > 0 ? `0 0 6px rgba(255,77,0,0.4)` : "none",
              transition:`width 0.35s ${EXPO}, background 0.3s`,
            }}/>
          </div>

          {/* Footer with character count + tier label */}
          <div style={{
            display:"flex", justifyContent:"space-between", alignItems:"center",
            padding:"10px 20px 12px",
          }}>
            <span style={{
              fontFamily:"'Instrument Sans',sans-serif", fontSize:10, fontWeight:600,
              color: tierColor,
              letterSpacing:"0.05em", textTransform:"uppercase",
              transition:"color 0.2s",
              display:"flex", alignItems:"center", gap:6,
            }}>
              {textTier > 0 && (
                <span style={{
                  width:5, height:5, borderRadius:"50%", background:tierColor,
                  boxShadow:`0 0 4px ${tierColor}`,
                }}/>
              )}
              {tierLabel}
            </span>
            <span style={{
              fontFamily:"'Instrument Sans',sans-serif", fontSize:10, color:T.lo,
              fontVariantNumeric:"tabular-nums",
            }}>
              <span style={{ color: chars >= 1 ? T.mid : T.lo }}>{chars}</span>
              <span style={{ color:T.lo }}> / 500</span>
            </span>
          </div>
        </div>
      )}

      {mode === "photo" && (
        <div onClick={() => setPhotoCaptured(true)} style={{
          background: photoCaptured ? T.orangeFog : T.card,
          border:`1.5px ${photoCaptured ? "solid" : "dashed"} ${photoCaptured ? T.orangeRim : T.borderMd}`,
          borderRadius:16, minHeight:148,
          display:"flex", flexDirection:"column",
          alignItems:"center", justifyContent:"center",
          gap:10, marginBottom:16, cursor:"pointer",
          transition:`all 0.2s ${EXPO}`,
          ...s(0.17),
        }}>
          <div style={{ fontSize:28 }}>{photoCaptured ? "✓" : "📷"}</div>
          <div style={{
            fontFamily:"'Syne',sans-serif", fontSize:14, fontWeight:700,
            color: photoCaptured ? T.orange : T.mid,
          }}>
            {photoCaptured ? "Photo captured" : "Take a photo"}
          </div>
          <div style={{ fontFamily:"'Instrument Sans',sans-serif", fontSize:11, color:T.lo }}>
            {photoCaptured ? "tap to retake" : "or choose from library"}
          </div>
        </div>
      )}

      {mode === "voice" && (
        <div style={{
          background: voiceCaptured ? T.orangeFog : T.card,
          border:`1px solid ${voiceCaptured ? T.orangeRim : T.border}`,
          borderRadius:16, minHeight:148,
          display:"flex", flexDirection:"column",
          alignItems:"center", justifyContent:"center",
          gap:14, marginBottom:16,
          transition:`all 0.2s ${EXPO}`,
          ...s(0.17),
        }}>
          <div
            onClick={() => setVoiceCaptured(true)}
            style={{
              width:66, height:66, borderRadius:"50%", flexShrink:0,
              background: voiceCaptured ? T.orange : T.orangeFog,
              border:`1.5px solid ${T.orange}`,
              display:"flex", alignItems:"center", justifyContent:"center",
              fontSize:26, cursor:"pointer",
              animation: voiceCaptured ? "none" : "pulse 2.2s ease-in-out infinite",
            }}>{voiceCaptured ? "✓" : "🎙"}</div>
          <div style={{
            fontFamily:"'Instrument Sans',sans-serif", fontSize:13,
            color: voiceCaptured ? T.orange : T.mid,
            fontWeight: voiceCaptured ? 600 : 400,
          }}>
            {voiceCaptured ? "Voice recorded · tap to redo" : "Tap to record"}
          </div>
        </div>
      )}

      <div style={s(0.21)}>
        <PrimaryBtn onClick={handleSubmit} disabled={!ready}>
          Submit Shot
          <Arrow opacity={0.65}/>
        </PrimaryBtn>
      </div>
    </div>
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// SCORE RING — cinematic 3-phase reveal:
//   Phase 1 (0–650ms):  Anticipation — analyzing spinner inside empty ring
//   Phase 2 (650ms–2.2s): Arc draws + number counts up with thump
//   Phase 3 (2.2s+):    Settled — radial pulse + grade label appears
// ─────────────────────────────────────────────────────────────────────────────
const ScoreRing = ({ score, loading = false }) => {
  const [phase, setPhase] = useState(0); // 0 analyzing, 1 revealing, 2 settled
  const [n, setN]         = useState(0);
  const R     = 74;
  const CIRC  = 2 * Math.PI * R;
  const color = score >= 85 ? T.teal : score >= 65 ? T.orange : "#E05050";
  const colorRGB = color === T.teal ? "0,181,160" : color === T.orange ? "255,77,0" : "224,80,80";

  // Phase progression — but never advance while loading is true.
  // When loading flips to false, the timers start from that moment.
  useEffect(() => {
    if (loading) {
      // Reset to analyzing phase while we wait for AI scoring
      setPhase(0);
      setN(0);
      return;
    }
    const t1 = setTimeout(() => setPhase(1), 650);   // analyzing → revealing
    const t2 = setTimeout(() => setPhase(2), 2200);  // revealing → settled
    return () => { clearTimeout(t1); clearTimeout(t2); };
  }, [loading]);

  // Count-up tied to phase 1
  useEffect(() => {
    if (phase < 1) return;
    let cur = 0;
    const total = 1450, tick = 16, inc = score / (total / tick);
    const id = setInterval(() => {
      cur += inc;
      if (cur >= score) { setN(score); clearInterval(id); }
      else setN(Math.floor(cur));
    }, tick);
    return () => clearInterval(id);
  }, [phase, score]);

  const offset = CIRC * (1 - n / 100);

  return (
    <div style={{ position:"relative", width:196, height:196, margin:"0 auto" }}>

      {/* Atmospheric backdrop glow — fades in when revealing */}
      {phase >= 1 && (
        <div style={{
          position:"absolute", inset:-14, borderRadius:"50%", zIndex:0,
          background:`radial-gradient(circle, rgba(${colorRGB},0.13) 0%, transparent 68%)`,
          animation:`in 0.8s ease both`,
        }}/>
      )}

      {/* Expanding ring pulse at settle — creates a "ding" moment */}
      {phase >= 2 && (
        <>
          <div style={{
            position:"absolute", inset:0, borderRadius:"50%", zIndex:0,
            border:`2px solid rgba(${colorRGB},0.5)`,
            animation:`ringPulse 1.1s ${EXPO} both`,
          }}/>
          <div style={{
            position:"absolute", inset:0, borderRadius:"50%", zIndex:0,
            border:`1px solid rgba(${colorRGB},0.3)`,
            animation:`ringPulse 1.4s ${EXPO} 0.15s both`,
          }}/>
        </>
      )}

      <svg width="196" height="196" style={{ transform:"rotate(-90deg)", position:"relative", zIndex:1 }}>
        <circle cx="98" cy="98" r={R} fill="none" stroke={T.border} strokeWidth="9"/>
        <circle
          cx="98" cy="98" r={R} fill="none"
          stroke={color} strokeWidth="9" strokeLinecap="round"
          strokeDasharray={CIRC}
          strokeDashoffset={phase < 1 ? CIRC : offset}
          style={{
            transition:`stroke-dashoffset 1.5s ${EXPO}, stroke 0.3s ease`,
            filter:`drop-shadow(0 0 ${phase >= 2 ? 8 : 5}px ${color})`,
          }}
        />
      </svg>

      {/* Center content */}
      <div style={{
        position:"absolute", inset:0, zIndex:2,
        display:"flex", flexDirection:"column",
        alignItems:"center", justifyContent:"center",
      }}>
        {phase === 0 && (
          // Anticipation spinner — three orbiting dots
          <div style={{
            width:42, height:42, position:"relative",
            animation:"spinSlow 1.2s linear infinite",
          }}>
            {[0, 120, 240].map(deg => (
              <div key={deg} style={{
                position:"absolute", top:"50%", left:"50%",
                width:6, height:6, borderRadius:"50%",
                background:T.orange, marginTop:-3, marginLeft:-3,
                transform:`rotate(${deg}deg) translateX(16px)`,
                opacity: 0.3 + (deg / 360) * 0.7,
              }}/>
            ))}
          </div>
        )}

        {phase >= 1 && (
          <>
            <div style={{
              fontFamily:"'Syne',sans-serif", fontWeight:800, fontSize:58,
              color:T.hi, lineHeight:1, letterSpacing:"-0.04em",
              animation:`thump 0.7s ${EXPO} both`,
            }}>{n}</div>
            <div style={{
              fontFamily:"'Instrument Sans',sans-serif", fontSize:10,
              fontWeight:600, letterSpacing:"0.12em", textTransform:"uppercase",
              color, marginTop:6,
              opacity: phase >= 2 ? 1 : 0,
              transform: phase >= 2 ? "translateY(0)" : "translateY(6px)",
              transition:`all 0.35s ${EXPO}`,
            }}>
              {score >= 85 ? "Excellent" : score >= 65 ? "Good" : "Keep going"}
            </div>
          </>
        )}
      </div>
    </div>
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// RESULT SCREEN — orchestrated reward cascade
//   The whole page is timed against the score reveal:
//     0.0s  Header                  (instant)
//     0.1s  Score ring container    (immediate, then ring runs its own timing)
//     2.2s  Earned badges float in  (synced with ring settle)
//     2.5s  "Personal best" caption
//     2.8s  Rank ladder (the carrot — shows who's just above you)
//     3.1s  Feedback
//     3.4s  Mega CTA appears
// ─────────────────────────────────────────────────────────────────────────────
const ResultScreen = ({ onNav, economy, pendingShot }) => {
  const s = useStagger();
  // Pull live score data from pendingShot. Defaults handle the edge cases
  // where someone navigates directly to /result (deep link, refresh, etc.).
  const SCORE = pendingShot?.score ?? 75;
  const FEEDBACK = pendingShot?.feedback || "A solid effort with room to sharpen.";
  const BREAKDOWN = (pendingShot?.breakdown && pendingShot.breakdown.length > 0)
    ? pendingShot.breakdown
    : [
        { label:"What worked",     note:"Clear voice with a personal angle." },
        { label:"What to sharpen", note:"Trade abstract words for specific images." },
        { label:"Try next time",   note:"End on the strongest detail you wrote." },
      ];
  const LOADING = pendingShot?.loading;

  // Score reveal completes at ~2.2s — most rewards stagger from there
  const REWARD_BASE = 2.2;
  const reward = (offset) => ({
    animation:`celebPop 0.6s ${EXPO} ${REWARD_BASE + offset}s both`,
    opacity: 0, // start hidden; the animation reveals
  });
  const rise = (offset) => ({
    animation:`up 0.55s ${EXPO} ${REWARD_BASE + offset}s both`,
    opacity: 0,
  });

  // Map AI breakdown to pts structure used by the UI
  const pts = BREAKDOWN.slice(0, 3);

  // Rank ladder data — synthetic competitors above and below the user.
  // User's score comes from this round's actual AI score (or fallback).
  // Targets are chosen so the user always has someone 3-6 pts above to chase.
  const userScore = SCORE || 75;
  const ladder = [
    { rank:3, name:"Elena V.", score: Math.min(98, userScore + 4 + (userScore % 3)), target:true },
    { rank:4, name:"You",      score: userScore, isYou:true },
    { rank:5, name:"Arjun P.", score: Math.max(60, userScore - 3) },
  ];

  return (
    <div style={{ padding:"0 20px 24px", position:"relative" }}>

      {/* Header */}
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-end",
        paddingTop:22, marginBottom:24, ...s(0) }}>
        <div>
          <Label style={{ marginBottom:5 }}>Shot #{economy.shotsUsed} · Today</Label>
          <div style={{ fontFamily:"'Syne',sans-serif", fontWeight:700, fontSize:16, color:T.hi }}>
            {LOADING ? "Scoring…" : "Your Score"}
          </div>
        </div>
      </div>

      {/* ── Score Ring + earned badges ── */}
      <div style={{ textAlign:"center", marginBottom:12, position:"relative", ...s(0.05) }}>
        <ScoreRing score={SCORE} loading={LOADING}/>

        {/* Floating score-band badge — green for excellent, orange for good */}
        {!LOADING && (
          <div style={{
            position:"absolute", top:18, right:"calc(50% - 130px)",
            fontFamily:"'Syne',sans-serif", fontWeight:800, fontSize:14,
            color: SCORE >= 85 ? T.teal : T.orange,
            textShadow:`0 0 16px ${SCORE >= 85 ? "rgba(0,181,160,0.6)" : "rgba(255,77,0,0.5)"}`,
            letterSpacing:"0.06em", textTransform:"uppercase",
            ...reward(0.05),
          }}>{SCORE >= 90 ? "Brilliant" : SCORE >= 80 ? "Strong" : SCORE >= 70 ? "Solid" : "Keep going"}</div>
        )}

        {/* Streak indicator — uses live streak value */}
        {!LOADING && economy.streak > 0 && (
          <div style={{
            position:"absolute", top:62, left:"calc(50% - 138px)",
            display:"flex", alignItems:"center", gap:5,
            padding:"4px 10px", borderRadius:99,
            background:T.orangeFog, border:`1px solid ${T.orangeRim}`,
            ...reward(0.2),
          }}>
            <span style={{ fontSize:11 }}>🔥</span>
            <span style={{
              fontFamily:"'Instrument Sans',sans-serif", fontSize:9, fontWeight:700,
              color:T.orange, letterSpacing:"0.07em", textTransform:"uppercase",
            }}>Day {economy.streak}</span>
          </div>
        )}

        {/* Achievement caption — adapts to whether this is a personal best */}
        <div style={{
          fontFamily:"'Syne',sans-serif", fontSize:15, fontWeight:700,
          color:T.hi, marginTop:18, ...rise(0.3),
        }}>
          {LOADING
            ? "Reading your shot…"
            : SCORE >= 90
              ? "Excellent work 🎯"
              : SCORE === economy.personalBest && economy.streak === economy.personalBest
                ? "New streak record! 🔥"
                : SCORE >= 80
                  ? "Sharp shot 📐"
                  : "Shot logged ✓"}
        </div>
        <div style={{
          fontFamily:"'Instrument Sans',sans-serif", fontSize:13, color:T.mid,
          marginTop:3, ...rise(0.38),
        }}>
          {LOADING
            ? "Our coach is reading the work."
            : `Streak: ${economy.streak} day${economy.streak === 1 ? "" : "s"} · ${economy.shotsUsed} shot${economy.shotsUsed === 1 ? "" : "s"} today`}
        </div>
      </div>

      <Divider style={{ margin:"22px 0", ...rise(0.45) }}/>

      {/* ── Rank Ladder (the carrot — next target visible) ── */}
      <div style={{ marginBottom:14, ...rise(0.52) }}>
        <div style={{ display:"flex", justifyContent:"space-between",
          alignItems:"center", marginBottom:10 }}>
          <Label>Today's Leaderboard</Label>
          <button onClick={() => onNav("leaderboard")} style={{
            fontFamily:"'Instrument Sans',sans-serif", fontSize:10, fontWeight:600,
            color:T.mid, background:"none", border:"none", cursor:"pointer",
            letterSpacing:"0.06em", textTransform:"uppercase",
          }}>Full board ›</button>
        </div>

        <div style={{ display:"flex", flexDirection:"column", gap:5 }}>
          {ladder.map(p => (
            <div key={p.rank} style={{
              background: p.isYou
                ? `linear-gradient(${T.card},${T.card}) padding-box,
                   linear-gradient(140deg, rgba(255,77,0,0.28) 0%, rgba(255,77,0,0.05) 100%) border-box`
                : p.target ? T.card : T.surface,
              border:`1px solid ${
                p.isYou ? "transparent" :
                p.target ? "rgba(0,181,160,0.20)" :
                T.border
              }`,
              borderRadius:12, padding:"10px 14px",
              display:"flex", alignItems:"center", gap:11,
              position:"relative", overflow:"hidden",
            }}>
              {/* Target chase indicator */}
              {p.target && (
                <div style={{
                  position:"absolute", left:0, top:0, bottom:0, width:3,
                  background:T.teal,
                  boxShadow:`0 0 8px ${T.teal}`,
                }}/>
              )}

              <div style={{
                fontFamily:"'Syne',sans-serif", fontSize:11, fontWeight:700,
                color: p.target ? T.teal : p.isYou ? T.orange : T.lo,
                width:14, textAlign:"center", flexShrink:0,
              }}>{p.rank}</div>

              <div style={{
                width:26, height:26, borderRadius:8, flexShrink:0,
                background: p.isYou ? T.orangeFog : p.target ? T.tealFog : T.bg,
                border:`1px solid ${p.isYou ? T.orangeRim : p.target ? T.tealRim : T.border}`,
                display:"flex", alignItems:"center", justifyContent:"center",
                fontFamily:"'Syne',sans-serif", fontSize:11, fontWeight:800,
                color: p.isYou ? T.orange : p.target ? T.teal : T.mid,
              }}>{p.name[0]}</div>

              <div style={{ flex:1 }}>
                <div style={{
                  fontFamily:"'Syne',sans-serif", fontSize:12, fontWeight:700,
                  color: p.isYou ? T.orange : T.hi,
                }}>
                  {p.name}
                  {p.target && (
                    <span style={{
                      fontFamily:"'Instrument Sans',sans-serif", fontWeight:600,
                      fontSize:9, color:T.teal, marginLeft:6,
                      letterSpacing:"0.06em", textTransform:"uppercase",
                    }}>{p.score - userScore} pts away</span>
                  )}
                </div>
              </div>

              <div style={{
                fontFamily:"'Syne',sans-serif", fontSize:16, fontWeight:800,
                color: p.isYou ? T.orange : p.target ? T.teal : T.mid,
                lineHeight:1,
              }}>{p.score}</div>
            </div>
          ))}
        </div>
      </div>

      {/* ── Feedback — condensed and forward-looking ── */}
      <Card style={{ marginBottom:14, ...rise(0.62) }} hover={false}>
        <Label style={{ marginBottom:14 }}>AI Feedback</Label>

        <div style={{ display:"flex", gap:14, marginBottom:16 }}>
          <div style={{
            width:2, flexShrink:0, borderRadius:99,
            background:`linear-gradient(180deg, ${T.orange} 0%, transparent 100%)`,
          }}/>
          <div style={{
            fontFamily:"'Instrument Sans',sans-serif", fontSize:13,
            lineHeight:1.68, color:T.mid, fontStyle:"italic",
          }}>
            {LOADING
              ? "Reading your shot…"
              : `"${FEEDBACK.replace(/^["']|["']$/g, "")}"`}
          </div>
        </div>

        <div style={{ display:"flex", flexDirection:"column", gap:11 }}>
          {pts.map(({ label, note }, i) => (
            <div key={label} style={{ display:"flex", gap:11 }}>
              <div style={{
                width:18, height:18, borderRadius:5, flexShrink:0,
                background:T.orangeFog, border:`1px solid ${T.orangeRim}`,
                display:"flex", alignItems:"center", justifyContent:"center",
                fontFamily:"'Syne',sans-serif", fontSize:9, fontWeight:800,
                color:T.orange, marginTop:1,
              }}>{i+1}</div>
              <div>
                <div style={{
                  fontFamily:"'Syne',sans-serif", fontSize:12, fontWeight:700,
                  color:T.hi, marginBottom:2,
                }}>{label}</div>
                <div style={{
                  fontFamily:"'Instrument Sans',sans-serif", fontSize:12,
                  color:T.lo, lineHeight:1.55,
                }}>{note}</div>
              </div>
            </div>
          ))}
        </div>
      </Card>

      {/* ── THE MEGA CTA ──
          Cinematic: shimmer + breathing + outer aura ring + integrated context.
          This is the loop's beating heart — every detail engineered to make
          tapping it feel inevitable. */}
      <div style={{ position:"relative", ...rise(0.72) }}>
        {/* Outer aura — radial glow that lives outside the button bounds */}
        <div style={{
          position:"absolute", inset:-8, borderRadius:28,
          background:"radial-gradient(ellipse at center, rgba(255,77,0,0.20) 0%, transparent 70%)",
          pointerEvents:"none", zIndex:0,
          animation:"breathe 2.8s ease-in-out infinite",
        }}/>

        <button
          onClick={() => onNav(economy.canTakeShot ? "shot" : "outOfShots")}
          className="megaBtn"
          aria-label="Take another shot"
          style={{
            width:"100%", border:"none", cursor:"pointer", padding:0,
            borderRadius:22, position:"relative", zIndex:1,
            boxShadow:`
              0 0 0 1px rgba(255,255,255,0.05),
              0 14px 44px rgba(255,77,0,0.48),
              0 4px 14px rgba(255,77,0,0.28),
              inset 0 1px 0 rgba(255,255,255,0.18),
              inset 0 -2px 0 rgba(0,0,0,0.15)
            `,
            overflow:"hidden",
            transition:`transform 0.15s ${EXPO}`,
          }}
        >
          {/* Top-edge highlight — gives the button a "lit from above" feel */}
          <div style={{
            position:"absolute", top:0, left:"15%", right:"15%", height:1,
            background:"linear-gradient(90deg, transparent, rgba(255,255,255,0.45), transparent)",
            zIndex:3, pointerEvents:"none",
          }}/>

          {/* Inner content — taller and more confident */}
          <div style={{
            padding:"24px 26px 22px",
            display:"flex", flexDirection:"column", alignItems:"center", gap:7,
            position:"relative", zIndex:2,
          }}>
            {/* Headline row */}
            <div style={{
              display:"flex", alignItems:"center", gap:12,
              fontFamily:"'Syne',sans-serif", fontWeight:800, fontSize:23,
              color:"#fff", letterSpacing:"-0.01em",
              textShadow:"0 2px 10px rgba(0,0,0,0.30)",
            }}>
              <span style={{
                fontSize:22,
                filter:"drop-shadow(0 1px 3px rgba(0,0,0,0.4))",
                display:"inline-block",
                animation:"streakPop 1.8s ease-in-out infinite",
              }}>⚡</span>
              Another Shot?
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none"
                stroke="rgba(255,255,255,0.92)" strokeWidth="2.7" strokeLinecap="round">
                <path d="M5 12h14M12 5l7 7-7 7"/>
              </svg>
            </div>

            {/* Integrated context chips — two pieces of stake info inside the button */}
            <div style={{
              display:"flex", alignItems:"center", gap:10,
              fontFamily:"'Instrument Sans',sans-serif", fontSize:11, fontWeight:600,
              color:"rgba(255,255,255,0.88)", letterSpacing:"0.02em",
            }}>
              <span style={{
                padding:"3px 9px", borderRadius:99,
                background:"rgba(0,0,0,0.22)",
                border:"1px solid rgba(255,255,255,0.12)",
                backdropFilter:"blur(4px)",
              }}>{ladder[0].score - userScore} pts to #3</span>
              <span style={{ color:"rgba(255,255,255,0.45)", fontSize:10 }}>·</span>
              <span style={{
                padding:"3px 9px", borderRadius:99,
                background:"rgba(0,0,0,0.22)",
                border:"1px solid rgba(255,255,255,0.12)",
                backdropFilter:"blur(4px)",
              }}>
                {economy.isPremium
                  ? "∞ shots"
                  : economy.shotsLeft === 0
                    ? "0 left — see options"
                    : `${economy.shotsLeft} shot${economy.shotsLeft === 1 ? "" : "s"} left`}
              </span>
            </div>
          </div>
        </button>

        {/* Watch Ad row for non-premium users — sits below CTA, offers more shots */}
        {!economy.isPremium && (
          <div style={{ marginTop:10, position:"relative", zIndex:1 }}>
            <WatchAdButton
              onClick={() => onNav("ad")}
              disabled={!economy.canWatchAd}
              compact
            />
          </div>
        )}

        {/* Stake reminders under the button */}
        <div style={{
          display:"flex", justifyContent:"center", gap:18, marginTop:14,
          position:"relative", zIndex:1,
        }}>
          <div style={{
            display:"flex", alignItems:"center", gap:5,
            fontFamily:"'Instrument Sans',sans-serif", fontSize:10, fontWeight:600,
            color:T.mid, letterSpacing:"0.04em",
          }}>
            <span style={{
              width:5, height:5, borderRadius:"50%", background:T.teal,
              boxShadow:`0 0 6px ${T.teal}`,
            }}/>
            {economy.bestScore > 0 ? `Beat your ${economy.bestScore} high` : "Set a new high"}
          </div>
          <div style={{ width:1, background:T.border }}/>
          <div style={{
            display:"flex", alignItems:"center", gap:5,
            fontFamily:"'Instrument Sans',sans-serif", fontSize:10, fontWeight:600,
            color:T.mid, letterSpacing:"0.04em",
          }}>
            <span style={{
              width:5, height:5, borderRadius:"50%", background:T.orange,
              boxShadow:`0 0 6px ${T.orange}`,
            }}/>
            Climb to #{Math.max(1, ladder[0].rank)}
          </div>
        </div>
      </div>
    </div>
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// LEADERBOARD SCREEN
// ─────────────────────────────────────────────────────────────────────────────
const LeaderboardScreen = ({ onNav, economy }) => {
  const s = useStagger();
  const [tab, setTab] = useState("today");

  // Synthetic competitor pool — these are placeholder bots until the app
  // has a real backend with social leaderboards. The user's row is inserted
  // dynamically based on their real score + streak, then sorted by score.
  const userScore  = (economy?.weekBestScore || economy?.bestScore || 0) || 75;
  const userStreak = economy?.streak || 0;
  const competitors = [
    { name:"Marcus R.",  score:97, streak:28, change:"+2" },
    { name:"Sora K.",    score:94, streak:15, change:"—"  },
    { name:"Elena V.",   score:92, streak:42, change:"+1" },
    { name:"Arjun P.",   score:86, streak:9,  change:"-1" },
    { name:"Claire M.",  score:83, streak:7,  change:"—"  },
    { name:"David L.",   score:81, streak:4,  change:"+2" },
    { name:"Yuki T.",    score:79, streak:21, change:"-2" },
  ];

  // Insert "You" and sort the whole field by score (descending). Then assign
  // ranks. This way the user moves up or down based on their actual best score.
  const players = [...competitors, { name:"You", score:userScore, streak:userStreak, change:"+0", isYou:true }]
    .sort((a, b) => b.score - a.score)
    .map((p, i) => ({ ...p, rank: i + 1 }));

  const me     = players.find(p => p.isYou);
  const target = players.find(p => p.rank === me.rank - 1);
  // gap is undefined when user is #1 — handled in the JSX below
  const gap    = target ? target.score - me.score : 0;

  const changeColor = c => c.startsWith("+") ? T.teal : c === "—" ? T.lo : "#E05050";

  // Status pill — only shown for noteworthy rows
  const statusFor = (p) => {
    if (p.streak >= 25) return { text:"Hot streak", color:T.orange, dot:T.orange };
    const n = parseInt(p.change);
    if (!isNaN(n) && n >= 3) return { text:"Climbing", color:T.teal, dot:T.teal };
    return null;
  };

  return (
    <div style={{ padding:"0 20px 24px" }}>

      {/* Header */}
      <div style={{ display:"flex", alignItems:"center", gap:12,
        paddingTop:22, marginBottom:22, ...s(0) }}>
        <BackBtn onClick={() => onNav("home")}/>
        <div style={{ flex:1 }}>
          <div style={{ fontFamily:"'Syne',sans-serif", fontWeight:700, fontSize:16, color:T.hi }}>
            Leaderboard
          </div>
          <div style={{ fontFamily:"'Instrument Sans',sans-serif", fontSize:11, color:T.lo, marginTop:1 }}>
            Updated every hour
          </div>
        </div>
        <div style={{
          fontFamily:"'Instrument Sans',sans-serif", fontSize:10, color:T.lo,
          letterSpacing:"0.07em", textTransform:"uppercase",
          display:"flex", alignItems:"center", gap:5,
        }}>
          <span style={{
            width:5, height:5, borderRadius:"50%", background:T.teal,
            animation:"streakPop 1.6s ease-in-out infinite",
          }}/>
          Live
        </div>
      </div>

      {/* Tab bar */}
      <div style={{
        display:"grid", gridTemplateColumns:"1fr 1fr 1fr",
        background:T.surface, border:`1px solid ${T.border}`,
        borderRadius:14, padding:4, gap:3,
        marginBottom:16, ...s(0.07),
      }}>
        {["today","week","all-time"].map(t => {
          const active = tab === t;
          return (
            <button key={t} onClick={() => setTab(t)} style={{
              padding:"9px 6px", borderRadius:11, border:"none", cursor:"pointer",
              background: active ? T.card : "transparent",
              fontFamily:"'Syne',sans-serif", fontSize:11, fontWeight:700,
              color: active ? T.hi : T.lo,
              transition:"all 0.18s ease",
              letterSpacing:"0.02em",
            }}>
              {t === "all-time" ? "All Time" : t[0].toUpperCase() + t.slice(1)}
            </button>
          );
        })}
      </div>

      {/* ── #1 Champion Hero Card ── */}
      <div style={{
        background:`linear-gradient(${T.card},${T.card}) padding-box,
                    linear-gradient(135deg,
                      rgba(194,160,48,0.45) 0%,
                      rgba(194,160,48,0.12) 50%,
                      rgba(194,160,48,0.05) 100%
                    ) border-box`,
        border:"1px solid transparent",
        borderRadius:18, padding:"16px 18px", marginBottom:10,
        position:"relative", overflow:"hidden",
        ...s(0.11),
      }}>
        {/* Gold ambient glow */}
        <div style={{
          position:"absolute", top:-50, right:-50, width:180, height:180,
          background:"radial-gradient(circle, rgba(194,160,48,0.12) 0%, transparent 65%)",
          pointerEvents:"none",
        }}/>

        <div style={{ display:"flex", alignItems:"center", gap:14, position:"relative" }}>
          {/* Avatar with gold rim + crown */}
          <div style={{ position:"relative", flexShrink:0 }}>
            <div style={{
              width:50, height:50, borderRadius:14,
              background:`linear-gradient(135deg, rgba(194,160,48,0.18) 0%, rgba(194,160,48,0.04) 100%)`,
              border:`1.5px solid rgba(194,160,48,0.45)`,
              display:"flex", alignItems:"center", justifyContent:"center",
              fontFamily:"'Syne',sans-serif", fontSize:18, fontWeight:800,
              color:T.gold,
              boxShadow:`0 0 14px rgba(194,160,48,0.18)`,
            }}>M</div>
            {/* Crown badge */}
            <div style={{
              position:"absolute", top:-8, right:-8,
              width:20, height:20, borderRadius:"50%",
              background:T.card, border:`1px solid rgba(194,160,48,0.4)`,
              display:"flex", alignItems:"center", justifyContent:"center",
              fontSize:11,
            }}>👑</div>
          </div>

          <div style={{ flex:1, minWidth:0 }}>
            <div style={{
              fontFamily:"'Instrument Sans',sans-serif", fontSize:9, fontWeight:700,
              color:T.gold, letterSpacing:"0.14em", textTransform:"uppercase",
              marginBottom:3,
            }}>Champion · Rank 1</div>
            <div style={{
              fontFamily:"'Syne',sans-serif", fontSize:18, fontWeight:800,
              color:T.hi, letterSpacing:"-0.005em",
            }}>Marcus R.</div>
            <div style={{
              fontFamily:"'Instrument Sans',sans-serif", fontSize:11, color:T.mid,
              marginTop:2, display:"flex", alignItems:"center", gap:8,
            }}>
              <span>🔥 28 day streak</span>
              <span style={{ width:3, height:3, borderRadius:"50%", background:T.lo }}/>
              <span style={{ color:T.teal, fontWeight:600 }}>+2 today</span>
            </div>
          </div>

          <div style={{ textAlign:"right", flexShrink:0 }}>
            <div style={{
              fontFamily:"'Syne',sans-serif", fontSize:34, fontWeight:800,
              color:T.gold, lineHeight:1, letterSpacing:"-0.03em",
              textShadow:`0 0 14px rgba(194,160,48,0.35)`,
            }}>97</div>
          </div>
        </div>
      </div>

      {/* ── #2 + #3 row ── */}
      <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:8, marginBottom:14, ...s(0.15) }}>
        {[players[1], players[2]].map((p, i) => {
          const isSilver = i === 0;
          const c   = isSilver ? T.silver : T.bronze;
          const rgb = isSilver ? "125,143,166" : "155,98,71";
          return (
            <div key={p.rank} style={{
              background:`linear-gradient(${T.card},${T.card}) padding-box,
                          linear-gradient(140deg, rgba(${rgb},0.32) 0%, transparent 70%) border-box`,
              border:"1px solid transparent",
              borderRadius:14, padding:"12px 14px",
              display:"flex", alignItems:"center", gap:10,
            }}>
              <div style={{
                width:36, height:36, borderRadius:11, flexShrink:0,
                background:`rgba(${rgb},0.10)`,
                border:`1px solid rgba(${rgb},0.30)`,
                display:"flex", alignItems:"center", justifyContent:"center",
                fontFamily:"'Syne',sans-serif", fontSize:13, fontWeight:800,
                color:c,
              }}>{p.name[0]}</div>
              <div style={{ flex:1, minWidth:0 }}>
                <div style={{
                  fontFamily:"'Instrument Sans',sans-serif", fontSize:9, fontWeight:700,
                  color:c, letterSpacing:"0.12em", textTransform:"uppercase",
                  marginBottom:1,
                }}>#{p.rank}</div>
                <div style={{
                  fontFamily:"'Syne',sans-serif", fontSize:13, fontWeight:700,
                  color:T.hi, whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis",
                }}>{p.name}</div>
              </div>
              <div style={{
                fontFamily:"'Syne',sans-serif", fontSize:20, fontWeight:800,
                color:c, lineHeight:1,
              }}>{p.score}</div>
            </div>
          );
        })}
      </div>

      {/* ── Your Gap Closer ── creates pull toward next rank */}
      {/* ── Gap-closer card ── only relevant when user has someone above them */}
      {target && (
        <div style={{
          background:`linear-gradient(${T.card},${T.card}) padding-box,
                      linear-gradient(135deg, rgba(0,181,160,0.30) 0%, rgba(0,181,160,0.06) 100%) border-box`,
          border:"1px solid transparent",
          borderRadius:14, padding:"12px 16px",
          marginBottom:14, ...s(0.19),
        }}>
          <div style={{
            display:"flex", justifyContent:"space-between",
            alignItems:"center", marginBottom:9,
          }}>
            <div style={{
              display:"flex", alignItems:"center", gap:8,
              fontFamily:"'Instrument Sans',sans-serif", fontSize:11,
            }}>
              <span style={{ color:T.teal, fontSize:13 }}>↑</span>
              <span style={{ color:T.mid, fontWeight:500 }}>
                <span style={{ color:T.teal, fontWeight:700 }}>{gap} pts</span> behind {target.name}
              </span>
            </div>
            <div style={{
              fontFamily:"'Instrument Sans',sans-serif", fontSize:10, fontWeight:600,
              color:T.lo, letterSpacing:"0.06em", textTransform:"uppercase",
            }}>Climb to #{target.rank}</div>
          </div>
          {/* Visual gap bar */}
          <div style={{ position:"relative", height:5 }}>
            <div style={{
              position:"absolute", inset:0, background:T.border,
              borderRadius:99,
            }}/>
            <div style={{
              position:"absolute", left:0, top:0, bottom:0,
              width:`${(me.score / target.score) * 100}%`,
              background:`linear-gradient(90deg, ${T.orange} 0%, ${T.teal} 100%)`,
              borderRadius:99,
              boxShadow:`0 0 8px rgba(0,181,160,0.4)`,
            }}/>
            {/* Target marker at right */}
            <div style={{
              position:"absolute", right:0, top:-2, bottom:-2,
              width:2, background:T.teal,
              boxShadow:`0 0 6px ${T.teal}`,
            }}/>
          </div>
        </div>
      )}

      {/* When user is #1 — show a celebration card instead */}
      {!target && me && (
        <div style={{
          background:`linear-gradient(${T.card},${T.card}) padding-box,
                      linear-gradient(135deg, rgba(194,160,48,0.40) 0%, rgba(194,160,48,0.06) 100%) border-box`,
          border:"1px solid transparent",
          borderRadius:14, padding:"12px 16px",
          marginBottom:14, ...s(0.19),
          textAlign:"center",
        }}>
          <div style={{
            fontFamily:"'Syne',sans-serif", fontSize:13, fontWeight:700, color:T.gold,
          }}>👑 You're #1 today</div>
          <div style={{
            fontFamily:"'Instrument Sans',sans-serif", fontSize:11, color:T.mid, marginTop:3,
          }}>Hold the lead — keep shooting.</div>
        </div>
      )}

      {/* ── Rest of list ── */}
      <div style={{ display:"flex", flexDirection:"column", gap:6 }}>
        {players.slice(3).map((p, i) => {
          const status = statusFor(p);
          const isYou  = p.isYou;
          return (
            <div key={p.rank} style={{
              background: isYou
                ? `linear-gradient(${T.card},${T.card}) padding-box,
                   linear-gradient(140deg, rgba(255,77,0,0.28) 0%, rgba(255,77,0,0.04) 100%) border-box`
                : T.card,
              border:`1px solid ${isYou ? "transparent" : T.border}`,
              borderRadius:14, padding:"12px 16px",
              display:"flex", alignItems:"center", gap:12,
              animation:`up 0.45s ${EXPO} ${0.22 + i * 0.045}s both`,
              position:"relative", overflow:"hidden",
            }}>
              {/* Rank number */}
              <div style={{
                fontFamily:"'Syne',sans-serif", fontSize:12, fontWeight:700,
                color: isYou ? T.orange : T.lo,
                width:15, textAlign:"center", flexShrink:0,
              }}>{p.rank}</div>

              {/* Avatar */}
              <div style={{
                width:32, height:32, borderRadius:10, flexShrink:0,
                background: isYou ? T.orangeFog : T.surface,
                border:`1px solid ${isYou ? T.orangeRim : T.border}`,
                display:"flex", alignItems:"center", justifyContent:"center",
                fontFamily:"'Syne',sans-serif", fontSize:12, fontWeight:800,
                color: isYou ? T.orange : T.mid,
              }}>{p.name[0]}</div>

              {/* Name + status */}
              <div style={{ flex:1, minWidth:0 }}>
                <div style={{
                  display:"flex", alignItems:"center", gap:6,
                  fontFamily:"'Syne',sans-serif", fontSize:13, fontWeight:700,
                  color: isYou ? T.orange : T.hi,
                }}>
                  <span style={{
                    whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis",
                  }}>{p.name}</span>
                  {isYou && (
                    <span style={{
                      fontFamily:"'Instrument Sans',sans-serif", fontWeight:400,
                      fontSize:9, color:T.orange, opacity:0.65,
                    }}>you</span>
                  )}
                </div>
                <div style={{
                  display:"flex", alignItems:"center", gap:7,
                  marginTop:2,
                }}>
                  <span style={{
                    fontFamily:"'Instrument Sans',sans-serif", fontSize:10, color:T.lo,
                  }}>🔥 {p.streak}d</span>
                  {status && (
                    <>
                      <span style={{ width:2, height:2, borderRadius:"50%", background:T.lo }}/>
                      <span style={{
                        display:"inline-flex", alignItems:"center", gap:4,
                        fontFamily:"'Instrument Sans',sans-serif", fontSize:9, fontWeight:600,
                        color:status.color, letterSpacing:"0.06em", textTransform:"uppercase",
                      }}>
                        <span style={{
                          width:4, height:4, borderRadius:"50%", background:status.dot,
                          boxShadow:`0 0 4px ${status.dot}`,
                        }}/>
                        {status.text}
                      </span>
                    </>
                  )}
                </div>
              </div>

              {/* Score + change */}
              <div style={{ textAlign:"right" }}>
                <div style={{
                  fontFamily:"'Syne',sans-serif", fontSize:21, fontWeight:800,
                  color:T.hi, lineHeight:1,
                }}>{p.score}</div>
                <div style={{
                  fontFamily:"'Instrument Sans',sans-serif", fontSize:10,
                  fontWeight:600, color:changeColor(p.change), marginTop:2,
                  letterSpacing:"0.02em",
                }}>{p.change}</div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Footnote */}
      <div style={{
        textAlign:"center", marginTop:18,
        fontFamily:"'Instrument Sans',sans-serif", fontSize:10, color:T.lo,
        letterSpacing:"0.05em",
        animation:`in 0.6s ease 0.6s both`,
      }}>
        Showing top 8 of 1,247 active creators today
      </div>
    </div>
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// HISTORY SCREEN
// ─────────────────────────────────────────────────────────────────────────────
const HistoryScreen = ({ onNav, economy }) => {
  const s = useStagger();
  const DAYS = ["M","T","W","T","F","S","S"];
  const MAX_H = 52;

  // Build a 7-day window from real weekScores, anchored to today on the right.
  // For each calendar day, find any score; 0 means "no shot taken that day".
  const buildWeekBars = () => {
    const bars = [];
    const today = new Date();
    // Map dates → best score that day (in case user took multiple shots)
    const scoresByDate = {};
    (economy?.weekScores || []).forEach(s => {
      scoresByDate[s.date] = Math.max(scoresByDate[s.date] || 0, s.score);
    });
    for (let i = 6; i >= 0; i--) {
      const d = new Date(today);
      d.setDate(d.getDate() - i);
      const key = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
      bars.push(scoresByDate[key] || 0);
    }
    return bars;
  };
  const BAR_DATA = buildWeekBars();

  // Stats from real data — fall back to "—" placeholders for new users
  const valid    = BAR_DATA.filter(v => v > 0);
  const weekAvg  = valid.length > 0 ? Math.round(valid.reduce((a,b) => a+b, 0) / valid.length) : 0;
  const weekBest = valid.length > 0 ? Math.max(...valid) : 0;
  const totalShots = (economy?.weekScores || []).length;

  // Group real scores by date for the list. Most-recent days first.
  // Friendly date label: Today / Yesterday / weekday name.
  const friendlyDate = (dateStr) => {
    const today = todayKey();
    if (dateStr === today) return "Today";
    const d = new Date();
    d.setDate(d.getDate() - 1);
    const yesterdayStr = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
    if (dateStr === yesterdayStr) return "Yesterday";
    const parsed = new Date(dateStr + "T00:00:00");
    return parsed.toLocaleDateString(undefined, { weekday: "long" });
  };

  // Bucket shots by date, sort buckets newest-first
  const buckets = {};
  (economy?.weekScores || []).forEach((entry, idx) => {
    if (!buckets[entry.date]) buckets[entry.date] = [];
    // Each weekScore entry only has { date, score } — synthesize the rest for display.
    // In a future revision, weekScores could include prompt + mode + time.
    buckets[entry.date].push({
      id: `${entry.date}-${idx}`,
      score: entry.score,
      mode: "✍️",   // default; future: persist mode in weekScores
      modeName: "Shot",
      prompt: promptForDate(entry.date).text.slice(0, 60),
      time: "",     // we don't persist exact times yet
    });
  });

  // Mark the best score in each bucket
  Object.keys(buckets).forEach(date => {
    const max = Math.max(...buckets[date].map(s => s.score));
    buckets[date].forEach(s => { s.best = s.score === max && buckets[date].length > 1; });
  });

  const groups = Object.keys(buckets)
    .sort((a, b) => b.localeCompare(a))  // newest first
    .map(date => ({ date: friendlyDate(date), shots: buckets[date].reverse() }));

  // Mode → color mapping for tinted icon boxes
  const modeStyle = {
    "✍️": { bg:T.orangeFog, border:T.orangeRim },
    "📸": { bg:T.tealFog,   border:T.tealRim },
    "🎙": { bg:"rgba(125,143,166,0.10)", border:"rgba(125,143,166,0.22)" },
  };

  return (
    <div style={{ padding:"0 20px 24px" }}>

      {/* Header */}
      <div style={{ display:"flex", alignItems:"center", gap:12,
        paddingTop:22, marginBottom:20, ...s(0) }}>
        <BackBtn onClick={() => onNav("home")}/>
        <div style={{ flex:1 }}>
          <div style={{ fontFamily:"'Syne',sans-serif", fontWeight:700, fontSize:16, color:T.hi }}>
            History
          </div>
          <div style={{ fontFamily:"'Instrument Sans',sans-serif", fontSize:11, color:T.lo, marginTop:1 }}>
            Your full creative log
          </div>
        </div>
      </div>

      {/* ── Summary Stats Strip ── */}
      <div style={{
        background:T.card, border:`1px solid ${T.border}`,
        borderRadius:16, padding:"14px 8px",
        display:"grid", gridTemplateColumns:"1fr 1fr 1fr 1fr",
        marginBottom:14, ...s(0.06),
      }}>
        {[
          { val: totalShots,             label:"Total",   color:T.hi },
          { val: weekAvg || "—",         label:"Avg",     color:T.mid },
          { val: weekBest || "—",        label:"Best",    color:T.teal },
          { val: economy?.streak || 0,   label:"Streak",  color:T.orange, suffix:"d" },
        ].map((stat, i) => (
          <div key={stat.label} style={{
            textAlign:"center",
            borderRight: i < 3 ? `1px solid ${T.border}` : "none",
            padding:"2px 4px",
          }}>
            <div style={{
              fontFamily:"'Syne',sans-serif", fontWeight:800, fontSize:22,
              color: stat.color, lineHeight:1, letterSpacing:"-0.02em",
            }}>
              {stat.val}
              {stat.suffix && (
                <span style={{ fontSize:13, color:T.lo, marginLeft:1 }}>{stat.suffix}</span>
              )}
            </div>
            <div style={{
              fontFamily:"'Instrument Sans',sans-serif", fontSize:9, fontWeight:600,
              color:T.lo, marginTop:4,
              letterSpacing:"0.08em", textTransform:"uppercase",
            }}>{stat.label}</div>
          </div>
        ))}
      </div>

      {/* ── Weekly bar chart ── */}
      <Card style={{ marginBottom:20, ...s(0.10) }} hover={false}>
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:16 }}>
          <Label>This Week</Label>
          <div style={{
            fontFamily:"'Instrument Sans',sans-serif", fontSize:10, color:T.lo,
            display:"flex", alignItems:"center", gap:6,
          }}>
            <span style={{
              width:14, height:1.5, background:T.mid, borderRadius:99,
              borderTop:`1px dashed ${T.mid}`,
            }}/>
            <span>avg {weekAvg}</span>
          </div>
        </div>

        <div style={{ position:"relative", height:MAX_H + 18 }}>
          {/* Dashed average line */}
          <div style={{
            position:"absolute", left:0, right:0,
            top: MAX_H - (weekAvg / 100) * MAX_H,
            borderTop:`1px dashed ${T.borderMd}`,
            zIndex:1, pointerEvents:"none",
          }}/>

          <div style={{ display:"flex", gap:6, alignItems:"flex-end", height:MAX_H + 18, position:"relative", zIndex:2 }}>
            {BAR_DATA.map((v, i) => {
              const barH   = v ? Math.max(5, (v / 100) * MAX_H) : 3;
              const missed = v === 0;
              const today  = i === 6;
              const isBest = v === weekBest;
              return (
                <div key={i} style={{ flex:1, display:"flex", flexDirection:"column", alignItems:"center", gap:6 }}>
                  <div style={{ width:"100%", height:MAX_H, display:"flex", alignItems:"flex-end", position:"relative" }}>
                    {/* Best marker */}
                    {isBest && (
                      <div style={{
                        position:"absolute", top:-2, left:"50%", transform:"translateX(-50%)",
                        fontFamily:"'Syne',sans-serif", fontSize:9, fontWeight:800,
                        color:T.teal,
                      }}>{v}</div>
                    )}
                    <div style={{
                      width:"100%", height:barH,
                      borderRadius: missed ? "2px" : "5px 5px 3px 3px",
                      background: missed
                        ? T.border
                        : today
                          ? `linear-gradient(180deg, ${T.orangeHi} 0%, ${T.orange} 100%)`
                          : isBest
                            ? `linear-gradient(180deg, ${T.teal} 0%, #00A090 100%)`
                            : T.borderMd,
                      boxShadow: today
                        ? `0 3px 12px rgba(255,77,0,0.30)`
                        : isBest
                          ? `0 3px 12px rgba(0,181,160,0.25)`
                          : "none",
                      transition:`height 0.7s ${EXPO}`,
                    }}/>
                  </div>
                  <div style={{
                    fontFamily:"'Instrument Sans',sans-serif", fontSize:9,
                    color: today ? T.orange : T.lo,
                    fontWeight: today ? 600 : 400,
                    letterSpacing:"0.04em",
                  }}>{DAYS[i]}</div>
                </div>
              );
            })}
          </div>
        </div>
      </Card>

      {/* ── Shot groups (or empty state for new users) ── */}
      {groups.length === 0 ? (
        <div style={{
          background:T.card, border:`1px solid ${T.border}`,
          borderRadius:16, padding:"28px 22px", textAlign:"center",
          ...s(0.14),
        }}>
          <div style={{ fontSize:24, marginBottom:10 }}>📋</div>
          <div style={{
            fontFamily:"'Syne',sans-serif", fontSize:15, fontWeight:700,
            color:T.hi, marginBottom:6,
          }}>No shots yet</div>
          <div style={{
            fontFamily:"'Instrument Sans',sans-serif", fontSize:12,
            color:T.mid, lineHeight:1.55, marginBottom:18,
            maxWidth:260, marginLeft:"auto", marginRight:"auto",
          }}>
            Take your first shot today and it'll appear here. Your full creative log starts now.
          </div>
          <button onClick={() => onNav("home")} style={{
            padding:"10px 18px", borderRadius:12, border:"none", cursor:"pointer",
            background:T.orangeFog, border:`1px solid ${T.orangeRim}`,
            fontFamily:"'Syne',sans-serif", fontSize:12, fontWeight:700,
            color:T.orange, letterSpacing:"0.02em",
          }}>Go to home →</button>
        </div>
      ) : groups.map(({ date, shots }, gi) => (
        <div key={date} style={{
          marginBottom:18,
          animation:`up 0.5s ${EXPO} ${0.14 + gi * 0.06}s both`,
        }}>
          <div style={{
            display:"flex", justifyContent:"space-between",
            alignItems:"center", marginBottom:10, paddingLeft:2,
          }}>
            <Label>{date}</Label>
            <span style={{
              fontFamily:"'Instrument Sans',sans-serif", fontSize:9, color:T.lo,
              letterSpacing:"0.05em",
            }}>
              {shots.length} {shots.length === 1 ? "shot" : "shots"}
            </span>
          </div>

          <div style={{ display:"flex", flexDirection:"column", gap:7 }}>
            {shots.map((shot, si) => {
              const m = modeStyle[shot.mode] || modeStyle["✍️"];
              return (
                <div key={shot.id} className="hov" style={{
                  background:T.card, border:`1px solid ${T.border}`,
                  borderRadius:14, padding:"12px 14px",
                  display:"flex", alignItems:"center", gap:12, cursor:"pointer",
                  animation:`up 0.42s ${EXPO} ${0.16 + gi * 0.06 + si * 0.035}s both`,
                  position:"relative",
                }}>
                  {/* Tinted mode icon */}
                  <div style={{
                    width:38, height:38, borderRadius:11, flexShrink:0,
                    background:m.bg, border:`1px solid ${m.border}`,
                    display:"flex", alignItems:"center", justifyContent:"center",
                    fontSize:16,
                  }}>{shot.mode}</div>

                  {/* Content */}
                  <div style={{ flex:1, minWidth:0 }}>
                    <div style={{
                      fontFamily:"'Instrument Sans',sans-serif", fontSize:13,
                      fontWeight:500, color:T.hi, marginBottom:3,
                      whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis",
                    }}>{shot.prompt}</div>
                    <div style={{
                      display:"flex", alignItems:"center", gap:7,
                      fontFamily:"'Instrument Sans',sans-serif", fontSize:10, color:T.lo,
                    }}>
                      <span>{shot.modeName}</span>
                      <span style={{ width:2, height:2, borderRadius:"50%", background:T.lo }}/>
                      <span>{shot.time}</span>
                      {shot.best && (
                        <>
                          <span style={{ width:2, height:2, borderRadius:"50%", background:T.lo }}/>
                          <span style={{
                            color:T.teal, fontWeight:600, letterSpacing:"0.07em",
                            textTransform:"uppercase",
                          }}>★ Best</span>
                        </>
                      )}
                    </div>
                  </div>

                  {/* Mini score ring */}
                  <MiniRing score={shot.score} size={40}/>
                </div>
              );
            })}
          </div>
        </div>
      ))}

      {/* Footer */}
      <div style={{
        textAlign:"center", marginTop:8,
        fontFamily:"'Instrument Sans',sans-serif", fontSize:10, color:T.lo,
        letterSpacing:"0.05em",
        animation:`in 0.6s ease 0.6s both`,
      }}>
        That's everything so far. Keep going. ✨
      </div>
    </div>
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// AD SCREEN — simulated rewarded video
// Shows a 2-second fake ad, then automatically grants bonus shots and
// returns to home. Replace `simulateAd` with AdMob/IronSource SDK call
// when wiring real ads. The reward callback must fire only on completion.
// ─────────────────────────────────────────────────────────────────────────────
const AdScreen = ({ onNav, economy }) => {
  const [progress, setProgress] = useState(0);
  const [done, setDone]         = useState(false);

  // Simulated ad lifecycle.
  // PRODUCTION: replace with rewarded-ad SDK call. Reward must only be
  // granted on the SDK's onRewarded callback, never on dismissal.
  useEffect(() => {
    let interval;
    let closeTimer;
    let cancelled = false;
    const start = Date.now();

    interval = setInterval(() => {
      if (cancelled) return;
      const elapsed = Date.now() - start;
      const pct = Math.min(100, (elapsed / MONEY.AD_SIMULATION_MS) * 100);
      setProgress(pct);
      if (pct >= 100) {
        clearInterval(interval);
        if (cancelled) return;
        setDone(true);
        economy.grantAdReward();
        // Auto-close after a brief reward-confirmation moment
        closeTimer = setTimeout(() => {
          if (!cancelled) onNav("home");
        }, 1100);
      }
    }, 50);

    return () => {
      cancelled = true;
      clearInterval(interval);
      clearTimeout(closeTimer);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div style={{
      padding:"0 20px 24px", minHeight:"calc(100vh - 80px)",
      display:"flex", flexDirection:"column", justifyContent:"center",
    }}>
      <div style={{ textAlign:"center" }}>
        {/* AD label at top */}
        <div style={{
          display:"inline-flex", alignItems:"center", gap:6,
          padding:"5px 12px", borderRadius:99,
          background:T.surface, border:`1px solid ${T.border}`,
          fontFamily:"'Instrument Sans',sans-serif", fontSize:10, fontWeight:700,
          color:T.lo, letterSpacing:"0.14em", textTransform:"uppercase",
          marginBottom:40,
          animation:`in 0.3s ease both`,
        }}>
          <span style={{ width:5, height:5, borderRadius:"50%", background:T.lo }}/>
          Advertisement
        </div>

        {/* Center stage */}
        {!done ? (
          <>
            <div style={{
              width:120, height:120, margin:"0 auto 28px",
              borderRadius:24, position:"relative",
              background:`linear-gradient(${T.card},${T.card}) padding-box,
                          linear-gradient(135deg, ${T.tealRim} 0%, transparent 70%) border-box`,
              border:"1px solid transparent",
              display:"flex", alignItems:"center", justifyContent:"center",
              animation:`pop 0.45s ${EXPO} both`,
            }}>
              {/* Play icon */}
              <div style={{
                width:62, height:62, borderRadius:"50%",
                background:T.tealFog, border:`1.5px solid ${T.teal}`,
                display:"flex", alignItems:"center", justifyContent:"center",
                animation:`pulse 1.8s ease-in-out infinite`,
              }}>
                <svg width="22" height="22" viewBox="0 0 24 24" fill={T.teal}>
                  <polygon points="6 4 20 12 6 20 6 4"/>
                </svg>
              </div>
            </div>

            <div style={{
              fontFamily:"'Syne',sans-serif", fontSize:18, fontWeight:700,
              color:T.hi, marginBottom:6,
            }}>Ad would play here</div>
            <div style={{
              fontFamily:"'Instrument Sans',sans-serif", fontSize:13,
              color:T.mid, marginBottom:32,
            }}>
              In production, a real rewarded video would play.
            </div>

            {/* Progress bar */}
            <div style={{
              width:"60%", margin:"0 auto",
              height:4, background:T.border, borderRadius:99,
              overflow:"hidden",
            }}>
              <div style={{
                height:"100%", width:`${progress}%`,
                background:`linear-gradient(90deg, ${T.teal}, #00D4BC)`,
                borderRadius:99,
                transition:"width 0.05s linear",
              }}/>
            </div>
            <div style={{
              fontFamily:"'Instrument Sans',sans-serif", fontSize:10,
              color:T.lo, marginTop:10, letterSpacing:"0.06em", textTransform:"uppercase",
            }}>
              Ad ends in {Math.max(0, Math.ceil((100 - progress) / 50))}s
            </div>
          </>
        ) : (
          /* Reward confirmation — celebratory state */
          <div style={{ animation:`celebPop 0.6s ${EXPO} both` }}>
            <div style={{
              width:120, height:120, margin:"0 auto 28px",
              borderRadius:"50%",
              background:`linear-gradient(${T.card},${T.card}) padding-box,
                          linear-gradient(135deg, ${T.tealRim} 0%, ${T.teal} 100%) border-box`,
              border:"2px solid transparent",
              display:"flex", alignItems:"center", justifyContent:"center",
              boxShadow:`0 0 40px rgba(0,181,160,0.35)`,
            }}>
              <svg width="46" height="46" viewBox="0 0 24 24" fill="none"
                stroke={T.teal} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="20 6 9 17 4 12"/>
              </svg>
            </div>
            <div style={{
              fontFamily:"'Syne',sans-serif", fontSize:22, fontWeight:800,
              color:T.hi, marginBottom:6,
            }}>+{MONEY.AD_REWARD_SHOTS} shots added</div>
            <div style={{
              fontFamily:"'Instrument Sans',sans-serif", fontSize:13,
              color:T.mid,
            }}>You can now take {economy.shotsLeft} more shots today.</div>
          </div>
        )}
      </div>
    </div>
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// PAYWALL — powered by RevenueCat
//
// Reads live prices from the offering passed in via the `purchases` prop,
// triggers a real `purchase()` on the selected package, and reflects state
// (loading / processing / error) inline. Falls back to a synthetic offering
// on web preview so the UI is still inspectable.
//
// Apple-compliance checklist baked in:
//   - "Restore Purchases" button (required)
//   - Auto-renewal disclosure (required)
//   - Terms + Privacy links (required)
//   - Localized price strings from StoreKit (via RC offerings)
// ─────────────────────────────────────────────────────────────────────────────
const Paywall = ({ onNav, economy, purchases }) => {
  const s = useStagger();
  const [plan, setPlan] = useState("yearly");
  const [error, setError] = useState(null);
  const [restored, setRestored] = useState(false);

  const benefits = [
    { icon:"∞",  title:"Unlimited shots",   desc:"No daily caps. Create as much as you want." },
    { icon:"✦",  title:"Streak protection", desc:"Skip a day, keep your streak. Once per week." },
    { icon:"◆",  title:"Deeper AI feedback",desc:"Longer, more personalised critiques on every shot." },
    { icon:"⊘",  title:"Zero ads",          desc:"A clean, focused, ad-free experience." },
    { icon:"◐",  title:"Pro themes",        desc:"Exclusive UI themes and a Pro badge on the leaderboard." },
  ];

  // Live offerings — falls back to constants if RC hasn't returned yet
  const monthly = purchases?.offerings?.monthly;
  const annual  = purchases?.offerings?.annual;
  const monthlyPrice    = monthly?.priceString    || MONEY.FALLBACK_PRICE_MONTHLY;
  const annualPrice     = annual?.priceString     || MONEY.FALLBACK_PRICE_YEARLY;
  const annualPerMonth  = annual?.pricePerMonth   || MONEY.FALLBACK_YEARLY_PER_MO;

  const handleSubscribe = async () => {
    if (purchases?.purchasing) return;
    setError(null);
    const pkg = plan === "yearly" ? annual?.pkg : monthly?.pkg;
    if (!pkg) {
      setError("Plan unavailable. Please try again later.");
      return;
    }
    const result = await purchases.purchase(pkg);
    if (result.cancelled) {
      // User cancelled the system payment sheet — no error, just stay here
      return;
    }
    if (result.success && result.isPremium) {
      // Entitlement listener will also fire; this just navigates home immediately
      onNav("home");
      return;
    }
    setError(result.error || "Purchase failed. Please try again.");
  };

  const handleRestore = async () => {
    setError(null);
    const result = await purchases.restore();
    if (result.success && result.isPremium) {
      setRestored(true);
      setTimeout(() => onNav("home"), 700);
      return;
    }
    if (result.success && !result.isPremium) {
      setError("No previous purchases found on this account.");
      return;
    }
    setError(result.error || "Restore failed. Please try again.");
  };

  const processing = purchases?.purchasing;

  return (
    <div style={{ padding:"0 20px 24px", minHeight:"calc(100vh - 80px)" }}>

      {/* Top bar: close + restore */}
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center",
        paddingTop:22, marginBottom:24, ...s(0) }}>
        <button onClick={() => onNav("home")} className="navbtn" aria-label="Close" style={{
          width:38, height:38, borderRadius:12,
          background:T.surface, border:`1px solid ${T.border}`,
          display:"flex", alignItems:"center", justifyContent:"center",
          cursor:"pointer", color:T.mid,
        }}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
            stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
            <path d="M18 6L6 18M6 6l12 12"/>
          </svg>
        </button>
        <button onClick={handleRestore} style={{
          background:"none", border:"none", cursor:"pointer", padding:"6px 4px",
          fontFamily:"'Instrument Sans',sans-serif", fontSize:10, color: restored ? T.teal : T.lo,
          letterSpacing:"0.08em", textTransform:"uppercase", fontWeight:600,
        }}>{restored ? "Restored ✓" : "Restore Purchases"}</button>
      </div>

      {/* Hero */}
      <div style={{ textAlign:"center", marginBottom:28, ...s(0.05) }}>
        <div style={{
          display:"inline-flex", alignItems:"center", gap:6,
          padding:"6px 14px", borderRadius:99,
          background:`linear-gradient(135deg, rgba(194,160,48,0.18), rgba(194,160,48,0.05))`,
          border:`1px solid rgba(194,160,48,0.32)`,
          marginBottom:18,
        }}>
          <span style={{ fontSize:11, color:T.gold }}>✦</span>
          <span style={{
            fontFamily:"'Syne',sans-serif", fontSize:11, fontWeight:700,
            color:T.gold, letterSpacing:"0.10em", textTransform:"uppercase",
          }}>ANOTHERSHOT Pro</span>
        </div>
        <div style={{
          fontFamily:"'Syne',sans-serif", fontSize:32, fontWeight:800,
          color:T.hi, lineHeight:1.1, letterSpacing:"-0.025em",
          marginBottom:10,
        }}>
          Create without limits.
        </div>
        <div style={{
          fontFamily:"'Instrument Sans',sans-serif", fontSize:14,
          color:T.mid, lineHeight:1.55, maxWidth:300, margin:"0 auto",
        }}>
          Unlock unlimited shots, deeper feedback, and a calmer experience.
        </div>
      </div>

      {/* Benefits */}
      <div style={{ marginBottom:24, ...s(0.10) }}>
        {benefits.map(({ icon, title, desc }, i) => (
          <div key={title} style={{
            display:"flex", gap:14, padding:"12px 0",
            borderTop: i > 0 ? `1px solid ${T.border}` : "none",
            animation:`up 0.4s ${EXPO} ${0.15 + i * 0.05}s both`,
          }}>
            <div style={{
              width:30, height:30, borderRadius:9, flexShrink:0,
              background:T.orangeFog, border:`1px solid ${T.orangeRim}`,
              display:"flex", alignItems:"center", justifyContent:"center",
              fontFamily:"'Syne',sans-serif", fontSize:14, fontWeight:800,
              color:T.orange,
            }}>{icon}</div>
            <div>
              <div style={{
                fontFamily:"'Syne',sans-serif", fontSize:14, fontWeight:700,
                color:T.hi, marginBottom:2,
              }}>{title}</div>
              <div style={{
                fontFamily:"'Instrument Sans',sans-serif", fontSize:12,
                color:T.mid, lineHeight:1.5,
              }}>{desc}</div>
            </div>
          </div>
        ))}
      </div>

      {/* Plan selector — prices come from RevenueCat offerings (already localized) */}
      <div style={{
        display:"flex", flexDirection:"column", gap:10,
        marginBottom:18, ...s(0.40),
      }}>
        {/* Yearly */}
        <button onClick={() => setPlan("yearly")}
          disabled={!annual}
          style={{
            background: plan === "yearly"
              ? `linear-gradient(${T.card},${T.card}) padding-box,
                 linear-gradient(135deg, ${T.orange} 0%, rgba(255,77,0,0.2) 100%) border-box`
              : T.card,
            border:`${plan === "yearly" ? "2px" : "1px"} solid ${plan === "yearly" ? "transparent" : T.border}`,
            borderRadius:16, padding: plan === "yearly" ? "17px 20px" : "18px 21px",
            cursor: annual ? "pointer" : "not-allowed",
            opacity: annual ? 1 : 0.5,
            textAlign:"left",
            position:"relative", transition:`all 0.18s ${EXPO}`,
          }}>
          {/* "Best value" ribbon */}
          <div style={{
            position:"absolute", top:-9, right:18,
            padding:"3px 10px", borderRadius:99,
            background:`linear-gradient(135deg, ${T.orangeHi}, ${T.orange})`,
            fontFamily:"'Syne',sans-serif", fontSize:9, fontWeight:800,
            color:"#fff", letterSpacing:"0.08em", textTransform:"uppercase",
            boxShadow:`0 4px 10px rgba(255,77,0,0.35)`,
          }}>Save {MONEY.YEARLY_SAVINGS_PCT}%</div>

          <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start" }}>
            <div>
              <div style={{
                fontFamily:"'Syne',sans-serif", fontSize:15, fontWeight:800,
                color: plan === "yearly" ? T.orange : T.hi, marginBottom:3,
              }}>Yearly</div>
              <div style={{
                fontFamily:"'Instrument Sans',sans-serif", fontSize:12,
                color:T.mid,
              }}>{annualPerMonth}/mo · billed annually</div>
            </div>
            <div style={{ textAlign:"right" }}>
              <div style={{
                fontFamily:"'Syne',sans-serif", fontSize:22, fontWeight:800,
                color:T.hi, lineHeight:1, letterSpacing:"-0.02em",
              }}>{annualPrice}</div>
              <div style={{
                fontFamily:"'Instrument Sans',sans-serif", fontSize:10,
                color:T.lo, marginTop:3,
              }}>per year</div>
            </div>
          </div>
        </button>

        {/* Monthly */}
        <button onClick={() => setPlan("monthly")}
          disabled={!monthly}
          style={{
            background:T.card,
            border:`${plan === "monthly" ? "2px" : "1px"} solid ${plan === "monthly" ? T.orange : T.border}`,
            borderRadius:16, padding: plan === "monthly" ? "17px 20px" : "18px 21px",
            cursor: monthly ? "pointer" : "not-allowed",
            opacity: monthly ? 1 : 0.5,
            textAlign:"left",
            transition:`all 0.18s ${EXPO}`,
          }}>
          <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start" }}>
            <div>
              <div style={{
                fontFamily:"'Syne',sans-serif", fontSize:15, fontWeight:800,
                color: plan === "monthly" ? T.orange : T.hi, marginBottom:3,
              }}>Monthly</div>
              <div style={{
                fontFamily:"'Instrument Sans',sans-serif", fontSize:12,
                color:T.mid,
              }}>Cancel anytime</div>
            </div>
            <div style={{ textAlign:"right" }}>
              <div style={{
                fontFamily:"'Syne',sans-serif", fontSize:22, fontWeight:800,
                color:T.hi, lineHeight:1, letterSpacing:"-0.02em",
              }}>{monthlyPrice}</div>
              <div style={{
                fontFamily:"'Instrument Sans',sans-serif", fontSize:10,
                color:T.lo, marginTop:3,
              }}>per month</div>
            </div>
          </div>
        </button>
      </div>

      {/* Error banner (only when present) */}
      {error && (
        <div style={{
          background:"rgba(224,80,80,0.08)",
          border:"1px solid rgba(224,80,80,0.28)",
          borderRadius:12, padding:"10px 14px", marginBottom:14,
          fontFamily:"'Instrument Sans',sans-serif", fontSize:12, color:"#E05050",
          textAlign:"center",
          animation:`up 0.3s ${EXPO} both`,
        }}>{error}</div>
      )}

      {/* Subscribe button — calls real StoreKit/Play Billing via RevenueCat */}
      <div style={s(0.50)}>
        <PrimaryBtn onClick={handleSubscribe} disabled={processing} large>
          {processing
            ? "Processing…"
            : `Start ${plan === "yearly" ? "Yearly" : "Monthly"} Plan`}
          {!processing && <Arrow opacity={0.7} size={15}/>}
        </PrimaryBtn>
        <div style={{
          textAlign:"center", marginTop:14,
          fontFamily:"'Instrument Sans',sans-serif", fontSize:10,
          color:T.lo, lineHeight:1.6, letterSpacing:"0.02em",
        }}>
          Auto-renews until cancelled. Manage in account settings.<br/>
          <span style={{ marginTop:4, display:"inline-block" }}>
            <a href="#" style={{ color:T.lo, textDecoration:"underline" }}>Terms</a>
            {" · "}
            <a href="#" style={{ color:T.lo, textDecoration:"underline" }}>Privacy</a>
          </span>
        </div>
      </div>
    </div>
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// OUT OF SHOTS — shown when user tries to take a shot but has none left
// Offers two paths forward: rewarded ad (free) or premium upgrade.
// ─────────────────────────────────────────────────────────────────────────────
const OutOfShots = ({ onNav, economy }) => {
  const s = useStagger();
  return (
    <div style={{ padding:"0 20px 24px", minHeight:"calc(100vh - 80px)" }}>

      {/* Close button */}
      <div style={{ paddingTop:22, marginBottom:24, ...s(0) }}>
        <button onClick={() => onNav("home")} className="navbtn" style={{
          width:38, height:38, borderRadius:12,
          background:T.surface, border:`1px solid ${T.border}`,
          display:"flex", alignItems:"center", justifyContent:"center",
          cursor:"pointer", color:T.mid,
        }}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
            stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
            <path d="M18 6L6 18M6 6l12 12"/>
          </svg>
        </button>
      </div>

      {/* Hero icon */}
      <div style={{ textAlign:"center", marginBottom:24, ...s(0.05) }}>
        <div style={{
          width:88, height:88, margin:"0 auto 22px",
          borderRadius:24, position:"relative",
          background:`linear-gradient(${T.card},${T.card}) padding-box,
                      linear-gradient(135deg, ${T.orangeRim} 0%, transparent 70%) border-box`,
          border:"1px solid transparent",
          display:"flex", alignItems:"center", justifyContent:"center",
        }}>
          <svg width="36" height="36" viewBox="0 0 24 24" fill="none"
            stroke={T.orange} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="9"/>
            <line x1="4.5" y1="4.5" x2="19.5" y2="19.5"/>
          </svg>
        </div>
        <div style={{
          fontFamily:"'Syne',sans-serif", fontSize:24, fontWeight:800,
          color:T.hi, letterSpacing:"-0.02em", marginBottom:8,
        }}>Out of shots for today</div>
        <div style={{
          fontFamily:"'Instrument Sans',sans-serif", fontSize:14,
          color:T.mid, lineHeight:1.55, maxWidth:320, margin:"0 auto",
        }}>
          You've used all {economy.totalAllowed} of your daily shots. Resets at midnight.
        </div>
      </div>

      {/* Streak warning */}
      <div style={{
        background:T.card, border:`1px solid ${T.border}`,
        borderRadius:14, padding:"14px 16px",
        display:"flex", alignItems:"center", gap:12,
        marginBottom:20, ...s(0.10),
      }}>
        <div style={{ fontSize:18 }}>🔥</div>
        <div style={{ flex:1 }}>
          <div style={{
            fontFamily:"'Syne',sans-serif", fontSize:13, fontWeight:700,
            color:T.hi, marginBottom:2,
          }}>Your 15-day streak is safe</div>
          <div style={{
            fontFamily:"'Instrument Sans',sans-serif", fontSize:11, color:T.lo,
          }}>You've already taken at least one shot today.</div>
        </div>
      </div>

      {/* Two paths */}
      <div style={{ marginBottom:14, ...s(0.16) }}>
        <Label style={{ marginBottom:10, paddingLeft:2 }}>Get more shots</Label>

        {/* Path 1: Watch an ad */}
        <div style={{
          background:`linear-gradient(${T.card},${T.card}) padding-box,
                      linear-gradient(135deg, ${T.tealRim} 0%, transparent 70%) border-box`,
          border:"1px solid transparent",
          borderRadius:16, padding:"16px 18px", marginBottom:10,
        }}>
          <div style={{ display:"flex", alignItems:"center", gap:12, marginBottom:14 }}>
            <div style={{
              width:34, height:34, borderRadius:10, flexShrink:0,
              background:T.tealFog, border:`1px solid ${T.tealRim}`,
              display:"flex", alignItems:"center", justifyContent:"center",
            }}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill={T.teal}>
                <polygon points="6 4 20 12 6 20 6 4"/>
              </svg>
            </div>
            <div style={{ flex:1 }}>
              <div style={{
                fontFamily:"'Syne',sans-serif", fontSize:14, fontWeight:700,
                color:T.hi, marginBottom:2,
              }}>Watch a quick ad</div>
              <div style={{
                fontFamily:"'Instrument Sans',sans-serif", fontSize:11, color:T.lo,
              }}>Get +{MONEY.AD_REWARD_SHOTS} shots instantly · free</div>
            </div>
          </div>
          <WatchAdButton
            onClick={() => onNav("ad")}
            disabled={!economy.canWatchAd}
          />
          {!economy.canWatchAd && (
            <div style={{
              textAlign:"center", marginTop:8,
              fontFamily:"'Instrument Sans',sans-serif", fontSize:10, color:T.lo,
              letterSpacing:"0.04em",
            }}>
              You've watched the max {MONEY.AD_DAILY_CAP} ads today
            </div>
          )}
        </div>

        {/* Path 2: Go Pro */}
        <div style={{
          background:`linear-gradient(${T.card},${T.card}) padding-box,
                      linear-gradient(135deg, rgba(194,160,48,0.32) 0%, transparent 70%) border-box`,
          border:"1px solid transparent",
          borderRadius:16, padding:"16px 18px",
        }}>
          <div style={{ display:"flex", alignItems:"center", gap:12, marginBottom:14 }}>
            <div style={{
              width:34, height:34, borderRadius:10, flexShrink:0,
              background:`linear-gradient(135deg, rgba(194,160,48,0.18), rgba(194,160,48,0.04))`,
              border:`1px solid rgba(194,160,48,0.32)`,
              display:"flex", alignItems:"center", justifyContent:"center",
              fontFamily:"'Syne',sans-serif", fontWeight:800, fontSize:14, color:T.gold,
            }}>✦</div>
            <div style={{ flex:1 }}>
              <div style={{
                fontFamily:"'Syne',sans-serif", fontSize:14, fontWeight:700,
                color:T.hi, marginBottom:2,
              }}>Go Pro for unlimited</div>
              <div style={{
                fontFamily:"'Instrument Sans',sans-serif", fontSize:11, color:T.lo,
              }}>From {MONEY.YEARLY_PER_MONTH}/month · no caps, no ads</div>
            </div>
          </div>
          <PrimaryBtn onClick={() => onNav("paywall")}>
            See Pro Plans
            <Arrow opacity={0.65} size={14}/>
          </PrimaryBtn>
        </div>
      </div>

      {/* Footer */}
      <div style={{
        textAlign:"center", marginTop:18,
        fontFamily:"'Instrument Sans',sans-serif", fontSize:11, color:T.lo,
        lineHeight:1.55,
      }}>
        Or come back tomorrow — your shots refresh at midnight.
      </div>
    </div>
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// SETTINGS — premium status, restore purchases, support, legal
// Reachable via the gear icon on Home. Required for App Store / Play Store
// compliance (must provide an in-app way to manage subscription, restore
// purchases, and access Terms + Privacy).
// ─────────────────────────────────────────────────────────────────────────────
const Settings = ({ onNav, economy, purchases }) => {
  const s = useStagger();
  const [restored, setRestored]   = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [restoreMsg, setRestoreMsg] = useState(null); // for "no purchases found" feedback

  // Restore purchases via RevenueCat — required by Apple. The hook surfaces
  // any state change through onEntitlementChange so economy.isPremium updates
  // automatically.
  const handleRestore = async () => {
    if (restoring || !purchases) return;
    setRestoring(true);
    setRestoreMsg(null);
    const result = await purchases.restore();
    setRestoring(false);
    if (result.success && result.isPremium) {
      setRestored(true);
      setTimeout(() => setRestored(false), 2500);
    } else if (result.success) {
      setRestoreMsg("No active subscription found");
      setTimeout(() => setRestoreMsg(null), 2500);
    } else {
      setRestoreMsg(result.error || "Restore failed");
      setTimeout(() => setRestoreMsg(null), 2500);
    }
  };

  // Manage subscription — on iOS/Android, opens RevenueCat's Customer Center
  // (or the native Settings → Subscriptions screen). On web preview where
  // those APIs don't exist, falls back to navigating to the paywall so the
  // user can see the plan options. App Store requires manage-subscription
  // access via a real entry point — this satisfies the rule on every platform.
  const handleManage = async () => {
    if (!purchases) {
      onNav("paywall");
      return;
    }
    const result = await purchases.manageSubscription();
    // If native subscription management isn't available (web, missing SDK),
    // route to the paywall as the next-best entry point.
    if (!result?.success) {
      onNav("paywall");
    }
  };

  // Row primitive — keeps every settings entry visually identical
  const Row = ({ icon, label, value, onClick, danger = false, last = false }) => (
    <button
      onClick={onClick}
      disabled={!onClick}
      style={{
        width:"100%", background:"transparent", border:"none",
        borderBottom: last ? "none" : `1px solid ${T.border}`,
        padding:"14px 18px", cursor: onClick ? "pointer" : "default",
        display:"flex", alignItems:"center", gap:14, textAlign:"left",
        transition:`background 0.15s`,
      }}
      onMouseEnter={e => onClick && (e.currentTarget.style.background = "rgba(255,255,255,0.02)")}
      onMouseLeave={e => (e.currentTarget.style.background = "transparent")}
    >
      <div style={{
        width:28, height:28, borderRadius:8, flexShrink:0,
        background: danger ? "rgba(224,80,80,0.08)" : T.surface,
        border:`1px solid ${danger ? "rgba(224,80,80,0.22)" : T.border}`,
        display:"flex", alignItems:"center", justifyContent:"center",
        color: danger ? "#E05050" : T.mid,
      }}>{icon}</div>
      <div style={{ flex:1 }}>
        <div style={{
          fontFamily:"'Instrument Sans',sans-serif", fontSize:13, fontWeight:500,
          color: danger ? "#E05050" : T.hi,
        }}>{label}</div>
      </div>
      {value && (
        <div style={{
          fontFamily:"'Instrument Sans',sans-serif", fontSize:12,
          color:T.lo, fontWeight:400,
        }}>{value}</div>
      )}
      {onClick && (
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none"
          stroke={T.lo} strokeWidth="2" strokeLinecap="round">
          <path d="M9 18l6-6-6-6"/>
        </svg>
      )}
    </button>
  );

  // Group container — gives sections their card-like grouping
  const Group = ({ label, children, style = {} }) => (
    <div style={{ marginBottom:16, ...style }}>
      <Label style={{ marginBottom:9, paddingLeft:4 }}>{label}</Label>
      <div style={{
        background:T.card, border:`1px solid ${T.border}`,
        borderRadius:14, overflow:"hidden",
      }}>{children}</div>
    </div>
  );

  // SVG icon helpers — kept small and inline for clarity
  const I = {
    crown:    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M5 17h14l1.5-9-5 3L12 5l-3.5 6L3.5 8 5 17z"/></svg>,
    bell:     <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><path d="M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/></svg>,
    refresh:  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>,
    help:     <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>,
    mail:     <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M4 4h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z"/><polyline points="22,6 12,13 2,6"/></svg>,
    star:     <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>,
    shield:   <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>,
    file:     <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>,
    logout:   <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>,
  };

  return (
    <div style={{ padding:"0 20px 24px", minHeight:"calc(100vh - 80px)" }}>

      {/* Header */}
      <div style={{ display:"flex", alignItems:"center", gap:12,
        paddingTop:22, marginBottom:22, ...s(0) }}>
        <BackBtn onClick={() => onNav("home")}/>
        <div style={{ flex:1 }}>
          <div style={{ fontFamily:"'Syne',sans-serif", fontWeight:700, fontSize:16, color:T.hi }}>
            Settings
          </div>
          <div style={{ fontFamily:"'Instrument Sans',sans-serif", fontSize:11, color:T.lo, marginTop:1 }}>
            Account, support, and preferences
          </div>
        </div>
      </div>

      {/* ── Subscription Card ── always visible, status-aware */}
      <div style={{ marginBottom:18, ...s(0.06) }}>
        {economy.isPremium ? (
          /* Premium status card */
          <div style={{
            background:`linear-gradient(${T.card},${T.card}) padding-box,
                        linear-gradient(135deg, rgba(194,160,48,0.42) 0%, rgba(194,160,48,0.06) 100%) border-box`,
            border:"1px solid transparent",
            borderRadius:16, padding:"18px 20px", position:"relative", overflow:"hidden",
          }}>
            <div style={{
              position:"absolute", top:-40, right:-40, width:140, height:140,
              background:"radial-gradient(circle, rgba(194,160,48,0.10) 0%, transparent 65%)",
            }}/>
            <div style={{ display:"flex", alignItems:"center", gap:12, marginBottom:14 }}>
              <div style={{
                width:38, height:38, borderRadius:11,
                background:`linear-gradient(135deg, rgba(194,160,48,0.20), rgba(194,160,48,0.05))`,
                border:`1px solid rgba(194,160,48,0.32)`,
                display:"flex", alignItems:"center", justifyContent:"center",
                color:T.gold,
              }}>{I.crown}</div>
              <div style={{ flex:1 }}>
                <div style={{
                  fontFamily:"'Syne',sans-serif", fontSize:15, fontWeight:800,
                  color:T.gold, letterSpacing:"-0.005em",
                }}>ANOTHERSHOT Pro</div>
                <div style={{
                  fontFamily:"'Instrument Sans',sans-serif", fontSize:11,
                  color:T.mid, marginTop:1,
                }}>Active · unlimited shots, no ads</div>
              </div>
            </div>
            <button onClick={handleManage} style={{
              width:"100%", padding:"10px 14px", borderRadius:10,
              background:T.surface, border:`1px solid ${T.border}`,
              fontFamily:"'Syne',sans-serif", fontSize:12, fontWeight:700,
              color:T.mid, cursor:"pointer",
            }}>Manage subscription</button>
          </div>
        ) : (
          /* Upgrade prompt card */
          <div style={{
            background:`linear-gradient(${T.card},${T.card}) padding-box,
                        linear-gradient(135deg, ${T.orangeRim} 0%, rgba(255,77,0,0.05) 100%) border-box`,
            border:"1px solid transparent",
            borderRadius:16, padding:"18px 20px", position:"relative", overflow:"hidden",
          }}>
            <div style={{
              position:"absolute", top:-40, right:-40, width:140, height:140,
              background:"radial-gradient(circle, rgba(255,77,0,0.10) 0%, transparent 65%)",
            }}/>
            <div style={{ display:"flex", alignItems:"center", gap:12, marginBottom:14 }}>
              <div style={{
                width:38, height:38, borderRadius:11,
                background:T.orangeFog, border:`1px solid ${T.orangeRim}`,
                display:"flex", alignItems:"center", justifyContent:"center",
                fontFamily:"'Syne',sans-serif", fontSize:16, fontWeight:800,
                color:T.orange,
              }}>✦</div>
              <div style={{ flex:1 }}>
                <div style={{
                  fontFamily:"'Syne',sans-serif", fontSize:15, fontWeight:800,
                  color:T.hi,
                }}>Unlock ANOTHERSHOT Pro</div>
                <div style={{
                  fontFamily:"'Instrument Sans',sans-serif", fontSize:11,
                  color:T.mid, marginTop:1,
                }}>Unlimited shots · no ads · deeper feedback</div>
              </div>
            </div>
            <PrimaryBtn onClick={() => onNav("paywall")}>
              See Pro Plans
              <Arrow opacity={0.65} size={13}/>
            </PrimaryBtn>
          </div>
        )}
      </div>

      {/* ── Account ── */}
      <div style={s(0.10)}>
        <Group label="Account">
          <Row
            icon={I.refresh}
            label={
              restoring ? "Restoring…" :
              restored  ? "Restored ✓" :
              restoreMsg || "Restore purchases"
            }
            onClick={restoring ? undefined : handleRestore}
          />
          <Row icon={I.bell} label="Notifications" value="Daily" onClick={() => {}} last/>
        </Group>
      </div>

      {/* ── Streak Stats ── */}
      <div style={s(0.13)}>
        <Group label="Your stats">
          <div style={{
            display:"grid", gridTemplateColumns:"1fr 1fr 1fr",
            padding:"14px 0",
          }}>
            {[
              { val: economy.streak,       label:"Current",      color:T.orange, suffix:"d" },
              { val: economy.personalBest, label:"Best",         color:T.gold,   suffix:"d" },
              { val: economy.shotDates.length, label:"Total shots", color:T.teal,  suffix:"" },
            ].map((stat, i) => (
              <div key={stat.label} style={{
                textAlign:"center",
                borderRight: i < 2 ? `1px solid ${T.border}` : "none",
              }}>
                <div style={{
                  fontFamily:"'Syne',sans-serif", fontSize:22, fontWeight:800,
                  color:stat.color, lineHeight:1, letterSpacing:"-0.02em",
                }}>
                  {stat.val}
                  {stat.suffix && (
                    <span style={{ fontSize:13, color:T.lo, marginLeft:1 }}>{stat.suffix}</span>
                  )}
                </div>
                <div style={{
                  fontFamily:"'Instrument Sans',sans-serif", fontSize:9, fontWeight:600,
                  color:T.lo, marginTop:5,
                  letterSpacing:"0.08em", textTransform:"uppercase",
                }}>{stat.label}</div>
              </div>
            ))}
          </div>
        </Group>
      </div>

      {/* ── Support ── */}
      <div style={s(0.16)}>
        <Group label="Support">
          <Row icon={I.star}  label="Rate ANOTHERSHOT" onClick={() => {}}/>
          <Row icon={I.mail}  label="Contact support"  onClick={() => {}}/>
          <Row icon={I.help}  label="Help & FAQ"        onClick={() => {}} last/>
        </Group>
      </div>

      {/* ── Legal ── */}
      <div style={s(0.19)}>
        <Group label="Legal">
          <Row icon={I.shield} label="Privacy Policy"        onClick={() => {}}/>
          <Row icon={I.file}   label="Terms of Service"      onClick={() => {}} last/>
        </Group>
      </div>

      {/* App version footer */}
      <div style={{
        textAlign:"center", marginTop:18, ...s(0.22),
      }}>
        <div style={{
          fontFamily:"'Syne',sans-serif", fontSize:11, fontWeight:700,
          color:T.lo, letterSpacing:"0.10em", textTransform:"uppercase",
          marginBottom:4,
        }}>ANOTHERSHOT</div>
        <div style={{
          fontFamily:"'Instrument Sans',sans-serif", fontSize:10, color:T.lo,
          letterSpacing:"0.04em",
        }}>Version 1.0.0 · Built with care</div>
      </div>
    </div>
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// BOTTOM NAV
// ─────────────────────────────────────────────────────────────────────────────
const NAV = [
  {
    id:"home", label:"Home",
    Icon: ({ a }) => (
      <svg width="19" height="19" viewBox="0 0 24 24" fill="none"
        stroke="currentColor" strokeWidth={a ? 2.2 : 1.7} strokeLinecap="round" strokeLinejoin="round">
        <path d="M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z"/>
        <polyline points="9,22 9,12 15,12 15,22"/>
      </svg>
    ),
  },
  {
    id:"leaderboard", label:"Board",
    Icon: ({ a }) => (
      <svg width="19" height="19" viewBox="0 0 24 24" fill="none"
        stroke="currentColor" strokeWidth={a ? 2.2 : 1.7} strokeLinecap="round" strokeLinejoin="round">
        <rect x="18" y="3" width="4" height="18" rx="1"/>
        <rect x="10" y="8" width="4" height="13" rx="1"/>
        <rect x="2"  y="13" width="4" height="8"  rx="1"/>
      </svg>
    ),
  },
  { id:"shot", isCenter:true },
  {
    id:"history", label:"History",
    Icon: ({ a }) => (
      <svg width="19" height="19" viewBox="0 0 24 24" fill="none"
        stroke="currentColor" strokeWidth={a ? 2.2 : 1.7} strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="9"/>
        <polyline points="12,7 12,12 15.5,14"/>
      </svg>
    ),
  },
  {
    id:"result", label:"Score",
    Icon: ({ a }) => (
      <svg width="19" height="19" viewBox="0 0 24 24" fill="none"
        stroke="currentColor" strokeWidth={a ? 2.2 : 1.7} strokeLinecap="round" strokeLinejoin="round">
        <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
      </svg>
    ),
  },
];

const BottomNav = ({ screen, onNav, canTakeShot }) => (
  <div style={{
    position:"fixed", bottom:0, left:"50%", transform:"translateX(-50%)",
    width:"100%", maxWidth:430, zIndex:100,
    background:"rgba(7,7,10,0.86)",
    backdropFilter:"blur(28px) saturate(180%)",
    borderTop:"1px solid rgba(255,255,255,0.040)",
    padding:"10px 6px 26px",
    display:"grid", gridTemplateColumns:"repeat(5,1fr)",
    alignItems:"center",
  }}>
    {NAV.map(({ id, label, Icon, isCenter }) => {
      if (isCenter) return (
        <div key="fab" style={{ display:"flex", justifyContent:"center" }}>
          <button
            onClick={() => onNav(canTakeShot ? "shot" : "outOfShots")}
            className="fab"
            style={{
              width:50, height:50, borderRadius:16, flexShrink:0,
              background:`linear-gradient(150deg, ${T.orangeHi} 0%, ${T.orange} 55%, #E53A00 100%)`,
              border:"none", cursor:"pointer",
              display:"flex", alignItems:"center", justifyContent:"center",
              boxShadow:"0 5px 20px rgba(255,77,0,0.48), 0 1px 4px rgba(255,77,0,0.25), inset 0 1px 0 rgba(255,255,255,0.12)",
              transform:"translateY(-9px)",
              transition:`all 0.2s ${EXPO}`,
            }}
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none"
              stroke="rgba(255,255,255,0.92)" strokeWidth="1.9" strokeLinecap="round">
              <circle cx="12" cy="12" r="9"/>
              <circle cx="12" cy="12" r="3.5"/>
              <line x1="12" y1="3" x2="12" y2="8.5"/>
              <line x1="12" y1="15.5" x2="12" y2="21"/>
              <line x1="3" y1="12" x2="8.5" y2="12"/>
              <line x1="15.5" y1="12" x2="21" y2="12"/>
            </svg>
          </button>
        </div>
      );

      const active = screen === id;
      return (
        <button key={id} onClick={() => onNav(id)} className="navbtn"
          style={{
            display:"flex", flexDirection:"column", alignItems:"center", gap:4,
            background:"none", border:"none", cursor:"pointer",
            color: active ? T.orange : T.lo,
            transition:"color 0.2s ease",
            padding:"4px 0", position:"relative",
          }}>
          <Icon a={active}/>
          <span style={{
            fontFamily:"'Instrument Sans',sans-serif",
            fontSize:9, fontWeight:600,
            letterSpacing:"0.07em", textTransform:"uppercase",
          }}>{label}</span>
          {active && (
            <div style={{
              position:"absolute", bottom:-4,
              width:4, height:4, borderRadius:"50%",
              background:T.orange,
              animation:"in 0.2s ease",
            }}/>
          )}
        </button>
      );
    })}
  </div>
);

// ─────────────────────────────────────────────────────────────────────────────
// APP SHELL
// ─────────────────────────────────────────────────────────────────────────────
// Routing table — maps screen ids to components.
// Monetization screens (ad, paywall, outOfShots) are full-screen takeovers
// and don't show in bottom nav.
const SCREENS = {
  home:        HomeScreen,
  shot:        ShotScreen,
  result:      ResultScreen,
  leaderboard: LeaderboardScreen,
  history:     HistoryScreen,
  ad:          AdScreen,
  paywall:     Paywall,
  outOfShots:  OutOfShots,
  settings:    Settings,
};

// Screen ids where the bottom nav should be hidden (full-screen flows)
const FULLSCREEN = new Set(["ad", "paywall", "outOfShots", "settings"]);

// ─────────────────────────────────────────────────────────────────────────────
// ERROR BOUNDARY — catches any uncaught JS error in the tree and shows a
// graceful fallback. App Store / Play Store both reject apps that crash to
// a blank white screen, so this is non-negotiable. In production, log to
// Sentry or your error tracker in componentDidCatch().
// ─────────────────────────────────────────────────────────────────────────────
class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }
  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }
  componentDidCatch(error, info) {
    // PRODUCTION: report to error tracking service
    // Sentry.captureException(error, { extra: info });
    console.error("[ANOTHERSHOT crash]", error, info);
  }
  handleReset = () => this.setState({ hasError: false, error: null });
  render() {
    if (!this.state.hasError) return this.props.children;
    return (
      <div style={{
        background:T.bg, minHeight:"100vh", maxWidth:430, margin:"0 auto",
        display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center",
        padding:"40px 24px", textAlign:"center",
        fontFamily:"'Instrument Sans',sans-serif",
      }}>
        <div style={{
          width:60, height:60, borderRadius:18, marginBottom:20,
          background:T.orangeFog, border:`1px solid ${T.orangeRim}`,
          display:"flex", alignItems:"center", justifyContent:"center",
        }}>
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none"
            stroke={T.orange} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10"/>
            <line x1="12" y1="8" x2="12" y2="12"/>
            <line x1="12" y1="16" x2="12.01" y2="16"/>
          </svg>
        </div>
        <div style={{
          fontFamily:"'Syne',sans-serif", fontSize:20, fontWeight:800,
          color:T.hi, marginBottom:8, letterSpacing:"-0.01em",
        }}>Something went wrong</div>
        <div style={{
          fontSize:13, color:T.mid, marginBottom:24, maxWidth:300, lineHeight:1.55,
        }}>
          We've logged the issue. Try restarting — your data is safe.
        </div>
        <button onClick={this.handleReset} style={{
          padding:"12px 24px", borderRadius:14, border:"none", cursor:"pointer",
          background:`linear-gradient(150deg, ${T.orangeHi} 0%, ${T.orange} 55%, #E53A00 100%)`,
          color:"#fff", fontFamily:"'Syne',sans-serif", fontSize:14, fontWeight:700,
          boxShadow:"0 8px 24px rgba(255,77,0,0.32)",
        }}>Try Again</button>
      </div>
    );
  }
}

function AnotherShotInner() {
  const [screen, setScreen]   = useState("home");
  const [mountKey, setMountKey] = useState(0);
  const [flash, setFlash]     = useState(false); // brief orange flash on loop continuation

  // pendingShot holds the in-flight (or just-completed) submission so the
  // Result screen can render real AI scoring instead of hardcoded values.
  // Shape: { mode, prompt, text, loading, score, feedback, breakdown, source }
  const [pendingShot, setPendingShot] = useState(null);

  // Central monetization state — passed to every screen that needs it
  const economy = useShotEconomy();

  // RevenueCat — bound to economy.setPremium so any entitlement change
  // (purchase, restore, renewal, refund) immediately flips the user's
  // premium status everywhere in the UI.
  const purchases = usePurchases((isPremium) => {
    economy.setPremium(isPremium);
  });

  useEffect(setupGlobals, []);

  // Track the flash timer so we can clean it up on unmount or rapid re-navs
  const flashTimer = useRef(null);
  useEffect(() => () => {
    if (flashTimer.current) clearTimeout(flashTimer.current);
  }, []);

  const navigate = (next) => {
    // Loop-continuation flash: result → shot is the addictive moment
    if (screen === "result" && next === "shot") {
      setFlash(true);
      if (flashTimer.current) clearTimeout(flashTimer.current);
      flashTimer.current = setTimeout(() => setFlash(false), 700);
    }
    setScreen(next);
    setMountKey(k => k + 1);
  };

  // submitShot — the heart of the loop.
  //   1. Optimistically navigate to Result with a loading state
  //   2. Consume one shot from the economy (handles streak, daily count)
  //   3. For text: kick off real Gemini scoring in the background
  //      For photo/voice: use a simulated score (vision API would go here)
  //   4. When the score returns, update pendingShot so ResultScreen reveals it
  const submitShot = async ({ mode, prompt, text }) => {
    // Show loading state immediately
    setPendingShot({ mode, prompt, text, loading: true });
    economy.consumeShot();
    navigate("result");

    let result;
    if (mode === "text") {
      // Real AI scoring via Gemini (with heuristic fallback)
      result = await scoreSubmission(prompt, text);
    } else {
      // Photo/voice — simulated scoring (replace with vision/audio model later).
      // Use a believable 72–88 band so the experience still feels rewarding.
      const fakeScore = 72 + Math.floor(Math.random() * 17);
      result = {
        score: fakeScore,
        feedback: mode === "photo"
          ? "A captured moment worth keeping. Composition reads clearly."
          : "Honest voice. The hesitations are doing real work.",
        breakdown: [
          { label: "What worked",     note: mode === "photo" ? "Framing and subject choice." : "Authentic delivery." },
          { label: "What to sharpen", note: mode === "photo" ? "Tighten the focal point." : "Cut the throat-clears." },
          { label: "Try next time",   note: "Lean further into the angle that drew you in." },
        ],
        source: "simulated",
      };
    }

    // Update with final score — Result screen will animate the reveal
    setPendingShot(prev => prev ? { ...prev, ...result, loading: false } : null);
    // Persist the score so bestScore + weekScores update
    if (typeof result.score === "number") {
      economy.recordScore(result.score);
    }
  };

  // Fallback to home if an unknown screen id slips through
  const Screen = SCREENS[screen] || SCREENS.home;

  return (
    <div style={{
      background:T.bg, minHeight:"100vh", maxWidth:430,
      margin:"0 auto", position:"relative", overflowX:"hidden",
    }}>
      {/* Grain overlay — premium texture depth */}
      <div style={{
        position:"fixed", inset:0, zIndex:200, pointerEvents:"none",
        opacity:0.028,
        backgroundImage:`url("data:image/svg+xml,%3Csvg viewBox='0 0 200 200' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E")`,
      }}/>

      {/* Ambient top glow */}
      <div style={{
        position:"fixed", top:-100, left:"50%", transform:"translateX(-50%)",
        width:400, height:400, pointerEvents:"none", zIndex:0,
        background:`radial-gradient(ellipse at 50% 0%, rgba(255,77,0,0.060) 0%, transparent 65%)`,
      }}/>

      {/* Loop-continuation flash overlay */}
      {flash && (
        <div style={{
          position:"fixed", inset:0, zIndex:300, pointerEvents:"none",
          background:"radial-gradient(circle at 50% 50%, rgba(255,107,32,0.35) 0%, rgba(255,77,0,0.15) 30%, transparent 65%)",
          animation:`flashFade 0.7s ease both`,
        }}/>
      )}

      {/* Screen — key drives remount + entry animation. Economy + purchases passed to all. */}
      <div key={mountKey} style={{
        position:"relative", zIndex:1,
        paddingBottom: FULLSCREEN.has(screen) ? 0 : 94,
        animation:`up 0.38s ${EXPO} both`,
      }}>
        <Screen
          onNav={navigate}
          economy={economy}
          purchases={purchases}
          submitShot={submitShot}
          pendingShot={pendingShot}
        />
      </div>

      {/* Bottom nav hidden on monetization takeover screens */}
      {!FULLSCREEN.has(screen) && (
        <BottomNav screen={screen} onNav={navigate} canTakeShot={economy.canTakeShot}/>
      )}
    </div>
  );
}

// Export wraps inner app in ErrorBoundary so any uncaught error shows the
// graceful fallback instead of a blank white screen.
export default function AnotherShot() {
  return (
    <ErrorBoundary>
      <AnotherShotInner/>
    </ErrorBoundary>
  );
}