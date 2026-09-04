"use client";

import { useEffect, useState, useCallback } from "react";

interface AuditLogEntry {
  id: number;
  mandate_id: string;
  request_id: string;
  decision: "approved" | "rejected" | "pending_confirmation" | "settled";
  reason_code: string | null;
  amount: number;
  merchant_id: string;
  category: string;
  created_at: string;
}

interface MandateEntry {
  mandate_id: string;
  agent_id: string;
  principal_id: string;
  scope_merchant_allowlist: string[];
  scope_category_allowlist: string[];
  limits_max_per_txn: number;
  limits_daily_cap: number;
  limits_currency: string;
  validity_not_before: string;
  validity_not_after: string;
  confirmation_threshold: number;
  status: "active" | "revoked" | "exhausted";
  daily_spent: number;
  created_at: string;
}

interface PaymentAttemptEntry {
  id: number;
  mandate_id: string;
  request_id: string;
  amount: number;
  currency: string;
  razorpay_order_id: string | null;
  razorpay_payment_id: string | null;
  settlement_status: "pending" | "captured" | "failed";
  created_at: string;
}

// Mirror of MandateInput from lib/mandate/types.ts (client-side copy)
interface ProposedMandate {
  agent_id: string;
  principal_id: string;
  scope: { merchant_allowlist: string[]; category_allowlist: string[] };
  limits: { max_per_txn: number; daily_cap: number; currency: string };
  validity: { not_before: string; not_after: string };
  confirmation_threshold: number;
}

export default function DashboardPage() {
  const [auditLogs, setAuditLogs] = useState<AuditLogEntry[]>([]);
  const [mandates, setMandates] = useState<MandateEntry[]>([]);
  const [pendingConfirmations, setPendingConfirmations] = useState<
    AuditLogEntry[]
  >([]);
  const [paymentAttempts, setPaymentAttempts] = useState<PaymentAttemptEntry[]>(
    [],
  );
  const [loading, setLoading] = useState<boolean>(true);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [autoRefresh, setAutoRefresh] = useState<boolean>(true);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<{
    type: "success" | "error";
    text: string;
  } | null>(null);

  // --- New Mandate (propose/issue) state ---
  const [showNewMandate, setShowNewMandate] = useState<boolean>(false);
  const [proposeText, setProposeText] = useState<string>("");
  const [proposing, setProposing] = useState<boolean>(false);
  const [proposal, setProposal] = useState<ProposedMandate | null>(null);
  const [proposeRefusal, setProposeRefusal] = useState<string | null>(null);
  const [editingProposal, setEditingProposal] = useState<boolean>(false);
  const [issuing, setIssuing] = useState<boolean>(false);

  // --- Agent Playground state ---
  const [playgroundMandateId, setPlaygroundMandateId] = useState<string>("");
  const [playgroundMerchant, setPlaygroundMerchant] = useState<string>("");
  const [playgroundCategory, setPlaygroundCategory] = useState<string>("");
  const [playgroundAmount, setPlaygroundAmount] = useState<string>("");
  const [playgroundFiring, setPlaygroundFiring] = useState<boolean>(false);
  const [playgroundResult, setPlaygroundResult] = useState<{
    decision: "approved" | "rejected" | "pending_confirmation";
    reason_code: string | null;
    explanation: string;
    request_id: string;
    amount_inr: number;
    razorpay_order_id: string | null;
  } | null>(null);

  const [dashboardWarnings, setDashboardWarnings] = useState<string[]>([]);

  const fetchData = useCallback(async () => {
    try {
      const res = await fetch("/api/dashboard");
      if (!res.ok) throw new Error("Failed to fetch dashboard data");
      const data = await res.json();
      setAuditLogs(data.auditLogs || []);
      setMandates(data.mandates || []);
      setPendingConfirmations(data.pendingConfirmations || []);
      setPaymentAttempts(data.paymentAttempts || []);
      setDashboardWarnings(data.warnings || []);
      setLastUpdated(new Date());
    } catch (err) {
      console.error("Dashboard fetch error:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let isSubscribed = true;

    async function poll() {
      try {
        const res = await fetch("/api/dashboard");
        if (!res.ok) return;
        const data = await res.json();
        if (isSubscribed) {
          setAuditLogs(data.auditLogs || []);
          setMandates(data.mandates || []);
          setPendingConfirmations(data.pendingConfirmations || []);
          setPaymentAttempts(data.paymentAttempts || []);
          setDashboardWarnings(data.warnings || []);
          setLastUpdated(new Date());
          setLoading(false);
        }
      } catch (err) {
        console.error("Poll error:", err);
        if (isSubscribed) setLoading(false);
      }
    }

    poll();

    if (!autoRefresh) {
      return () => {
        isSubscribed = false;
      };
    }

    const interval = setInterval(poll, 3000);
    return () => {
      isSubscribed = false;
      clearInterval(interval);
    };
  }, [autoRefresh]);

  const handleConfirm = async (item: AuditLogEntry) => {
    const key = `${item.mandate_id}:${item.request_id}`;
    setConfirmingId(key);
    setActionMessage(null);

    try {
      const res = await fetch("/api/mandates/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mandate_id: item.mandate_id,
          request_id: item.request_id,
          amount: Number(item.amount),
          merchant_id: item.merchant_id,
          category: item.category,
        }),
      });

      const result = await res.json();

      if (!res.ok || !result.success) {
        const errorMsg =
          result.decision?.reason_code || result.error || "Confirmation failed";
        setActionMessage({
          type: "error",
          text: `Confirmation rejected: ${errorMsg}`,
        });
      } else {
        setActionMessage({
          type: "success",
          text: `Confirmed. Razorpay order created — awaiting payment capture. Order: ${result.razorpayOrderId ?? "N/A"}`,
        });
      }

      await fetchData();
    } catch (err) {
      setActionMessage({
        type: "error",
        text:
          err instanceof Error
            ? err.message
            : "Network error during confirmation",
      });
    } finally {
      setConfirmingId(null);
    }
  };

  const handlePropose = async () => {
    if (!proposeText.trim()) return;
    setProposing(true);
    setProposal(null);
    setProposeRefusal(null);
    setEditingProposal(false);

    try {
      const res = await fetch("/api/mandates/propose", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: proposeText }),
      });
      const data = await res.json() as { safe?: boolean; proposal?: ProposedMandate; reason?: string; error?: string };

      if (!res.ok) {
        setProposeRefusal(data.error ?? "Proposal failed unexpectedly.");
      } else if (data.safe === false) {
        setProposeRefusal(data.reason ?? "The request was refused.");
      } else if (data.safe === true && data.proposal) {
        setProposal(data.proposal);
      }
    } catch (err) {
      setProposeRefusal(err instanceof Error ? err.message : "Network error during proposal.");
    } finally {
      setProposing(false);
    }
  };

  const handleIssue = async (mandateInput: ProposedMandate) => {
    setIssuing(true);
    setActionMessage(null);

    try {
      const res = await fetch("/api/mandates/issue", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mandateInput }),
      });
      const data = await res.json() as { success?: boolean; mandate_id?: string; error?: string };

      if (!res.ok || !data.success) {
        setActionMessage({ type: "error", text: `Mandate issuance failed: ${data.error ?? "Unknown error"}` });
      } else {
        setActionMessage({ type: "success", text: `Mandate issued successfully! ID: ${data.mandate_id ?? ""}` });
        // Reset the form and refresh mandates
        setShowNewMandate(false);
        setProposeText("");
        setProposal(null);
        setProposeRefusal(null);
        setEditingProposal(false);
        await fetchData();
      }
    } catch (err) {
      setActionMessage({ type: "error", text: err instanceof Error ? err.message : "Network error during issuance." });
    } finally {
      setIssuing(false);
    }
  };

  const handlePlaygroundFire = async (overrides?: {
    merchant_id?: string;
    category?: string;
    amount?: number;
  }) => {
    const mandateId = playgroundMandateId;
    if (!mandateId) {
      setPlaygroundResult(null);
      return;
    }
    const merchant = overrides?.merchant_id ?? playgroundMerchant;
    const category = overrides?.category ?? playgroundCategory;
    const amountPaise =
      overrides?.amount !== undefined
        ? overrides.amount
        : Math.round(parseFloat(playgroundAmount) * 100);

    if (!merchant || !category || isNaN(amountPaise) || amountPaise <= 0) {
      return;
    }

    setPlaygroundFiring(true);
    setPlaygroundResult(null);

    try {
      const res = await fetch("/api/gate/pay", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mandate_id: mandateId,
          amount: amountPaise,
          merchant_id: merchant,
          category: category.toUpperCase(),
          // No request_id — server auto-generates a UUID so every click is fresh
        }),
      });
      const data = await res.json() as {
        decision?: "approved" | "rejected" | "pending_confirmation";
        reason_code?: string | null;
        explanation?: string;
        request_id?: string;
        amount_inr?: number;
        razorpay_order_id?: string | null;
        error?: string;
      };

      if (!res.ok || !data.decision) {
        setPlaygroundResult({
          decision: "rejected",
          reason_code: "SERVER_ERROR",
          explanation: data.error ?? "Unexpected server error.",
          request_id: "",
          amount_inr: amountPaise / 100,
          razorpay_order_id: null,
        });
      } else {
        setPlaygroundResult({
          decision: data.decision,
          reason_code: data.reason_code ?? null,
          explanation: data.explanation ?? "",
          request_id: data.request_id ?? "",
          amount_inr: data.amount_inr ?? amountPaise / 100,
          razorpay_order_id: data.razorpay_order_id ?? null,
        });
        // Refresh dashboard so the ledger & utilization bars update live
        await fetchData();
      }
    } catch (err) {
      setPlaygroundResult({
        decision: "rejected",
        reason_code: "NETWORK_ERROR",
        explanation: err instanceof Error ? err.message : "Network error.",
        request_id: "",
        amount_inr: amountPaise / 100,
        razorpay_order_id: null,
      });
    } finally {
      setPlaygroundFiring(false);
    }
  };

  const formatPaise = (paise: number) => {

    return new Intl.NumberFormat("en-IN", {
      style: "currency",
      currency: "INR",
      minimumFractionDigits: 2,
    }).format(Number(paise) / 100);
  };

  const truncateId = (id: string, chars = 8) => {
    if (!id) return "";
    if (id.length <= chars * 2) return id;
    return `${id.slice(0, chars)}...${id.slice(-chars)}`;
  };

  const formatDateTime = (iso: string) => {
    try {
      const d = new Date(iso);
      return d.toLocaleTimeString("en-GB", {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      });
    } catch {
      return iso;
    }
  };

  const formatDate = (iso: string) => {
    try {
      const d = new Date(iso);
      return d.toLocaleDateString("en-GB", {
        day: "2-digit",
        month: "short",
        year: "numeric",
      });
    } catch {
      return iso;
    }
  };

  const formatValidityWindow = (notBefore: string, notAfter: string) => {
    try {
      const d1 = new Date(notBefore);
      const d2 = new Date(notAfter);
      const d1Day = d1.getDate();
      const d1Month = d1.toLocaleDateString("en-GB", { month: "short" });
      const d2Day = d2.getDate();
      const d2Month = d2.toLocaleDateString("en-GB", { month: "short" });

      if (d1Month === d2Month && d1.getFullYear() === d2.getFullYear()) {
        return `${d1Day}→${d2Day} ${d2Month}`;
      }
      return `${d1Day} ${d1Month} → ${d2Day} ${d2Month}`;
    } catch {
      return `${formatDate(notBefore)} → ${formatDate(notAfter)}`;
    }
  };

  return (
    <div className="min-h-screen bg-[var(--color-page)] text-zinc-100 font-sans p-6 md:p-12 selection:bg-[var(--color-gold)] selection:text-black">
      {/* Top Navigation / Header */}
      <header className="flex flex-col md:flex-row md:items-end justify-between pb-8 border-b border-[var(--color-elevated)] gap-6">
        <div>
          <div className="flex items-center gap-3 mb-2">
            <div className="h-2 w-2 rounded-full bg-[var(--color-gold)] shadow-[0_0_8px_var(--color-gold-hover)] animate-pulse-slow" />
            <h1 className="text-3xl font-display tracking-wide text-white flex items-baseline gap-3">
              MandateGate
              <span className="text-xs font-mono font-medium tracking-widest px-2 py-0.5 rounded bg-[var(--color-elevated)] text-zinc-400">
                OPS CONSOLE
              </span>
            </h1>
          </div>
          <p className="text-sm text-zinc-400 font-serif italic tracking-wide">
            Autonomous Policy Engine &amp; High-Assurance Settlement Gate
          </p>
        </div>

        <div className="flex items-center gap-4 text-xs font-mono">
          <div className="flex items-center gap-2 bg-[var(--color-panel)] border border-[var(--color-elevated)] px-3 py-2 rounded shadow-sm">
            <span className="text-zinc-500">POLLING</span>
            <button
              onClick={() => setAutoRefresh(!autoRefresh)}
              className={`px-2 py-0.5 rounded font-bold transition-all uppercase tracking-widest ${
                autoRefresh
                  ? "bg-[var(--color-gold-subtle)] text-[var(--color-gold)] border border-[var(--color-gold-muted)]"
                  : "bg-zinc-800/50 text-zinc-500 border border-transparent"
              }`}
            >
              {autoRefresh ? "Active" : "Paused"}
            </button>
          </div>

          <button
            onClick={() => fetchData()}
            disabled={loading}
            className="bg-[var(--color-panel)] hover:bg-[var(--color-elevated)] active:bg-zinc-800 border border-[var(--color-elevated)] text-zinc-300 px-4 py-2 rounded shadow-sm transition-all flex items-center gap-2 font-medium tracking-wide"
          >
            <svg
              className={`w-3.5 h-3.5 ${loading ? "animate-spin text-[var(--color-gold)]" : "text-zinc-500"}`}
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
            REFRESH
          </button>

          {lastUpdated && (
            <span className="text-zinc-500 hidden sm:inline ml-2 border-l border-zinc-800 pl-4">
              SYNC: {lastUpdated.toLocaleTimeString()}
            </span>
          )}
        </div>
      </header>

      {/* DB Partial-Failure Warning Banner */}
      {dashboardWarnings.length > 0 && (
        <div className="my-4 p-3 rounded border border-amber-800 bg-amber-950 text-amber-300 text-xs font-mono flex items-start gap-3 animate-slide-down-fade">
          <span className="text-amber-500 font-bold tracking-widest shrink-0">⚠ DATA WARNING</span>
          <ul className="list-disc list-inside space-y-0.5">
            {dashboardWarnings.map((w, i) => <li key={i}>{w}</li>)}
          </ul>
          <button onClick={() => setDashboardWarnings([])} className="ml-auto text-zinc-500 hover:text-white shrink-0">✕</button>
        </div>
      )}

      {/* Action Notification Toast */}
      {actionMessage && (
        <div
          className={`my-8 p-4 rounded border shadow-lg flex items-center justify-between text-sm animate-slide-down-fade ${
            actionMessage.type === "success"
              ? "bg-[var(--color-semantic-green-subtle)] border-[var(--color-semantic-green)] text-emerald-200"
              : "bg-[var(--color-semantic-red-subtle)] border-[var(--color-semantic-red)] text-rose-200"
          }`}
        >
          <div className="flex items-center gap-3">
            <span className="font-bold font-mono tracking-widest">
              {actionMessage.type === "success" ? "VERIFIED" : "REJECTED"}
            </span>
            <span className="font-serif italic text-base">{actionMessage.text}</span>
          </div>
          <button onClick={() => setActionMessage(null)} className="text-zinc-400 hover:text-white text-xs font-mono tracking-widest uppercase">
            Dismiss
          </button>
        </div>
      )}

      {/* Stats Summary Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-6 my-10">
        <div className="bg-[var(--color-panel)] border border-[var(--color-elevated)] shadow-md rounded p-5 relative overflow-hidden group hover:border-zinc-700 transition-colors">
          <div className="text-zinc-500 text-[10px] font-mono uppercase tracking-widest mb-2">Active Mandates</div>
          <div className="text-4xl font-display text-zinc-100">
            {mandates.filter((m) => m.status === "active").length}
            <span className="text-sm font-sans text-zinc-600 ml-2">/ {mandates.length}</span>
          </div>
        </div>

        <div className="bg-[var(--color-panel)] border border-[var(--color-elevated)] shadow-md rounded p-5 relative overflow-hidden group hover:border-[var(--color-gold-muted)] transition-colors">
          <div className="text-[var(--color-gold)] text-[10px] font-mono uppercase tracking-widest mb-2 flex justify-between">
            Pending Approvals
            {pendingConfirmations.length > 0 && <span className="h-1.5 w-1.5 rounded-full bg-[var(--color-gold)] animate-pulse-slow mt-1" />}
          </div>
          <div className="text-4xl font-display text-[var(--color-gold)]">
            {pendingConfirmations.length}
          </div>
        </div>

        <div className="bg-[var(--color-panel)] border border-[var(--color-elevated)] shadow-md rounded p-5 relative overflow-hidden group hover:border-zinc-700 transition-colors">
          <div className="text-zinc-500 text-[10px] font-mono uppercase tracking-widest mb-2">Audit Ledger Events</div>
          <div className="text-4xl font-display text-zinc-100">
            {auditLogs.length}
          </div>
        </div>

        <div className="bg-[var(--color-panel)] border border-[var(--color-elevated)] shadow-md rounded p-5 relative overflow-hidden group hover:border-zinc-700 transition-colors">
          <div className="text-zinc-500 text-[10px] font-mono uppercase tracking-widest mb-2">Settled Payments</div>
          <div className="text-4xl font-display text-emerald-500/90">
            {paymentAttempts.filter((p) => p.settlement_status === "captured").length}
          </div>
        </div>
      </div>

      {/* AGENT PLAYGROUND */}
      <section className="mb-14">
        <h2 className="text-2xl font-display text-white tracking-wide mb-2 flex items-center gap-4">
          Agent Playground
          <span className="text-xs font-sans font-medium px-2 py-0.5 rounded bg-emerald-950 text-emerald-400 border border-emerald-900 uppercase tracking-widest">
            Live Gate · Real Pipeline
          </span>
        </h2>
        <p className="text-xs text-zinc-500 font-mono mb-6">
          Every request below runs through the full 10-step policy engine — signature verify, scope, atomic cap, settlement. Nothing is mocked.
        </p>

        <div className="bg-[var(--color-panel)] border border-[var(--color-elevated)] rounded shadow-md overflow-hidden">
          {/* Mandate selector */}
          <div className="p-6 border-b border-[var(--color-elevated)]">
            <label className="block text-[10px] font-mono uppercase tracking-widest text-zinc-500 mb-2">
              Select Mandate to Test Against
            </label>
            <select
              value={playgroundMandateId}
              onChange={(e) => {
                setPlaygroundMandateId(e.target.value);
                setPlaygroundResult(null);
              }}
              className="w-full bg-[var(--color-page)] border border-[var(--color-elevated)] text-zinc-200 font-mono text-xs rounded px-3 py-2.5 focus:outline-none focus:border-zinc-600"
            >
              <option value="">— choose an active mandate —</option>
              {mandates
                .filter((m) => m.status === "active")
                .map((m) => {
                  const remaining = Number(m.limits_daily_cap) - Number(m.daily_spent);
                  const merchants =
                    m.scope_merchant_allowlist.length > 0
                      ? m.scope_merchant_allowlist.slice(0, 2).join(", ")
                      : "ANY";
                  const cats =
                    m.scope_category_allowlist.length > 0
                      ? m.scope_category_allowlist.slice(0, 2).join(", ")
                      : "ANY";
                  return (
                    <option key={m.mandate_id} value={m.mandate_id}>
                      {m.mandate_id.slice(0, 8)}… · ₹{(remaining / 100).toFixed(0)} left today · {merchants} · [{cats}]
                    </option>
                  );
                })}
            </select>

            {/* Show selected mandate's live limits */}
            {playgroundMandateId && (() => {
              const m = mandates.find((x) => x.mandate_id === playgroundMandateId);
              if (!m) return null;
              const spent = Number(m.daily_spent) / 100;
              const cap = Number(m.limits_daily_cap) / 100;
              const maxTxn = Number(m.limits_max_per_txn) / 100;
              const threshold = Number(m.confirmation_threshold) / 100;
              const pct = cap > 0 ? Math.min((spent / cap) * 100, 100) : 0;
              return (
                <div className="mt-4 grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs font-mono">
                  <div className="bg-[var(--color-page)] border border-[var(--color-elevated)] rounded px-3 py-2">
                    <div className="text-zinc-500 text-[9px] uppercase tracking-widest mb-1">Daily Cap</div>
                    <div className="text-zinc-100">₹{cap.toFixed(0)}</div>
                  </div>
                  <div className="bg-[var(--color-page)] border border-[var(--color-elevated)] rounded px-3 py-2">
                    <div className="text-zinc-500 text-[9px] uppercase tracking-widest mb-1">Spent Today</div>
                    <div className="text-zinc-100">₹{spent.toFixed(0)} <span className="text-zinc-600">({pct.toFixed(0)}%)</span></div>
                  </div>
                  <div className="bg-[var(--color-page)] border border-[var(--color-elevated)] rounded px-3 py-2">
                    <div className="text-zinc-500 text-[9px] uppercase tracking-widest mb-1">Max / Txn</div>
                    <div className="text-zinc-100">₹{maxTxn.toFixed(0)}</div>
                  </div>
                  <div className="bg-[var(--color-page)] border border-[var(--color-gold-muted)] rounded px-3 py-2">
                    <div className="text-[var(--color-gold)] text-[9px] uppercase tracking-widest mb-1">Confirm Threshold</div>
                    <div className="text-[var(--color-gold)]">₹{threshold.toFixed(0)}</div>
                  </div>
                </div>
              );
            })()}
          </div>

          {/* Open-Scope Info Badge — shown when mandate has empty allowlists */}
          {playgroundMandateId && (() => {
            const m = mandates.find((x) => x.mandate_id === playgroundMandateId);
            if (!m) return null;
            const openMerchant = m.scope_merchant_allowlist.length === 0;
            const openCategory = m.scope_category_allowlist.length === 0;
            if (!openMerchant && !openCategory) return null;
            return (
              <div className="mx-6 mb-2 px-3 py-2 rounded border border-amber-800 bg-amber-950 text-amber-400 text-[10px] font-mono flex items-start gap-2">
                <span className="shrink-0 font-bold">⚠ OPEN SCOPE</span>
                <span>
                  This mandate has {[openMerchant && "no merchant restriction", openCategory && "no category restriction"].filter(Boolean).join(" and ")}.
                  {" "}Empty allowlist = <strong>any value permitted</strong> by design.
                  The <em>Wrong Category</em> scenario requires an explicit allowlist to demonstrate OUT_OF_SCOPE.
                  Issue a new mandate with a specific category list to enable it.
                </span>
              </div>
            );
          })()}

          {/* Quick Scenarios */}
          {playgroundMandateId && (() => {
            const m = mandates.find((x) => x.mandate_id === playgroundMandateId);
            const allowedMerchant =
              m && m.scope_merchant_allowlist.length > 0
                ? m.scope_merchant_allowlist[0]
                : "merchant_grocery";
            const allowedCat =
              m && m.scope_category_allowlist.length > 0
                ? m.scope_category_allowlist[0]
                : "GROCERY";
            const threshold = m ? Number(m.confirmation_threshold) : 100000;
            const cap = m ? Number(m.limits_daily_cap) : 150000;
            const spent = m ? Number(m.daily_spent) : 0;
            const remaining = cap - spent;

            // For "Wrong Category": pick a category that is NOT in the allowlist.
            // If the mandate allows ANY category (empty allowlist), this scenario
            // cannot demonstrate OUT_OF_SCOPE — mark it as not applicable.
            const hasLockedCategories = m && m.scope_category_allowlist.length > 0;
            const ALL_CATEGORIES = ["GROCERY", "TECH", "ELECTRONICS", "TRAVEL", "UTILITIES", "FOOD", "FASHION", "HEALTH"];
            const wrongCategory = hasLockedCategories
              ? ALL_CATEGORIES.find((c) => !m!.scope_category_allowlist.includes(c)) ?? "ELECTRONICS"
              : null; // null means mandate allows ANY — can't demo OUT_OF_SCOPE

            const hasLockedMerchants = m && m.scope_merchant_allowlist.length > 0;
            const wrongMerchant = hasLockedMerchants
              ? "store-electronics"
              : "store-electronics"; // merchant won't matter if scope is ANY

            // "Needs Approval": pick an amount above threshold but within cap.
            const needsApprovalAmount = remaining > threshold + 5000
              ? threshold + 5000
              : remaining > threshold
              ? remaining - 1000
              : null; // null = cap too exhausted to demo this

            const scenarios = [
              {
                label: "✅ Happy Path",
                desc: "Small in-scope purchase",
                color: "border-emerald-900 hover:border-emerald-700 text-emerald-400",
                disabled: remaining <= 0,
                disabledReason: "Budget exhausted — pick another mandate",
                params: { merchant_id: allowedMerchant, category: allowedCat, amount: Math.min(30000, Math.max(100, Math.floor(threshold * 0.3))) },
              },
              {
                label: "🔴 Over Daily Cap",
                desc: "Exceeds remaining budget",
                color: "border-rose-900 hover:border-rose-700 text-rose-400",
                disabled: false,
                disabledReason: "",
                params: { merchant_id: allowedMerchant, category: allowedCat, amount: cap + 10000 },
              },
              {
                label: "🔴 Wrong Category",
                desc: wrongCategory ? "Out-of-scope purchase" : "N/A — mandate allows ANY",
                color: wrongCategory
                  ? "border-rose-900 hover:border-rose-700 text-rose-400"
                  : "border-zinc-800 text-zinc-600 cursor-not-allowed opacity-50",
                disabled: !wrongCategory,
                disabledReason: "This mandate has no category restriction (ANY). It cannot demonstrate OUT_OF_SCOPE. Pick a mandate with a specific category allowlist.",
                params: { merchant_id: wrongMerchant, category: wrongCategory ?? "ELECTRONICS", amount: 10000 },
              },
              {
                label: "🟡 Needs Approval",
                desc: needsApprovalAmount ? "Exceeds confirmation threshold" : "N/A — budget too low",
                color: needsApprovalAmount
                  ? "border-amber-900 hover:border-amber-700 text-amber-400"
                  : "border-zinc-800 text-zinc-600 cursor-not-allowed opacity-50",
                disabled: !needsApprovalAmount,
                disabledReason: "Not enough remaining budget to exceed the threshold. Pick a mandate with more budget left.",
                params: { merchant_id: allowedMerchant, category: allowedCat, amount: needsApprovalAmount ?? threshold + 1000 },
              },
              {
                // Demonstrate the newly-enforced per-transaction limit.
                // Fires an amount 10% above max_per_txn so it always fails this check.
                label: "🔴 Exceeds Per-Txn",
                desc: "Over single-transaction limit",
                color: "border-rose-900 hover:border-rose-700 text-rose-400",
                disabled: false,
                disabledReason: "",
                params: { merchant_id: allowedMerchant, category: allowedCat, amount: Math.floor(m ? Number(m.limits_max_per_txn) * 1.1 + 1000 : 200000) },
              },
            ];

            return (
              <div className="p-6 border-b border-[var(--color-elevated)]">
                <div className="text-[10px] font-mono uppercase tracking-widest text-zinc-500 mb-3">
                  Quick Scenarios — 1 Click
                </div>
                <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
                  {scenarios.map((s) => (
                    <button
                      key={s.label}
                      disabled={playgroundFiring || s.disabled}
                      title={s.disabled ? s.disabledReason : ""}
                      onClick={() => {
                        const merchant = s.params.merchant_id;
                        const cat = s.params.category;
                        const amt = s.params.amount;
                        setPlaygroundMerchant(merchant);
                        setPlaygroundCategory(cat);
                        setPlaygroundAmount((amt / 100).toFixed(2));
                        void handlePlaygroundFire({ merchant_id: merchant, category: cat, amount: amt });
                      }}
                      className={`flex flex-col gap-1 px-4 py-3 rounded border bg-[var(--color-page)] text-left transition-all ${s.disabled ? "opacity-40 cursor-not-allowed" : ""} ${!s.disabled ? s.color : "border-zinc-800 text-zinc-600"}`}
                    >
                      <span className="text-xs font-bold font-mono">{s.label}</span>
                      <span className="text-[10px] text-zinc-500">{s.desc}</span>
                      {!s.disabled && (
                        <span className="text-[9px] font-mono text-zinc-600 mt-1">
                          ₹{(s.params.amount / 100).toFixed(0)} · {s.params.category}
                        </span>
                      )}
                    </button>
                  ))}
                </div>
                {remaining <= 0 && (
                  <p className="text-[10px] font-mono text-amber-600 mt-3">
                    ⚠ This mandate&apos;s daily budget is fully spent. Happy Path and Needs Approval are disabled. Switch to a mandate with remaining budget to demo approvals.
                  </p>
                )}
              </div>
            );
          })()}

          {/* Custom input */}
          {playgroundMandateId && (
            <div className="p-6 border-b border-[var(--color-elevated)]">
              <div className="text-[10px] font-mono uppercase tracking-widest text-zinc-500 mb-3">
                Custom Request
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
                <div>
                  <label className="block text-[9px] font-mono uppercase tracking-widest text-zinc-600 mb-1">Merchant ID</label>
                  <input
                    type="text"
                    value={playgroundMerchant}
                    onChange={(e) => setPlaygroundMerchant(e.target.value)}
                    placeholder="merchant_grocery"
                    className="w-full bg-[var(--color-page)] border border-[var(--color-elevated)] text-zinc-200 font-mono text-xs rounded px-3 py-2 focus:outline-none focus:border-zinc-600 placeholder-zinc-700"
                  />
                </div>
                <div>
                  <label className="block text-[9px] font-mono uppercase tracking-widest text-zinc-600 mb-1">Category</label>
                  <select
                    value={playgroundCategory}
                    onChange={(e) => setPlaygroundCategory(e.target.value)}
                    className="w-full bg-[var(--color-page)] border border-[var(--color-elevated)] text-zinc-200 font-mono text-xs rounded px-3 py-2 focus:outline-none focus:border-zinc-600"
                  >
                    <option value="">— select —</option>
                    <option value="GROCERY">GROCERY</option>
                    <option value="FOOD">FOOD</option>
                    <option value="TECH">TECH</option>
                    <option value="ELECTRONICS">ELECTRONICS</option>
                    <option value="TRAVEL">TRAVEL</option>
                    <option value="UTILITIES">UTILITIES</option>
                    <option value="FASHION">FASHION</option>
                    <option value="HEALTH">HEALTH</option>
                    <option value="SAAS">SAAS</option>
                  </select>
                </div>
                <div>
                  <label className="block text-[9px] font-mono uppercase tracking-widest text-zinc-600 mb-1">Amount (₹)</label>
                  <input
                    type="number"
                    value={playgroundAmount}
                    onChange={(e) => setPlaygroundAmount(e.target.value)}
                    placeholder="300.00"
                    min="1"
                    step="1"
                    className="w-full bg-[var(--color-page)] border border-[var(--color-elevated)] text-zinc-200 font-mono text-xs rounded px-3 py-2 focus:outline-none focus:border-zinc-600 placeholder-zinc-700"
                  />
                </div>
                <div className="flex items-end">
                  <button
                    disabled={playgroundFiring || !playgroundMerchant || !playgroundCategory || !playgroundAmount}
                    onClick={() => void handlePlaygroundFire()}
                    className="w-full px-4 py-2 rounded text-xs font-bold font-mono uppercase tracking-widest transition-all bg-zinc-100 hover:bg-white text-black disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                  >
                    {playgroundFiring ? (
                      <>
                        <svg className="w-3 h-3 animate-spin" fill="none" viewBox="0 0 24 24">
                          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z" />
                        </svg>
                        Firing…
                      </>
                    ) : (
                      "Fire Request →"
                    )}
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Result card */}
          {playgroundResult && (() => {
            const isApproved = playgroundResult.decision === "approved";
            const isPending = playgroundResult.decision === "pending_confirmation";
            const borderColor = isApproved
              ? "border-emerald-800"
              : isPending
              ? "border-amber-800"
              : "border-rose-900";
            const bgColor = isApproved
              ? "bg-emerald-950/40"
              : isPending
              ? "bg-amber-950/40"
              : "bg-rose-950/40";
            const labelColor = isApproved
              ? "text-emerald-400"
              : isPending
              ? "text-amber-400"
              : "text-rose-400";
            const decisionLabel = isApproved
              ? "APPROVED"
              : isPending
              ? "PENDING CONFIRMATION"
              : "REJECTED";

            return (
              <div className={`p-6 border-t ${borderColor} ${bgColor} animate-slide-down-fade`}>
                <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-4">
                  <div className="flex-1">
                    <div className={`text-xs font-mono font-bold uppercase tracking-widest mb-1 ${labelColor}`}>
                      ⬤ {decisionLabel}
                      {playgroundResult.reason_code && (
                        <span className="ml-3 text-zinc-500 font-normal">· {playgroundResult.reason_code}</span>
                      )}
                    </div>
                    <p className="text-sm text-zinc-300 font-serif italic mb-3">{playgroundResult.explanation}</p>
                    <div className="flex flex-wrap gap-4 text-[10px] font-mono text-zinc-500">
                      <span>Amount: <span className="text-zinc-300">₹{playgroundResult.amount_inr.toFixed(2)}</span></span>
                      <span>Req ID: <span className="text-zinc-400 break-all">{playgroundResult.request_id.slice(0, 32)}…</span></span>
                      {playgroundResult.razorpay_order_id && (
                        <span>Razorpay Order: <span className="text-emerald-400">{playgroundResult.razorpay_order_id}</span></span>
                      )}
                    </div>
                  </div>
                  {isPending && (
                    <div className="text-[10px] font-mono text-amber-500 bg-amber-950/60 border border-amber-900 rounded px-3 py-2 shrink-0">
                      ↑ Check Pending Confirmations
                    </div>
                  )}
                </div>
              </div>
            );
          })()}

          {!playgroundMandateId && (
            <div className="p-10 text-center text-zinc-600 text-sm font-serif italic">
              Select a mandate above to start testing the live policy engine.
            </div>
          )}
        </div>
      </section>

      {/* SECTION C: PENDING CONFIRMATIONS (ACTIONABLE HUMAN-IN-THE-LOOP) */}
      <section className="mb-14">
        <h2 className="text-2xl font-display text-white tracking-wide mb-6 flex items-center gap-4">
          Pending Confirmations
          <span className="text-xs font-sans font-medium px-2 py-0.5 rounded bg-[var(--color-elevated)] text-zinc-400 border border-zinc-800 uppercase tracking-widest">
            Human-in-the-Loop
          </span>
        </h2>

        {pendingConfirmations.length === 0 ? (
          <div className="bg-[var(--color-panel)] border border-[var(--color-elevated)] shadow-sm rounded p-10 text-center">
            <p className="text-sm text-zinc-500 font-serif italic tracking-wide">
              No payments are currently awaiting human approval.
            </p>
          </div>
        ) : (
          <div className="bg-[#141411] border border-[var(--color-gold-muted)] rounded shadow-[0_4px_24px_rgba(212,162,76,0.06)] overflow-hidden relative">
            <div className="absolute top-0 left-0 w-full h-0.5 bg-gradient-to-r from-transparent via-[var(--color-gold-muted)] to-transparent opacity-50" />
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm font-mono whitespace-nowrap">
                <thead className="bg-[#181814] text-[var(--color-gold)] border-b border-[var(--color-gold-subtle)] uppercase tracking-widest text-[10px]">
                  <tr>
                    <th className="py-4 px-6 font-medium">Time (Local)</th>
                    <th className="py-4 px-6 font-medium">Mandate Hash</th>
                    <th className="py-4 px-6 font-medium">Request Ref</th>
                    <th className="py-4 px-6 font-medium">Target</th>
                    <th className="py-4 px-6 font-medium">Requested Amt</th>
                    <th className="py-4 px-6 text-right font-medium">Required Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--color-gold-subtle)]">
                  {pendingConfirmations.map((item) => {
                    const key = `${item.mandate_id}:${item.request_id}`;
                    const isProcessing = confirmingId === key;
                    return (
                      <tr key={key} className="hover:bg-[var(--color-gold-subtle)] transition-colors animate-slide-down-fade">
                        <td className="py-5 px-6 text-zinc-400 text-xs">
                          {formatDateTime(item.created_at)}
                        </td>
                        <td className="py-5 px-6 text-zinc-300">
                          <span title={item.mandate_id}>{truncateId(item.mandate_id, 6)}</span>
                        </td>
                        <td className="py-5 px-6 text-zinc-100 font-bold">
                          {item.request_id}
                        </td>
                        <td className="py-5 px-6 text-zinc-300 text-xs">
                          <span className="font-bold text-zinc-200">{item.merchant_id}</span>
                          <span className="text-zinc-500 ml-2 font-sans tracking-wide">[{item.category}]</span>
                        </td>
                        <td className="py-5 px-6 text-[var(--color-gold)] font-bold text-base">
                          {formatPaise(item.amount)}
                        </td>
                        <td className="py-5 px-6 text-right">
                          <button
                            onClick={() => handleConfirm(item)}
                            disabled={isProcessing}
                            className={`inline-flex items-center justify-center min-w-[160px] gap-2 px-4 py-2 rounded text-xs font-bold font-sans uppercase tracking-widest transition-all focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-[#141411] focus:ring-[var(--color-gold)] ${
                              isProcessing
                                ? "bg-zinc-800 text-zinc-500 cursor-not-allowed"
                                : "bg-[var(--color-gold)] hover:bg-[var(--color-gold-hover)] active:bg-[#b5883d] text-black shadow-lg shadow-[var(--color-gold-muted)]"
                            }`}
                          >
                            {isProcessing ? (
                              <>
                                <span className="w-3 h-3 border-2 border-zinc-500 border-t-zinc-300 rounded-full animate-spin" />
                                Validating...
                              </>
                            ) : (
                              <>
                                Authorize &amp; Settle
                              </>
                            )}
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </section>

      {/* SECTION B: MANDATES TABLE + NEW MANDATE FORM */}
      <section className="mb-14">
        <h2 className="text-2xl font-display text-white tracking-wide mb-6 flex items-center gap-4">
          Mandates
          <span className="text-xs font-sans font-medium px-2 py-0.5 rounded bg-[var(--color-elevated)] text-zinc-400 border border-zinc-800 uppercase tracking-widest">
            Policy &amp; Limits ({mandates.length})
          </span>
          <button
            onClick={() => {
              setShowNewMandate(!showNewMandate);
              if (showNewMandate) {
                setProposal(null);
                setProposeRefusal(null);
                setProposeText("");
                setEditingProposal(false);
              }
            }}
            className={`ml-auto text-xs font-mono font-bold uppercase tracking-widest px-3 py-1.5 rounded transition-all focus:outline-none focus:ring-2 focus:ring-[var(--color-gold)] focus:ring-offset-2 focus:ring-offset-[var(--color-page)] ${
              showNewMandate
                ? "bg-zinc-800 text-zinc-400 border border-zinc-700"
                : "bg-[var(--color-gold-subtle)] text-[var(--color-gold)] border border-[var(--color-gold-muted)] hover:bg-[var(--color-gold-muted)]"
            }`}
          >
            {showNewMandate ? "✕ Cancel" : "+ New Mandate"}
          </button>
        </h2>

        {/* New Mandate Panel */}
        {showNewMandate && (
          <div className="mb-8 bg-[var(--color-panel)] border border-[var(--color-elevated)] rounded shadow-sm overflow-hidden animate-slide-down-fade">
            {/* Input stage */}
            <div className="p-6 border-b border-[var(--color-elevated)]">
              <div className="flex items-start gap-3 mb-4">
                <div className="h-1.5 w-1.5 rounded-full bg-[var(--color-gold)] mt-2 shrink-0" />
                <div>
                  <p className="text-sm font-sans font-medium text-zinc-200">Describe the mandate in plain English</p>
                  <p className="text-xs text-zinc-500 font-sans mt-0.5">
                    Include: who can spend, on what, how much per day, and for how long.
                    The AI will propose a structured mandate — you review and approve before anything is signed.
                  </p>
                </div>
              </div>
              <textarea
                value={proposeText}
                onChange={(e) => {
                  setProposeText(e.target.value);
                  setProposal(null);
                  setProposeRefusal(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                    void handlePropose();
                  }
                }}
                placeholder="e.g. Let the agent spend up to ₹500 per day on groceries at Swiggy Instamart for the next 3 days"
                rows={3}
                className="w-full bg-[var(--color-elevated)] border border-zinc-700 focus:border-[var(--color-gold)] focus:ring-1 focus:ring-[var(--color-gold)] rounded text-sm font-sans text-zinc-100 placeholder-zinc-600 px-4 py-3 resize-none outline-none transition-colors"
              />
              <div className="flex items-center justify-between mt-3">
                <p className="text-[10px] font-mono text-zinc-600 tracking-widest uppercase">Ctrl+Enter to propose</p>
                <button
                  onClick={() => void handlePropose()}
                  disabled={proposing || !proposeText.trim()}
                  className={`inline-flex items-center gap-2 px-5 py-2 rounded text-xs font-bold font-sans uppercase tracking-widest transition-all focus:outline-none focus:ring-2 focus:ring-[var(--color-gold)] ${
                    proposing || !proposeText.trim()
                      ? "bg-zinc-800 text-zinc-500 cursor-not-allowed"
                      : "bg-[var(--color-gold)] hover:bg-[var(--color-gold-hover)] text-black"
                  }`}
                >
                  {proposing ? (
                    <>
                      <span className="w-3 h-3 border-2 border-zinc-600 border-t-black rounded-full animate-spin" />
                      Proposing...
                    </>
                  ) : (
                    "Propose →"
                  )}
                </button>
              </div>
            </div>

            {/* Refusal card */}
            {proposeRefusal && (
              <div className="p-6 bg-[var(--color-semantic-red-subtle)] border-t border-[var(--color-semantic-red)]/40 animate-slide-down-fade">
                <div className="flex items-start gap-3">
                  <span className="text-[var(--color-semantic-red)] font-mono font-bold text-xs tracking-widest uppercase mt-0.5 shrink-0">Refused</span>
                  <p className="text-sm text-rose-200 font-sans">{proposeRefusal}</p>
                </div>
                <p className="text-[10px] text-zinc-600 font-mono mt-3 tracking-widest uppercase">Revise your description above and try again</p>
              </div>
            )}

            {/* Proposal review card */}
            {proposal && !proposeRefusal && (
              <div className="p-6 border-t border-[var(--color-gold-muted)] bg-[#141411] animate-slide-down-fade">
                <div className="flex items-center justify-between mb-5">
                  <div className="flex items-center gap-2">
                    <div className="h-1.5 w-1.5 rounded-full bg-[var(--color-gold)]" />
                    <span className="text-xs font-mono font-bold text-[var(--color-gold)] tracking-widest uppercase">AI Proposal — Review Before Issuing</span>
                  </div>
                  <button
                    onClick={() => setEditingProposal(!editingProposal)}
                    className="text-[10px] font-mono text-zinc-400 hover:text-zinc-200 uppercase tracking-widest transition-colors"
                  >
                    {editingProposal ? "↩ Hide Edit" : "✎ Edit Fields"}
                  </button>
                </div>

                {!editingProposal ? (
                  /* Read-only review */
                  <div className="grid grid-cols-2 md:grid-cols-3 gap-4 text-xs font-mono mb-6">
                    <div>
                      <div className="text-zinc-600 uppercase tracking-widest text-[9px] mb-1">Daily Cap</div>
                      <div className="text-zinc-100 font-bold text-sm">
                        {new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", minimumFractionDigits: 2 }).format(proposal.limits.daily_cap / 100)}
                      </div>
                    </div>
                    <div>
                      <div className="text-zinc-600 uppercase tracking-widest text-[9px] mb-1">Max Per Txn</div>
                      <div className="text-zinc-100 font-bold text-sm">
                        {new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", minimumFractionDigits: 2 }).format(proposal.limits.max_per_txn / 100)}
                      </div>
                    </div>
                    <div>
                      <div className="text-zinc-600 uppercase tracking-widest text-[9px] mb-1">Confirm Threshold</div>
                      <div className="text-zinc-100 font-bold text-sm">
                        {new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", minimumFractionDigits: 2 }).format(proposal.confirmation_threshold / 100)}
                      </div>
                    </div>
                    <div>
                      <div className="text-zinc-600 uppercase tracking-widest text-[9px] mb-1">Categories</div>
                      <div className="text-zinc-200">{proposal.scope.category_allowlist.join(", ") || "ANY (*)"}</div>
                    </div>
                    <div>
                      <div className="text-zinc-600 uppercase tracking-widest text-[9px] mb-1">Merchants</div>
                      <div className="text-zinc-200">{proposal.scope.merchant_allowlist.join(", ") || "ANY (*)"}</div>
                    </div>
                    <div>
                      <div className="text-zinc-600 uppercase tracking-widest text-[9px] mb-1">Validity Window</div>
                      <div className="text-zinc-200">{formatValidityWindow(proposal.validity.not_before, proposal.validity.not_after)}</div>
                    </div>
                  </div>
                ) : (
                  /* Editable fields — human can freely adjust */
                  <div className="grid grid-cols-2 gap-3 mb-6 text-xs font-mono">
                    {[
                      { label: "Daily Cap (paise)", key: "daily_cap", val: proposal.limits.daily_cap },
                      { label: "Max Per Txn (paise)", key: "max_per_txn", val: proposal.limits.max_per_txn },
                      { label: "Confirm Threshold (paise)", key: "confirmation_threshold", val: proposal.confirmation_threshold },
                    ].map(({ label, key, val }) => (
                      <div key={key}>
                        <label className="text-zinc-600 uppercase tracking-widest text-[9px] mb-1 block">{label}</label>
                        <input
                          type="number"
                          defaultValue={val}
                          onChange={(e) => {
                            const n = Number(e.target.value);
                            if (key === "daily_cap") setProposal({ ...proposal, limits: { ...proposal.limits, daily_cap: n } });
                            else if (key === "max_per_txn") setProposal({ ...proposal, limits: { ...proposal.limits, max_per_txn: n } });
                            else if (key === "confirmation_threshold") setProposal({ ...proposal, confirmation_threshold: n });
                          }}
                          className="w-full bg-[var(--color-elevated)] border border-zinc-700 focus:border-[var(--color-gold)] rounded text-zinc-100 px-3 py-1.5 outline-none transition-colors"
                        />
                      </div>
                    ))}
                    <div className="col-span-2">
                      <label className="text-zinc-600 uppercase tracking-widest text-[9px] mb-1 block">Categories (comma-separated)</label>
                      <input
                        type="text"
                        defaultValue={proposal.scope.category_allowlist.join(", ")}
                        onChange={(e) => {
                          const cats = e.target.value.split(",").map((s) => s.trim()).filter(Boolean);
                          setProposal({ ...proposal, scope: { ...proposal.scope, category_allowlist: cats } });
                        }}
                        className="w-full bg-[var(--color-elevated)] border border-zinc-700 focus:border-[var(--color-gold)] rounded text-zinc-100 px-3 py-1.5 outline-none transition-colors"
                      />
                    </div>
                    <div className="col-span-2">
                      <label className="text-zinc-600 uppercase tracking-widest text-[9px] mb-1 block">Not After (ISO 8601)</label>
                      <input
                        type="text"
                        defaultValue={proposal.validity.not_after}
                        onChange={(e) => setProposal({ ...proposal, validity: { ...proposal.validity, not_after: e.target.value } })}
                        className="w-full bg-[var(--color-elevated)] border border-zinc-700 focus:border-[var(--color-gold)] rounded text-zinc-100 px-3 py-1.5 outline-none transition-colors font-mono text-[11px]"
                      />
                    </div>
                  </div>
                )}

                <div className="flex items-center gap-4 pt-4 border-t border-[var(--color-elevated)]">
                  <button
                    onClick={() => void handleIssue(proposal)}
                    disabled={issuing}
                    className={`inline-flex items-center gap-2 px-6 py-2.5 rounded text-xs font-bold font-sans uppercase tracking-widest transition-all focus:outline-none focus:ring-2 focus:ring-[var(--color-gold)] focus:ring-offset-2 focus:ring-offset-[#141411] ${
                      issuing
                        ? "bg-zinc-800 text-zinc-500 cursor-not-allowed"
                        : "bg-[var(--color-gold)] hover:bg-[var(--color-gold-hover)] active:bg-[#b5883d] text-black shadow-lg shadow-[var(--color-gold-muted)]"
                    }`}
                  >
                    {issuing ? (
                      <>
                        <span className="w-3 h-3 border-2 border-zinc-600 border-t-black rounded-full animate-spin" />
                        Signing &amp; Storing...
                      </>
                    ) : (
                      "Issue Mandate →"
                    )}
                  </button>
                  <p className="text-[10px] font-mono text-zinc-600 tracking-wide">
                    Issuing creates a signed, immutable mandate. This cannot be undone.
                  </p>
                </div>
              </div>
            )}
          </div>
        )}

        <div className="bg-[var(--color-panel)] border border-[var(--color-elevated)] rounded shadow-sm overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs font-mono">
              <thead className="bg-[#181814] text-zinc-500 border-b border-[var(--color-elevated)] uppercase tracking-widest text-[10px]">
                <tr>
                  <th className="py-3.5 px-4 font-medium w-28 whitespace-nowrap">Mandate Hash</th>
                  <th className="py-3.5 px-4 font-medium w-24 whitespace-nowrap">Status</th>
                  <th className="py-3.5 px-4 font-medium w-48 whitespace-nowrap">Utilization (Daily)</th>
                  <th className="py-3.5 px-4 font-medium w-28 whitespace-nowrap">Threshold</th>
                  <th className="py-3.5 px-4 font-medium">Scope Constraints</th>
                  <th className="py-3.5 px-4 font-medium w-36 whitespace-nowrap">Validity Window</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--color-elevated)]">
                {mandates.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="py-8 text-center text-zinc-500 font-serif italic tracking-wide">
                      No mandates issued yet. Run the simulator to seed mandates.
                    </td>
                  </tr>
                ) : (
                  mandates.map((m) => {
                    const spent = Number(m.daily_spent);
                    const cap = Number(m.limits_daily_cap);
                    const percent = cap > 0 ? Math.min(100, Math.round((spent / cap) * 100)) : 0;
                    const merchantStr = m.scope_merchant_allowlist?.length > 0 ? m.scope_merchant_allowlist.join(", ") : "ANY (*)";
                    const categoryStr = m.scope_category_allowlist?.length > 0 ? m.scope_category_allowlist.join(", ") : "ANY (*)";
                    
                    return (
                      <tr key={m.mandate_id} className="hover:bg-[var(--color-elevated)] transition-colors group">
                        <td className="py-4 px-4 font-bold text-zinc-300 whitespace-nowrap">
                          <span title={m.mandate_id}>{truncateId(m.mandate_id, 5)}</span>
                        </td>
                        <td className="py-4 px-4 whitespace-nowrap">
                          <span
                            className={`px-2 py-0.5 rounded-sm text-[10px] font-bold uppercase tracking-widest ${
                              m.status === "active"
                                ? "bg-[var(--color-semantic-green-subtle)] text-[var(--color-semantic-green)] border border-[var(--color-semantic-green)]/30"
                                : m.status === "revoked"
                                ? "bg-[var(--color-semantic-red-subtle)] text-[var(--color-semantic-red)] border border-[var(--color-semantic-red)]/30"
                                : "bg-zinc-800 text-zinc-400 border border-zinc-700"
                            }`}
                          >
                            {m.status}
                          </span>
                        </td>
                        <td className="py-4 px-4 min-w-[170px] whitespace-nowrap">
                          <div className="flex items-center justify-between mb-1.5 text-xs">
                            <span className="font-bold text-zinc-100">
                              {formatPaise(spent)}
                            </span>
                            <span className="text-zinc-500 font-sans tracking-wide text-[11px]">
                              / {formatPaise(cap)} <span className="font-mono text-zinc-400">({percent}%)</span>
                            </span>
                          </div>
                          <div className="w-full bg-zinc-900 rounded-full h-2 overflow-hidden border border-zinc-800">
                            <div
                              className={`h-full rounded-full transition-all duration-500 ${
                                percent >= 100
                                  ? "bg-[var(--color-gold)] shadow-[0_0_8px_var(--color-gold-muted)]"
                                  : percent >= 75
                                  ? "bg-[var(--color-gold)]"
                                  : "bg-[var(--color-semantic-green)]"
                              }`}
                              style={{ width: `${percent}%` }}
                            />
                          </div>
                        </td>
                        <td className="py-4 px-4 text-zinc-400 font-medium whitespace-nowrap">
                          {formatPaise(m.confirmation_threshold)}
                        </td>
                        <td className="py-4 px-4 text-zinc-400 text-xs">
                          <div className="flex flex-col gap-1 max-w-[280px]">
                            <div className="flex items-baseline gap-2 truncate" title={merchantStr}>
                              <span className="text-zinc-600 font-sans uppercase text-[9px] tracking-widest w-14 shrink-0">Merchant</span>
                              <span className="text-zinc-300 truncate">
                                {merchantStr}
                              </span>
                            </div>
                            <div className="flex items-baseline gap-2 truncate" title={categoryStr}>
                              <span className="text-zinc-600 font-sans uppercase text-[9px] tracking-widest w-14 shrink-0">Category</span>
                              <span className="text-zinc-300 truncate">
                                {categoryStr}
                              </span>
                            </div>
                          </div>
                        </td>
                        <td className="py-4 px-4 text-zinc-400 text-xs whitespace-nowrap" title={`${formatDate(m.validity_not_before)} → ${formatDate(m.validity_not_after)}`}>
                          <span className="text-zinc-400">
                            {formatValidityWindow(m.validity_not_before, m.validity_not_after)}
                          </span>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      {/* SECTION A: LIVE AUDIT FEED */}
      <section className="mb-14">
        <div className="flex items-center justify-between mb-6">
          <h2 className="text-2xl font-display text-white tracking-wide flex items-center gap-4">
            Live Ledger
            <span className="text-xs font-sans font-medium px-2 py-0.5 rounded bg-[var(--color-elevated)] text-zinc-400 border border-zinc-800 uppercase tracking-widest">
              Immutable Events ({auditLogs.length})
            </span>
          </h2>
        </div>

        <div className="bg-[var(--color-panel)] border border-[var(--color-elevated)] rounded shadow-sm overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm font-mono whitespace-nowrap">
              <thead className="bg-[#181814] text-zinc-500 border-b border-[var(--color-elevated)] uppercase tracking-widest text-[10px]">
                <tr>
                  <th className="py-4 px-6 font-medium">Time (Local)</th>
                  <th className="py-4 px-6 font-medium">Mandate Hash</th>
                  <th className="py-4 px-6 font-medium">Request Ref</th>
                  <th className="py-4 px-6 font-medium">System Decision</th>
                  <th className="py-4 px-6 font-medium">Reason Code</th>
                  <th className="py-4 px-6 font-medium text-right">Amount</th>
                  <th className="py-4 px-6 font-medium">Target</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--color-elevated)]">
                {auditLogs.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="py-8 text-center text-zinc-500 font-serif italic tracking-wide">
                      No ledger events recorded yet.
                    </td>
                  </tr>
                ) : (
                  auditLogs.map((log) => {
                    const isGreen = log.decision === "approved" || log.decision === "settled";
                    const isRed = log.decision === "rejected";
                    const isAmber = log.decision === "pending_confirmation";
                    
                    const borderColorClass = isGreen 
                      ? "border-l-[var(--color-semantic-green)]" 
                      : isRed 
                      ? "border-l-[var(--color-semantic-red)]" 
                      : isAmber 
                      ? "border-l-[var(--color-gold)]" 
                      : "border-l-zinc-700";

                    return (
                      <tr
                        key={log.id}
                        className={`hover:bg-[var(--color-elevated)] transition-colors animate-slide-down-fade border-l-[3px] ${borderColorClass}`}
                      >
                        <td className="py-4 px-6 text-zinc-500 text-xs">
                          {formatDateTime(log.created_at)}
                        </td>
                        <td className="py-4 px-6 text-zinc-400">
                          <span title={log.mandate_id}>
                            {truncateId(log.mandate_id, 6)}
                          </span>
                        </td>
                        <td className="py-4 px-6 text-zinc-100 font-bold">
                          {log.request_id}
                        </td>
                        <td className="py-4 px-6">
                          <span
                            className={`inline-flex items-center gap-2 px-2.5 py-1 rounded-sm text-[10px] font-bold uppercase tracking-widest ${
                              isGreen
                                ? "bg-[var(--color-semantic-green-subtle)] text-[var(--color-semantic-green)]"
                                : isRed
                                ? "bg-[var(--color-semantic-red-subtle)] text-[var(--color-semantic-red)]"
                                : isAmber
                                ? "bg-[var(--color-gold-subtle)] text-[var(--color-gold)]"
                                : "bg-zinc-800 text-zinc-400"
                            }`}
                          >
                            {log.decision}
                          </span>
                        </td>
                        <td className="py-4 px-6">
                          {log.reason_code ? (
                            <span className="px-2 py-0.5 rounded text-[10px] text-zinc-400 border border-zinc-700 uppercase tracking-widest">
                              {log.reason_code}
                            </span>
                          ) : (
                            <span className="text-zinc-600">—</span>
                          )}
                        </td>
                        <td className="py-4 px-6 text-zinc-100 font-bold text-right">
                          {formatPaise(log.amount)}
                        </td>
                        <td className="py-4 px-6 text-zinc-400 text-xs">
                          <span className="text-zinc-300 font-bold">{log.merchant_id || "—"}</span>
                          {log.category && (
                            <span className="text-zinc-500 ml-2 font-sans tracking-wide">[{log.category}]</span>
                          )}
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="mt-16 pt-8 border-t border-[var(--color-elevated)] text-center text-xs font-mono text-zinc-600 flex flex-col sm:flex-row items-center justify-between gap-4">
        <div className="flex items-center gap-2">
          <div className="h-1.5 w-1.5 rounded-full bg-zinc-600" />
          MandateGate Policy Engine • Ed25519 Signed Mandates &amp; Razorpay Settlement
        </div>
        <div className="tracking-widest uppercase text-zinc-500">Internal Operations Console</div>
      </footer>
    </div>
  );
}
