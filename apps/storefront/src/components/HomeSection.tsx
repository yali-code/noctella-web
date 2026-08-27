import Link from "next/link";

export function HomeSection({ title, viewAllHref, children, className = "" }: {
  title: string;
  viewAllHref?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={`sf-home-section ${className}`.trim()} aria-labelledby={`section-${toId(title)}`}>
      <div className="sf-section-heading">
        <h2 id={`section-${toId(title)}`}>{title}</h2>
        {viewAllHref && <Link href={viewAllHref}>View all</Link>}
      </div>
      {children}
    </section>
  );
}

function toId(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}
