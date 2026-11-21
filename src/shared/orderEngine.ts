import { findMenuItemByIdOrName } from './menu';
import type {
  OrderLineItem,
  OrderStatus,
  OrderTicket,
  StationChannel,
  VoiceArchitecture,
} from '../types/voicepizza';

export const TAX_RATE = 0.085;

export interface OrderStageInfo {
  status: OrderStatus;
  shortLabel: string;
  description: string;
  nextActionLabel: string | null;
}

export const ORDER_STAGE_META: Record<OrderStatus, OrderStageInfo> = {
  incoming: {
    status: 'incoming',
    shortLabel: 'Incoming (Confirmed)',
    description: 'Order confirmed by customer and sent to the kitchen pass — waiting to be prepped.',
    nextActionLabel: 'Start Baking (In Oven)',
  },
  oven: {
    status: 'oven',
    shortLabel: 'In Oven (Baking)',
    description: 'Pizzaiolo is actively cooking this order in the wood-fired oven.',
    nextActionLabel: 'Mark Ready for Pickup',
  },
  ready: {
    status: 'ready',
    shortLabel: 'Ready (Pickup)',
    description: 'Out of the oven, boxed, and waiting at the counter for customer pickup & payment.',
    nextActionLabel: 'Mark Paid & Archive',
  },
  paid: {
    status: 'paid',
    shortLabel: 'Completed (Paid)',
    description: 'Paid and handed to the customer — archived under Previous Orders.',
    nextActionLabel: null,
  },
};

export function calculateTicketTotals(items: OrderLineItem[]): {
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
} {
  const subtotalCents = items.reduce(
    (sum, item) => sum + item.unitPriceCents * Math.max(1, item.quantity),
    0
  );
  const taxCents = Math.round(subtotalCents * TAX_RATE);
  const totalCents = subtotalCents + taxCents;
  return { subtotalCents, taxCents, totalCents };
}

export function formatCurrency(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

/**
 * Formats an ISO timestamp with explicit Day of Week, Date, Hour, Minute, and Second.
 * Example: "Saturday, Nov 21, 2026 · 12:04:38 PM"
 */
export function formatOrderTimestamp(isoString: string, timeZone?: string): string {
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) {
    return isoString;
  }
  const datePart = new Intl.DateTimeFormat('en-US', {
    weekday: 'long',
    month: 'short',
    day: '2-digit',
    year: 'numeric',
    ...(timeZone ? { timeZone } : {}),
  }).format(date);
  const timePart = new Intl.DateTimeFormat('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: true,
    ...(timeZone ? { timeZone } : {}),
  }).format(date);
  return `${datePart} · ${timePart}`;
}

export function formatOrderTotalsSummary(ticket: OrderTicket): string {
  const itemList = ticket.items
    .map(
      (i) =>
        `${i.quantity}x ${i.name} (${formatCurrency(i.unitPriceCents * i.quantity)})`
    )
    .join(', ');
  return `Ticket #${ticket.ticketNumber}: ${itemList} | Subtotal ${formatCurrency(
    ticket.subtotalCents
  )} + Tax (8.5%) ${formatCurrency(ticket.taxCents)} = Total ${formatCurrency(
    ticket.totalCents
  )} · Confirmed ${formatOrderTimestamp(ticket.confirmedAt)}`;
}

export function mergeOrderLineItems(
  existing: OrderLineItem[],
  incoming: Array<{
    menuItemId: string;
    quantity: number;
    modifiers?: string[];
    assignedTo?: string;
    languageCode?: string;
    operation?: 'add' | 'set' | 'remove';
  }>
): { items: OrderLineItem[]; allergenFlag: boolean } {
  const merged = existing.map((item) => ({ ...item, modifiers: [...item.modifiers] }));

  for (const req of incoming) {
    const menuItem = findMenuItemByIdOrName(req.menuItemId);
    if (!menuItem) continue;

    const op = req.operation ?? 'add';
    const assignedTo = req.assignedTo?.trim() || 'Guest';
    const languageCode = req.languageCode?.trim() || 'en';
    const modifiers = (req.modifiers ?? []).map((m) => m.trim()).filter(Boolean);
    const modKey = [...modifiers].sort().join('|').toLowerCase();

    const exactIdx = merged.findIndex(
      (m) =>
        m.menuItemId === menuItem.id &&
        m.assignedTo.toLowerCase() === assignedTo.toLowerCase() &&
        [...m.modifiers].sort().join('|').toLowerCase() === modKey
    );

    if (op === 'remove' || (op === 'set' && Math.round(req.quantity || 0) <= 0)) {
      const targetIdx =
        exactIdx >= 0 ? exactIdx : merged.findIndex((m) => m.menuItemId === menuItem.id);
      if (targetIdx >= 0) {
        const removeQty = Math.round(req.quantity || 0);
        if (op === 'set' || removeQty <= 0 || removeQty >= merged[targetIdx].quantity) {
          merged.splice(targetIdx, 1);
        } else {
          merged[targetIdx].quantity -= removeQty;
        }
      }
      continue;
    }

    const qty = Math.max(1, Math.round(req.quantity || 1));

    if (op === 'set') {
      const targetIdx =
        exactIdx >= 0 ? exactIdx : merged.findIndex((m) => m.menuItemId === menuItem.id);
      if (targetIdx >= 0) {
        merged[targetIdx].quantity = qty;
        if (modifiers.length > 0) merged[targetIdx].modifiers = modifiers;
      } else {
        merged.push({
          menuItemId: menuItem.id,
          sku: menuItem.sku,
          name: menuItem.name,
          quantity: qty,
          unitPriceCents: menuItem.priceCents,
          assignedTo,
          languageCode,
          modifiers,
        });
      }
      continue;
    }

    if (exactIdx >= 0) {
      merged[exactIdx].quantity += qty;
    } else {
      merged.push({
        menuItemId: menuItem.id,
        sku: menuItem.sku,
        name: menuItem.name,
        quantity: qty,
        unitPriceCents: menuItem.priceCents,
        assignedTo,
        languageCode,
        modifiers,
      });
    }
  }

  const allergenFlag = merged.some((item) =>
    item.modifiers.some((mod) =>
      /gluten|allergy|allergen|celiac|nut|dairy|no cheese|lactose|glutenfrei|sin gluten/i.test(mod)
    )
  );

  return { items: merged, allergenFlag };
}

export function buildOrderTicket(params: {
  id: string;
  ticketNumber: number;
  channel: StationChannel;
  architecture: VoiceArchitecture;
  partyLabel: string;
  items: OrderLineItem[];
  kitchenNoteIt?: string;
  counterNoteEs?: string;
  createdAt?: string;
  confirmedAt?: string;
  status?: OrderStatus;
  shopifyDraftOrderId?: string;
}): OrderTicket {
  const { subtotalCents, taxCents, totalCents } = calculateTicketTotals(params.items);
  const languages = Array.from(new Set(params.items.map((i) => i.languageCode).filter(Boolean)));
  const allergenFlag = params.items.some((item) =>
    item.modifiers.some((mod) =>
      /gluten|allergy|allergen|celiac|nut|dairy|no cheese|lactose|glutenfrei|sin gluten/i.test(mod)
    )
  );

  const defaultIt = params.items
    .map((i) => `${i.quantity}x ${i.name}${i.modifiers.length ? ` (${i.modifiers.join(', ')})` : ''}`)
    .join(' · ');
  const defaultEs = `Para llevar (${params.partyLabel}): ${params.items
    .map((i) => `${i.quantity}x ${i.name}`)
    .join(', ')}`;

  const nowIso = new Date().toISOString();

  return {
    id: params.id,
    ticketNumber: params.ticketNumber,
    channel: params.channel,
    architecture: params.architecture,
    partyLabel: params.partyLabel,
    languages: languages.length > 0 ? languages : ['en'],
    status: params.status ?? 'incoming',
    items: params.items,
    subtotalCents,
    taxCents,
    totalCents,
    kitchenNoteIt: params.kitchenNoteIt?.trim() || defaultIt,
    counterNoteEs: params.counterNoteEs?.trim() || defaultEs,
    allergenFlag,
    createdAt: params.createdAt ?? nowIso,
    confirmedAt: params.confirmedAt ?? nowIso,
    updatedAt: nowIso,
    shopifyDraftOrderId: params.shopifyDraftOrderId,
  };
}

export function buildShopifyCheckoutPayload(ticket: OrderTicket) {
  return {
    draft_order: {
      note: `VoicePizza ${ticket.channel.toUpperCase()} (${ticket.architecture}) | Confirmed: ${formatOrderTimestamp(
        ticket.confirmedAt
      )} | Languages: ${ticket.languages.join(', ')}`,
      tags: ['voicepizza', ticket.channel, ticket.architecture, ...(ticket.allergenFlag ? ['allergen-alert'] : [])],
      line_items: ticket.items.map((item) => ({
        sku: item.sku,
        title: `${item.name} — ${item.assignedTo}`,
        quantity: item.quantity,
        price: (item.unitPriceCents / 100).toFixed(2),
        properties: item.modifiers.map((mod, idx) => ({
          name: `Modifier ${idx + 1}`,
          value: mod,
        })),
      })),
      currency: 'USD',
      subtotal_price: (ticket.subtotalCents / 100).toFixed(2),
      total_tax: (ticket.taxCents / 100).toFixed(2),
      total_price: (ticket.totalCents / 100).toFixed(2),
    },
  };
}

export function evaluateOrderRecall(
  expected: Array<{ menuItemId: string; quantity: number }>,
  predicted: Array<{ menuItemId: string; quantity: number }>
): number {
  if (expected.length === 0) return 1;
  const expectedMap = new Map<string, number>();
  for (const e of expected) {
    expectedMap.set(e.menuItemId, (expectedMap.get(e.menuItemId) ?? 0) + e.quantity);
  }
  const predictedMap = new Map<string, number>();
  for (const p of predicted) {
    const resolved = findMenuItemByIdOrName(p.menuItemId)?.id ?? p.menuItemId;
    predictedMap.set(resolved, (predictedMap.get(resolved) ?? 0) + p.quantity);
  }

  let expectedTotal = 0;
  let matchedTotal = 0;
  for (const [id, qty] of expectedMap.entries()) {
    expectedTotal += qty;
    const predQty = predictedMap.get(id) ?? 0;
    matchedTotal += Math.min(qty, predQty);
  }

  const extraPenalty = Array.from(predictedMap.entries()).reduce((acc, [id, qty]) => {
    const expQty = expectedMap.get(id) ?? 0;
    return acc + Math.max(0, qty - expQty);
  }, 0);

  const rawScore = expectedTotal === 0 ? 1 : (matchedTotal - extraPenalty * 0.25) / expectedTotal;
  return Math.max(0, Math.min(1, Number(rawScore.toFixed(3))));
}

export function canSwitchArchitecture(sessionActive: boolean): {
  allowed: boolean;
  reason?: string;
} {
  if (sessionActive) {
    return {
      allowed: false,
      reason: 'Stop the active session before switching voice architectures.',
    };
  }
  return { allowed: true };
}

export function nextOrderStatus(current: OrderStatus): OrderStatus {
  switch (current) {
    case 'incoming':
      return 'oven';
    case 'oven':
      return 'ready';
    case 'ready':
      return 'paid';
    case 'paid':
      return 'paid';
  }
}
