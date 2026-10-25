// Talks to the copilot server (server/app.py).

export async function health() {
  const r = await fetch('/api/health');
  if (!r.ok) throw new Error(`health ${r.status}`);
  return r.json();
}

/** @returns {Promise<{ blocked: boolean, reason?: string, patch: object, reply: string, mode: string }>} */
export async function askCopilot(message, avatar) {
  const r = await fetch('/api/copilot', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, avatar }),
  });
  if (!r.ok) throw new Error(`The copilot server answered ${r.status}.`);
  return r.json();
}
