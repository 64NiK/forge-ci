const buildsEl = document.getElementById("builds");
const queueInfo = document.getElementById("queue-info");

function timeAgo(iso) {
  if (!iso) return "";
  const s = Math.floor((Date.now() - new Date(iso + (iso.endsWith("Z") || iso.includes("+") ? "" : "Z")).getTime()) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function duration(b) {
  if (!b.started_at) return "";
  const end = b.finished_at ? new Date(b.finished_at) : new Date();
  const s = Math.max(0, Math.floor((end - new Date(b.started_at)) / 1000));
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}

async function refresh() {
  const builds = await fetch("/api/builds").then((r) => r.json());
  const active = builds.filter((b) => b.status === "running" || b.status === "queued").length;
  queueInfo.textContent = active > 0 ? `${active} active` : "idle";

  if (builds.length === 0) {
    buildsEl.innerHTML = `<div class="empty">No builds yet — point forge at a repo with a .forge.yml and run a pipeline.</div>`;
    return;
  }

  buildsEl.innerHTML = builds
    .map(
      (b) => `
    <a class="build-row" href="/build/${b.id}">
      <span class="status-dot ${b.status}"></span>
      <span class="build-num">#${b.id}</span>
      <span class="build-main">
        <span class="build-title">${esc(b.commit_msg || b.repo_name)}</span>
        <span class="build-sub">${esc(b.repo_name)} · ${esc(b.branch)}${b.commit_sha ? " · " + esc(b.commit_sha) : ""}</span>
      </span>
      <span class="chip">${esc(b.trigger)}</span>
      <span class="build-meta">
        <span class="status-label ${b.status}">${b.status}</span><br/>
        ${duration(b)}${b.finished_at ? " · " + timeAgo(b.finished_at) : ""}
      </span>
    </a>`
    )
    .join("");
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

document.getElementById("trigger-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const res = await fetch("/api/builds", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ repoUrl: fd.get("repoUrl"), branch: fd.get("branch") }),
  });
  if (res.ok) {
    const build = await res.json();
    location.href = `/build/${build.id}`;
  }
});

refresh();
setInterval(refresh, 3000);
