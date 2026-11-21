import { CheckCircle2, Clock, ShoppingBag, Trash2 } from 'lucide-react';
import { useState } from 'react';
import type { OrderStatus, OrderTicket } from '../types/voicepizza';
import {
  formatCurrency,
  formatOrderTimestamp,
  ORDER_STAGE_META,
} from '../shared/orderEngine';

interface OrdersBoardProps {
  orders: OrderTicket[];
  onAdvanceStatus: (order: OrderTicket) => Promise<void>;
  onSyncShopify: (orderId: string) => Promise<Record<string, unknown> | null>;
  onDeleteOrder: (orderId: string) => Promise<void>;
  onClearCompleted: () => Promise<void>;
}

type OrderFilter = 'active' | OrderStatus;

const STAGE_ORDER: OrderStatus[] = ['incoming', 'oven', 'ready', 'paid'];

export function OrdersBoard({
  orders,
  onAdvanceStatus,
  onSyncShopify,
  onDeleteOrder,
  onClearCompleted,
}: OrdersBoardProps) {
  const [filter, setFilter] = useState<OrderFilter>('active');
  const [shopifyInspect, setShopifyInspect] = useState<{
    ticketNumber: number;
    payload: Record<string, unknown>;
  } | null>(null);
  const [syncingId, setSyncingId] = useState<string | null>(null);
  const [clearing, setClearing] = useState(false);

  const activeOrders = orders.filter((o) => o.status !== 'paid');
  const completedOrders = orders.filter((o) => o.status === 'paid');

  const STATUS_TABS: Array<{ id: OrderFilter; label: string; count: number }> = [
    { id: 'active', label: 'Active Orders', count: activeOrders.length },
    {
      id: 'incoming',
      label: 'Incoming',
      count: orders.filter((o) => o.status === 'incoming').length,
    },
    {
      id: 'oven',
      label: 'In Oven',
      count: orders.filter((o) => o.status === 'oven').length,
    },
    {
      id: 'ready',
      label: 'Ready',
      count: orders.filter((o) => o.status === 'ready').length,
    },
    { id: 'paid', label: 'Previous Orders (Paid)', count: completedOrders.length },
  ];

  const visibleOrders =
    filter === 'active'
      ? activeOrders
      : orders.filter((o) => o.status === filter);

  async function handleShopifyClick(order: OrderTicket) {
    setSyncingId(order.id);
    try {
      const payload = await onSyncShopify(order.id);
      if (payload) {
        setShopifyInspect({ ticketNumber: order.ticketNumber, payload });
      }
    } finally {
      setSyncingId(null);
    }
  }

  async function handleClearCompleted() {
    setClearing(true);
    try {
      await onClearCompleted();
    } finally {
      setClearing(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4 border-b border-[#E5E0D8] pb-4">
        <div>
          <h1 className="font-display text-2xl font-bold text-[#171717]">
            Kitchen Pass &amp; Commerce Orders
          </h1>
          <p className="text-sm text-[#525252]">
            Active orders stay in the live kitchen queue until paid; settled orders automatically
            move to Previous Orders (Paid) so the live pass stays clean.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div
            role="group"
            aria-label="Filter orders by status"
            className="inline-flex flex-wrap items-center gap-1 rounded-lg bg-[#EFECE6] p-1"
          >
            {STATUS_TABS.map((tab) => (
              <button
                key={tab.id}
                type="button"
                onClick={() => setFilter(tab.id)}
                className={`px-3 py-1.5 text-xs font-semibold rounded-md transition-colors whitespace-nowrap shrink-0 ${
                  filter === tab.id
                    ? 'bg-white text-[#171717] shadow-xs'
                    : 'text-[#525252] hover:text-[#171717]'
                }`}
              >
                {tab.label} ({tab.count})
              </button>
            ))}
          </div>

          {filter === 'paid' && completedOrders.length > 0 && (
            <button
              type="button"
              disabled={clearing}
              onClick={handleClearCompleted}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold rounded-lg border border-[#E5E0D8] bg-white text-[#C23B22] hover:bg-[#C23B22]/5 disabled:opacity-50 whitespace-nowrap shrink-0"
            >
              <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
              {clearing ? 'Clearing...' : 'Clear Previous Orders'}
            </button>
          )}
        </div>
      </div>

      {/* Plain-English Kitchen Stage Legend */}
      <section
        aria-label="Order stage definitions"
        className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 rounded-xl border border-[#E5E0D8] bg-white p-4"
      >
        {STAGE_ORDER.map((stage, idx) => {
          const info = ORDER_STAGE_META[stage];
          return (
            <div key={stage} className="space-y-0.5 text-xs">
              <p className="font-semibold text-[#171717]">
                {idx + 1}. {info.shortLabel}
              </p>
              <p className="text-[#525252] leading-snug">{info.description}</p>
            </div>
          );
        })}
      </section>

      {visibleOrders.length === 0 ? (
        <div className="rounded-xl border border-[#E5E0D8] bg-white p-12 text-center space-y-2">
          <p className="text-sm font-semibold text-[#171717]">
            {filter === 'paid'
              ? 'No previous completed orders.'
              : 'No active orders in this stage.'}
          </p>
          <p className="text-xs text-[#737373]">
            {filter === 'paid'
              ? 'Once a Ready order is marked Paid & Archived, its receipt appears here for staff lookup.'
              : 'Take a phone or counter order on the Station tab — confirmed items, exact subtotal + 8.5% tax, and full timestamp will appear here immediately.'}
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6">
          {visibleOrders.map((order) => {
            const stageInfo = ORDER_STAGE_META[order.status];
            return (
              <article
                key={order.id}
                className="flex flex-col justify-between rounded-xl border border-[#E5E0D8] bg-white p-5 space-y-4"
              >
                <div className="space-y-3">
                  <div className="border-b border-[#EFECE6] pb-3 space-y-1.5">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className="text-xs text-[#737373]">
                          {order.channel === 'phone' ? 'P1 Phone Line' : 'P2 Counter'} ·{' '}
                          {order.architecture} · {order.languages.join(' / ')}
                        </p>
                        <h2 className="font-display text-lg font-bold text-[#171717]">
                          #{order.ticketNumber} — {order.partyLabel}
                        </h2>
                      </div>
                      <span className="font-mono-tabular text-xs font-semibold text-[#1F6E4A] text-right">
                        {stageInfo.shortLabel}
                      </span>
                    </div>

                    <p
                      data-testid="order-confirmed-timestamp"
                      className="inline-flex items-center gap-1.5 font-mono-tabular text-[11px] text-[#525252]"
                    >
                      <Clock className="h-3.5 w-3.5 text-[#737373] shrink-0" aria-hidden="true" />
                      <span>Confirmed: {formatOrderTimestamp(order.confirmedAt)}</span>
                    </p>
                  </div>

                  <ul className="space-y-2 text-xs">
                    {order.items.map((item, idx) => (
                      <li key={idx} className="flex items-start justify-between gap-2">
                        <div>
                          <p className="font-semibold text-[#171717]">
                            {item.quantity}x {item.name}
                          </p>
                          <p className="text-[#737373]">
                            {item.assignedTo} ({item.languageCode}) ·{' '}
                            {formatCurrency(item.unitPriceCents)} ea · SKU {item.sku}
                            {item.modifiers.length > 0 ? ` · ${item.modifiers.join(', ')}` : ''}
                          </p>
                        </div>
                        <span className="font-mono-tabular font-medium text-[#171717]">
                          {formatCurrency(item.unitPriceCents * item.quantity)}
                        </span>
                      </li>
                    ))}
                  </ul>

                  {order.allergenFlag && (
                    <p className="text-xs font-semibold text-[#C23B22]">
                      Allergy / Dietary Warning: verify dedicated prep peel
                    </p>
                  )}

                  <div className="rounded-lg bg-[#F8F7F4] p-3 space-y-1 text-xs text-[#525252]">
                    <p>
                      <span className="font-semibold text-[#171717]">Cucina (IT):</span>{' '}
                      {order.kitchenNoteIt}
                    </p>
                    <p>
                      <span className="font-semibold text-[#171717]">Mostrador (ES):</span>{' '}
                      {order.counterNoteEs}
                    </p>
                  </div>
                </div>

                <div className="space-y-3 border-t border-[#EFECE6] pt-3">
                  <div className="space-y-1 font-mono-tabular text-xs">
                    <div className="flex items-center justify-between text-[#525252]">
                      <span>Subtotal</span>
                      <span>{formatCurrency(order.subtotalCents)}</span>
                    </div>
                    <div className="flex items-center justify-between text-[#525252]">
                      <span>Sales Tax (8.5%)</span>
                      <span>{formatCurrency(order.taxCents)}</span>
                    </div>
                    <div className="flex items-center justify-between text-sm font-bold text-[#171717] pt-0.5">
                      <span>Exact Total</span>
                      <span>{formatCurrency(order.totalCents)}</span>
                    </div>
                  </div>

                  <div className="flex items-center gap-2">
                    {stageInfo.nextActionLabel ? (
                      <button
                        type="button"
                        onClick={() => onAdvanceStatus(order)}
                        className="flex-1 py-2 px-3 text-xs font-semibold rounded-lg bg-[#171717] text-white hover:bg-[#2E2E2E] transition-colors whitespace-nowrap"
                      >
                        {stageInfo.nextActionLabel}
                      </button>
                    ) : (
                      <span className="flex-1 inline-flex items-center justify-center gap-1 py-2 px-3 text-xs font-semibold text-[#1F6E4A]">
                        <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" />
                        Completed &amp; Paid
                      </span>
                    )}

                    <button
                      type="button"
                      disabled={syncingId === order.id}
                      onClick={() => handleShopifyClick(order)}
                      className="inline-flex items-center gap-1.5 py-2 px-3 text-xs font-semibold rounded-lg border border-[#E5E0D8] bg-white text-[#171717] hover:bg-[#EFECE6] transition-colors whitespace-nowrap shrink-0"
                    >
                      <ShoppingBag className="h-3.5 w-3.5" aria-hidden="true" />
                      {order.shopifyDraftOrderId ? 'Shopify Draft' : 'Sync Shopify'}
                    </button>

                    <button
                      type="button"
                      onClick={() => onDeleteOrder(order.id)}
                      aria-label={`Remove Ticket #${order.ticketNumber}`}
                      title="Remove ticket"
                      className="p-2 rounded-lg border border-[#E5E0D8] bg-white text-[#737373] hover:text-[#C23B22] hover:border-[#C23B22]/40 transition-colors shrink-0"
                    >
                      <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                    </button>
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      )}

      {shopifyInspect && (
        <section className="rounded-xl border border-[#E5E0D8] bg-white p-5 space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="font-display text-base font-semibold text-[#171717]">
              Shopify Draft Order Payload — Ticket #{shopifyInspect.ticketNumber}
            </h3>
            <button
              type="button"
              onClick={() => setShopifyInspect(null)}
              className="text-xs font-semibold text-[#525252] hover:text-[#171717]"
            >
              Close
            </button>
          </div>
          <pre className="overflow-x-auto rounded-lg bg-[#171717] p-4 text-xs text-[#F5F5F4] font-mono-tabular">
            {JSON.stringify(shopifyInspect.payload, null, 2)}
          </pre>
        </section>
      )}
    </div>
  );
}
