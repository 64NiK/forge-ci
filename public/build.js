const buildId = location.pathname.split("/").pop();
const stepsEl = document.getElementById("steps");

const state = { build: null, steps: [], logs: {} }; // logs keyed by step idx
const openSteps = new Set();

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function stepDuration(s) {
  if (!s.started_at) return "";
  const end = s.finished_at ? new Date(s.finished_at) : new Date();
  const secs = Math.max(0, Math.floor((end - new Date(s.started_at)) / 1000));
  return secs < 60 ? `${secs}s` : `${Math.floor(secs / 60)}m ${String(secs % 60).padStart(2, "0")}s`;
}

const ICONS = { passed: "✓", failed: "✗", running: "●", pending: "○", skipped: "–", canceled: "–" };
const ICON_COLORS = {
  passed: "var(--green)", failed: "var(--red)", running: "var(--amber)",
  pending: "var(--subtle)", skipped: "var(--subtle)", canceled: "var(--subtle)",
};

function renderHead() {
  const b = state.build;
  if (!b) return;
  document.getElementById("title").textContent = `${b.repo_name} #${b.id}`;
  document.getElementById("dot").className = `status-dot ${b.status}`;
  const st = document.getElementById("status");
  st.className = `status-label ${b.status}`;
  st.textContent = b.status;
  document.getElementById("sub").textContent =
    `${b.branch}${b.commit_sha ? " · " + b.commit_sha : ""}${b.commit_msg ? " · " + b.commit_msg : ""} · triggered by ${b.trigger}`;
  document.getElementById("cancel-btn").style.display =
    b.status === "running" || b.status === "queued" ? "" : "none";
  const badgeUrl = `${location.origin}/badge/${b.repo_name}.svg`;
  document.getElementById("badge-img").src = badgeUrl + "?t=" + Date.now();
  document.getElementById("badge-url").textContent = badgeUrl;
}

function renderSteps() {
  stepsEl.innerHTML = state.steps
    .map((s) => {
      const open = openSteps.has(s.idx);
      return `
      <div class="step ${open ? "open" : ""}" data-idx="${s.idx}">
        <div class="step-head" onclick="toggleStep(${s.idx})">
          <span class="caret">▶</span>
          <span style="color:${ICON_COLORS[s.status] ?? "var(--subtle)"};font-family:var(--mono);width:14px;text-align:center">${ICONS[s.status] ?? "○"}</span>
          <span class="step-name">${esc(s.name)}</span>
          <span class="step-cmd">${esc(s.cmd)}</span>
          <span class="step-time">${stepDuration(s)}</span>
        </div>
        <pre class="step-log" id="log-${s.idx}">${esc(state.logs[s.idx] ?? "")}</pre>
      </div>`;
    })
    .join("");
  // Restore scroll position at bottom for open running steps
  for (const idx of openSteps) {
    const el = document.getElementById(`log-${idx}`);
    if (el) el.scrollTop = el.scrollHeight;
  }
}

window.toggleStep = (idx) => {
  if (openSteps.has(idx)) openSteps.delete(idx);
  else openSteps.add(idx);
  renderSteps();
};

// ---- Live updates over SSE ----
const es = new EventSource(`/api/builds/${buildId}/events`);
es.onmessage = (e) => {
  const ev = JSON.parse(e.data);
  if (ev.type === "snapshot") {
    state.build = ev.build;
    state.steps = ev.steps;
    ev.steps.forEach((s, i) => { state.logs[s.idx] = ev.logs[i]; });
    // Auto-open the currently running step, or the failed one
    const interesting = ev.steps.find((s) => s.status === "running") ?? ev.steps.find((s) => s.status === "failed");
    if (interesting) openSteps.add(interesting.idx);
    renderHead();
    renderSteps();
  } else if (ev.type === "log") {
    state.logs[ev.step] = (state.logs[ev.step] ?? "") + ev.chunk;
    const el = document.getElementById(`log-${ev.step}`);
    if (el) {
      el.textContent = state.logs[ev.step];
      el.scrollTop = el.scrollHeight;
    }
  } else if (ev.type === "step") {
    refreshBuild(); // statuses & timings come from the source of truth
    if (ev.status === "running") { openSteps.add(ev.step); }
  } else if (ev.type === "build" || ev.type === "meta") {
    refreshBuild();
  }
};

async function refreshBuild() {
  const data = await fetch(`/api/builds/${buildId}`).then((r) => r.json());
  state.build = data;
  state.steps = data.steps;
  renderHead();
  renderSteps();
}

// Tick durations while running
setInterval(() => {
  if (state.build && (state.build.status === "running" || state.build.status === "queued")) renderSteps();
}, 1000);

document.getElementById("cancel-btn").addEventListener("click", async () => {
  await fetch(`/api/builds/${buildId}/cancel`, { method: "POST" });
  refreshBuild();
});

document.getElementById("retry-btn").addEventListener("click", async () => {
  const res = await fetch(`/api/builds/${buildId}/retry`, { method: "POST" });
  if (res.ok) {
    const build = await res.json();
    location.href = `/build/${build.id}`;
  }
});

refreshBuild();
