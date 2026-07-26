// Shared utility for escaping HTML characters to prevent XSS.

export function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;"
  })[char]);
}

export function formatMoney(value) {
  const number = Math.round(Number(value) || 0);
  return `$${number.toLocaleString()}`;
}
