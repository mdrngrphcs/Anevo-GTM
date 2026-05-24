export default function Sidebar() {
  return (
    <aside className="w-56 bg-gray-900 text-white flex flex-col shrink-0">
      <div className="px-6 py-6 border-b border-gray-700">
        <span className="text-lg font-bold tracking-tight">Anevo GTM</span>
      </div>
      <nav className="flex-1 px-3 py-4 space-y-1">
        <div className="px-3 py-2 rounded text-sm text-white bg-gray-700 font-medium cursor-default">
          Data Procurement
        </div>
      </nav>
      <div className="px-6 py-4 border-t border-gray-700">
        <span className="text-xs text-gray-500">Anevo Marketing</span>
      </div>
    </aside>
  );
}
