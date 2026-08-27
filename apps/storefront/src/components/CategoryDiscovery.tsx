import Link from "next/link";
import type { PublicCategory } from "@/lib/types";

export function CategoryDiscovery({ categories }: { categories: PublicCategory[] }) {
  return (
    <nav className="sf-category-list" aria-label="Product categories">
      <Link href="/categories">All categories</Link>
      {categories.map((category) => (
        <Link key={category.id} href={`/category/${category.slug}`}>{category.name}</Link>
      ))}
    </nav>
  );
}
