export function ResearchTrace({ items, citations }: { items: string[]; citations: Array<{ title: string; publishedAt: string; href: string }> }) {
  return <aside aria-label="研究过程"><details open><summary>研究过程</summary>{items.map((item, index) => <p key={`${item}-${index}`}>{item}</p>)}{citations.length > 0 && <div aria-label="来源">{citations.map((citation) => <a key={citation.href} href={citation.href}>{citation.title} · {citation.publishedAt}</a>)}</div>}</details></aside>;
}
