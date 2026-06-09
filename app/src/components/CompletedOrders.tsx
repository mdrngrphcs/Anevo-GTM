"use client";

import { useEffect, useState, useCallback } from "react";

interface Order {
  jobId: string;
  clientName: string;
  listName: string;
  source: string;
  status: string;
  createdAt: string;
  endedAt?: string;
  outputFilename?: string;
}

export default function CompletedOrders() {
  const [orders, setOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(true);
  const [downloading, setDownloading] = useState<string | null>(null);

  const fetchOrders = useCallback(async () => {
    try {
      const res = await fetch("/api/orders?status=completed");
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

  async function handleDownload(jobId: string) {
    setDownloading(jobId);
    try {
      const res = await fetch(`/api/orders/${jobId}/download`);
      const data = await res.json();
      if (data.driveUrl) {
        window.open(data.driveUrl, "_blank");
      } else {
        alert(data.error ?? "Download failed — file may not be ready yet.");
      }
    } catch {
      alert("Download failed — please try again.");
    } finally {
      setDownloading(null);
    }
  }

  if (loading) {
    return <p className="text-sm text-gray-500">Loading…</p>;
  }

  if (orders.length === 0) {
    return (
      <div className="bg-white rounded-xl border border-gray-200 p-12 text-center">
        <p className="text-gray-500 text-sm">No completed orders yet.</p>
      </div>
    );
  }

  return (
    <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
      <div className="px-6 py-4 border-b border-gray-100">
        <h2 className="font-semibold text-gray-900">Completed Orders</h2>
      </div>
      <table className="w-full text-sm">
        <thead className="bg-gray-50 text-gray-500 uppercase text-xs">
          <tr>
            <th className="px-6 py-3 text-left font-medium">Client</th>
            <th className="px-6 py-3 text-left font-medium">List</th>
            <th className="px-6 py-3 text-left font-medium">Source</th>
            <th className="px-6 py-3 text-left font-medium">Completed</th>
            <th className="px-6 py-3 text-left font-medium">Status</th>
            <th className="px-6 py-3 text-left font-medium"></th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {orders.map((order) => (
            <tr key={order.jobId} className="hover:bg-gray-50 transition-colors">
              <td className="px-6 py-4 font-medium text-gray-900">{order.clientName}</td>
              <td className="px-6 py-4 text-gray-600">{order.listName}</td>
              <td className="px-6 py-4 text-gray-600 capitalize">{order.source}</td>
              <td className="px-6 py-4 text-gray-400 text-xs">
                {order.endedAt ? new Date(order.endedAt).toLocaleString() : "—"}
              </td>
              <td className="px-6 py-4">
                <span
                  className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${
                    order.status === "completed"
                      ? "bg-green-100 text-green-800"
                      : "bg-red-100 text-red-800"
                  }`}
                >
                  {order.status}
                </span>
              </td>
              <td className="px-6 py-4">
                {order.status === "completed" && (
                  <button
                    onClick={() => handleDownload(order.jobId)}
                    disabled={downloading === order.jobId}
                    className="text-xs font-medium text-gray-900 underline hover:text-gray-500 disabled:opacity-50"
                  >
                    {downloading === order.jobId ? "Downloading…" : "Download CSV"}
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
