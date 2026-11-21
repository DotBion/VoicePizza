# VoicePizza — Complete Prompt Log (Both Ends)

> **Project Author / Solution Architect**: **SAL** (`vim719`)  
> **Problem Solved**: Multilingual multi-party phone ordering (**P1**) and loud overlapping over-the-counter pizzeria chaos (**P2**), plus exact POS total synchronization, full Day/Date/HH:MM:SS confirmation timestamps, clear kitchen stage workflows, **Element 119** stress benchmarking, and **Shopify Draft Order** commerce export.  
> **SAL's Solution**: Dual-mode voice orchestration (**Gemini 3.8 Live** + 5-stage **Cascaded Pipeline** powered by **Gemini 3.5 Transcribe**, **Gemini Decisions API**, **Gemini 4 Neon**, **Gemini 4 Hydrogen**, and **Gemini 3.8 Flash Lite TTS**), real-time `AudioMeter` + dynamic noise-floor gate + 90+ language detector, authoritative cent-exact POS math, and bilingual Italian/Spanish staff routing.

This document records **every prompt from both ends of the VoicePizza build**:

1. **Part 1 — User-to-AI Builder Prompts (from SAL)**: The chronological sequence of product briefs, solution directives, feature requests, bug reports, model switches, and UX refinements given by SAL while building VoicePizza.
2. **Part 2 — Application-to-Gemini Prompts (System, Tool, Triage & Synthesis)**: The exact runtime prompts, function-calling schemas, Decisions API rubrics, and speech style directives sent by VoicePizza to Gemini models in production.
3. **Part 3 — Engineering Evolution & Bug Fixes (Gemini 4 Hydrogen + Gemini 4 Neon)**: Every technical issue identified and resolved across the build.

> **Security Note**: No API keys, secrets, or credentials appear anywhere in this file or repository. All Gemini calls execute server-side using `process.env.GEMINI_API_KEY`.

---

## Part 1 — User-to-AI Builder Prompts (Chronological Record)

### 1. Core Hackathon Brief — P1 Phone Line, P2 Over-the-Counter Chaos, Element 119 & Commerce Bonus Track
- Build **VoicePizza**, a live multilingual voice agent for a busy neighborhood pizzeria run by an Italian owner and a Spanish-speaking counter clerk.
- **P1 — Phone Line**: Handle multi-party calls where two people on the same line speak different languages (e.g., British English husband + German wife adding a gluten-free pizza) without dropping either speaker.
- **P2 — Over-the-Counter Chaos**: Operate in a noisy shop with overlapping voices across multiple languages (English, German, Greek queue complaint, Mandarin Chinese supplier delivery, Italian pizzaiolo, Spanish counter clerk), separating actual takeaway orders from operational non-order alerts.
- **Dual Voice Architecture**: Support both **Cascaded Voice Pipeline** (`gemini-3.5-transcribe` → `gemini-decision-1` → `gemini-4-neon` → `gemini-4-hydrogen` → `gemini-3.8-flash-lite-tts`) and **Gemini Live Native Audio WebSocket** (`gemini-3.8-live`) with live microphone + optional counter camera vision frames.
- **Element 119 ("Where It Breaks")**: Include a reproducible Stress Lab comparing an uncalibrated fast baseline (`gemini-4-hydrogen`) against the orchestrated VoicePizza pipeline (`gemini-decision-1` + `gemini-4-neon` + `gemini-4-hydrogen`) across escalating acoustic chaos (Level 1 → Level 2 → Level 3).
- **Bonus Track (Build with Commerce / Shopify)**: Generate real structured Shopify Draft Order JSON payloads (`draft_order` with line item SKUs, custom properties for speaker/language/modifiers, allergen tags, and 8.5% tax) directly from confirmed tickets.

### 2. Paid Gemini API Confirmation
- Confirmed usage of a paid Gemini API key for server-side Gemini 4 Neon, Gemini 4 Hydrogen, Gemini 3.8 Live, Gemini 3.5 Transcribe, Gemini 3.8 Flash Lite TTS, and Decisions API (`gemini-decision-1`).

### 3. Live Voice Responsiveness & Audio Engineering Fixes
- Reported that live voice input needed reliable responsiveness, visual confirmation of microphone capture, and noise handling in loud environments.
- Confirmed **"YES to all 1, 2, 3"**:
  1. Real-time **Visual Audio Meter** (`AudioMeter.tsx`) showing live waveform/dB/RMS level and speech gate state.
  2. **Dynamic Noise Floor Thresholding** (`audioMath.ts` + `audioEngine.ts`) adapting automatically to background pizzeria noise so ambient chatter does not falsely trigger or block real speech, plus trailing silence flush (`audioStreamEnd`) for responsive Gemini Live turn completion.
  3. **Live Detected Language Indicator** (`languageDetect.ts`) displaying detected spoken language(s) in real time across **90+ Gemini-supported languages**, alongside Agora CLI/skills research for real-time audio tooling.

### 4. Status Check
- *"is it all done and perfectly working?"*

### 5. Local Port Configuration & Troubleshooting
- *"can you change the port from 3000 to 3004 (http://localhost:3004)"*
- *"so what port should I run to test locally?"*
- *"http://localhost:3000 not working; find the issue and fix it"*
- *"failed again"*
  - Root cause found and fixed: Vite 8 blocked external preview/host headers with `403 Forbidden` unless `allowedHosts: true` was explicitly configured in both `vite.config.ts` and `server.ts`, while `server.ts` was updated to support both `PORT` env var (default `3000`) and CLI `--port` flag (`PORT=3004 npm run dev` for local testing on 3004).

### 6. Model Switch to Gemini 4 Neon
- *"Can you change the GEMINI model to NEON"*
  - Updated default Shift Assistant chat model in `server.ts` and `src/components/ChatAssistant.tsx` to `gemini-4-neon` (alongside `gemini-4-neon` already serving as the primary multi-speaker orchestration brain in `server/cascadedPipeline.ts`).
- *"what model are you?"*

### 7. Exact Order Math, Confirmed Timestamps, Kitchen Stage Clarity & Previous Orders Separation
- *"Can you fix this part? whatever the customer orders including the total amount is not the exact reflection in the Orders section and neither on the Station. Can you please fix it? also date stamp date, day, time , minute and second once an order is confirmed that must be visible. In case of previous Orders why do you keep it in order section ? what does it actually mean by OVEN? INCOMING? READY? explain and fix it"*
  - Fixed end-to-end exact itemized pricing (`Subtotal + 8.5% Sales Tax = Exact Total`), removed fake pre-seeded orders, bound Live session tool calls to a single authoritative ticket, added `action: 'add' | 'set' | 'remove'` and fuzzy menu aliases, synced exact totals into spoken/text replies, added full Day + Date + HH:MM:SS confirmation timestamps, added plain-English Kitchen Stage Legend (`Incoming`, `In Oven`, `Ready for Pickup`, `Completed / Paid`), and separated `Active Orders` from `Previous Orders (Paid)` with one-click cleanup.

### 8. GitHub Deployment & Complete Documentation
- *"Now can you deploy it to my github under VoicePizza repo which is already opened with all of the works that done by NEON and HYDROGEN including bug fixes, your codes, all of the prompts from both ends under PROMPTS.md, all of the assets and every little things? Explain how why where when GEMINI and what are the tools and techstacks been used in the project. this is my github https://github.com/vim719/VoicePizza"*

---

## Part 2 — Application-to-Gemini Prompts (Exact Runtime Prompts)

All prompts below are verbatim from the VoicePizza server modules.

---

### A. Gemini 3.8 Live (`gemini-3.8-live`) — System Instruction & Function Tools
**File**: `server/liveBridge.ts`  
**When called**: Immediately when the user opens a live bidirectional audio/camera WebSocket session (`/api/live?channel=phone|counter`).

#### System Instruction
```text
You are VoicePizza, a live multilingual pizzeria voice agent operating in ${
  channel === 'phone' ? 'P1 Phone Line' : 'P2 Busy Counter Chaos'
} mode.
CRITICAL MULTILINGUAL & EXACT ORDER RULES:
1) You fluently understand and speak all 90+ Gemini-supported languages (including British English, Spanish, German, Italian, Greek, Mandarin Chinese, French, Portuguese, Japanese, Korean, Arabic, Hindi, Turkish, Polish, Dutch, Vietnamese, and more) in the SAME conversation.
2) Always reply aloud clearly in the exact language(s) spoken by the customer(s). If two people speak on the same call or at the counter in different languages, answer BOTH in their own languages in one spoken reply and call upsert_order_item for each item with their exact BCP-47 languageCode.
3) EXACT TOTALS & ORDER SYNC: Sales tax is 8.5%. NEVER calculate, round, or guess totals in your head! Always call upsert_order_item for EVERY item ordered (use action="set" to change a quantity or action="remove" to cancel an item). Then read back the EXACT items, subtotal, 8.5% tax, and final total returned by the upsert_order_item tool response so your spoken confirmation matches the Station and Orders board to the exact cent.
4) After calling any tool (upsert_order_item or route_non_order_speaker), ALWAYS speak a concise, friendly confirmation aloud in the customer's language with the exact total from the tool response.
5) In noisy counter environments, ignore background complaints or supplier deliveries for the food cart, and instead call route_non_order_speaker so the Spanish counter clerk and Italian owner see what happened.
6) If the counter camera shows allergen notes, ingredients, or packaging, acknowledge what you see.
Menu items (prices before 8.5% tax): ${MENU_LIST}. Keep spoken replies concise, warm, and natural.
```

#### Function Tool Declarations Provided to `gemini-3.8-live`
1. **`upsert_order_item`**
   - *Description*: *"Adds, updates quantity of, or removes a pizza, dessert, or drink item on the live pizzeria order board, attributed to the exact speaker and language. Returns the exact authoritative ticket items, subtotal, 8.5% tax, total, and confirmation timestamp."*
   - *Parameters*: `menuItemId` (required), `quantity` (required), `action` (`"add" | "set" | "remove"`), `assignedTo` (required), `languageCode` (required), `modifiers` (array of strings), `partyLabel`, `newOrder` (boolean).
2. **`route_non_order_speaker`**
   - *Description*: *"Routes non-order speech (supplier delivery, queue complaint, staff request) to the counter staff in Spanish and Italian without adding items to a food order."*
   - *Parameters*: `role` (`supplier_delivery | queue_complaint | counter_staff | other`), `languageCode`, `summary`, `staffActionEs`, `staffActionIt`.

---

### B. Gemini 3.5 Transcribe (`gemini-3.5-transcribe`) — Raw Audio ASR
**File**: `server/cascadedPipeline.ts` (`transcribeRawAudio`)  
**When called**: Step 1 of Cascaded Mode whenever raw recorded microphone or scenario audio is submitted.

```text
Transcribe every audible speaker accurately in their original language across all 90+ Gemini-supported languages (preserving native script). Label overlapping turns if multiple voices are heard.
```

---

### C. Gemini Decisions API (`gemini-decision-1`) — Calibrated Zero-Token Triage
**File**: `server/cascadedPipeline.ts` (`evaluateWithDecisionsApi`)  
**When called**: Step 2 of Cascaded Mode (multimodal audio + optional camera frame + text), post-turn scoring in Gemini Live mode, and inside the Element 119 Stress Lab.

| Question Key | Decision Type | Instructions | Criteria |
| --- | --- | --- | --- |
| `is_customer_order_intent` | `noul` (calibrated probability) | *"Does this pizzeria audio/text contain at least one customer placing, modifying, or asking about a food or drink order?"* | `true_description`: *"Contains a customer food or drink order, modifier, or menu inquiry."*<br>`false_description`: *"Only supplier delivery, staff-only kitchen talk, or complaint without an order."* |
| `speaker_role` | `choice` | *"Who is the dominant or highest-priority speaker needing action in this input?"* | `customer_primary`, `customer_companion`, `counter_staff`, `supplier_delivery`, `queue_complaint`, `other` |
| `primary_language` | `choice` | *"Which primary language is spoken first or most prominently in this input?"* | `en`, `de`, `es`, `it`, `el`, `zh`, `other` (any other of the 90+ Gemini-supported languages) |
| `chaos_severity` | `score` (0–3 rubric) | *"Rate the acoustic and conversational complexity of this pizzeria turn."* | 0: Single clear speaker<br>1: Two cooperative bilingual speakers<br>2: 3–4 overlapping voices / side chatter<br>3: Severe 5+ speaker acoustic chaos, complaint, delivery, or allergen alert |

---

### D. Gemini 4 Neon (`gemini-4-neon`) — Multi-Speaker Orchestration & Attribution
**File**: `server/cascadedPipeline.ts` (`runCascadedTurn`)  
**When called**: Step 3 of Cascaded Mode (`thinkingLevel: MEDIUM`, strict JSON `responseSchema`, receives raw audio + camera image + Decisions API pre-triage + ASR transcript).

```text
You are VoicePizza's multilingual orchestration brain operating in "${
  params.channel === 'phone' ? 'P1 Phone Line' : 'P2 Over-the-Counter Chaos'
}" mode.
You can hear raw overlapping voices directly from the audio AND see counter camera frames if attached.
Do NOT drop secondary speakers! Across all 90+ Gemini-supported languages—whether a British English caller and German wife speak together, or Chinese, Greek, French, Japanese, Hindi, Arabic, Spanish, and Italian voices overlap at the counter:
1) Separate every distinct speaker into its own segment with accurate BCP-47 languageCode (e.g., en-GB, de-DE, es-ES, it-IT, el-GR, zh-CN, fr-FR, pt-BR, ja-JP, ko-KR, ar-SA, hi-IN, tr-TR, pl-PL).
2) Attribute food/drink menu items ONLY to actual ordering customers (never turn a queue complaint or supplier delivery into a pizza order!).
3) Match menu items strictly to the catalog IDs below and capture modifiers (especially allergies like gluten-free / glutenfrei, well done, extra garlic, no chili).
4) Write a warm, concise reply in EACH speaker's own language (replyText + replyLanguageCode), AND produce combinedAgentSpeech that confirms the ordered items naturally in their respective languages. Do NOT invent or estimate a dollar total in combinedAgentSpeech (the exact subtotal + 8.5% tax total is calculated automatically by the POS engine right after extraction).
5) If there is a non-order operational event (supplier delivery, queue complaint, staff confusion), populate nonOrderAlerts with clear Spanish (for the counter clerk) and Italian (for the owner) action notes.

Menu Catalog (pre-tax prices; 8.5% sales tax applied by POS):
${MENU_SUMMARY}

Decisions API Pre-Triage:
${JSON.stringify(triage)}

ASR Transcript:
"${rawTranscript}"
```

---

### E. Gemini 4 Hydrogen (`gemini-4-hydrogen`) — Ultra-Fast Bilingual Kitchen Ticket Translation
**File**: `server/cascadedPipeline.ts` (`runCascadedTurn`)  
**When called**: Step 4 of Cascaded Mode (`thinkingLevel: LOW`, JSON schema) immediately whenever 1+ order items are extracted.

```text
Format a concise kitchen ticket for these pizzeria items: ${JSON.stringify(allExtractedItems)}. Provide an Italian note for the pizzaiolo (kitchenNoteIt) and a Spanish note for the counter clerk (counterNoteEs), highlighting any allergen or gluten-free warnings.
```

---

### F. Gemini 3.8 Flash Lite TTS (`gemini-3.8-flash-lite-tts`) — Spoken Reply & Chaos Track Synthesis
**File**: `server/cascadedPipeline.ts` (`synthesizeAudioClip`, `synthesizeChaosScenarioTracks`)  
**When called**: Step 5 of Cascaded Mode for the customer-facing spoken confirmation (with authoritative POS total appended), and when synthesizing multi-speaker audio tracks in the Stress Lab / Chaos Simulator.

- **Customer Host Reply (`Zephyr`)**:
  - *Speech Style*: `"Warm, efficient Italian pizzeria host switching effortlessly between languages"`
  - *Spoken Text Pattern*: `${baseSpeech} Confirmed Ticket #${ticketNumber}. Your exact total including 8.5% tax is ${exactTotal}.`
- **Chaos Scenario Track Styles**:
  - `queue_complaint`: `"Impatient, loud customer in a noisy restaurant queue"`
  - `supplier_delivery`: `"Hurried delivery driver calling over shop noise"`
  - Default customer / staff: `"Natural conversational tone in a lively pizzeria"`

---

### G. Element 119 Stress Lab ("Where It Breaks") Prompts
**File**: `server/cascadedPipeline.ts` (`runElement119StressTest`)

1. **Uncalibrated Baseline Prompt (`gemini-4-hydrogen`, `ThinkingLevel.LOW`, no Decisions API)**:
```text
Extract all pizza order items from this noisy counter input into JSON array {items: [{menuItemId, quantity}]}. Menu IDs: ${menuIds}. Input:
${simulatedMixedTranscript}
```

2. **Orchestrated VoicePizza Pipeline Prompt (`gemini-decision-1` → `gemini-4-neon`, `ThinkingLevel.MEDIUM`)**:
```text
You are disambiguating a ${speakerSliceCount}-speaker overlapping pizzeria environment.
Decisions API Triage: ${JSON.stringify(triage)}
Filter out queue complaints (table 4 waiting) and supplier deliveries (20 crates of tomatoes), and extract ONLY actual customer takeaway pizza orders with strict menu IDs from:
${MENU_SUMMARY}
Acoustic capture:
${simulatedMixedTranscript}
```

---

### H. Shift Assistant Multi-Turn Chat (`gemini-4-neon` default, switchable with Hydrogen / Carbon / 3.1 Flash Lite)
**File**: `server/chatManager.ts` (`buildSystemInstruction`)

```text
You are VoicePizza's multilingual pizzeria assistant (${rolePersona}).
Respond fluently in whichever language(s) the user or customer uses (English, Spanish, German, Italian, Greek, Mandarin Chinese, etc.).
Menu: ${menuSummary}
Live Kitchen Tickets:
${activeOrders || 'No active orders yet.'}
```

---

### I. Visual Assets Generation Briefs (`src/assets/images/`)
Generated bespoke editorial pizzeria photography stored locally and bundled via Vite:
1. `hero_pizzeria_counter_1795280909275.jpg` — Warm wood-fired artisan Neapolitan pizzeria counter and brick oven atmosphere.
2. `pizza_margherita_dop_1795280908611.jpg` — Neapolitan Margherita D.O.P. with San Marzano tomatoes, fior di latte mozzarella, and fresh basil.
3. `pizza_diavola_piccante_1795280908474.jpg` — Spicy Calabrian salami Diavola Piccante with blistered crust and chili oil.
4. `pizza_tartufo_funghi_1795280909298.jpg` — Cremini mushroom and black truffle cream Tartufo & Funghi white pizza.

---

## Part 3 — Summary of Bug Fixes & Hardening Completed Across Hydrogen & Neon

| Area | Issue Identified | Resolution |
| --- | --- | --- |
| **Vite 8 Host Blocking** | Accessing the server via preview/Cloud Run hosts returned `403 Forbidden` (blocked host header). | Configured `allowedHosts: true as const` in `vite.config.ts` and `allowedHosts: true` in `server.ts`. |
| **Port Flexibility** | Needed seamless local testing on port `3004` while keeping default port `3000` for AI Studio preview. | Updated `server.ts` to read `--port` CLI flag or `process.env.PORT` (defaulting to `3000`). |
| **Live Voice Capture & Noise** | No visual feedback of mic levels; ambient background noise caused premature/missed turns in noisy rooms. | Built `AudioMeter.tsx`, dynamic noise-floor gating in `src/shared/audioMath.ts` & `src/utils/audioEngine.ts`, and 800ms silence flush + `audioStreamEnd` in `server/liveBridge.ts`. |
| **Multilingual Detection (90+ Languages)** | Limited initial language labels and Spanish/Portuguese lexical tie on `"por favor"`. | Built `src/shared/languageDetect.ts` covering 95+ ISO-639-1 languages with Unicode script detection + refined Latin lexicons + `Intl.DisplayNames` fallback. |
| **Exact Order Sync & Totals** | Spoken totals could drift from POS tax math, partial item aliases were dropped, multiple Live tool calls split across tickets, and 2 fake orders appeared on startup. | Added fuzzy `MENU_ALIASES` in `menu.ts`; removed pre-seeded orders in `stateStore.ts`; bound all Live calls to `activeSessionTicketId` with `add/set/remove` actions; returned authoritative POS itemized subtotal + 8.5% tax + total from `upsert_order_item` and appended exact POS total to Cascaded speech. |
| **Confirmed Timestamp** | Orders only showed rough time without full day, date, and seconds. | Added `confirmedAt` & `updatedAt` timestamps formatted via `formatOrderTimestamp()` (`Day, Mon DD, YYYY · HH:MM:SS AM/PM`) across Station and Orders Board. |
| **Kitchen Stages & Previous Orders** | `INCOMING`, `OVEN`, `READY` lacked clear explanation and paid/previous orders cluttered the active orders queue. | Added plain-English Kitchen Stage Legend (`Incoming → In Oven → Ready for Pickup → Completed / Paid`), split **Active Orders** from **Previous Orders (Paid)**, and added **Clear Previous Orders** + per-ticket removal endpoints (`DELETE /api/orders/completed`, `DELETE /api/orders/:id`). |
| **Default Chat Model** | Shift Assistant initially defaulted to Hydrogen. | Switched default Shift Assistant model to **`gemini-4-neon`** across `server.ts` and `src/components/ChatAssistant.tsx` while keeping live model selector for comparison. |
