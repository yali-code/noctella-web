"use client";

import { useId, useState } from "react";
import { useRouter } from "next/navigation";

export function SearchForm({ compact = false, onNavigate }: { compact?: boolean; onNavigate?: () => void }) {
  const router = useRouter();
  const inputId = useId();
  const [query, setQuery] = useState("");

  function submit(event: React.FormEvent) {
    event.preventDefault();
    const normalized = query.trim();
    router.push(normalized ? `/shop?search=${encodeURIComponent(normalized)}` : "/shop");
    onNavigate?.();
  }

  return (
    <form className={`sf-search${compact ? " sf-search--compact" : ""}`} role="search" onSubmit={submit}>
      <label className="sf-visually-hidden" htmlFor={inputId}>Search products</label>
      <input
        id={inputId}
        type="search"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="Search vintage objects"
      />
      <button type="submit">Search</button>
    </form>
  );
}
