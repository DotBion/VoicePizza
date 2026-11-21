import test from 'node:test';
import assert from 'node:assert/strict';
import {
  analyzeAudioFrame,
  classifyInputVolume,
  computeRmsLevel,
  createNoiseGateState,
  downsampleFloat32,
  processNoiseGateFrame,
} from './audioMath';
import { detectStreamLanguages, getLanguageLabel } from './languageDetect';
import { findMenuItemByIdOrName } from './menu';
import {
  buildOrderTicket,
  buildShopifyCheckoutPayload,
  calculateTicketTotals,
  canSwitchArchitecture,
  evaluateOrderRecall,
  formatOrderTimestamp,
  mergeOrderLineItems,
  nextOrderStatus,
  ORDER_STAGE_META,
} from './orderEngine';

test('downsampleFloat32 downsamples 48kHz to 16kHz accurately', () => {
  const src = new Float32Array(480);
  for (let i = 0; i < src.length; i++) {
    src[i] = Math.sin((2 * Math.PI * 440 * i) / 48000);
  }
  const down = downsampleFloat32(src, 48000, 16000);
  assert.equal(down.length, 160);
  assert.ok(Math.abs(down[0] - src[0]) < 1e-6);
});

test('computeRmsLevel returns 0 for silence and positive bounded value for signal', () => {
  assert.equal(computeRmsLevel(new Float32Array(128)), 0);
  const loud = new Float32Array(128).fill(0.5);
  assert.equal(computeRmsLevel(loud), 1);
});

test('analyzeAudioFrame computes RMS level, peak amplitude, and clamped dBFS', () => {
  const silent = analyzeAudioFrame(new Float32Array(128));
  assert.equal(silent.level, 0);
  assert.equal(silent.peak, 0);
  assert.equal(silent.dbfs, -60);

  const speech = new Float32Array(128).fill(0.08);
  const speechMetrics = analyzeAudioFrame(speech);
  assert.equal(speechMetrics.level, 0.32);
  assert.equal(speechMetrics.peak, 0.08);
  assert.ok(speechMetrics.dbfs > -25 && speechMetrics.dbfs < -18);

  const hot = new Float32Array(128).fill(0.96);
  const hotMetrics = analyzeAudioFrame(hot);
  assert.equal(hotMetrics.level, 1);
  assert.equal(hotMetrics.peak, 0.96);
  assert.equal(hotMetrics.dbfs, 0);
});

test('classifyInputVolume transitions across standby, quiet, voice_detected, too_loud, and clipping', () => {
  assert.equal(
    classifyInputVolume({ active: false, level: 0.4, peak: 0.4 }).state,
    'standby'
  );
  assert.equal(
    classifyInputVolume({ active: true, level: 0.03, peak: 0.05 }).state,
    'too_quiet'
  );
  assert.equal(
    classifyInputVolume({ active: true, level: 0.35, peak: 0.45 }).state,
    'voice_detected'
  );
  assert.equal(
    classifyInputVolume({ active: true, level: 0.78, peak: 0.78 }).state,
    'too_loud'
  );
  assert.equal(
    classifyInputVolume({ active: true, level: 0.5, peak: 0.55, sustainedLoudMs: 700 }).state,
    'too_loud'
  );
  assert.equal(
    classifyInputVolume({ active: true, level: 0.6, peak: 0.95 }).state,
    'clipping'
  );
  assert.equal(
    classifyInputVolume({
      active: true,
      level: 0.25,
      peak: 0.25,
      voiceThreshold: 0.43,
      gateOpen: false,
      noiseGateEnabled: true,
    }).label,
    'Background Chatter Ignored'
  );
});

test('dynamic noise gate calibrates to steady pizzeria chatter and triggers only on human voice', () => {
  // 1600 samples at 16kHz = 100ms per frame
  const chatterFrame = new Float32Array(1600).fill(0.06); // level = 0.24 steady chatter
  const voiceFrame = new Float32Array(1600).fill(0.14); // level = 0.56 human voice

  let state = createNoiseGateState();
  assert.equal(state.calibrating, true);

  // Calibrate across 800ms of steady pizzeria chatter
  for (let i = 0; i < 8; i++) {
    const res = processNoiseGateFrame(state, chatterFrame, 16000);
    state = res.nextState;
    assert.equal(res.shouldStreamToLive, false);
  }
  assert.equal(state.calibrating, false);
  assert.ok(state.noiseFloor >= 0.2 && state.noiseFloor <= 0.26);
  assert.ok(state.openThreshold > 0.38);

  // Continued steady chatter (even slightly bumped to 0.28) must stay gated
  const slightlyLouderChatter = new Float32Array(1600).fill(0.07); // level = 0.28
  for (let i = 0; i < 4; i++) {
    const res = processNoiseGateFrame(state, slightlyLouderChatter, 16000);
    state = res.nextState;
    assert.equal(res.gateOpen, false);
    assert.equal(res.shouldStreamToLive, false);
  }

  // Actual human voice (level = 0.56) opens the gate immediately
  const floorBeforeVoice = state.noiseFloor;
  const openRes = processNoiseGateFrame(state, voiceFrame, 16000);
  state = openRes.nextState;
  assert.equal(openRes.justOpened, true);
  assert.equal(openRes.gateOpen, true);
  assert.equal(openRes.shouldStreamToLive, true);

  // Two more frames of voice (total 300ms >= MIN_SPEECH_TURN_MS) do not inflate noise floor
  for (let i = 0; i < 2; i++) {
    const res = processNoiseGateFrame(state, voiceFrame, 16000);
    state = res.nextState;
    assert.equal(res.gateOpen, true);
  }
  assert.equal(state.noiseFloor, floorBeforeVoice);

  // Voice stops and returns to chatter: hangover keeps gate open briefly, then closes with speech flag
  let closedWithSpeech = false;
  for (let i = 0; i < 6; i++) {
    const res = processNoiseGateFrame(state, chatterFrame, 16000);
    state = res.nextState;
    if (res.justClosedWithSpeech) {
      closedWithSpeech = true;
      assert.equal(res.gateOpen, false);
    }
  }
  assert.equal(closedWithSpeech, true);
});

test('detectStreamLanguages identifies 90+ Gemini languages across scripts and bilingual voice streams', () => {
  assert.equal(detectStreamLanguages('').primary, null);
  assert.equal(
    detectStreamLanguages('Hi there, could we order one Margherita takeaway please?').primary?.code,
    'en'
  );
  assert.equal(
    detectStreamLanguages('Und für mich bitte eine Diavola glutenfrei ohne Chili!').primary?.code,
    'de'
  );
  assert.equal(
    detectStreamLanguages('Hola, ¿para llevar dos pizzas por favor?').primary?.code,
    'es'
  );
  assert.equal(
    detectStreamLanguages('Buongiorno, vorrei una Margherita senza aglio per favore.').primary?.code,
    'it'
  );
  assert.equal(
    detectStreamLanguages('Πού είναι η πίτσα μου, περιμένω είκοσι λεπτά!').primary?.code,
    'el'
  );
  assert.equal(
    detectStreamLanguages('你好，十箱面粉和番茄酱放哪里？').primary?.code,
    'zh'
  );
  assert.equal(
    detectStreamLanguages("Bonjour, je voudrais une pizza Margherita s'il vous plaît.").primary?.code,
    'fr'
  );
  assert.equal(
    detectStreamLanguages('Olá, gostaria de duas pizzas para viagem, por favor.').primary?.code,
    'pt'
  );
  assert.equal(
    detectStreamLanguages('こんにちは、マルゲリータを一つお願いします。').primary?.code,
    'ja'
  );
  assert.equal(
    detectStreamLanguages('안녕하세요, 마르게리타 피자 하나 주세요.').primary?.code,
    'ko'
  );
  assert.equal(
    detectStreamLanguages('مرحبا، أريد بيتزا مارغريتا من فضلك.').primary?.code,
    'ar'
  );
  assert.equal(
    detectStreamLanguages('नमस्ते, कृपया एक मार्गेरीटा पिज़्ज़ा दीजिए।').primary?.code,
    'hi'
  );
  assert.equal(
    detectStreamLanguages('Merhaba, iki tane pizza alabilir miyim lütfen?').primary?.code,
    'tr'
  );
  assert.equal(
    detectStreamLanguages('Привіт, будь ласка, одну піцу Маргарита з собою.').primary?.code,
    'uk'
  );

  const bilingual = detectStreamLanguages(
    'Hi there, one Margherita takeaway please. Und für mich bitte eine Diavola glutenfrei!'
  );
  const codes = bilingual.languages.map((l) => l.code);
  assert.ok(codes.includes('en') && codes.includes('de'));
  assert.equal(getLanguageLabel('de-DE'), 'German');
  assert.equal(getLanguageLabel('fr-CA'), 'French');
});

test('mergeOrderLineItems merges identical item+speaker+modifiers and flags allergens', () => {
  const first = mergeOrderLineItems([], [
    {
      menuItemId: 'margherita-dop',
      quantity: 1,
      modifiers: ['well done'],
      assignedTo: 'Husband',
      languageCode: 'en-GB',
    },
    {
      menuItemId: 'diavola-piccante',
      quantity: 1,
      modifiers: ['glutenfrei', 'no chili'],
      assignedTo: 'Wife',
      languageCode: 'de-DE',
    },
  ]);

  assert.equal(first.items.length, 2);
  assert.equal(first.allergenFlag, true);

  const second = mergeOrderLineItems(first.items, [
    {
      menuItemId: 'margherita-dop',
      quantity: 2,
      modifiers: ['well done'],
      assignedTo: 'Husband',
      languageCode: 'en-GB',
    },
  ]);

  assert.equal(second.items.length, 2);
  assert.equal(second.items[0].quantity, 3);
});

test('calculateTicketTotals computes subtotal, tax, and total in cents accurately', () => {
  const { items } = mergeOrderLineItems([], [
    { menuItemId: 'margherita-dop', quantity: 2, assignedTo: 'Guest' }, // 2900
    { menuItemId: 'tiramisu-casa', quantity: 1, assignedTo: 'Guest' }, // 850
  ]);
  const totals = calculateTicketTotals(items);
  assert.equal(totals.subtotalCents, 3750);
  assert.equal(totals.taxCents, Math.round(3750 * 0.085));
  assert.equal(totals.totalCents, 3750 + totals.taxCents);
});

test('buildShopifyCheckoutPayload formats SKUs, line properties, and allergen tags', () => {
  const { items } = mergeOrderLineItems([], [
    {
      menuItemId: 'diavola-piccante',
      quantity: 1,
      modifiers: ['gluten-free crust'],
      assignedTo: 'Wife',
      languageCode: 'de-DE',
    },
  ]);
  const ticket = buildOrderTicket({
    id: 'ord-1',
    ticketNumber: 101,
    channel: 'phone',
    architecture: 'cascaded',
    partyLabel: 'UK + DE Call',
    items,
  });
  const payload = buildShopifyCheckoutPayload(ticket);
  assert.equal(payload.draft_order.line_items[0].sku, 'VP-PIZ-DIAV-02');
  assert.ok(payload.draft_order.tags.includes('allergen-alert'));
  assert.equal(payload.draft_order.line_items[0].properties[0].value, 'gluten-free crust');
});

test('evaluateOrderRecall scores exact match 1.0 and penalizes missing or hallucinated items', () => {
  const expected = [
    { menuItemId: 'margherita-dop', quantity: 2 },
    { menuItemId: 'tartufo-funghi', quantity: 1 },
  ];
  assert.equal(
    evaluateOrderRecall(expected, [
      { menuItemId: 'margherita-dop', quantity: 2 },
      { menuItemId: 'tartufo-funghi', quantity: 1 },
    ]),
    1
  );
  const partial = evaluateOrderRecall(expected, [{ menuItemId: 'margherita-dop', quantity: 1 }]);
  assert.ok(partial > 0.3 && partial < 0.4);
});

test('canSwitchArchitecture blocks switching while session is active and allows when stopped', () => {
  assert.equal(canSwitchArchitecture(true).allowed, false);
  assert.equal(canSwitchArchitecture(false).allowed, true);
});

test('nextOrderStatus advances cleanly through kitchen states', () => {
  assert.equal(nextOrderStatus('incoming'), 'oven');
  assert.equal(nextOrderStatus('oven'), 'ready');
  assert.equal(nextOrderStatus('ready'), 'paid');
  assert.equal(nextOrderStatus('paid'), 'paid');
});

test('findMenuItemByIdOrName resolves spoken variations without dropping items', () => {
  assert.equal(findMenuItemByIdOrName('margherita pizza')?.id, 'margherita-dop');
  assert.equal(findMenuItemByIdOrName('sparkling water')?.id, 'chinotto-sparkling');
  assert.equal(findMenuItemByIdOrName('spicy pepperoni')?.id, 'diavola-piccante');
  assert.equal(findMenuItemByIdOrName('truffle mushroom')?.id, 'tartufo-funghi');
});

test('mergeOrderLineItems supports add, set, and remove operations with exact totals', () => {
  const step1 = mergeOrderLineItems([], [
    { menuItemId: 'margherita pizza', quantity: 2, assignedTo: 'Husband', languageCode: 'en-GB' },
    { menuItemId: 'sparkling water', quantity: 1, assignedTo: 'Husband', languageCode: 'en-GB' },
  ]);
  assert.equal(step1.items.length, 2);
  assert.equal(calculateTicketTotals(step1.items).subtotalCents, 1450 * 2 + 450);

  // Customer changes Margherita from 2 to 1 via 'set'
  const step2 = mergeOrderLineItems(step1.items, [
    {
      menuItemId: 'margherita-dop',
      quantity: 1,
      assignedTo: 'Husband',
      languageCode: 'en-GB',
      operation: 'set',
    },
  ]);
  assert.equal(step2.items.find((i) => i.menuItemId === 'margherita-dop')?.quantity, 1);

  // Customer removes sparkling water
  const step3 = mergeOrderLineItems(step2.items, [
    {
      menuItemId: 'chinotto-sparkling',
      quantity: 1,
      assignedTo: 'Husband',
      languageCode: 'en-GB',
      operation: 'remove',
    },
  ]);
  assert.equal(step3.items.length, 1);
  assert.equal(calculateTicketTotals(step3.items).subtotalCents, 1450);
  assert.equal(calculateTicketTotals(step3.items).taxCents, 123);
  assert.equal(calculateTicketTotals(step3.items).totalCents, 1573);
});

test('formatOrderTimestamp includes day of week, date, hour, minute, and second', () => {
  const formatted = formatOrderTimestamp('2026-11-21T20:04:38.000Z', 'America/Los_Angeles');
  assert.ok(formatted.includes('Saturday'));
  assert.ok(formatted.includes('Nov 21, 2026'));
  assert.ok(formatted.includes('12:04:38 PM'));
  assert.ok(ORDER_STAGE_META.incoming.description.length > 10);
  assert.ok(ORDER_STAGE_META.oven.description.length > 10);
  assert.ok(ORDER_STAGE_META.ready.description.length > 10);
  assert.ok(ORDER_STAGE_META.paid.description.length > 10);
});
