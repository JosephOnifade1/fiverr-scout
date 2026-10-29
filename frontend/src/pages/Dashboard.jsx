import React, { useEffect, useState, useCallback } from "react";
import { useAuth } from "../AuthContext";
import { Button } from "../components/ui/button";
import { toast } from "sonner";
import {
  TrendUp, BookmarkSimple, SignOut, FileCsv, FileText,
  Clock, ChartLineUp, Tag, Circle, XCircle, Database,
} from "@phosphor-icons/react";
import { ScoreGauge, RatioMeter, MetricTile, VelocityCard } from "../components/ScoreCards";
import { GigTable } from "../components/GigTable";
import { AIPanel } from "../components/AIPanel";
import { TopFocusKeywords } from "../components/TopFocusKeywords";
import { SearchBar } from "../components/SearchBar";
import { PlanBadge, useBilling } from "../components/Billing";
import { LiveNicheBoard } from "../components/LiveNicheBoard";
import { ReferralDialog } from "../components/ReferralDialog";
import { Gift } from "@phosphor-icons/react";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from "recharts";

export default function Dashboard() {
  const { user, logout, authAxios } = useAuth();
  const { billing, refresh: refreshBilling, openPricing, PricingMount } = useBilling();
  const [keyword, setKeyword] = useState("");
  const [referralOpen, setReferralOpen] = useState(false);
  const [activeJob, setActiveJob] = useState(null);
  const [activeSnapshot, setActiveSnapshot] = useState(null);
  const [polling, setPolling] = useState(false);
  const [history, setHistory] = useState([]);
  const [watchlist, setWatchlist] = useState([]);
  const [trendData, setTrendData] = useState([]);

  const showFullResult = useCallback((jobDoc) => {
    setActiveSnapshot(null);
    setActiveJob(jobDoc);
    setKeyword(jobDoc.keyword);
  }, []);

  const showSnapshotOnly = useCallback((detail) => {
    setActiveJob(null);
    setTrendData([]);
    setActiveSnapshot(detail?.market_insight || null);
    setKeyword(detail?.keyword || detail?.market_insight?.display_keyword || "");
  }, []);

  const refreshHistory = useCallback(async () => {
    const r = await authAxios.get("/scrape/jobs");
    setHistory(r.data);
    return r.data;
  }, [authAxios]);

  const refreshWatchlist = useCallback(async () => {
    const r = await authAxios.get("/watchlist");
    setWatchlist(r.data);
  }, [authAxios]);

  const fetchTrends = useCallback(async (kw) => {
    try {
      const r = await authAxios.get(`/trends/${encodeURIComponent(kw)}`);
      setTrendData(r.data.snapshots.map((s) => ({
        date: new Date(s.captured_at).toLocaleDateString(undefined, { month: "short", day: "numeric" }),
        services: s.total_services,
        orders: s.avg_orders_in_queue,
        score: s.opportunity_score,
      })));
    } catch {/* noop */}
  }, [authAxios]);

  const loadNicheDetail = useCallback(async (kw) => {
    const term = (kw || "").trim();
    if (!term) return;
    try {
      const r = await authAxios.get(`/niches/${encodeURIComponent(term)}`);
      if (r.data.latest_user_job) {
        showFullResult(r.data.latest_user_job);
        fetchTrends(r.data.latest_user_job.keyword);
        return;
      }
      showSnapshotOnly(r.data);
    } catch {
      toast.error("No stored Mongo result found for that keyword yet.");
    }
  }, [authAxios, fetchTrends, showFullResult, showSnapshotOnly]);

  const loadJob = useCallback(async (jobId) => {
    const r = await authAxios.get(`/scrape/jobs/${jobId}`);
    showFullResult(r.data);
    fetchTrends(r.data.keyword);
  }, [authAxios, fetchTrends, showFullResult]);

  const loadFocusKeyword = useCallback(async (item) => {
    if (item?.job_id) {
      loadJob(item.job_id);
      return;
    }
    if (item?.keyword) {
      loadNicheDetail(item.keyword);
    }
  }, [loadJob, loadNicheDetail]);

  useEffect(() => { refreshHistory(); refreshWatchlist(); }, [refreshHistory, refreshWatchlist]);

  useEffect(() => {
    if (activeJob || activeSnapshot || polling) return;
    const recent = history.find((item) => item.status === "complete");
    if (recent) loadJob(recent.id);
  }, [activeJob, activeSnapshot, history, loadJob, polling]);

  const pollJob = async (jobId) => {
    for (let i = 0; i < 30; i++) {
      await new Promise((res) => setTimeout(res, 1500));
      try {
        const r = await authAxios.get(`/scan/${jobId}`);
        if (r.data.job_ready) {
          const job = await authAxios.get(`/scrape/jobs/${r.data.job_id || jobId}`);
          showFullResult(job.data);
          setPolling(false);
          refreshHistory();
          fetchTrends(job.data.keyword);
          toast.success(`Scrape complete · Score ${job.data.result?.opportunity_score}`);
          return;
        }
        if (r.data.status === "failed" || r.data.job_status === "failed") {
          setPolling(false);
          toast.error("Scrape failed");
          return;
        }
      } catch {/* noop */}
    }
    setPolling(false);
  };

  const startSearch = async (kw) => {
    const term = (kw || keyword).trim();
    if (!term) return;
    setKeyword(term);
    setPolling(true);
    setActiveSnapshot(null);
    try {
      const r = await authAxios.post("/scan", { keyword: term });
      const jobId = r.data.job_id || r.data.task_id;
      setActiveJob({ id: jobId, keyword: term, status: "running", result: null });
      pollJob(jobId);
      refreshBilling();
    } catch (err) {
      setPolling(false);
      if (err?.response?.status === 402) {
        toast.error("Free plan limit reached. Upgrade to Pro for unlimited scans.");
        openPricing();
      } else {
        toast.error("Failed to start scrape");
      }
    }
  };

  const exportJob = async (fmt) => {
    if (!activeJob) return;
    const url = `${authAxios.defaults.baseURL}/scrape/jobs/${activeJob.id}/export?format=${fmt}`;
    const res = await fetch(url, { headers: authAxios.defaults.headers });
    const blob = await res.blob();
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `fiverr_${activeJob.keyword}.${fmt}`;
    a.click();
  };

  const addWatch = async () => {
    const watchKeyword = activeJob?.keyword || activeSnapshot?.display_keyword || keyword;
    if (!watchKeyword) return;
    await authAxios.post("/watchlist", { keyword: watchKeyword });
    toast.success("Added to watchlist");
    refreshWatchlist();
  };

  const removeWatch = async (id) => {
    await authAxios.delete(`/watchlist/${id}`);
    refreshWatchlist();
  };

  const result = activeJob?.result;
  const snapshotSignal = activeSnapshot?.snapshot || {};
  const gigs = result?.gigs || [];
  const top10 = gigs.filter((g) => g.position <= 10);
  const bot10 = gigs.filter((g) => g.position > 10);
  const detailMode = result ? "full_result" : activeSnapshot ? "snapshot_only" : "empty";
  const activeKeyword = activeJob?.keyword || activeSnapshot?.display_keyword || activeSnapshot?.keyword || keyword;

  return (
    <div className="min-h-screen bg-white">
      <header className="border-b border-zinc-200 bg-white sticky top-0 z-20">
        <div className="flex items-center justify-between px-6 lg:px-8 h-14">
          <div className="flex items-center gap-3">
            <div className="w-7 h-7 bg-black flex items-center justify-center">
              <TrendUp size={14} weight="bold" color="#F59E0B" />
            </div>
            <span className="font-black tracking-tight text-sm" style={{ fontFamily: "'Cabinet Grotesk', system-ui" }}>
              FIVERR&nbsp;SCOUT
            </span>
            <span className="text-[10px] uppercase tracking-[0.3em] text-zinc-400 font-mono hidden sm:inline">
              Niche Arbitrage Terminal
            </span>
          </div>
          <div className="flex items-center gap-3">
            <button
              data-testid="open-referral-btn"
              onClick={() => setReferralOpen(true)}
              title="Refer a friend, get 1 month free"
              className="text-[10px] uppercase tracking-[0.2em] font-mono px-3 py-1.5 border border-zinc-300 bg-white hover:bg-black hover:text-white transition-colors flex items-center gap-1"
            >
              <Gift size={11} weight="bold" /> Refer
            </button>
            <PlanBadge billing={billing} onOpen={openPricing} />
            <span className="text-xs font-mono text-zinc-500 hidden sm:inline" data-testid="user-email">{user?.email}</span>
            <button onClick={logout} data-testid="logout-btn"
              className="text-xs font-mono uppercase tracking-[0.2em] text-zinc-600 hover:text-black flex items-center gap-1">
              <SignOut size={14} weight="bold" /> Sign out
            </button>
          </div>
        </div>
      </header>

      <div className="grid lg:grid-cols-[260px_1fr] min-h-[calc(100vh-3.5rem)]">
        <aside className="border-r border-zinc-200 bg-zinc-50/50 p-4 lg:p-5 space-y-6">
          <div>
            <div className="text-[10px] uppercase tracking-[0.3em] text-zinc-500 font-mono mb-3 flex items-center gap-2">
              <Clock size={12} weight="bold" /> History
            </div>
            <div className="space-y-1 max-h-64 overflow-y-auto" data-testid="history-list">
              {history.length === 0 && <p className="text-xs font-mono text-zinc-400">No searches yet.</p>}
              {history.map((j) => (
                <button key={j.id} onClick={() => loadJob(j.id)}
                  className="w-full text-left px-2 py-1.5 border border-transparent hover:border-zinc-300 hover:bg-white transition-colors group">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-mono truncate">{j.keyword}</span>
                    <span className="text-[9px] font-mono text-zinc-400">
                      {j.status === "complete" ? `${j.result?.opportunity_score?.toFixed?.(0) ?? "-"}` :
                       j.status === "running" ? "..." : "x"}
                    </span>
                  </div>
                </button>
              ))}
            </div>
          </div>

          <div>
            <div className="text-[10px] uppercase tracking-[0.3em] text-zinc-500 font-mono mb-3 flex items-center gap-2">
              <BookmarkSimple size={12} weight="bold" /> Watchlist
            </div>
            <div className="space-y-2" data-testid="watchlist">
              {watchlist.length === 0 && <p className="text-xs font-mono text-zinc-400">Empty.</p>}
              {watchlist.map((w) => (
                <div key={w.id} className="border border-zinc-200 bg-white p-2">
                  <div className="flex items-center justify-between gap-1">
                    <button onClick={() => loadNicheDetail(w.keyword)} className="text-xs font-mono font-bold text-left hover:text-amber-600 truncate flex-1">
                      {w.keyword}
                    </button>
                    <button onClick={() => removeWatch(w.id)} className="text-zinc-400 hover:text-red-500">
                      <XCircle size={14} weight="bold" />
                    </button>
                  </div>
                  {w.latest_snapshot && (
                    <div className="text-[10px] font-mono text-zinc-500 mt-1 flex justify-between">
                      <span>Score {w.latest_snapshot.opportunity_score?.toFixed?.(0)}</span>
                      {w.week_over_week_pct != null && (
                        <span className={w.week_over_week_pct > 10 ? "text-amber-600 font-bold" : ""}>
                          {w.week_over_week_pct > 0 ? "+" : ""}{w.week_over_week_pct}%
                        </span>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        </aside>

        <main className="p-6 lg:p-8 space-y-6 max-w-[1600px]">
          <SearchBar value={keyword} onChange={setKeyword} onSubmit={startSearch} busy={polling} authAxios={authAxios} />

          <LiveNicheBoard activeTaskId={polling ? (activeJob?.id || "pending") : null} onPick={loadNicheDetail} />

          {detailMode === "empty" && !polling && (
            <>
              <div className="border border-zinc-200 bg-zinc-50 p-12 text-center">
                <p className="text-[10px] uppercase tracking-[0.3em] font-mono text-zinc-400 mb-3">Empty terminal</p>
                <h2 className="text-2xl font-black tracking-tight mb-2" style={{ fontFamily: "'Cabinet Grotesk', system-ui" }}>
                  Scan a keyword to begin.
                </h2>
                <p className="text-xs font-mono text-zinc-500 max-w-md mx-auto">
                  Try a long-tail phrase like <span className="font-bold">"logo for bio-hacking startups"</span> or
                  broader like <span className="font-bold">"video editing"</span>.
                </p>
              </div>
              <TopFocusKeywords authAxios={authAxios} onPick={loadFocusKeyword} refreshKey={history.length} />
            </>
          )}

          {detailMode === "snapshot_only" && activeSnapshot && !polling && (
            <>
              <div className="flex items-center justify-between flex-wrap gap-3">
                <div>
                  <div className="text-[10px] uppercase tracking-[0.3em] font-mono text-zinc-500">Mongo live snapshot</div>
                  <h1 className="text-3xl lg:text-4xl font-black tracking-tighter" style={{ fontFamily: "'Cabinet Grotesk', system-ui" }} data-testid="active-keyword">
                    {activeKeyword}
                  </h1>
                  <div className="flex items-center gap-3 mt-1 text-[10px] font-mono uppercase tracking-[0.2em]">
                    <span className="flex items-center gap-1 text-zinc-500">
                      <Database size={10} weight="bold" /> MARKET SNAPSHOT
                    </span>
                    <span className="text-zinc-400">{activeSnapshot.last_scanned ? new Date(activeSnapshot.last_scanned).toLocaleString() : "Awaiting first completed scan"}</span>
                  </div>
                </div>
                <div className="flex gap-2">
                  <Button onClick={addWatch} data-testid="add-watchlist-btn"
                    className="rounded-none bg-white hover:bg-zinc-100 text-black border border-zinc-300 font-mono text-xs uppercase tracking-[0.15em] h-9">
                    <BookmarkSimple size={12} weight="bold" className="mr-1" /> Watch
                  </Button>
                  <Button onClick={() => startSearch(activeKeyword)} data-testid="rescan-btn"
                    className="rounded-none bg-black hover:bg-zinc-800 text-white font-mono text-xs uppercase tracking-[0.15em] h-9">
                    <TrendUp size={12} weight="bold" className="mr-1" /> Re-scan
                  </Button>
                </div>
              </div>

              <div className="grid lg:grid-cols-3 gap-4">
                <RatioMeter ratio={snapshotSignal.competition_to_order_ratio || 0} isGold={Boolean(snapshotSignal.ratio_is_gold || activeSnapshot.is_gold)} />
                <VelocityCard
                  score={snapshotSignal.velocity_score || 0}
                  momentumGap={false}
                  highTicketVacuum={false}
                />
                <div className={`border p-5 ${activeSnapshot.is_gold ? "border-amber-500 bg-amber-50" : "border-zinc-200 bg-white"}`} data-testid="snapshot-summary-card">
                  <div className="text-[10px] uppercase tracking-[0.3em] font-mono text-zinc-500 mb-3">Shared board summary</div>
                  <div className="flex items-end justify-between gap-4">
                    <div>
                      <div className="text-4xl font-black tracking-tighter" style={{ fontFamily: "'Cabinet Grotesk', system-ui" }}>
                        {(activeSnapshot.score ?? 0).toFixed(0)}
                      </div>
                      <div className="text-[10px] font-mono uppercase tracking-[0.2em] text-zinc-500">Board score</div>
                    </div>
                    {activeSnapshot.is_gold && (
                      <div className="bg-amber-500 text-white px-2 py-1 text-[10px] font-mono uppercase tracking-[0.2em]">Gold</div>
                    )}
                  </div>
                  <p className="text-xs font-mono text-zinc-600 mt-4 leading-relaxed">
                    This keyword is loaded from MongoDB market insights. Run a fresh scan to hydrate gig tables, exports, and AI analysis for your account.
                  </p>
                </div>
              </div>

              <div className="grid grid-cols-2 lg:grid-cols-4 gap-px bg-zinc-200">
                <MetricTile testid="snapshot-total" label="Total Gigs" value={(activeSnapshot.total_gigs ?? 0).toLocaleString()} sublabel={(activeSnapshot.total_gigs ?? 0) < 2000 ? "LOW COMP" : "DENSE"} />
                <MetricTile testid="snapshot-queue" label="Avg Queue" value={(activeSnapshot.avg_orders_in_queue ?? 0).toFixed(1)} sublabel={`score ${(activeSnapshot.score ?? 0).toFixed(1)}`} />
                <MetricTile testid="snapshot-opportunity" label="Opportunity" value={snapshotSignal.opportunity_score ?? 0} sublabel={snapshotSignal.data_source === "live" ? "LIVE SCRAPE" : "FALLBACK"} tone={snapshotSignal.data_source === "live" ? "gold" : undefined} />
                <MetricTile testid="snapshot-saturation" label="Saturation" value={snapshotSignal.saturation_index ?? 0} sublabel={snapshotSignal.ratio_is_gold ? "RATIO GOLD" : "BOARD MODE"} tone={snapshotSignal.ratio_is_gold ? "gold" : undefined} />
              </div>

              <TopFocusKeywords authAxios={authAxios} onPick={loadFocusKeyword} refreshKey={history.length} />
            </>
          )}

          {detailMode === "full_result" && result && (
            <>
              <div className="flex items-center justify-between flex-wrap gap-3">
                <div>
                  <div className="text-[10px] uppercase tracking-[0.3em] font-mono text-zinc-500">Current scan</div>
                  <h1 className="text-3xl lg:text-4xl font-black tracking-tighter" style={{ fontFamily: "'Cabinet Grotesk', system-ui" }} data-testid="active-keyword">
                    {activeJob.keyword}
                  </h1>
                  <div className="flex items-center gap-3 mt-1 text-[10px] font-mono uppercase tracking-[0.2em]">
                    <span className="flex items-center gap-1 text-zinc-500">
                      <Circle size={6} weight="fill" className={result.data_source === "live" ? "text-green-500" : "text-amber-500"} />
                      {result.data_source === "live" ? "LIVE SCRAPE" : "STEALTH FALLBACK"}
                    </span>
                    <span className="text-zinc-400">{new Date(result.scraped_at).toLocaleString()}</span>
                  </div>
                </div>
                <div className="flex gap-2">
                  <Button onClick={addWatch} data-testid="add-watchlist-btn"
                    className="rounded-none bg-white hover:bg-zinc-100 text-black border border-zinc-300 font-mono text-xs uppercase tracking-[0.15em] h-9">
                    <BookmarkSimple size={12} weight="bold" className="mr-1" /> Watch
                  </Button>
                  <Button onClick={() => startSearch(activeJob.keyword)} data-testid="rescan-btn"
                    className="rounded-none bg-white hover:bg-zinc-100 text-black border border-zinc-300 font-mono text-xs uppercase tracking-[0.15em] h-9">
                    <TrendUp size={12} weight="bold" className="mr-1" /> Re-scan
                  </Button>
                  <Button onClick={() => exportJob("csv")} data-testid="export-csv-btn"
                    className="rounded-none bg-white hover:bg-zinc-100 text-black border border-zinc-300 font-mono text-xs uppercase tracking-[0.15em] h-9">
                    <FileCsv size={12} weight="bold" className="mr-1" /> CSV
                  </Button>
                  <Button onClick={() => exportJob("json")} data-testid="export-json-btn"
                    className="rounded-none bg-black hover:bg-zinc-800 text-white font-mono text-xs uppercase tracking-[0.15em] h-9">
                    <FileText size={12} weight="bold" className="mr-1" /> JSON
                  </Button>
                </div>
              </div>

              <div className="grid lg:grid-cols-3 gap-4">
                <ScoreGauge score={result.opportunity_score} breakdown={result.breakdown} />
                <RatioMeter ratio={result.competition_to_order_ratio} isGold={result.ratio_is_gold} />
                <VelocityCard score={result.velocity_score}
                  momentumGap={result.momentum_gap} highTicketVacuum={result.high_ticket_vacuum} />
              </div>

              <div className="grid grid-cols-2 lg:grid-cols-4 xl:grid-cols-7 gap-px bg-zinc-200">
                <MetricTile testid="metric-total" label="Total Gigs" value={result.metrics.total_services.toLocaleString()} sublabel={result.metrics.total_services < 2000 ? "LOW COMP" : "DENSE"} />
                <MetricTile testid="metric-queue" label="Avg Queue" value={result.metrics.avg_orders_in_queue} sublabel={`top10 ${result.metrics.avg_queue_top10}`} />
                <MetricTile testid="metric-saturation-index" label="Saturation Index"
                  value={result.saturation_index}
                  sublabel={result.saturation_index > 50 ? "HUNGRY" : "FED"}
                  tone={result.saturation_index > 60 ? "gold" : undefined} />
                <MetricTile testid="metric-promoted" label="Promoted CPA"
                  value={`${result.promoted_cpa_pct}%`}
                  sublabel={result.promoted_cpa_signal?.replace("_", " ")}
                  tone={result.promoted_cpa_signal === "WIDE_OPEN" ? "gold" : (result.promoted_cpa_signal === "CROWDED" ? "danger" : undefined)} />
                <MetricTile testid="metric-velocity-meta" label="Velocity"
                  value={result.velocity_score}
                  sublabel={`${result.metrics.reviews_last_7d} rev/7d`}
                  tone={result.velocity_score > 50 ? "gold" : undefined} />
                <MetricTile testid="metric-median" label="Median Price" value={`$${result.metrics.median_price}`}
                  sublabel={result.metrics.price_inflation_pct != null ? `${result.metrics.price_inflation_pct >= 0 ? "+" : ""}${result.metrics.price_inflation_pct}% vs prior` : "no prior"}
                  tone={(result.metrics.price_inflation_pct || 0) > 20 ? "gold" : undefined} />
                <MetricTile testid="metric-ceiling" label="Top Decile" value={`$${result.metrics.top_decile_price}`}
                  sublabel={result.high_ticket_vacuum ? "HIGH-TICKET VACUUM" : `${result.metrics.high_ticket_count} >= $200 +queue`}
                  tone={result.high_ticket_vacuum ? "gold" : undefined} />
              </div>

              <AIPanel job={activeJob} authAxios={authAxios} onPickKeyword={startSearch} />

              <TopFocusKeywords authAxios={authAxios} onPick={loadFocusKeyword} refreshKey={history.length} />

              <div className="grid lg:grid-cols-2 gap-4">
                <GigTable testid="top10-table" title="Top 10 - first page" gigs={top10} />
                <GigTable testid="bottom10-table" title="Bottom 10 - first page" gigs={bot10} />
              </div>

              {trendData.length > 1 && (
                <div className="border border-zinc-200 bg-white p-5" data-testid="trend-chart">
                  <div className="flex items-center justify-between mb-4">
                    <span className="text-[10px] uppercase tracking-[0.3em] font-mono text-zinc-500 flex items-center gap-2">
                      <ChartLineUp size={12} weight="bold" /> Trend (week-over-week)
                    </span>
                  </div>
                  <ResponsiveContainer width="100%" height={220}>
                    <LineChart data={trendData}>
                      <CartesianGrid stroke="#E5E7EB" strokeDasharray="3 3" />
                      <XAxis dataKey="date" stroke="#52525B" fontSize={10} fontFamily="IBM Plex Mono" />
                      <YAxis yAxisId="left" stroke="#52525B" fontSize={10} fontFamily="IBM Plex Mono" />
                      <YAxis yAxisId="right" orientation="right" stroke="#F59E0B" fontSize={10} fontFamily="IBM Plex Mono" />
                      <Tooltip contentStyle={{ fontFamily: "IBM Plex Mono", fontSize: 11, border: "1px solid #E5E7EB" }} />
                      <Line yAxisId="left" type="monotone" dataKey="services" stroke="#09090B" strokeWidth={1.5} dot={false} name="Total gigs" />
                      <Line yAxisId="right" type="monotone" dataKey="orders" stroke="#F59E0B" strokeWidth={1.5} dot={false} name="Avg queue" />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              )}

              {result.tags?.length > 0 && (
                <div className="border border-zinc-200 bg-white p-5" data-testid="tag-cloud">
                  <div className="text-[10px] uppercase tracking-[0.3em] font-mono text-zinc-500 mb-3 flex items-center gap-2">
                    <Tag size={12} weight="bold" /> Cross-reference tags (top 3 gigs)
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {result.tags.map((t, i) => (
                      <button key={i} onClick={() => startSearch(t)}
                        className="text-xs font-mono border border-zinc-300 bg-white hover:bg-black hover:text-white px-3 py-1.5 transition-colors">
                        {t}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
        </main>
      </div>

      {PricingMount}
      <ReferralDialog open={referralOpen} onOpenChange={setReferralOpen} onRedeemSuccess={refreshBilling} />
    </div>
  );
}
