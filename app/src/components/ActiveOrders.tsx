"use client";

import { useEffect, useState, useCallback } from "react";

interface Order {
  jobId: string;
  clientName: string;
  listName: string;
  source: string;
  status: string;
  createdAt: string;
  startedAt?: string;
}

const STATUS_COLORS: Record<string, string> = {
  queued: "bg-yellow-100 text-yellow-800",
  processing: "bg-blue-100 text-blue-800",
};

export default function ActiveOrders() {
  const [orders, setOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchOrders = useCallback(async () => {
    try {
      const res = await fetch("/api/orders?status=active");
      if (res.ok) {
        const data = await res.json();
        setOrders(data.orders ?? []);
      }
    } catch {
      // silent
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchOrders();
    const interval = setInterval(fetchOrders, 10000);
    return () => clearInterval(interval);
  }, [fetchOrders]);

  if (loading) {
    return <p className="text-sm text-gray-500">Loading…</p>;
  }

  if (orders.length === 0) {
    return (
      <div className="bg-white rounded-xl border border-gray-200 p-12 text-center">
        <p className="text-gray-500 text-sm">No active orders. Place a new order to get started.</p>
      </div>
    );
  }

  return (
    <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
      <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
        <h2 className="font-semibold text-gray-900">Active Orders</h2>
        <span className="text-xs text-gray-400">Auto-refreshes every 10s</span>
      </div>
      <table className="w-full text-sm">
        <thead className="bg-gray-50 text-gray-500 uppercase text-xs">
          <tr>
            <th className="px-6 py-3 text-left font-medium">Client</th>
            <th className="px-6 py-3 text-left font-medium">List</th>
            <th className="px-6 py-3 text-left font-medium">Source</th>
            <th className="px-6 py-3 text-left font-medium">Status</th>
            <th className="px-6 py-3 text-left font-medium">Created</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {orders.map((order) => (
            <tr key={order.jobId} className="hover:bg-gray-50 transition-colors">
              <td className="px-6 py-4 font-medium text-gray-900">{order.clientName}</td>
              <td className="px-6 py-4 text-gray-600">{order.listName}</td>
              <td className="px-6 py-4 text-gray-600 capitalize">{order.source}</td>
              <td className="px-6 py-4">
                <span
                  className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${
                    STATUS_COLORS[order.status] ?? "bg-gray-100 text-gray-700"
                  }`}
                >
                  {order.status}
                </span>
              </td>
              <td className="px-6 py-4 text-gray-400 text-xs">
                {new Date(order.createdAt).toLocaleString()}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
