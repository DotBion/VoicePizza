const DEFAULT_FIXIT_URL = 'https://bradley-bookmarks-rice-late.trycloudflare.com/';

function resolveFixItUrl(): string {
  const fromEnv = import.meta.env.VITE_FIXIT_URL;
  if (typeof fromEnv === 'string' && fromEnv.trim()) {
    return fromEnv.trim();
  }
  return DEFAULT_FIXIT_URL;
}

export function FixItCam() {
  const fixItUrl = resolveFixItUrl();

  return (
    <section className="flex min-h-[calc(100vh-180px)] flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-4 border-b border-[#E5E0D8] pb-4">
        <div>
          <h1 className="font-display text-2xl font-bold text-[#171717]">Fix-It Cam</h1>
          <p className="text-sm text-[#525252]">
            Film a broken part, get a Gemini diagnosis, and buy the matching replacement on Shop.
          </p>
        </div>
        <a
          href={fixItUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="px-4 py-2 text-sm font-semibold rounded-lg bg-[#171717] text-white hover:bg-[#2E2E2E] transition-colors whitespace-nowrap shrink-0 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#C23B22]"
        >
          Open in new tab
        </a>
      </div>

      <iframe
        title="Fix-It Cam"
        src={fixItUrl}
        allow="camera; microphone; clipboard-write"
        referrerPolicy="strict-origin-when-cross-origin"
        className="w-full flex-1 min-h-[70vh] rounded-xl border border-[#E5E0D8] bg-[#0d0f12]"
      />
    </section>
  );
}
