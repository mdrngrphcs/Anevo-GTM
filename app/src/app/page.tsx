"use client";

import { useState } from "react";
import NewOrderForm from "@/components/NewOrderForm";
import ActiveOrders from "@/components/ActiveOrders";
import CompletedOrders from "@/components/CompletedOrders";

type Tab = "new" | "active" | "completed";

export default function Home() {
  const [activeTab, setActiveTab] = useState<Tab>("new");

  const tabs: { id: Tab; label: string }[] = [
    { id: "new", label: "New Order" },
    { id: "active", label: "Active Orders" },
    { id: "completed", label: "Completed" },
  ];

  return (
    <div className="max-w-5xl mx-auto">
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-gray-900">Data Procurement</h1>
        <p className="text-gray-500 mt-1 text-sm">
          Pull, verify, and enrich targeted B2B contact lists.
        </p>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 border-b border-gray-200 mb-8">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`px-5 py-2.5 text-sm font-medium rounded-t transition-colors ${
              activeTab === tab.id
                ? "bg-white border border-b-white border-gray-200 -mb-px text-gray-900"
                : "text-gray-500 hover:text-gray-700"
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {activeTab === "new" && <NewOrderForm onOrderPlaced={() => setActiveTab("active")} />}
      {activeTab === "active" && <ActiveOrders />}
      {activeTab === "completed" && <CompletedOrders />}
    </div>
  );
}
