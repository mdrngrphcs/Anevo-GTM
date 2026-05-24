"use client";

import { useState } from "react";
import TagInput from "./TagInput";
import IndustrySelect from "./IndustrySelect";

interface FormState {
  clientName: string;
  listName: string;
  source: "aiark" | "apollo" | "both";
  recordLimitMode: "all" | "limit";
  recordLimitValue: string;
  titles: string[];
  industriesInclude: string[];
  industriesExclude: string[];
  companyKeywordsInclude: string[];
  companyKeywordsExclude: string[];
  locations: string[];
  technologies: string[];
  headcountMin: string;
  headcountMax: string;
  revenueMin: string;
  revenueMax: string;
  additionalCriteria: string;
  websiteSummary: boolean;
  icpClassification: boolean;
  icpClassificationContext: string;
  businessLabeling: boolean;
  businessTypeLabelTemplate: string;
  decisionMakerDiscovery: boolean;
  decisionMakerContext: string;
}

const DEFAULT: FormState = {
  clientName: "",
  listName: "",
  source: "aiark",
  recordLimitMode: "all",
  recordLimitValue: "",
  titles: [],
  industriesInclude: [],
  industriesExclude: [],
  companyKeywordsInclude: [],
  companyKeywordsExclude: [],
  locations: [],
  technologies: [],
  headcountMin: "",
  headcountMax: "",
  revenueMin: "",
  revenueMax: "",
  additionalCriteria: "",
  websiteSummary: true,
  icpClassification: true,
  icpClassificationContext: "",
  businessLabeling: true,
  businessTypeLabelTemplate: "",
  decisionMakerDiscovery: true,
  decisionMakerContext: "",
};

interface EnrichmentContextProps {
  label: string;
  placeholder: string;
  rows: number;
  value: string;
  onChange: (v: string) => void;
}

function EnrichmentContext({ label, placeholder, rows, value, onChange }: EnrichmentContextProps) {
  return (
    <div className="ml-7 mt-2">
      <label className="block text-xs font-medium text-gray-500 mb-1">{label}</label>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        rows={rows}
        className="w-full border border-gray-200 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gray-900 resize-none bg-gray-50 placeholder:text-gray-400"
      />
    </div>
  );
}

interface NewOrderFormProps {
  onOrderPlaced?: () => void;
}

export default function NewOrderForm({ onOrderPlaced }: NewOrderFormProps) {
  const [form, setForm] = useState<FormState>(DEFAULT);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);

  function set<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setResult(null);

    try {
      const res = await fetch("/api/orders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientName: form.clientName.trim(),
          listName: form.listName.trim(),
          source: form.source,
          icp: {
            titles: form.titles,
            industries: form.industriesInclude,
            industriesExclude: form.industriesExclude,
            companyKeywords: form.companyKeywordsInclude,
            companyKeywordsExclude: form.companyKeywordsExclude,
            location: form.locations,
            technologies: form.technologies,
            headcount: {
              min: form.headcountMin ? parseInt(form.headcountMin) : undefined,
              max: form.headcountMax ? parseInt(form.headcountMax) : undefined,
            },
            revenue: {
              min: form.revenueMin ? parseInt(form.revenueMin) : undefined,
              max: form.revenueMax ? parseInt(form.revenueMax) : undefined,
            },
            additionalCriteria: form.additionalCriteria.trim() || undefined,
          },
          enrichments: {
            websiteSummary: form.websiteSummary,
            icpClassification: form.icpClassification,
            icpClassificationContext: form.icpClassificationContext.trim() || undefined,
            businessLabeling: form.businessLabeling,
            businessTypeLabelTemplate: form.businessTypeLabelTemplate.trim() || undefined,
            decisionMakerDiscovery: form.decisionMakerDiscovery,
            decisionMakerContext: form.decisionMakerContext.trim() || undefined,
          },
          recordLimit:
            form.recordLimitMode === "limit" && form.recordLimitValue
              ? parseInt(form.recordLimitValue)
              : null,
          outputDestination: "data/final",
        }),
      });

      const data = await res.json();
      if (res.ok) {
        setResult({ ok: true, message: `Order placed — job ID: ${data.jobId}` });
        setForm(DEFAULT);
        setTimeout(() => onOrderPlaced?.(), 1200);
      } else {
        setResult({ ok: false, message: data.error ?? "Failed to place order" });
      }
    } catch {
      setResult({ ok: false, message: "Network error — could not reach server" });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-8 max-w-2xl">
      {/* Order details */}
      <section className="bg-white rounded-xl border border-gray-200 p-6 space-y-4">
        <h2 className="font-semibold text-gray-900">Order Details</h2>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Client Name</label>
            <input
              required
              type="text"
              value={form.clientName}
              onChange={(e) => set("clientName", e.target.value)}
              placeholder="Acme Corp"
              className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gray-900"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">List Name</label>
            <input
              required
              type="text"
              value={form.listName}
              onChange={(e) => set("listName", e.target.value)}
              placeholder="Q3_Toronto_CROs"
              className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gray-900"
            />
          </div>
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Data Source</label>
          <div className="flex gap-3">
            {(["aiark", "apollo", "both"] as const).map((s) => (
              <label key={s} className="flex items-center gap-2 cursor-pointer">
                <input
                  type="radio"
                  name="source"
                  value={s}
                  checked={form.source === s}
                  onChange={() => set("source", s)}
                  className="accent-gray-900"
                />
                <span className="text-sm">
                  {s === "aiark" ? "AI Ark" : s === "apollo" ? "Apollo" : "Both"}
                </span>
              </label>
            ))}
          </div>
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Records to Pull</label>
          <div className="flex flex-col gap-2">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="radio"
                name="recordLimitMode"
                value="all"
                checked={form.recordLimitMode === "all"}
                onChange={() => set("recordLimitMode", "all")}
                className="accent-gray-900"
              />
              <span className="text-sm">All matching records</span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="radio"
                name="recordLimitMode"
                value="limit"
                checked={form.recordLimitMode === "limit"}
                onChange={() => set("recordLimitMode", "limit")}
                className="accent-gray-900"
              />
              <span className="text-sm">Limit to specific number</span>
            </label>
            {form.recordLimitMode === "limit" && (
              <input
                type="number"
                min="1"
                value={form.recordLimitValue}
                onChange={(e) => set("recordLimitValue", e.target.value)}
                placeholder="e.g. 5, 10, 25, 100"
                className="ml-6 w-48 border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gray-900"
              />
            )}
          </div>
        </div>
      </section>

      {/* ICP filters */}
      <section className="bg-white rounded-xl border border-gray-200 p-6 space-y-5">
        <h2 className="font-semibold text-gray-900">ICP Filters</h2>

        <TagInput
          label="Job Titles"
          placeholder="Chief Revenue Officer, CRO…"
          tags={form.titles}
          onChange={(v) => set("titles", v)}
        />

        <div className="space-y-3">
          <IndustrySelect
            label="Industries — Include"
            selected={form.industriesInclude}
            onChange={(v) => set("industriesInclude", v)}
            excluded={form.industriesExclude}
          />
          <IndustrySelect
            label="Industries — Exclude"
            selected={form.industriesExclude}
            onChange={(v) => set("industriesExclude", v)}
            excluded={form.industriesInclude}
          />
        </div>

        <div className="space-y-3">
          <TagInput
            label="Company Keywords — Include"
            placeholder="SaaS, B2B, fintech…"
            tags={form.companyKeywordsInclude}
            onChange={(v) => set("companyKeywordsInclude", v)}
          />
          <TagInput
            label="Company Keywords — Exclude"
            placeholder="agency, consulting…"
            tags={form.companyKeywordsExclude}
            onChange={(v) => set("companyKeywordsExclude", v)}
          />
        </div>

        <TagInput
          label="Locations"
          placeholder="Toronto, Ontario, Canada…"
          tags={form.locations}
          onChange={(v) => set("locations", v)}
        />

        <TagInput
          label="Technologies"
          placeholder="Salesforce, HubSpot…"
          tags={form.technologies}
          onChange={(v) => set("technologies", v)}
        />

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Headcount</label>
            <div className="flex items-center gap-2">
              <input
                type="number"
                min="0"
                value={form.headcountMin}
                onChange={(e) => set("headcountMin", e.target.value)}
                placeholder="Min"
                className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gray-900"
              />
              <span className="text-gray-400 text-sm">–</span>
              <input
                type="number"
                min="0"
                value={form.headcountMax}
                onChange={(e) => set("headcountMax", e.target.value)}
                placeholder="Max"
                className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gray-900"
              />
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Revenue (USD)</label>
            <div className="flex items-center gap-2">
              <input
                type="number"
                min="0"
                value={form.revenueMin}
                onChange={(e) => set("revenueMin", e.target.value)}
                placeholder="Min"
                className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gray-900"
              />
              <span className="text-gray-400 text-sm">–</span>
              <input
                type="number"
                min="0"
                value={form.revenueMax}
                onChange={(e) => set("revenueMax", e.target.value)}
                placeholder="Max"
                className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gray-900"
              />
            </div>
          </div>
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Additional Criteria</label>
          <textarea
            value={form.additionalCriteria}
            onChange={(e) => set("additionalCriteria", e.target.value)}
            placeholder="Any additional targeting notes or instructions…"
            rows={3}
            className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gray-900 resize-none"
          />
        </div>
      </section>

      {/* Enrichments */}
      <section className="bg-white rounded-xl border border-gray-200 p-6 space-y-4">
        <h2 className="font-semibold text-gray-900">Enrichments</h2>

        {/* Website Summary */}
        <label className="flex items-center gap-3 cursor-pointer">
          <input
            type="checkbox"
            checked={form.websiteSummary}
            onChange={(e) => set("websiteSummary", e.target.checked)}
            className="w-4 h-4 accent-gray-900"
          />
          <span className="text-sm text-gray-700">Website Summary</span>
        </label>

        {/* ICP Classification */}
        <div>
          <label className="flex items-center gap-3 cursor-pointer">
            <input
              type="checkbox"
              checked={form.icpClassification}
              onChange={(e) => set("icpClassification", e.target.checked)}
              className="w-4 h-4 accent-gray-900"
            />
            <span className="text-sm text-gray-700">ICP Classification</span>
          </label>
          {form.icpClassification && (
            <EnrichmentContext
              label="ICP Context (optional)"
              placeholder={
                "Describe your client and what makes a company a good fit. " +
                "e.g. Client is a BIM consulting firm targeting commercial and industrial " +
                "contractors involved in construction projects — MEP, HVAC, plumbing, " +
                "and general contractors qualify."
              }
              rows={3}
              value={form.icpClassificationContext}
              onChange={(v) => set("icpClassificationContext", v)}
            />
          )}
        </div>

        {/* Business Type Label */}
        <div>
          <label className="flex items-center gap-3 cursor-pointer">
            <input
              type="checkbox"
              checked={form.businessLabeling}
              onChange={(e) => set("businessLabeling", e.target.checked)}
              className="w-4 h-4 accent-gray-900"
            />
            <span className="text-sm text-gray-700">Business Type Label</span>
          </label>
          {form.businessLabeling && (
            <EnrichmentContext
              label="Sentence Template (optional)"
              placeholder={
                "Provide the sentence where the business type label will be inserted as a dynamic placeholder. " +
                "e.g. Most {{company_type}} IT teams are stretched thin across critical systems."
              }
              rows={2}
              value={form.businessTypeLabelTemplate}
              onChange={(v) => set("businessTypeLabelTemplate", v)}
            />
          )}
        </div>

        {/* Decision Maker Discovery */}
        <div>
          <label className="flex items-center gap-3 cursor-pointer">
            <input
              type="checkbox"
              checked={form.decisionMakerDiscovery}
              onChange={(e) => set("decisionMakerDiscovery", e.target.checked)}
              className="w-4 h-4 accent-gray-900"
            />
            <span className="text-sm text-gray-700">Additional Decision Maker Discovery</span>
          </label>
          {form.decisionMakerDiscovery && (
            <EnrichmentContext
              label="Decision Maker Context (optional)"
              placeholder={
                "Describe who you're looking for. " +
                "e.g. Primary target is HR Director or VP of HR. " +
                "If not found, identify the most senior relevant decision maker at the company."
              }
              rows={2}
              value={form.decisionMakerContext}
              onChange={(v) => set("decisionMakerContext", v)}
            />
          )}
        </div>
      </section>

      {result && (
        <div
          className={`rounded-lg px-4 py-3 text-sm ${
            result.ok
              ? "bg-green-50 text-green-800 border border-green-200"
              : "bg-red-50 text-red-800 border border-red-200"
          }`}
        >
          {result.message}
        </div>
      )}

      <button
        type="submit"
        disabled={submitting}
        className="w-full bg-gray-900 text-white py-3 rounded-xl font-medium text-sm hover:bg-gray-700 transition-colors disabled:opacity-50"
      >
        {submitting ? "Placing Order…" : "Place Order"}
      </button>
    </form>
  );
}
