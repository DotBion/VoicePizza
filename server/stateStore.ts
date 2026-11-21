import {
  buildOrderTicket,
  mergeOrderLineItems,
} from '../src/shared/orderEngine';
import type {
  NonOrderAlert,
  OrderLineItem,
  OrderStatus,
  OrderTicket,
  SessionState,
  SpeakerRole,
  StationChannel,
  TranscriptEntry,
  VoiceArchitecture,
} from '../src/types/voicepizza';

class VoicePizzaStore {
  private session: SessionState = {
    sessionId: null,
    active: false,
    architecture: 'cascaded',
    channel: 'phone',
    startedAt: null,
  };

  private activeCloseHandler: (() => void) | null = null;
  private ticketCounter = 100;
  private orders: OrderTicket[] = [];
  private transcripts: TranscriptEntry[] = [];
  private alerts: NonOrderAlert[] = [];
  private draftItemsByParty = new Map<string, OrderLineItem[]>();

  getSession(): SessionState {
    return { ...this.session };
  }

  registerCloseHandler(fn: (() => void) | null) {
    this.activeCloseHandler = fn;
  }

  startSession(architecture: VoiceArchitecture, channel: StationChannel): SessionState {
    if (this.session.active && this.session.architecture !== architecture) {
      throw new Error(
        `Active ${this.session.architecture} session must be stopped before switching to ${architecture}.`
      );
    }
    if (this.session.active) {
      this.stopSession();
    }
    this.session = {
      sessionId: `vp-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      active: true,
      architecture,
      channel,
      startedAt: new Date().toISOString(),
    };
    return this.getSession();
  }

  stopSession(): SessionState {
    if (this.activeCloseHandler) {
      try {
        this.activeCloseHandler();
      } catch {
        // ignore cleanup errors
      }
      this.activeCloseHandler = null;
    }
    this.session = {
      ...this.session,
      sessionId: null,
      active: false,
      startedAt: null,
    };
    return this.getSession();
  }

  setPreferences(architecture: VoiceArchitecture, channel: StationChannel): SessionState {
    if (this.session.active && this.session.architecture !== architecture) {
      throw new Error('Stop the active session before switching architectures.');
    }
    this.session = {
      ...this.session,
      architecture,
      channel,
    };
    return this.getSession();
  }

  getOrders(): OrderTicket[] {
    return this.orders;
  }

  getOrderById(id: string): OrderTicket | undefined {
    return this.orders.find((o) => o.id === id);
  }

  getTranscripts(): TranscriptEntry[] {
    return this.transcripts;
  }

  getAlerts(): NonOrderAlert[] {
    return this.alerts;
  }

  addTranscript(entry: TranscriptEntry) {
    this.transcripts = [entry, ...this.transcripts].slice(0, 40);
  }

  addAlert(alert: NonOrderAlert) {
    this.alerts = [alert, ...this.alerts].slice(0, 25);
  }

  resolveAlert(id: string): NonOrderAlert | undefined {
    const found = this.alerts.find((a) => a.id === id);
    if (found) {
      found.resolved = true;
    }
    return found;
  }

  upsertOrderFromExtractedItems(params: {
    channel: StationChannel;
    architecture: VoiceArchitecture;
    partyLabel: string;
    ticketId?: string | null;
    extractedItems: Array<{
      menuItemId: string;
      quantity: number;
      modifiers?: string[];
      assignedTo?: string;
      languageCode?: string;
      operation?: 'add' | 'set' | 'remove';
    }>;
    kitchenNoteIt?: string;
    counterNoteEs?: string;
    createNewTicket?: boolean;
  }): OrderTicket | null {
    if (params.extractedItems.length === 0) return null;

    let existingOpen: OrderTicket | undefined;
    if (!params.createNewTicket) {
      if (params.ticketId) {
        existingOpen = this.orders.find(
          (o) => o.id === params.ticketId && o.status !== 'paid'
        );
      }
      if (!existingOpen) {
        existingOpen = this.orders.find(
          (o) =>
            o.status === 'incoming' &&
            o.partyLabel.toLowerCase() === params.partyLabel.toLowerCase() &&
            o.channel === params.channel
        );
      }
    }

    if (existingOpen) {
      const merged = mergeOrderLineItems(existingOpen.items, params.extractedItems);
      if (merged.items.length === 0) {
        this.orders = this.orders.filter((o) => o.id !== existingOpen.id);
        return null;
      }
      const rebuilt = buildOrderTicket({
        id: existingOpen.id,
        ticketNumber: existingOpen.ticketNumber,
        channel: existingOpen.channel,
        architecture: params.architecture,
        partyLabel: existingOpen.partyLabel,
        items: merged.items,
        kitchenNoteIt: params.kitchenNoteIt,
        counterNoteEs: params.counterNoteEs,
        createdAt: existingOpen.createdAt,
        confirmedAt: new Date().toISOString(),
        status: existingOpen.status,
        shopifyDraftOrderId: existingOpen.shopifyDraftOrderId,
      });
      this.orders = [rebuilt, ...this.orders.filter((o) => o.id !== existingOpen.id)];
      return rebuilt;
    }

    const merged = mergeOrderLineItems([], params.extractedItems);
    if (merged.items.length === 0) return null;

    this.ticketCounter += 1;
    const nowIso = new Date().toISOString();
    const ticket = buildOrderTicket({
      id: `ord-${Date.now()}-${this.ticketCounter}`,
      ticketNumber: this.ticketCounter,
      channel: params.channel,
      architecture: params.architecture,
      partyLabel: params.partyLabel,
      items: merged.items,
      kitchenNoteIt: params.kitchenNoteIt,
      counterNoteEs: params.counterNoteEs,
      createdAt: nowIso,
      confirmedAt: nowIso,
      status: 'incoming',
    });
    this.orders = [ticket, ...this.orders];
    return ticket;
  }

  updateOrderStatus(id: string, status: OrderStatus): OrderTicket | undefined {
    const target = this.orders.find((o) => o.id === id);
    if (!target) return undefined;
    target.status = status;
    target.updatedAt = new Date().toISOString();
    return target;
  }

  deleteOrder(id: string): boolean {
    const before = this.orders.length;
    this.orders = this.orders.filter((o) => o.id !== id);
    return this.orders.length < before;
  }

  clearCompletedOrders(): number {
    const before = this.orders.length;
    this.orders = this.orders.filter((o) => o.status !== 'paid');
    return before - this.orders.length;
  }

  markOrderShopifySynced(id: string, shopifyDraftOrderId: string): OrderTicket | undefined {
    const target = this.orders.find((o) => o.id === id);
    if (!target) return undefined;
    target.shopifyDraftOrderId = shopifyDraftOrderId;
    target.updatedAt = new Date().toISOString();
    return target;
  }

  createQuickAlert(params: {
    role: SpeakerRole;
    languageCode: string;
    summary: string;
    staffActionEs: string;
    staffActionIt: string;
  }): NonOrderAlert {
    const alert: NonOrderAlert = {
      id: `alrt-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      timestamp: new Date().toISOString(),
      role: params.role,
      languageCode: params.languageCode,
      summary: params.summary,
      staffActionEs: params.staffActionEs,
      staffActionIt: params.staffActionIt,
      resolved: false,
    };
    this.addAlert(alert);
    return alert;
  }

  clearHistory() {
    this.transcripts = [];
    this.alerts = [];
    this.draftItemsByParty.clear();
  }
}

export const voicePizzaStore = new VoicePizzaStore();
