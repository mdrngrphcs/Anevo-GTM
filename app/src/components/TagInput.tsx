"use client";

import { useState, KeyboardEvent } from "react";

interface Props {
  label: string;
  placeholder?: string;
  tags: string[];
  onChange: (tags: string[]) => void;
}

export default function TagInput({ label, placeholder, tags, onChange }: Props) {
  const [input, setInput] = useState("");

  function commit() {
    const val = input.trim();
    if (val && !tags.includes(val)) {
      onChange([...tags, val]);
    }
    setInput("");
  }

  function handleKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      commit();
    } else if (e.key === "Backspace" && input === "" && tags.length > 0) {
      onChange(tags.slice(0, -1));
    }
  }

  function remove(tag: string) {
    onChange(tags.filter((t) => t !== tag));
  }

  return (
    <div>
      <label className="block text-sm font-medium text-gray-700 mb-1">{label}</label>
      <div className="min-h-[42px] flex flex-wrap gap-1.5 items-center px-3 py-2 border border-gray-300 rounded-md bg-white focus-within:ring-2 focus-within:ring-gray-900 focus-within:border-transparent">
        {tags.map((tag) => (
          <span
            key={tag}
            className="flex items-center gap-1 bg-gray-900 text-white text-xs px-2 py-1 rounded"
          >
            {tag}
            <button
              type="button"
              onClick={() => remove(tag)}
              className="hover:text-gray-300 leading-none"
            >
              ×
            </button>
          </span>
        ))}
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          onBlur={commit}
          placeholder={tags.length === 0 ? placeholder : ""}
          className="flex-1 min-w-[120px] text-sm outline-none bg-transparent"
        />
      </div>
      <p className="text-xs text-gray-400 mt-1">Press Enter or comma to add</p>
    </div>
  );
}
