export function textOffsetInBlock(block: Element, node: Node, codeUnitOffset: number): number {
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
  let count = 0;
  while (walker.nextNode()) {
    const current = walker.currentNode;
    if (current === node) return count + [...(current.textContent ?? "").slice(0, codeUnitOffset)].length;
    count += [...(current.textContent ?? "")].length;
  }
  return count;
}

export function rangeForTextOffsets(block: Element, start: number, end: number): Range | null {
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  let count = 0;
  let foundStart = false;
  while (walker.nextNode()) {
    const node = walker.currentNode;
    const text = node.textContent ?? "";
    const length = [...text].length;
    if (!foundStart && start <= count + length) {
      range.setStart(node, [...text].slice(0, Math.max(0, start - count)).join("").length);
      foundStart = true;
    }
    if (foundStart && end <= count + length) {
      range.setEnd(node, [...text].slice(0, Math.max(0, end - count)).join("").length);
      return range;
    }
    count += length;
  }
  return null;
}
