# VoicePizza — Multilingual Live Voice & Counter Order Agent

> **Project Author / Solution Architect**: **SAL** (`vim719`)  
> Looking for every prompt used both to build the app and inside the app at runtime? See **[`PROMPTS.md`](./PROMPTS.md)**.

**VoicePizza** is a full-stack, real-time multilingual voice and multimodal order orchestration platform built for busy pizzerias running **P1 Phone Line** and **P2 Over-the-Counter Chaos** operations—engineered with **Gemini 4 Neon**, **Gemini 4 Hydrogen**, **Gemini 3.8 Live**, **Gemini 3.5 Transcribe**, **Gemini 3.8 Flash Lite TTS**, and the **Gemini Decisions API (`gemini-decision-1`)**.

---

## The Problem We Are Solving & SAL's Solution

### The Real-World Problem
Independent neighborhood pizzerias—often operated by multilingual teams (such as an Italian owner/pizzaiolo and a Spanish-speaking counter clerk)—suffer severe order loss, allergen errors, and front-of-house bottlenecks during dinner rush across **three compounding failure points**:

1. **P1 — Multi-Party Multilingual Phone Calls**: Multiple people share a single phone call while speaking different languages (e.g., a British English caller ordering pizzas while their German-speaking partner chimes in to add a gluten-free item or modifier). Conventional single-language voice agents drop the secondary speaker, miss critical allergy requests, or fail to confirm in both languages.
2. **P2 — Over-the-Counter Acoustic Chaos (60–90 dB)**: At a crowded walk-up counter, real takeaway orders overlap with background interruptions in different languages—such as a waiting Greek customer complaining about Table 4's delayed pizza, a Mandarin Chinese delivery driver asking where to unload 20 crates of tomatoes, and staff shouting across the oven pass. Standard voice AI turns complaints and deliveries into phantom food orders or collapses under overlapping speech.
3. **POS Math Drift, Ambiguous Kitchen States & Cluttered Order Boards**: In real restaurant operations, letting an LLM guess totals causes spoken quotes to disagree with the POS screen; missing second-level confirmation timestamps makes rush auditing impossible; cryptic labels (`INCOMING`, `OVEN`, `READY`) confuse new staff; and keeping already-paid history mixed into live active orders slows down kitchen fulfillment.

### SAL's End-to-End Solution
To solve all three problems reliably in one unified production workspace, SAL designed and iteratively engineered **VoicePizza**:

- **Dual-Mode 90+ Language Voice Architecture**: Runs both **Gemini 3.8 Live** (sub-second bidirectional native audio + optional counter camera vision with barge-in) and a **5-stage Cascaded Pipeline** (`gemini-3.5-transcribe` → `gemini-decision-1` → `gemini-4-neon` → `gemini-4-hydrogen` → `gemini-3.8-flash-lite-tts`), hearing every speaker in their own language and replying to all parties without dropping secondary voices.
- **Calibrated Chaos Triage & Bilingual Staff Routing**: Uses the **Gemini Decisions API (`gemini-decision-1`)** alongside **Gemini 4 Neon** to distinguish genuine customer orders from complaints and supplier deliveries—keeping phantom items off the ticket while immediately generating Spanish (`counterNoteEs`) and Italian (`kitchenNoteIt`) action alerts for staff via **Gemini 4 Hydrogen**.
- **Noise-Resilient Live Audio Engineering**: Integrates a live visual `AudioMeter`, adaptive dynamic noise-floor gating for loud restaurant environments, trailing silence flush (`audioStreamEnd`) for responsive turn completion, and a real-time 90+ language indicator.
- **Exact POS Synchronization, Full Timestamps & Clean Kitchen Workflow**: Binds every voice/tool update to a single authoritative integer-cent POS engine (`Subtotal + 8.5% Sales Tax = Exact Total`) so spoken totals match the **Station** and **Orders** screens to the penny, stamps every confirmed ticket with **Day of Week, Date, Hour, Minute, and Second**, explains every kitchen stage (`Incoming → In Oven → Ready for Pickup → Completed / Paid`), and cleanly separates **Active Orders** from **Previous Orders (Paid)** with one-click cleanup.
- **Element 119 ("Where It Breaks") Stress Lab & Shopify Commerce Export**: Proves empirically where an uncalibrated single model (`gemini-4-hydrogen`) fails under 2-, 4-, and 6-speaker overlap vs. the orchestrated Gemini pipeline, and exports every confirmed ticket as a ready-to-submit **Shopify Draft Order JSON** payload.

---

## Why, Where, When & How Gemini Is Used

VoicePizza deliberately splits work across **specialized Gemini models** instead of forcing a single model to handle low-latency voice streaming, calibrated chaos triage, complex multi-speaker disambiguation, and fast kitchen ticket translation simultaneously.

### Model-by-Model Breakdown

| Gemini Model | **Where** (Module) | **When** (Trigger) | **How** (API / Mode) | **Why** (Architectural Role) |
| --- | --- | --- | --- | --- |
| **Gemini 4 Neon** (`gemini-4-neon`) | `server/cascadedPipeline.ts`<br>`server/chatManager.ts`<br>`server.ts` | • Step 3 of every Cascaded voice/text/camera turn<br>• Element 119 orchestrated stress test<br>• Default Shift Assistant multi-turn chat | `ai.models.generateContent()` with `ThinkingLevel.MEDIUM`, multimodal inline audio + JPEG frame + structured JSON `responseSchema`; `ai.chats.create()` for Shift Assistant | **Primary reasoning & multi-speaker attribution brain.** Separates overlapping voices across 90+ languages, protects secondary speakers (e.g., German wife on an English call), extracts strict menu IDs & allergen modifiers, and refuses to turn queue complaints or supplier deliveries into food orders. |
| **Gemini 4 Hydrogen** (`gemini-4-hydrogen`) | `server/cascadedPipeline.ts`<br>`server/chatManager.ts` | • Step 4 of Cascaded turn (whenever ≥ 1 order item is extracted)<br>• Element 119 uncalibrated baseline benchmark<br>• Optional fast mode in Shift Assistant | `ai.models.generateContent()` with `ThinkingLevel.LOW` and strict JSON `responseSchema` | **Ultra-low-latency kitchen ticket translator & baseline benchmark.** Instantly translates confirmed items and allergen warnings into an Italian pizzaiolo pass note (`kitchenNoteIt`) and a Spanish counter clerk note (`counterNoteEs`). Also serves as the fast uncalibrated baseline in the Stress Lab so we can measure exactly where single-model extraction breaks. |
| **Gemini 3.8 Live** (`gemini-3.8-live`) | `server/liveBridge.ts` | • Whenever the user activates **Gemini Live** mode on `/api/live` WebSocket | `ai.live.connect()` (`v1beta`), bidirectional 16kHz PCM audio streaming + optional JPEG counter camera frames + `Modality.AUDIO` (`Zephyr` voice) + real-time function calling (`upsert_order_item`, `route_non_order_speaker`) | **Sub-second bidirectional native audio & vision agent.** Handles natural barge-in/interruption, hears overlapping multilingual speech directly, reads back authoritative POS totals returned by tool calls, and streams spoken audio back to the browser in real time. |
| **Gemini 3.5 Transcribe** (`gemini-3.5-transcribe`) | `server/cascadedPipeline.ts` | • Step 1 of Cascaded turn when raw audio is recorded or uploaded | `ai.models.generateContent()` (`v1beta`) with raw inline audio (`audio/webm`, `audio/wav`, etc.) | **High-accuracy multilingual ASR.** Preserves native scripts across 90+ languages (Greek, Mandarin, German, Italian, Spanish, Japanese, Arabic, etc.) and labels overlapping turns before downstream triage. |
| **Gemini Decisions API** (`gemini-decision-1`) | `server/cascadedPipeline.ts`<br>`server/liveBridge.ts` | • Step 2 of Cascaded turn (audio + image + text)<br>• Post-turn telemetry triage after every Live turn<br>• Pre-triage inside Element 119 Stress Lab | `ai.decisions.create()` (`v1beta`) returning calibrated `noul` probability, `choice` classification, and `score` rubric | **Calibrated, deterministic chaos gate.** Evaluates `is_customer_order_intent` (`noul`), `speaker_role` (`choice`), `primary_language` (`choice`), and `chaos_severity` (0–3 `score`) with calibrated confidence scores so Neon knows whether it is dealing with a calm call or 6-speaker counter chaos. |
| **Gemini 3.8 Flash Lite TTS** (`gemini-3.8-flash-lite-tts`) | `server/cascadedPipeline.ts` | • Step 5 of Cascaded turn for spoken order confirmation<br>• Multi-speaker Chaos Scenario audio synthesis | `ai.models.generateContent()` (`v1beta`) with `responseModalities: ['AUDIO']` and `speechMetadata.style` (`Zephyr`, `Puck`, `Charon`, `Kore`, `Fenrir`) | **Expressive multilingual voice synthesis.** Speaks the confirmed order and exact tax-inclusive total back to the customer in their own language(s), and synthesizes realistic multi-voice pizzeria chaos clips for reproducible testing. |
| **Gemini 4 Carbon** (`gemini-4-carbon`) & **Gemini 3.1 Flash Lite** (`gemini-3.1-flash-lite`) | `server/chatManager.ts`<br>`src/components/ChatAssistant.tsx` | • Optional selectable models in the Shift Assistant drawer | `ai.chats.create()` with live session history migration | Allows staff or judges to switch Shift Assistant reasoning depth on the fly without losing conversation history. |

---

## System Architecture & Data Flow

### 1. Dual Voice Architectures
VoicePizza lets operators switch between two live production architectures from the Station Workspace:

```text
┌────────────────────────────────────────────────────────────────────────────┐
│                        Browser (React 19 + Web Audio API)                  │
│  Mic (48kHz→16kHz PCM) ─► Dynamic Noise Floor Gate ─► Live AudioMeter      │
│  Optional Counter Camera (JPEG) ─► Live 90+ Language Indicator             │
└──────────────────┬───────────────────────────────────────┬─────────────────┘
                   │ WebSocket (/api/live)                 │ HTTP POST (/api/cascaded/turn)
                   ▼                                       ▼
┌─────────────────────────────────────────┐ ┌─────────────────────────────────────────────┐
│        GEMINI LIVE ARCHITECTURE         │ │            CASCADED ARCHITECTURE            │
│  gemini-3.8-live (Native Audio/Vision)  │ │  1. gemini-3.5-transcribe (Multilingual ASR)│
│   ├─ Tool: upsert_order_item            │ │  2. gemini-decision-1 (Calibrated Triage)   │
│   │   └─ Returns EXACT POS Subtotal,    │ │  3. gemini-4-neon (Speaker Attribution)     │
│   │      8.5% Tax, Total & Timestamp    │ │  4. gemini-4-hydrogen (IT/ES Kitchen Notes) │
│   ├─ Tool: route_non_order_speaker      │ │  5. POS Engine (Exact Total + Timestamp)    │
│   └─ Post-turn: gemini-decision-1       │ │  6. gemini-3.8-flash-lite-tts (Audio Reply) │
└──────────────────┬──────────────────────┘ └──────────────────────┬──────────────────────┘
                   └───────────────────────┬───────────────────────┘
                                           ▼
                 ┌──────────────────────────────────────────────────┐
                 │   Authoritative POS Store (server/stateStore.ts) │
                 │  • Single Source of Truth for Items & 8.5% Tax   │
                 │  • Confirmed Day, Date, HH:MM:SS Timestamp       │
                 │  • Active Queue vs. Previous Orders (Paid)       │
                 │  • Non-Order Bilingual Staff Alerts (ES / IT)    │
                 │  • Shopify Draft Order JSON Export               │
                 └──────────────────────────────────────────────────┘
```

### 2. Exact Order Synchronization & Confirmed Timestamps
To prevent LLMs from hallucinating arithmetic or splitting one customer's order across multiple tickets:
- **Deterministic POS Engine (`src/shared/orderEngine.ts`)**: All line totals, subtotals, **8.5% sales tax**, and final totals are computed in integer cents (`subtotalCents`, `taxCents`, `totalCents`).
- **Fuzzy Spoken Menu Matching (`src/shared/menu.ts`)**: Spoken names and aliases (e.g., `"sparkling water"`, `"margherita pizza"`, `"spicy pepperoni"`, `"truffle mushroom"`) deterministically resolve to canonical catalog SKUs.
- **Single-Ticket Live Binding (`server/liveBridge.ts`)**: All `upsert_order_item` calls in a Live call stay bound to `activeSessionTicketId` with explicit `add`, `set`, and `remove` actions. The tool returns the exact POS totals and confirmation timestamp so Gemini reads back the exact penny shown on both **Station** and **Orders**.
- **Full Confirmation Timestamp**: Every confirmed order displays **Day of Week, Date, Hour, Minute, and Second** (e.g., `Saturday, Nov 21, 2026 · 12:04:18 PM`) on both the Live Station ticket card and the Orders Board.

### 3. Kitchen Order Stages & Active vs. Previous Orders
The Orders Board includes a clear plain-English **Kitchen Stage Legend** and separates active work from completed history:
- **Incoming (New Order)**: Order just confirmed by voice and waiting to be started by the kitchen.
- **In Oven (Cooking)**: Pizzaiolo is preparing and baking the pizzas in the wood-fired oven.
- **Ready for Pickup**: Hot and boxed at the counter, ready to hand to the customer.
- **Completed / Paid (Previous Orders)**: Customer has paid and picked up the order. Paid tickets automatically move out of **Active Orders** into the **Previous Orders (Paid)** tab so the live kitchen queue stays clean, with a **Clear Previous Orders** button and per-ticket removal controls.

### 4. Element 119 Stress Lab ("Where It Breaks")
Accessible in the **Element 119** tab:
- Synthesizes or runs 2-speaker (**Level 1 · 62 dB**), 4-speaker (**Level 2 · 78 dB**), and 6-speaker (**Level 3 · 89 dB**) multilingual chaos scenarios.
- Benchmarks an uncalibrated fast baseline (`gemini-4-hydrogen`, low thinking, no triage) side-by-side against our orchestrated pipeline (`gemini-decision-1` + `gemini-4-neon` + `gemini-4-hydrogen`), reporting exact item recall %, latency, failure notes (e.g., turning Table 4's Greek complaint into a phantom Diavola pizza), and Decisions API confidence.

### 5. Shopify Commerce Bonus Track
Every confirmed ticket on the Orders Board exposes a **Shopify Draft Order** payload (`buildShopifyDraftOrderPayload` in `src/shared/orderEngine.ts`) formatted to Shopify Admin REST `draft_order` specifications, including SKU, price, custom line-item properties (`Speaker`, `Language`, `Modifiers`), allergen tags, bilingual kitchen notes, and 8.5% sales tax.

---

## Tools & Tech Stack

### Frontend
- **React 19** + **TypeScript 7** (`src/`)
- **Vite 8** (`@vitejs/plugin-react`)
- **Tailwind CSS v4** (`@tailwindcss/vite`)
- **Lucide React** (icons) & **Motion** (`motion/react` animations)
- **Web Audio API** (`src/utils/audioEngine.ts`, `src/shared/audioMath.ts`): 48kHz→16kHz PCM resampling, real-time `AudioMeter`, adaptive noise-floor speech gating, and multi-track chaos mixer
- **Real-Time 90+ Language Detector** (`src/shared/languageDetect.ts`): Unicode script detection + Latin diacritic/lexicon disambiguation + `Intl.DisplayNames` fallback

### Backend & Real-Time Streaming
- **Node.js + Express 4** (`server.ts`, executed via `tsx`)
- **WebSocket Server (`ws`)** (`server/liveBridge.ts`) bridging browser PCM audio & JPEG frames to `gemini-3.8-live`
- **Official Google GenAI SDK (`@google/genai` v3.6+)** (`server/geminiClients.ts`, `server/cascadedPipeline.ts`, `server/liveBridge.ts`, `server/chatManager.ts`)
- **Dotenv** for local environment configuration

### Testing & Verification
- **Node native test runner (`node:test`)** via `tsx --test src/shared/orderEngine.test.ts` (15 unit tests covering menu matching, exact 8.5% tax math, `add/set/remove` merging, formatted day/date/HH:MM:SS timestamps, Shopify Draft Order generation, noise-floor audio math, and 90+ language detection)
- **TypeScript strict type-checking** (`npm run lint` / `tsc --noEmit`)
- **Production Vite bundle verification** (`npm run build`)

---

## Repository Structure

```text
VoicePizza/
├── README.md                          # Architecture, Gemini matrix, tech stack & run guide
├── PROMPTS.md                         # Complete log of all User-to-AI and App-to-Gemini prompts
├── metadata.json                      # App metadata & microphone/camera capabilities
├── package.json                       # Dependencies & scripts
├── vite.config.ts                     # Vite 8 + React + Tailwind v4 config (allowedHosts enabled)
├── tsconfig.json                      # TypeScript configuration
├── index.html                         # HTML entry point & fonts
├── .env.example                       # Environment template (no secrets)
├── server.ts                          # Express HTTP + WebSocket + Vite dev/static server
├── server/
│   ├── geminiClients.ts               # Server-side @google/genai stable & v1beta client factories
│   ├── liveBridge.ts                  # Gemini 3.8 Live WebSocket bridge & function tool handlers
│   ├── cascadedPipeline.ts            # 5-step Cascaded pipeline + Element 119 Stress Lab + TTS
│   ├── chatManager.ts                 # Multi-turn Shift Assistant (Gemini 4 Neon default)
│   └── stateStore.ts                  # Authoritative in-memory POS store, tickets & staff alerts
└── src/
    ├── App.tsx                        # Main workspace state, navigation & API orchestration
    ├── main.tsx                       # React entry point
    ├── index.css                      # Tailwind v4 design tokens & typography
    ├── types/voicepizza.ts            # Shared TypeScript contracts
    ├── shared/
    │   ├── menu.ts                    # Pizzeria menu catalog, fuzzy aliases & chaos scenarios
    │   ├── orderEngine.ts             # Exact cent math, timestamps, stage labels & Shopify payload
    │   ├── audioMath.ts               # RMS/dB calculation & adaptive noise-floor gate
    │   ├── languageDetect.ts          # 90+ language real-time stream detector
    │   └── orderEngine.test.ts        # 15 unit tests (node:test)
    ├── utils/
    │   └── audioEngine.ts             # Mic PCM capture, 16kHz resampler, Live playback & mixer
    ├── components/
    │   ├── TopBar.tsx                 # Header navigation & live active order count
    │   ├── StationWorkspace.tsx       # P1 Phone / P2 Counter live console, AudioMeter & ticket sync
    │   ├── AudioMeter.tsx             # Live waveform, dB meter & noise gate visualizer
    │   ├── OrdersBoard.tsx            # Active vs. Previous Orders, Kitchen Stage Legend & Shopify export
    │   ├── StressLab.tsx              # Element 119 ("Where It Breaks") benchmark console
    │   ├── MenuCatalog.tsx            # Full pizzeria menu with photography & allergen tags
    │   └── ChatAssistant.tsx          # Shift Assistant drawer (Gemini 4 Neon default)
    └── assets/images/
        ├── hero_pizzeria_counter_1795280909275.jpg
        ├── pizza_margherita_dop_1795280908611.jpg
        ├── pizza_diavola_piccante_1795280908474.jpg
        └── pizza_tartufo_funghi_1795280909298.jpg
```

---

## Local Setup & Running VoicePizza

### Prerequisites
- Node.js 20+
- A Gemini API key (`GEMINI_API_KEY`) with access to Gemini 4 Neon, Gemini 4 Hydrogen, Gemini 3.8 Live, Gemini 3.5 Transcribe, Gemini 3.8 Flash Lite TTS, and Decisions API (`gemini-decision-1`).

### 1. Install Dependencies
```bash
npm install
```

### 2. Configure Environment Variables
Copy `.env.example` to `.env` and add your Gemini API key:
```bash
cp .env.example .env
# Edit .env and set:
# GEMINI_API_KEY="your-actual-gemini-api-key"
```

### 3. Run Locally
Default port (`http://localhost:3000`):
```bash
npm run dev
```

Or run on port `3001` (`http://localhost:3001`):
```bash
PORT=3001 npm run dev
```

### 4. Run Tests, Type-Check & Production Build
```bash
# Unit tests (15 tests: exact order math, timestamps, Shopify payload, audio DSP, 90+ languages)
npx tsx --test src/shared/orderEngine.test.ts

# TypeScript strict check
npm run lint

# Production bundle
npm run build
```
