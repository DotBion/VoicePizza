import type { SessionState } from '../types/voicepizza';

export type ActiveView = 'station' | 'orders' | 'stress' | 'menu' | 'assistant' | 'fixit' | 'floor';

interface TopBarProps {
  activeView: ActiveView;
  onNavigate: (view: ActiveView) => void;
  session: SessionState;
  onToggleSession: () => void;
  sessionBusy: boolean;
  openOrdersCount: number;
}

const NAV_ITEMS: Array<{ id: ActiveView; label: string }> = [
  { id: 'station', label: 'Station' },
  { id: 'orders', label: 'Orders' },
  { id: 'stress', label: 'Stress Lab' },
  { id: 'menu', label: 'Menu' },
  { id: 'assistant', label: 'Assistant' },
  { id: 'fixit', label: 'Fix-It Cam' },
  { id: 'floor', label: 'Floor Monitor' },
];

export function TopBar({
  activeView,
  onNavigate,
  session,
  onToggleSession,
  sessionBusy,
  openOrdersCount,
}: TopBarProps) {
  return (
    <header className="sticky top-0 z-30 border-b border-[#E5E0D8] bg-[#F8F7F4]/95 backdrop-blur-sm">
      <div className="mx-auto flex max-w-[1440px] items-center justify-between gap-8 px-6 py-3.5">
        {/* Zone 1: Single-element brand wordmark */}
        <button
          type="button"
          onClick={() => onNavigate('station')}
          className="font-display text-xl font-bold tracking-tight text-[#171717] whitespace-nowrap shrink-0 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[#C23B22]"
        >
          VoicePizza
        </button>

        {/* Zone 2: 4 clean single-line navigation links */}
        <nav aria-label="Primary navigation" className="flex items-center gap-6 overflow-x-auto">
          {NAV_ITEMS.map((item) => {
            const isActive = activeView === item.id;
            const label =
              item.id === 'orders' && openOrdersCount > 0
                ? `${item.label} (${openOrdersCount})`
                : item.label;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => onNavigate(item.id)}
                className={`relative py-1 text-sm font-medium transition-colors whitespace-nowrap shrink-0 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[#C23B22] ${
                  isActive
                    ? 'text-[#171717] underline decoration-[#C23B22] decoration-2 underline-offset-8'
                    : 'text-[#525252] hover:text-[#171717]'
                }`}
              >
                {label}
              </button>
            );
          })}
        </nav>

        {/* Zone 3: 1 primary action */}
        <div className="flex items-center shrink-0">
          <button
            type="button"
            disabled={sessionBusy}
            onClick={onToggleSession}
            className={`px-4 py-2 text-sm font-semibold rounded-lg transition-colors whitespace-nowrap shrink-0 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#C23B22] disabled:opacity-50 ${
              session.active
                ? 'bg-[#171717] text-white hover:bg-[#2E2E2E]'
                : 'bg-[#C23B22] text-white hover:bg-[#A6311B]'
            }`}
          >
            {sessionBusy
              ? 'Connecting...'
              : session.active
                ? 'Stop Session'
                : 'Start Session'}
          </button>
        </div>
      </div>
    </header>
  );
}
