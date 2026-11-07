/** Locate a normalized quote across inline text nodes without guessing among duplicates. */
export function findQuoteRange(doc: Document, exact: string, prefix = "", suffix = ""): Range | null {
  const wanted = exact.replace(/\s+/g, " ").trim();
  if (!wanted || !doc.body) return null;
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
  const positions: Array<{ node: Node; offset: number }> = [];
  let text = "";
  while (walker.nextNode()) {
    const node = walker.currentNode;
    if (node.parentElement?.closest("script, style, noscript")) continue;
    const raw = node.textContent ?? "";
    for (let i = 0; i < raw.length; i++) {
      const character = /\s/.test(raw[i]) ? " " : raw[i];
      if (character === " " && text.endsWith(" ")) continue;
      text += character;
      positions.push({ node, offset: i });
    }
  }
  const before = prefix.replace(/\s+/g, " ");
  const after = suffix.replace(/\s+/g, " ");
  const matches: number[] = [];
  let from = 0;
  while (true) {
    const index = text.indexOf(wanted, from);
    if (index < 0) break;
    const matchesBefore = !before || text.slice(Math.max(0, index - before.length), index) === before;
    const matchesAfter = !after || text.slice(index + wanted.length, index + wanted.length + after.length) === after;
    if (matchesBefore && matchesAfter) matches.push(index);
    from = index + 1;
  }
  if (matches.length !== 1) return null;
  const first = positions[matches[0]];
  const last = positions[matches[0] + wanted.length - 1];
  if (!first || !last) return null;
  const range = doc.createRange();
  range.setStart(first.node, first.offset);
  range.setEnd(last.node, last.offset + 1);
  return range;
}
