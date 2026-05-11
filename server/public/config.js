'use strict';

const shutdownBtn = document.getElementById('shutdown-btn');
const statusEl = document.getElementById('status');

shutdownBtn.addEventListener('click', async () => {
  const confirmed = window.confirm('Shut down the Odroid now? This will stop the dashboard and tracker server.');
  if (!confirmed) return;

  shutdownBtn.disabled = true;
  statusEl.textContent = 'Sending shutdown request...';

  try {
    const resp = await fetch('/api/admin/shutdown', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    const body = await resp.json().catch(() => null);
    if (!resp.ok || !body?.ok) {
      throw new Error(body?.error || `http_${resp.status}`);
    }
    statusEl.textContent = 'Shutdown requested. The server should go offline shortly.';
  } catch (err) {
    statusEl.textContent = `Shutdown failed: ${String(err?.message || err)}`;
    shutdownBtn.disabled = false;
  }
});
