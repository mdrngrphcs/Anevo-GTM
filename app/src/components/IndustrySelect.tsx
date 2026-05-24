"use client";

import { useState, useRef, useEffect, KeyboardEvent } from "react";

export const APOLLO_INDUSTRIES = [
  "Accounting", "Airlines/Aviation", "Alternative Medicine", "Animation",
  "Apparel & Fashion", "Architecture & Planning", "Arts & Crafts", "Automotive",
  "Aviation & Aerospace", "Banking", "Biotechnology", "Broadcast Media",
  "Building Materials", "Business Supplies & Equipment", "Capital Markets",
  "Chemicals", "Civic & Social Organization", "Civil Engineering",
  "Commercial Real Estate", "Computer & Network Security", "Computer Games",
  "Computer Hardware", "Computer Networking", "Computer Software", "Construction",
  "Consumer Electronics", "Consumer Goods", "Consumer Services", "Cosmetics",
  "Defense & Space", "Design", "E-learning", "Education Management",
  "Electrical & Electronic Manufacturing", "Entertainment", "Environmental Services",
  "Events Services", "Executive Office", "Facilities Services", "Farming",
  "Financial Services", "Fine Art", "Fishery", "Food & Beverages",
  "Food Production", "Fundraising", "Furniture", "Gambling & Casinos",
  "Glass, Ceramics & Concrete", "Government Administration", "Government Relations",
  "Graphic Design", "Health, Wellness & Fitness", "Higher Education",
  "Hospital & Health Care", "Hospitality", "Human Resources", "Import & Export",
  "Individual & Family Services", "Industrial Automation", "Information Services",
  "Information Technology & Services", "Insurance", "International Affairs",
  "International Trade & Development", "Internet", "Investment Banking",
  "Investment Management", "Judiciary", "Law Enforcement", "Law Practice",
  "Legal Services", "Legislative Office", "Leisure, Travel & Tourism", "Libraries",
  "Logistics & Supply Chain", "Luxury Goods & Jewelry", "Machinery",
  "Management Consulting", "Maritime", "Marketing & Advertising", "Market Research",
  "Mechanical or Industrial Engineering", "Media Production", "Medical Device",
  "Medical Practice", "Mental Health Care", "Military", "Mining & Metals",
  "Mobile Games", "Motion Pictures & Film", "Museums & Institutions", "Music",
  "Nanotechnology", "Newspapers", "Non-profit Organization Management",
  "Oil & Energy", "Online Media", "Outsourcing/Offshoring",
  "Package/Freight Delivery", "Packaging & Containers", "Paper & Forest Products",
  "Performing Arts", "Pharmaceuticals", "Philanthropy", "Photography", "Plastics",
  "Political Organization", "Primary/Secondary Education", "Printing",
  "Professional Training & Coaching", "Program Development", "Public Policy",
  "Public Relations & Communications", "Public Safety", "Publishing",
  "Railroad Manufacture", "Ranching", "Real Estate",
  "Recreational Facilities & Services", "Religious Institutions",
  "Renewables & Environment", "Research", "Restaurants", "Retail",
  "Security & Investigations", "Semiconductors", "Shipbuilding", "Sporting Goods",
  "Sports", "Staffing & Recruiting", "Supermarkets", "Telecommunications",
  "Textiles", "Think Tanks", "Tobacco", "Translation & Localization",
  "Transportation/Trucking/Railroad", "Utilities",
  "Venture Capital & Private Equity", "Veterinary", "Warehousing", "Wholesale",
  "Wine & Spirits", "Wireless", "Writing & Editing",
] as const;

interface Props {
  label: string;
  selected: string[];
  onChange: (selected: string[]) => void;
  excluded?: string[];
}

export default function IndustrySelect({ label, selected, onChange, excluded = [] }: Props) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [highlighted, setHighlighted] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const filtered = APOLLO_INDUSTRIES.filter(
    (i) =>
      !selected.includes(i) &&
      !excluded.includes(i) &&
      i.toLowerCase().includes(query.toLowerCase())
  );

  useEffect(() => {
    setHighlighted(0);
  }, [query]);

  useEffect(() => {
    function handleOutsideClick(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
        setQuery("");
      }
    }
    document.addEventListener("mousedown", handleOutsideClick);
    return () => document.removeEventListener("mousedown", handleOutsideClick);
  }, []);

  function add(industry: string) {
    if (!selected.includes(industry)) {
      onChange([...selected, industry]);
    }
    setQuery("");
    setHighlighted(0);
    inputRef.current?.focus();
  }

  function remove(industry: string) {
    onChange(selected.filter((i) => i !== industry));
  }

  function handleKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (!open && e.key !== "Escape") setOpen(true);
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlighted((h) => Math.min(h + 1, filtered.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlighted((h) => Math.max(h - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (filtered[highlighted]) add(filtered[highlighted]);
    } else if (e.key === "Escape") {
      setOpen(false);
      setQuery("");
    } else if (e.key === "Backspace" && query === "" && selected.length > 0) {
      onChange(selected.slice(0, -1));
    }
  }

  return (
    <div ref={containerRef} className="relative">
      <label className="block text-sm font-medium text-gray-700 mb-1">{label}</label>

      <div
        className="min-h-[42px] flex flex-wrap gap-1.5 items-center px-3 py-2 border border-gray-300 rounded-md bg-white focus-within:ring-2 focus-within:ring-gray-900 focus-within:border-transparent cursor-text"
        onClick={() => { inputRef.current?.focus(); setOpen(true); }}
      >
        {selected.map((ind) => (
          <span
            key={ind}
            className="flex items-center gap-1 bg-gray-900 text-white text-xs px-2 py-1 rounded"
          >
            {ind}
            <button
              type="button"
              onMouseDown={(e) => { e.preventDefault(); remove(ind); }}
              className="hover:text-gray-300 leading-none"
            >
              ×
            </button>
          </span>
        ))}
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
          onFocus={() => setOpen(true)}
          onKeyDown={handleKeyDown}
          placeholder={selected.length === 0 ? "Search industries…" : ""}
          className="flex-1 min-w-[140px] text-sm outline-none bg-transparent"
        />
      </div>

      {open && filtered.length > 0 && (
        <ul className="absolute z-50 mt-1 w-full bg-white border border-gray-200 rounded-md shadow-lg max-h-52 overflow-y-auto">
          {filtered.map((ind, i) => (
            <li
              key={ind}
              onMouseDown={(e) => { e.preventDefault(); add(ind); }}
              className={`px-3 py-2 text-sm cursor-pointer ${
                i === highlighted ? "bg-gray-900 text-white" : "hover:bg-gray-50 text-gray-800"
              }`}
            >
              {ind}
            </li>
          ))}
        </ul>
      )}

      {open && query.length > 0 && filtered.length === 0 && (
        <div className="absolute z-50 mt-1 w-full bg-white border border-gray-200 rounded-md shadow-lg px-3 py-2 text-sm text-gray-400">
          No matching industries
        </div>
      )}
    </div>
  );
}
