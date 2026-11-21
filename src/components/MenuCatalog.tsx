import { Plus, Utensils } from 'lucide-react';
import { useState } from 'react';
import type { PizzaMenuItem } from '../types/voicepizza';
import { formatCurrency } from '../shared/orderEngine';

interface MenuCatalogProps {
  menu: PizzaMenuItem[];
  onQuickAdd: (item: PizzaMenuItem) => Promise<void>;
}

const CATEGORIES: Array<'All' | PizzaMenuItem['category']> = [
  'All',
  'Classiche',
  'Speciali',
  'Contorni & Bevande',
];

export function MenuCatalog({ menu, onQuickAdd }: MenuCatalogProps) {
  const [category, setCategory] = useState<'All' | PizzaMenuItem['category']>('All');
  const [addingId, setAddingId] = useState<string | null>(null);
  const [failedImages, setFailedImages] = useState<Record<string, boolean>>({});

  const visibleItems =
    category === 'All' ? menu : menu.filter((m) => m.category === category);

  async function handleAdd(item: PizzaMenuItem) {
    setAddingId(item.id);
    try {
      await onQuickAdd(item);
    } finally {
      setAddingId(null);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4 border-b border-[#E5E0D8] pb-4">
        <div>
          <h1 className="font-display text-2xl font-bold text-[#171717]">
            Artisan Menu &amp; Shopify SKU Catalog
          </h1>
          <p className="text-sm text-[#525252]">
            Every voice-extracted item resolves to these verified SKUs, allergens, and kitchen prep
            times.
          </p>
        </div>

        <div
          role="group"
          aria-label="Filter menu categories"
          className="inline-flex items-center gap-1 rounded-lg bg-[#EFECE6] p-1"
        >
          {CATEGORIES.map((cat) => (
            <button
              key={cat}
              type="button"
              onClick={() => setCategory(cat)}
              className={`px-3 py-1.5 text-xs font-semibold rounded-md transition-colors whitespace-nowrap shrink-0 ${
                category === cat
                  ? 'bg-white text-[#171717] shadow-xs'
                  : 'text-[#525252] hover:text-[#171717]'
              }`}
            >
              {cat}
            </button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {visibleItems.map((item) => {
          const imgFailed = failedImages[item.id];
          return (
            <article
              key={item.id}
              className="flex flex-col justify-between overflow-hidden rounded-xl border border-[#E5E0D8] bg-white transition-transform duration-150 hover:-translate-y-0.5"
            >
              <div>
                <div className="aspect-[4/3] w-full bg-[#EFECE6] overflow-hidden">
                  {imgFailed ? (
                    <div className="flex h-full w-full flex-col items-center justify-center gap-2 bg-gradient-to-br from-[#EFECE6] to-[#E5E0D8] text-[#525252]">
                      <Utensils className="h-6 w-6" aria-hidden="true" />
                      <span className="text-xs font-medium">{item.name}</span>
                    </div>
                  ) : (
                    <img
                      src={item.imageUrl}
                      alt={item.name}
                      referrerPolicy="no-referrer"
                      onError={() =>
                        setFailedImages((prev) => ({ ...prev, [item.id]: true }))
                      }
                      className="h-full w-full object-cover"
                    />
                  )}
                </div>

                <div className="p-5 space-y-2">
                  <p className="text-xs text-[#737373]">
                    {item.category} · {item.sku} · {item.prepMinutes} min bake
                  </p>
                  <div className="flex items-baseline justify-between gap-2">
                    <h2 className="font-display text-lg font-semibold text-[#171717]">
                      {item.name}
                    </h2>
                    <span className="font-mono-tabular text-base font-bold text-[#171717]">
                      {formatCurrency(item.priceCents)}
                    </span>
                  </div>
                  <p className="text-xs leading-relaxed text-[#525252]">{item.description}</p>
                  <p className="text-[11px] text-[#737373]">
                    Italian: {item.italianName}
                    {item.allergens.length > 0
                      ? ` · Allergens: ${item.allergens.join(', ')}`
                      : ' · Allergen-free'}
                  </p>
                </div>
              </div>

              <div className="px-5 pb-5">
                <button
                  type="button"
                  disabled={addingId === item.id}
                  onClick={() => handleAdd(item)}
                  className="inline-flex w-full items-center justify-center gap-1.5 rounded-lg bg-[#171717] px-4 py-2 text-xs font-semibold text-white hover:bg-[#2E2E2E] disabled:opacity-50 transition-colors"
                >
                  <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                  {addingId === item.id ? 'Adding...' : 'Add to Counter Ticket'}
                </button>
              </div>
            </article>
          );
        })}
      </div>
    </div>
  );
}
