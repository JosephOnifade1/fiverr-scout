import React, { useEffect, useState, useCallback } from "react";
import { Truck, Heart, Star, Crosshair, ArrowRight } from "@phosphor-icons/react";

const FILTERS = [
  { key: "opportunity_score", label: "Score", Icon: Crosshair },
  { key: "orders", label: "Orders", Icon: Truck },
  { key: "favourites", label: "Favourites", Icon: Heart },
  { key: "reviews", label: "Reviews", Icon: Star },
];

const fmtNum = (n) => {
  if (n == null) return "—";
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return typeof n === "number" ? n.toFixed(0) : n;
};

export const TopFocusKeywords = ({ authAxios, onPick, refreshKey }) => {
  const [filter, setFilter] = useState("opportunity_score");
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async (f) => {
    setLoading(true);
    try {
      const r = await authAxios.get(`/focus-keywords?sort_by=${f}`);
      setItems(r.data.items || []);
    } catch {/* noop */} finally { setLoading(false); }
  }, [authAxios]);

  useEffect(() => { load(filter); }, [filter, load, refreshKey]);

  const metricValue = (it) => {
    if (filter === "opportunity_score") return `${it.opportunity_score?.toFixed?.(0) ?? "—"}`;
    if (filter === "orders") return fmtNum(it.avg_orders);
    if (filter === "favourites") return fmtNum(it.total_favourites);
    if (filter === "reviews") return fmtNum(it.total_reviews);
    return "—";
  };

  return (
    <div className="border border-zinc-200 bg-white" data-testid="top-focus-keywords">
      <div className="flex items-center justify-between flex-wrap gap-3 px-5 py-3 border-b border-zinc-200">
        <div className="flex items-center gap-2">
          <Crosshair size={14} weight="bold" />
          <span className="text-[10px] uppercase tracking-[0.3em] font-mono text-zinc-600">Top Focus Keywords</span>
        </div>
        <div className="flex items-center gap-1" data-testid="focus-filters">
          {FILTERS.map(({ key, label, Icon }) => {
            const active = filter === key;
            return (
              <button
                key={key}
                data-testid={`focus-filter-${label.toLowerCase()}`}
                onClick={() => setFilter(key)}
                className={`flex items-center gap-1 text-[10px] uppercase tracking-[0.15em] font-mono px-2.5 py-1 border transition-colors ${
                  active
                    ? "bg-black text-white border-black"
                    : "bg-white text-zinc-600 border-zinc-300 hover:border-black"
                }`}
              >
                <Icon size={11} weight="bold" /> {label}
              </button>
            );
          })}
        </div>
      </div>
      <div className="divide-y divide-zinc-100">
        {loading && <div className="px-5 py-4 text-xs font-mono text-zinc-400">Loading focus keywords…</div>}
        {!loading && items.length === 0 && (
          <div className="px-5 py-6 text-xs font-mono text-zinc-400">
            No focus keywords yet. Run a few scans and they'll surface here ranked by your selected metric.
          </div>
        )}
        {items.slice(0, 8).map((it, i) => (
          <button
            key={it.job_id}
            onClick={() => onPick(it)}
            data-testid={`focus-row-${i}`}
            className="w-full text-left flex items-center gap-3 px-5 py-3 hover:bg-amber-50/40 transition-colors group"
          >
            <span className="text-[10px] font-mono text-zinc-400 w-6">#{i + 1}</span>
            <span className="text-sm font-mono font-bold flex-1 truncate">{it.keyword}</span>
            <div className="flex items-center gap-4 text-[10px] font-mono">
              <span className="text-zinc-500">{fmtNum(it.total_services)} gigs</span>
              {it.ratio_is_gold && (
                <span className="bg-amber-500 text-white px-1.5 py-0.5 uppercase tracking-[0.2em]">Gold</span>
              )}
              <span className="text-base font-black tracking-tight text-black min-w-[3rem] text-right">
                {metricValue(it)}
              </span>
              <ArrowRight size={12} weight="bold" className="text-zinc-300 group-hover:text-black transition-colors" />
            </div>
          </button>
        ))}
      </div>
    </div>
  );
};
